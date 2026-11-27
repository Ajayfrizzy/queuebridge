-- ---------------------------------------------------------------------------
-- QueueBridge — Continuity Engine (M3)
-- Migration: 0005_continuity_engine
-- Idempotent and additive: no column or table is dropped. queue_events stays append-only.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Devices: health reporting, revocation audit, tenant integrity
--    A device is a registered browser profile belonging to ONE staff user at ONE facility.
--    It carries no secret of its own: every sync request is authenticated by the owner's
--    server-side session, and the server checks that the device belongs to that session.
-- ---------------------------------------------------------------------------

ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ;
-- Approximate: reported by the device itself, never trusted for correctness, only for display
ALTER TABLE devices ADD COLUMN IF NOT EXISTS reported_pending_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_failure_code TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS revoked_by UUID REFERENCES staff_users (id) ON DELETE RESTRICT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS revoked_reason_code TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devices_pending_nonneg_chk') THEN
    ALTER TABLE devices
      ADD CONSTRAINT devices_pending_nonneg_chk CHECK (reported_pending_count >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devices_facility_org_fk') THEN
    ALTER TABLE devices
      ADD CONSTRAINT devices_facility_org_fk
      FOREIGN KEY (facility_id, organization_id) REFERENCES facilities (id, organization_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS devices_org_facility_idx ON devices (organization_id, facility_id);

-- ---------------------------------------------------------------------------
-- 2. Queue sessions: coordinator authority (ADR-006)
--    coordinator_epoch / coordinator_device_id already exist (0001). The epoch fences stale
--    coordinators and must never go backwards — enforced here, not only in application code.
-- ---------------------------------------------------------------------------

ALTER TABLE queue_sessions ADD COLUMN IF NOT EXISTS coordinator_granted_at TIMESTAMPTZ;
ALTER TABLE queue_sessions ADD COLUMN IF NOT EXISTS coordinator_expires_at TIMESTAMPTZ;
ALTER TABLE queue_sessions ADD COLUMN IF NOT EXISTS coordinator_allowed_actions TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE queue_sessions ADD COLUMN IF NOT EXISTS coordinator_granted_by UUID REFERENCES staff_users (id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'queue_sessions_coordinator_expiry_chk') THEN
    ALTER TABLE queue_sessions
      ADD CONSTRAINT queue_sessions_coordinator_expiry_chk
      CHECK (coordinator_device_id IS NULL OR coordinator_expires_at IS NOT NULL);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION queue_session_epoch_monotonic()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.coordinator_epoch < OLD.coordinator_epoch THEN
    RAISE EXCEPTION 'coordinator_epoch must never decrease (% -> %)', OLD.coordinator_epoch, NEW.coordinator_epoch
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS queue_session_epoch_monotonic_trg ON queue_sessions;
CREATE TRIGGER queue_session_epoch_monotonic_trg
  BEFORE UPDATE OF coordinator_epoch ON queue_sessions
  FOR EACH ROW
  EXECUTE FUNCTION queue_session_epoch_monotonic();

-- ---------------------------------------------------------------------------
-- 3. Client operations: keep the original offline command for supervisor review and record
--    how a needs_review operation was resolved. Resolution never edits queue_events: a
--    resolution that changes queue state appends a NEW event.
-- ---------------------------------------------------------------------------

-- The command as received (ids, enums and timestamps only — never personal data)
ALTER TABLE client_operations ADD COLUMN IF NOT EXISTS envelope JSONB;
ALTER TABLE client_operations ADD COLUMN IF NOT EXISTS reason_code TEXT;
ALTER TABLE client_operations ADD COLUMN IF NOT EXISTS resolution TEXT;
ALTER TABLE client_operations ADD COLUMN IF NOT EXISTS resolution_reason_code TEXT;
ALTER TABLE client_operations ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES staff_users (id) ON DELETE RESTRICT;
ALTER TABLE client_operations ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_operations_resolution_chk') THEN
    ALTER TABLE client_operations
      ADD CONSTRAINT client_operations_resolution_chk
      CHECK (resolution IS NULL OR resolution IN ('applied', 'dismissed'));
  END IF;
  -- A resolution always names who resolved it, when and why
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_operations_resolution_complete_chk') THEN
    ALTER TABLE client_operations
      ADD CONSTRAINT client_operations_resolution_complete_chk
      CHECK (resolution IS NULL OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND resolution_reason_code IS NOT NULL));
  END IF;
END $$;

-- Supervisor review queue and device health lookups
CREATE INDEX IF NOT EXISTS client_operations_open_review_idx
  ON client_operations (queue_session_id, created_at)
  WHERE status = 'needs_review';
CREATE INDEX IF NOT EXISTS client_operations_device_status_idx
  ON client_operations (device_id, status) WHERE device_id IS NOT NULL;

-- Resolving temporary ticket references to confirmed tickets (per device)
CREATE INDEX IF NOT EXISTS client_operations_temp_ref_idx
  ON client_operations (device_id, (result_json -> 'ticket_mapping' ->> 'temporary_ref'))
  WHERE action = 'ticket.create' AND device_id IS NOT NULL;

-- Audit: coordinator actions are looked up by (device, epoch) to recognise a fenced coordinator
CREATE INDEX IF NOT EXISTS queue_events_coordinator_idx
  ON queue_events (queue_session_id, event_type)
  WHERE event_type LIKE 'coordinator.%';
