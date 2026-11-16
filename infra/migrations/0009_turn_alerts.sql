-- =============================================================================
-- 0009 — M5.4 Smart Turn Alerts (REQ-F14, design §12, ADR-013)
--
-- Additive. New table `push_subscriptions`; new columns on `notifications`,
-- `notification_outbox`, `notification_deliveries` and `health_evaluations`;
-- the `notifications` channel/status CHECK constraints are widened (dropped and re-added with
-- a superset of values: no existing value becomes invalid). No column or table is dropped.
--
-- Secrets: a push endpoint URL is a capability URL and is stored only as AES-256-GCM
-- ciphertext (`endpoint_ct`), with its keys (`keys_ct`); `endpoint_hash` exists only for
-- idempotent re-subscription. Ciphertext is nulled the moment a subscription is revoked, and
-- the database refuses ciphertext on a revoked row.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Push subscriptions (one per ticket and browser endpoint)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS push_subscriptions (
  -- the non-secret `subscription_id` / `subscription_ref` / `pushRef` (random, grants nothing)
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  facility_id     UUID NOT NULL REFERENCES facilities (id) ON DELETE RESTRICT,
  ticket_id       UUID NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  -- the status token the visitor subscribed with (revoking it stops this subscription)
  credential_id   UUID REFERENCES ticket_recovery_credentials (id) ON DELETE SET NULL,
  endpoint_hash   TEXT NOT NULL,
  endpoint_ct     BYTEA,
  keys_ct         BYTEA,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  revoke_reason   TEXT CHECK (revoke_reason IN (
                    'visitor', 'ticket_ended', 'gone', 'session_closed', 'credentials_revoked',
                    'expired')),
  failure_count   INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  CONSTRAINT push_subscriptions_facility_org_fk
    FOREIGN KEY (facility_id, organization_id) REFERENCES facilities (id, organization_id),
  -- ciphertext exists only while active; a revoked row can never hold it (design §12.13)
  CONSTRAINT push_subscriptions_ciphertext_chk
    CHECK ((revoked_at IS NULL) = (endpoint_ct IS NOT NULL AND keys_ct IS NOT NULL)),
  CONSTRAINT push_subscriptions_revoked_pair_chk
    CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
-- Idempotent re-subscription of the same device to the same ticket
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_ticket_endpoint_idx
  ON push_subscriptions (ticket_id, endpoint_hash);
CREATE INDEX IF NOT EXISTS push_subscriptions_active_idx
  ON push_subscriptions (ticket_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS push_subscriptions_retention_idx
  ON push_subscriptions (revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS push_subscriptions_expiry_idx
  ON push_subscriptions (expires_at) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Notifications: web_push channel, suppressed status, per-device link
-- ---------------------------------------------------------------------------
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_channel_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_channel_check
  CHECK (channel IN ('sms', 'ussd', 'in_app', 'web_push'));
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_status_check
  CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'unknown', 'suppressed'));
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS push_subscription_id UUID
  REFERENCES push_subscriptions (id) ON DELETE SET NULL;
-- the committed call event this notification is about (for the first-party acknowledgement)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS event_sequence INTEGER;
-- the outcome detail of the latest attempt (accepted, gone, ttl_elapsed, retries_exhausted, ...)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS detail_code TEXT;
CREATE INDEX IF NOT EXISTS notifications_subscription_idx
  ON notifications (push_subscription_id, event_sequence) WHERE push_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_retention_idx ON notifications (created_at);

-- ---------------------------------------------------------------------------
-- 3. Outbox: a row is finished once processed (claims skip it; the lease is next_attempt_at)
-- ---------------------------------------------------------------------------
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS notification_outbox_due_idx
  ON notification_outbox (next_attempt_at) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Delivery attempts: what the attempt found (never an endpoint, key or payload)
-- ---------------------------------------------------------------------------
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS detail_code TEXT;
-- push attempts also record "accepted by the push service" (sent) and "no longer relevant"
-- (suppressed); `delivered` stays reserved for a first-party acknowledgement or a receipt
ALTER TABLE notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_receipt_status_check;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_receipt_status_check
  CHECK (receipt_status IN ('delivered', 'failed', 'unknown', 'sent', 'suppressed'));

-- ---------------------------------------------------------------------------
-- 5. Worker configuration fingerprint (non-secret), so the API can warn when the worker
--    evaluates with different thresholds or a different VAPID public key
-- ---------------------------------------------------------------------------
ALTER TABLE health_evaluations ADD COLUMN IF NOT EXISTS worker_config JSONB;
-- ---------------------------------------------------------------------------
-- 6. Per-ticket subscription-change throttle, shared by every API instance (one atomic upsert
--    per change; a self-expiring one-minute window; no secret, no endpoint, no address)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS push_subscription_throttle (
  ticket_id         UUID PRIMARY KEY REFERENCES tickets (id) ON DELETE CASCADE,
  window_started_at TIMESTAMPTZ NOT NULL,
  changes           INTEGER NOT NULL DEFAULT 0 CHECK (changes >= 0)
);
CREATE INDEX IF NOT EXISTS push_subscription_throttle_window_idx
  ON push_subscription_throttle (window_started_at);
