-- ---------------------------------------------------------------------------
-- QueueBridge — Fairness, overrides, routing and audit integrity (M4)
-- Migration: 0006_fairness_routing_audit
-- Idempotent and additive: no column or table is dropped. queue_events stays append-only.
-- ---------------------------------------------------------------------------

-- Generic append-only guard (row-level UPDATE/DELETE and statement-level TRUNCATE)
CREATE OR REPLACE FUNCTION prevent_append_only_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only. Attempted operation: %.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 0002 blocked row-level UPDATE/DELETE on queue_events; TRUNCATE bypasses row triggers.
DROP TRIGGER IF EXISTS queue_events_no_truncate ON queue_events;
CREATE TRIGGER queue_events_no_truncate
  BEFORE TRUNCATE ON queue_events
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

DROP TRIGGER IF EXISTS admin_events_no_truncate ON admin_events;
CREATE TRIGGER admin_events_no_truncate
  BEFORE TRUNCATE ON admin_events
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

-- ---------------------------------------------------------------------------
-- 1. Versioned fairness policies (REQ-F3.1, REQ-F5.6)
--    Every policy a service has ever had is kept as an immutable snapshot. services.policy holds
--    the CURRENT snapshot (including its version label); events cite the label they used.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS service_policy_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  facility_id     UUID NOT NULL REFERENCES facilities (id) ON DELETE RESTRICT,
  service_id      UUID NOT NULL REFERENCES services (id) ON DELETE RESTRICT,
  version_number  INTEGER NOT NULL CHECK (version_number >= 1),
  version_label   TEXT NOT NULL,
  policy          JSONB NOT NULL,
  created_by      UUID REFERENCES staff_users (id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS service_policy_versions_number_idx
  ON service_policy_versions (service_id, version_number);
CREATE UNIQUE INDEX IF NOT EXISTS service_policy_versions_label_idx
  ON service_policy_versions (service_id, version_label);
CREATE INDEX IF NOT EXISTS service_policy_versions_org_idx
  ON service_policy_versions (organization_id, facility_id);

DROP TRIGGER IF EXISTS service_policy_versions_append_only ON service_policy_versions;
CREATE TRIGGER service_policy_versions_append_only
  BEFORE UPDATE OR DELETE ON service_policy_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
DROP TRIGGER IF EXISTS service_policy_versions_no_truncate ON service_policy_versions;
CREATE TRIGGER service_policy_versions_no_truncate
  BEFORE TRUNCATE ON service_policy_versions
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

-- Existing services keep their M2 behaviour EXPLICITLY: transfers go to the end of the queue,
-- and the override reason list is the M4 default set.
UPDATE services
   SET policy = policy
       || jsonb_build_object('transfer_placement', 'end_of_queue')
       || CASE WHEN policy ? 'override_reasons' THEN '{}'::jsonb
               ELSE jsonb_build_object('override_reasons',
                      '["accessibility_need","urgent_need","returning_visitor","administrative_error"]'::jsonb)
          END
 WHERE NOT (policy ? 'transfer_placement');

-- Backfill version 1 for every service that has no snapshot yet (label kept as stored)
INSERT INTO service_policy_versions
  (organization_id, facility_id, service_id, version_number, version_label, policy, created_by, created_at)
SELECT s.organization_id, s.facility_id, s.id, 1, COALESCE(s.policy ->> 'version', 'v1'), s.policy,
       NULL, s.created_at
  FROM services s
 WHERE NOT EXISTS (SELECT 1 FROM service_policy_versions v WHERE v.service_id = s.id);

-- ---------------------------------------------------------------------------
-- 2. Ordering: the instant a ticket's place in line is measured from (waiting age).
--    Native tickets: their issue time (set inside the session lock, so monotonic in issue
--    order). Transfers: the original join time or the transfer time, per policy.
-- ---------------------------------------------------------------------------

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS wait_since TIMESTAMPTZ;

-- Deterministic backfill: running maximum of created_at in issue order, so pre-M4 tickets keep
-- exactly their M2 relative order (issued_sequence) under the new ordering key.
UPDATE tickets t
   SET wait_since = b.ws
  FROM (SELECT id, MAX(created_at) OVER (PARTITION BY queue_session_id ORDER BY issued_sequence
                                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS ws
          FROM tickets) b
 WHERE b.id = t.id AND t.wait_since IS NULL;

ALTER TABLE tickets ALTER COLUMN wait_since SET DEFAULT NOW();
ALTER TABLE tickets ALTER COLUMN wait_since SET NOT NULL;

CREATE INDEX IF NOT EXISTS tickets_waiting_order_idx
  ON tickets (queue_session_id, wait_since, issued_sequence) WHERE state = 'waiting';

-- ---------------------------------------------------------------------------
-- 3. Counters: operational availability (separate from the admin 'active' flag)
-- ---------------------------------------------------------------------------

ALTER TABLE counters ADD COLUMN IF NOT EXISTS availability TEXT NOT NULL DEFAULT 'open';
ALTER TABLE counters ADD COLUMN IF NOT EXISTS availability_changed_at TIMESTAMPTZ;
ALTER TABLE counters ADD COLUMN IF NOT EXISTS availability_changed_by UUID REFERENCES staff_users (id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'counters_availability_chk') THEN
    ALTER TABLE counters ADD CONSTRAINT counters_availability_chk CHECK (availability IN ('open', 'closed'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Priority overrides and routing overrides (REQ-F3.3, REQ-F3.6, REQ-F5.5)
--    priority_overrides existed since 0001 (unused). Complete it and make it append-only.
--    Free text lives ONLY here (never in queue_events.payload); the event carries its SHA-256.
-- ---------------------------------------------------------------------------

ALTER TABLE priority_overrides ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE priority_overrides ADD COLUMN IF NOT EXISTS queue_session_id UUID REFERENCES queue_sessions (id) ON DELETE RESTRICT;
ALTER TABLE priority_overrides ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'priority';
ALTER TABLE priority_overrides ADD COLUMN IF NOT EXISTS from_class TEXT;
ALTER TABLE priority_overrides ADD COLUMN IF NOT EXISTS to_class TEXT;
ALTER TABLE priority_overrides ADD COLUMN IF NOT EXISTS counter_id UUID REFERENCES counters (id) ON DELETE RESTRICT;
ALTER TABLE priority_overrides ADD COLUMN IF NOT EXISTS operation_id UUID;

DO $$
DECLARE
  fk_name TEXT;
BEGIN
  -- 0001 declared ticket_id ON DELETE CASCADE: an audit record must never vanish with its ticket
  SELECT conname INTO fk_name FROM pg_constraint
   WHERE conrelid = 'priority_overrides'::regclass AND contype = 'f' AND confdeltype = 'c'
     AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                          WHERE attrelid = 'priority_overrides'::regclass AND attname = 'ticket_id')];
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE priority_overrides DROP CONSTRAINT %I', fk_name);
    ALTER TABLE priority_overrides
      ADD CONSTRAINT priority_overrides_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'priority_overrides_kind_chk') THEN
    ALTER TABLE priority_overrides ADD CONSTRAINT priority_overrides_kind_chk
      CHECK (kind IN ('priority', 'routing'));
  END IF;
  -- Every override names its actor, policy, reason code and a non-trivial explanation (DB-enforced)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'priority_overrides_complete_chk') THEN
    ALTER TABLE priority_overrides ADD CONSTRAINT priority_overrides_complete_chk
      CHECK (length(btrim(reason_code)) > 0 AND length(btrim(reason_text)) >= 5
             AND length(reason_text) <= 500 AND length(btrim(policy_version)) > 0)
      NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'priority_overrides_m4_fields_chk') THEN
    ALTER TABLE priority_overrides ADD CONSTRAINT priority_overrides_m4_fields_chk
      CHECK (organization_id IS NOT NULL AND queue_session_id IS NOT NULL AND queue_event_id IS NOT NULL
             AND ((kind = 'priority' AND from_class IS NOT NULL AND to_class IS NOT NULL AND from_class <> to_class)
               OR (kind = 'routing' AND counter_id IS NOT NULL)))
      NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'priority_overrides_event_fk') THEN
    ALTER TABLE priority_overrides ADD CONSTRAINT priority_overrides_event_fk
      FOREIGN KEY (queue_event_id) REFERENCES queue_events (id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS priority_overrides_event_idx ON priority_overrides (queue_event_id);
CREATE INDEX IF NOT EXISTS priority_overrides_session_idx ON priority_overrides (queue_session_id, created_at);

DROP TRIGGER IF EXISTS priority_overrides_append_only ON priority_overrides;
CREATE TRIGGER priority_overrides_append_only
  BEFORE UPDATE OR DELETE ON priority_overrides
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
DROP TRIGGER IF EXISTS priority_overrides_no_truncate ON priority_overrides;
CREATE TRIGGER priority_overrides_no_truncate
  BEFORE TRUNCATE ON priority_overrides
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

-- ---------------------------------------------------------------------------
-- 5. Audit checkpoints and integrity alerts (REQ-F8.3, ADR-010)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_checkpoints_range_chk') THEN
    ALTER TABLE audit_checkpoints ADD CONSTRAINT audit_checkpoints_range_chk
      CHECK (from_sequence >= 1 AND to_sequence >= from_sequence);
  END IF;
END $$;

ALTER TABLE audit_checkpoints ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE audit_checkpoints ADD COLUMN IF NOT EXISTS algorithm TEXT NOT NULL DEFAULT 'hmac-sha256';
-- The event hash at to_sequence: lets the next range be linked without re-reading history
ALTER TABLE audit_checkpoints ADD COLUMN IF NOT EXISTS head_hash CHAR(64);

-- Ranges never overlap: one checkpoint per start and per end sequence
CREATE UNIQUE INDEX IF NOT EXISTS audit_checkpoints_from_idx ON audit_checkpoints (queue_session_id, from_sequence);
CREATE UNIQUE INDEX IF NOT EXISTS audit_checkpoints_to_idx ON audit_checkpoints (queue_session_id, to_sequence);

DROP TRIGGER IF EXISTS audit_checkpoints_append_only ON audit_checkpoints;
CREATE TRIGGER audit_checkpoints_append_only
  BEFORE UPDATE OR DELETE ON audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
DROP TRIGGER IF EXISTS audit_checkpoints_no_truncate ON audit_checkpoints;
CREATE TRIGGER audit_checkpoints_no_truncate
  BEFORE TRUNCATE ON audit_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

-- Integrity failures found by the worker. Never silently cleared: append-only.
CREATE TABLE IF NOT EXISTS audit_integrity_alerts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  queue_session_id UUID NOT NULL REFERENCES queue_sessions (id) ON DELETE RESTRICT,
  -- chain | checkpoint
  kind             TEXT NOT NULL CHECK (kind IN ('chain', 'checkpoint')),
  at_sequence      INTEGER,
  reason           TEXT NOT NULL,
  detected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS audit_integrity_alerts_dedupe_idx
  ON audit_integrity_alerts (queue_session_id, kind, COALESCE(at_sequence, -1), reason);
CREATE INDEX IF NOT EXISTS audit_integrity_alerts_org_idx ON audit_integrity_alerts (organization_id, detected_at);

DROP TRIGGER IF EXISTS audit_integrity_alerts_append_only ON audit_integrity_alerts;
CREATE TRIGGER audit_integrity_alerts_append_only
  BEFORE UPDATE OR DELETE ON audit_integrity_alerts
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
DROP TRIGGER IF EXISTS audit_integrity_alerts_no_truncate ON audit_integrity_alerts;
CREATE TRIGGER audit_integrity_alerts_no_truncate
  BEFORE TRUNCATE ON audit_integrity_alerts
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

-- Worker scan: sessions with events beyond their last checkpoint
CREATE INDEX IF NOT EXISTS queue_sessions_last_sequence_idx ON queue_sessions (last_sequence) WHERE last_sequence > 0;
