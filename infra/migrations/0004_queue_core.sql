-- QueueBridge — Online queue core (M2)
-- Migration: 0004_queue_core
-- Idempotent and additive: no column or table is dropped. queue_events stays append-only.

-- ---------------------------------------------------------------------------
-- 1. client_operations: allow ONLINE commands (no registered device until M3)
--    Offline-synced operations (M3) must still carry a device_id.
-- ---------------------------------------------------------------------------

ALTER TABLE client_operations ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'offline_sync';
ALTER TABLE client_operations ALTER COLUMN device_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_operations_source_chk') THEN
    ALTER TABLE client_operations
      ADD CONSTRAINT client_operations_source_chk CHECK (source IN ('online', 'offline_sync'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_operations_device_required_chk') THEN
    ALTER TABLE client_operations
      ADD CONSTRAINT client_operations_device_required_chk
      CHECK (source = 'online' OR device_id IS NOT NULL);
  END IF;
END $$;

-- Hash of the visitor's join proof (lets a lost-ACK join replay recover its ticket); never the raw value
ALTER TABLE client_operations ADD COLUMN IF NOT EXISTS proof_hash TEXT;

-- ---------------------------------------------------------------------------
-- 2. Services: short ticket-code prefix, unique within a facility
-- ---------------------------------------------------------------------------

ALTER TABLE services ADD COLUMN IF NOT EXISTS ticket_prefix TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'services_ticket_prefix_chk') THEN
    ALTER TABLE services
      ADD CONSTRAINT services_ticket_prefix_chk CHECK (ticket_prefix IS NULL OR ticket_prefix ~ '^[A-Z]{1,3}$');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS services_facility_ticket_prefix_idx
  ON services (facility_id, ticket_prefix) WHERE ticket_prefix IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Tickets: lifecycle timestamps, channel, transfer linkage
-- ---------------------------------------------------------------------------

-- Original join time — preserved across transfers (REQ-F5.4)
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS called_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS serving_started_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS missed_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS created_channel TEXT NOT NULL DEFAULT 'web';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES staff_users (id) ON DELETE RESTRICT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS transferred_from_ticket_id UUID REFERENCES tickets (id) ON DELETE RESTRICT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS transferred_to_ticket_id UUID REFERENCES tickets (id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_created_channel_chk') THEN
    ALTER TABLE tickets
      ADD CONSTRAINT tickets_created_channel_chk CHECK (created_channel IN ('web', 'staff', 'transfer'));
  END IF;
END $$;

-- No two tickets may share an issue number in one queue session (duplicate-ticket prevention)
CREATE UNIQUE INDEX IF NOT EXISTS tickets_session_issued_sequence_idx
  ON tickets (queue_session_id, issued_sequence);

-- A counter serves at most one ticket at a time (called or serving) — enforced by the database
CREATE UNIQUE INDEX IF NOT EXISTS tickets_one_active_per_counter_idx
  ON tickets (current_counter_id)
  WHERE state IN ('called', 'serving') AND current_counter_id IS NOT NULL;

-- A ticket is transferred at most once
CREATE UNIQUE INDEX IF NOT EXISTS tickets_transferred_from_idx
  ON tickets (transferred_from_ticket_id) WHERE transferred_from_ticket_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tickets_session_completed_idx
  ON tickets (queue_session_id, completed_at) WHERE completed_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Ticket status credentials: look up by hash
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS ticket_recovery_creds_hash_idx
  ON ticket_recovery_credentials (credential_hash);

-- ---------------------------------------------------------------------------
-- 5. Queue sessions: tenant integrity and lookups
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'queue_sessions_facility_org_fk') THEN
    ALTER TABLE queue_sessions
      ADD CONSTRAINT queue_sessions_facility_org_fk
      FOREIGN KEY (facility_id, organization_id) REFERENCES facilities (id, organization_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS queue_sessions_facility_date_idx
  ON queue_sessions (facility_id, operational_date);

-- A queue session's service must belong to the same facility
CREATE OR REPLACE FUNCTION queue_session_service_same_facility()
RETURNS TRIGGER AS $$
DECLARE
  service_facility UUID;
BEGIN
  SELECT facility_id INTO service_facility FROM services WHERE id = NEW.service_id;
  IF service_facility IS DISTINCT FROM NEW.facility_id THEN
    RAISE EXCEPTION 'queue session service must belong to the session facility'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS queue_session_service_same_facility_trg ON queue_sessions;
CREATE TRIGGER queue_session_service_same_facility_trg
  BEFORE INSERT OR UPDATE OF service_id, facility_id ON queue_sessions
  FOR EACH ROW
  EXECUTE FUNCTION queue_session_service_same_facility();

-- ---------------------------------------------------------------------------
-- 6. queue_events: actor deletion must never UPDATE an append-only row.
--    0001 declared ON DELETE SET NULL; staff are deactivated, never deleted, but make it explicit.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fk_name TEXT;
BEGIN
  SELECT conname INTO fk_name
    FROM pg_constraint
   WHERE conrelid = 'queue_events'::regclass AND contype = 'f'
     AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                          WHERE attrelid = 'queue_events'::regclass AND attname = 'actor_id')]
     AND confdeltype = 'n';
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE queue_events DROP CONSTRAINT %I', fk_name);
    ALTER TABLE queue_events
      ADD CONSTRAINT queue_events_actor_fk
      FOREIGN KEY (actor_id) REFERENCES staff_users (id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS queue_events_session_committed_idx
  ON queue_events (queue_session_id, sequence);
