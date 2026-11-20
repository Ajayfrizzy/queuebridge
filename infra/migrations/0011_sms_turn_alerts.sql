-- =============================================================================
-- 0011 — M6.1 SMS turn alerts (REQ-F11.8–F11.13, design §13, ADR-009, ADR-013)
--
-- Additive only: new columns on `visitor_contacts` and `notifications`, three new tables. Nothing
-- is dropped or renamed; no existing CHECK is narrowed.
--
-- Privacy (design §13.2): a phone number exists only as AES-256-GCM ciphertext in
-- `visitor_contacts.phone_ciphertext` (key derived from CONTACT_ENCRYPTION_KEY for this purpose),
-- plus a keyed lookup hash used only to apply an inbound STOP reply. Both are erased on opt-out or
-- when the ticket ends, and the row is deleted at `retention_until`. The database refuses a stored
-- number without recorded consent, and refuses a number on an opted-out or erased contact.
-- No phone number, hash or message text is ever written to `queue_events`, `notifications`,
-- `notification_outbox`, `notification_deliveries` or `admin_events`.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Visitor contacts: one optional, consented contact per ticket (follows service transfers)
-- ---------------------------------------------------------------------------
ALTER TABLE visitor_contacts ADD COLUMN IF NOT EXISTS facility_id UUID REFERENCES facilities (id) ON DELETE RESTRICT;
ALTER TABLE visitor_contacts ADD COLUMN IF NOT EXISTS ticket_id UUID REFERENCES tickets (id) ON DELETE CASCADE;
-- keyed HMAC of the normalized number (inbound opt-out lookup only; never a plain hash)
ALTER TABLE visitor_contacts ADD COLUMN IF NOT EXISTS phone_hash TEXT;
-- the consent text the visitor ticked (versioned, like the AI consent)
ALTER TABLE visitor_contacts ADD COLUMN IF NOT EXISTS consent_version TEXT;
ALTER TABLE visitor_contacts ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMPTZ;
ALTER TABLE visitor_contacts ADD COLUMN IF NOT EXISTS opt_out_source TEXT;
-- set when the number was erased because the ticket ended (the row stays until retention_until)
ALTER TABLE visitor_contacts ADD COLUMN IF NOT EXISTS erased_at TIMESTAMPTZ;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visitor_contacts_opt_out_source_chk') THEN
    ALTER TABLE visitor_contacts ADD CONSTRAINT visitor_contacts_opt_out_source_chk
      CHECK (opt_out_source IS NULL OR opt_out_source IN ('visitor', 'staff', 'keyword'));
  END IF;
  -- tenant consistency (same rule as 0003–0010)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visitor_contacts_facility_org_fk') THEN
    ALTER TABLE visitor_contacts ADD CONSTRAINT visitor_contacts_facility_org_fk
      FOREIGN KEY (facility_id, organization_id) REFERENCES facilities (id, organization_id);
  END IF;
  -- a stored number always has consent, a ticket, a facility and a retention date
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visitor_contacts_consent_chk') THEN
    ALTER TABLE visitor_contacts ADD CONSTRAINT visitor_contacts_consent_chk CHECK (
      phone_ciphertext IS NULL OR (
        consent_at IS NOT NULL AND consent_version IS NOT NULL AND retention_until IS NOT NULL
        AND ticket_id IS NOT NULL AND facility_id IS NOT NULL AND phone_hash IS NOT NULL));
  END IF;
  -- an opted-out or erased contact can never hold the number or its lookup hash
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visitor_contacts_erased_chk') THEN
    ALTER TABLE visitor_contacts ADD CONSTRAINT visitor_contacts_erased_chk CHECK (
      (opted_out_at IS NULL AND erased_at IS NULL) OR (phone_ciphertext IS NULL AND phone_hash IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visitor_contacts_opt_out_pair_chk') THEN
    ALTER TABLE visitor_contacts ADD CONSTRAINT visitor_contacts_opt_out_pair_chk
      CHECK ((opted_out_at IS NULL) = (opt_out_source IS NULL));
  END IF;
END $$;
-- at most one contact per ticket (the SMS idempotency key names the ticket, not the recipient)
CREATE UNIQUE INDEX IF NOT EXISTS visitor_contacts_ticket_idx
  ON visitor_contacts (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS visitor_contacts_phone_hash_idx
  ON visitor_contacts (phone_hash) WHERE phone_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS visitor_contacts_retention_idx
  ON visitor_contacts (retention_until) WHERE retention_until IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Notifications: SMS recipient link, provider correlation, at-most-once send marker
-- ---------------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS visitor_contact_id UUID
  REFERENCES visitor_contacts (id) ON DELETE SET NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
-- set (committed) BEFORE an SMS is handed to the provider: a worker that finds it set on a
-- reclaimed row records `unknown` and never sends again (REQ-F11.5, at most once per key)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS send_started_at TIMESTAMPTZ;
-- receipts are correlated by provider message id, per provider (never across providers)
CREATE UNIQUE INDEX IF NOT EXISTS notifications_provider_message_idx
  ON notifications (provider, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_contact_idx
  ON notifications (visitor_contact_id) WHERE visitor_contact_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Facility SMS setting (off by default; enabling needs a per-facility daily cap)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS facility_sms_settings (
  facility_id     UUID PRIMARY KEY REFERENCES facilities (id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  daily_cap       INTEGER NOT NULL DEFAULT 0 CHECK (daily_cap >= 0 AND daily_cap <= 100000),
  updated_by      UUID NOT NULL REFERENCES staff_users (id) ON DELETE RESTRICT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT facility_sms_settings_facility_org_fk
    FOREIGN KEY (facility_id, organization_id) REFERENCES facilities (id, organization_id),
  -- "on" is never unlimited
  CONSTRAINT facility_sms_settings_cap_chk CHECK (NOT enabled OR daily_cap > 0)
);
CREATE INDEX IF NOT EXISTS facility_sms_settings_org_idx ON facility_sms_settings (organization_id);

-- ---------------------------------------------------------------------------
-- 4. Daily send counters (hard caps, shared by every worker; sandbox counted apart from live)
--    scope = 'global' or a facility id. UTC days. Counts every attempt handed to a provider.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_daily_usage (
  usage_date DATE NOT NULL,
  mode       TEXT NOT NULL CHECK (mode IN ('sandbox', 'live')),
  scope      TEXT NOT NULL,
  sends      INTEGER NOT NULL DEFAULT 0 CHECK (sends >= 0),
  PRIMARY KEY (usage_date, mode, scope)
);

-- ---------------------------------------------------------------------------
-- 5. Webhook replay defense: each signed request nonce is accepted once per provider
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_webhook_nonces (
  provider    TEXT NOT NULL,
  nonce       TEXT NOT NULL CHECK (char_length(nonce) BETWEEN 16 AND 128),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, nonce)
);
CREATE INDEX IF NOT EXISTS sms_webhook_nonces_received_idx ON sms_webhook_nonces (received_at);
