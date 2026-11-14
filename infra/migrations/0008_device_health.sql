-- =============================================================================
-- 0008 — M5.3 Device health and automatic in-product alerts (REQ-F9.6–F9.14, design §17)
--
-- Additive only: one new column, two new tables, indexes. Nothing is dropped or renamed.
--
-- Privacy (REQ-F9.10): no column added here (or anywhere) holds an IP address, user agent,
-- hardware fingerprint, location or visitor data. Alert details are counts only.
-- Health OBSERVES: the evaluator writes only `health_alerts` and `health_evaluations`; it never
-- writes queue sessions, coordinator fields, tickets, events or devices (ADR-006 unchanged).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Consecutive identical failure reports (for `sync_failing`). Written by the device's own
--    heartbeat (and reset by a successful sync), never by the health evaluator.
-- ---------------------------------------------------------------------------
ALTER TABLE devices ADD COLUMN IF NOT EXISTS failure_streak INTEGER NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devices_failure_streak_nonneg_chk') THEN
    ALTER TABLE devices ADD CONSTRAINT devices_failure_streak_nonneg_chk CHECK (failure_streak >= 0);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Health alerts: at most ONE open alert per (facility, kind, subject)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS health_alerts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  facility_id      UUID NOT NULL REFERENCES facilities (id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN (
                     'coordinator_offline', 'coordinator_expiring', 'coordinator_expired',
                     'device_stale_pending', 'sync_failing', 'conflicts_unreviewed',
                     'recovery_abuse', 'alert_pipeline_failing')),
  severity         TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  subject_type     TEXT NOT NULL CHECK (subject_type IN ('device', 'queue', 'facility')),
  -- device id, queue session id or facility id (no foreign key: a subject may be purged while
  -- its resolved alert is retained for 30 days)
  subject_id       UUID NOT NULL,
  -- counts only, for example {"pending": 3}
  details          JSONB NOT NULL DEFAULT '{}',
  opened_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- consecutive evaluations in which the condition was absent (damping: resolve at 2)
  clear_count      INTEGER NOT NULL DEFAULT 0 CHECK (clear_count >= 0),
  acknowledged_by  UUID REFERENCES staff_users (id) ON DELETE SET NULL,
  acknowledged_at  TIMESTAMPTZ,
  resolved_at      TIMESTAMPTZ,
  resolved_reason  TEXT CHECK (resolved_reason IN ('condition_cleared', 'subject_gone')),
  CONSTRAINT health_alerts_facility_org_fk
    FOREIGN KEY (facility_id, organization_id) REFERENCES facilities (id, organization_id),
  CONSTRAINT health_alerts_resolution_pair_chk
    CHECK ((resolved_at IS NULL) = (resolved_reason IS NULL)),
  CONSTRAINT health_alerts_ack_pair_chk
    CHECK (acknowledged_at IS NOT NULL OR acknowledged_by IS NULL)
);

-- The deduplication rule, enforced by the database even under concurrent evaluators
CREATE UNIQUE INDEX IF NOT EXISTS health_alerts_one_open_idx
  ON health_alerts (facility_id, kind, subject_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS health_alerts_facility_idx
  ON health_alerts (organization_id, facility_id, resolved_at);
CREATE INDEX IF NOT EXISTS health_alerts_retention_idx
  ON health_alerts (resolved_at) WHERE resolved_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Last completed evaluation (single row): the dashboard says "Automatic alerts are paused"
--    when it is older than 3 intervals. States are still computed on read either way.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS health_evaluations (
  id                BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  last_evaluated_at TIMESTAMPTZ NOT NULL
);

-- ---------------------------------------------------------------------------
-- 4. Indexes for the evaluator's read-only scans (keep each pass independent of table size)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS queue_sessions_coordinator_idx
  ON queue_sessions (coordinator_device_id) WHERE coordinator_device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS client_operations_needs_review_idx
  ON client_operations (created_at) WHERE status = 'needs_review';
CREATE INDEX IF NOT EXISTS admin_events_recovery_abuse_idx
  ON admin_events (created_at) WHERE event_type = 'ticket_recovery.abuse_detected';
CREATE INDEX IF NOT EXISTS notifications_failed_idx
  ON notifications (updated_at) WHERE status = 'failed';
