-- QueueBridge — Tenancy hardening, org-level roles, staff invitations, admin audit log
-- Migration: 0003_tenancy_roles_invitations (M1)
-- Idempotent: every statement is guarded (IF NOT EXISTS / DO blocks / CREATE OR REPLACE).
-- Additive only: no column or table is dropped.

-- ---------------------------------------------------------------------------
-- 1. Composite keys so tenant columns cannot disagree with their parents
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS facilities_id_org_idx ON facilities (id, organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS staff_users_id_org_idx ON staff_users (id, organization_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'services_facility_org_fk') THEN
    ALTER TABLE services
      ADD CONSTRAINT services_facility_org_fk
      FOREIGN KEY (facility_id, organization_id) REFERENCES facilities (id, organization_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'counters_facility_org_fk') THEN
    ALTER TABLE counters
      ADD CONSTRAINT counters_facility_org_fk
      FOREIGN KEY (facility_id, organization_id) REFERENCES facilities (id, organization_id);
  END IF;
END $$;

-- Unique names within a facility (case-insensitive) — prevents confusing duplicates in UI
CREATE UNIQUE INDEX IF NOT EXISTS services_facility_name_idx ON services (facility_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS counters_facility_name_idx ON counters (facility_id, lower(name));

-- ---------------------------------------------------------------------------
-- 2. role_assignments: org-level role (org_admin) + explicit organization_id
-- ---------------------------------------------------------------------------

ALTER TABLE role_assignments ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations (id) ON DELETE RESTRICT;

UPDATE role_assignments ra
   SET organization_id = f.organization_id
  FROM facilities f
 WHERE ra.facility_id = f.id AND ra.organization_id IS NULL;

-- Fill organization_id from the facility for facility-scoped roles (keeps older seeds working)
CREATE OR REPLACE FUNCTION role_assignments_fill_org()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.organization_id IS NULL AND NEW.facility_id IS NOT NULL THEN
    SELECT organization_id INTO NEW.organization_id FROM facilities WHERE id = NEW.facility_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS role_assignments_fill_org_trg ON role_assignments;
CREATE TRIGGER role_assignments_fill_org_trg
  BEFORE INSERT ON role_assignments
  FOR EACH ROW
  EXECUTE FUNCTION role_assignments_fill_org();

ALTER TABLE role_assignments ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE role_assignments ALTER COLUMN facility_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'role_assignments_scope_chk') THEN
    ALTER TABLE role_assignments
      ADD CONSTRAINT role_assignments_scope_chk CHECK (
        (role = 'org_admin' AND facility_id IS NULL)
        OR (role <> 'org_admin' AND facility_id IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'role_assignments_facility_org_fk') THEN
    ALTER TABLE role_assignments
      ADD CONSTRAINT role_assignments_facility_org_fk
      FOREIGN KEY (facility_id, organization_id) REFERENCES facilities (id, organization_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'role_assignments_user_org_fk') THEN
    ALTER TABLE role_assignments
      ADD CONSTRAINT role_assignments_user_org_fk
      FOREIGN KEY (staff_user_id, organization_id) REFERENCES staff_users (id, organization_id) ON DELETE CASCADE;
  END IF;
END $$;

-- The original unique index cannot dedupe rows whose facility_id is NULL
CREATE UNIQUE INDEX IF NOT EXISTS role_assignments_user_org_role_idx
  ON role_assignments (staff_user_id, role) WHERE facility_id IS NULL;
CREATE INDEX IF NOT EXISTS role_assignments_org_idx ON role_assignments (organization_id);
CREATE INDEX IF NOT EXISTS role_assignments_user_idx ON role_assignments (staff_user_id);

-- ---------------------------------------------------------------------------
-- 3. counter_service_capabilities must link a counter and a service of one facility
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION counter_service_same_facility()
RETURNS TRIGGER AS $$
DECLARE
  counter_facility UUID;
  service_facility UUID;
BEGIN
  SELECT facility_id INTO counter_facility FROM counters WHERE id = NEW.counter_id;
  SELECT facility_id INTO service_facility FROM services WHERE id = NEW.service_id;
  IF counter_facility IS DISTINCT FROM service_facility THEN
    RAISE EXCEPTION 'counter and service must belong to the same facility'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS counter_service_same_facility_trg ON counter_service_capabilities;
CREATE TRIGGER counter_service_same_facility_trg
  BEFORE INSERT OR UPDATE ON counter_service_capabilities
  FOR EACH ROW
  EXECUTE FUNCTION counter_service_same_facility();

-- ---------------------------------------------------------------------------
-- 4. Staff invitations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS staff_invitations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  facility_id     UUID NOT NULL REFERENCES facilities (id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  role            TEXT NOT NULL
                    CHECK (role IN ('staff_reception', 'staff_counter', 'supervisor', 'facility_admin', 'auditor')),
  -- SHA-256 of the invitation secret; the secret itself is shown once and never persisted
  token_hash      TEXT NOT NULL,
  invited_by      UUID REFERENCES staff_users (id) ON DELETE SET NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  accepted_at     TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_invitations_facility_org_fk
    FOREIGN KEY (facility_id, organization_id) REFERENCES facilities (id, organization_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_invitations_token_hash_idx ON staff_invitations (token_hash);
CREATE INDEX IF NOT EXISTS staff_invitations_facility_idx ON staff_invitations (facility_id);
-- At most one open invitation per (facility, email, role)
CREATE UNIQUE INDEX IF NOT EXISTS staff_invitations_open_idx
  ON staff_invitations (facility_id, lower(email), role)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 5. Administrative audit log (append-only; no PII, no secrets)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admin_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  facility_id     UUID REFERENCES facilities (id) ON DELETE RESTRICT,
  -- No ON DELETE SET NULL: that would UPDATE a row of an append-only table.
  -- Staff are deactivated, never deleted.
  actor_id        UUID REFERENCES staff_users (id) ON DELETE RESTRICT,
  event_type      TEXT NOT NULL,
  target_type     TEXT NOT NULL,
  target_id       UUID,
  -- Never contains emails, names, passwords, tokens or phone numbers
  details         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_events_org_idx ON admin_events (organization_id, created_at);

CREATE OR REPLACE FUNCTION prevent_admin_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'admin_events is append-only. Attempted operation: %.', TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS admin_events_append_only ON admin_events;
CREATE TRIGGER admin_events_append_only
  BEFORE UPDATE OR DELETE ON admin_events
  FOR EACH ROW
  EXECUTE FUNCTION prevent_admin_event_mutation();
