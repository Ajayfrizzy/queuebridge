-- =============================================================================
-- 0007 — M5.1 Secure ticket recovery (REQ-F4.7–F4.15, design §15, ADR-015)
--
-- Additive. Only one index is dropped (the unique ticket_id index on
-- ticket_recovery_credentials, superseded so a ticket may hold up to 3 active
-- status tokens). No column or table is dropped.
--
-- Secrets are never stored: status tokens as SHA-256, recovery keys and staff
-- grants as HMAC-SHA-256 with a server-side pepper. Throttle keys are HMACs of
-- PUBLIC identifiers and the request source only — never of a submitted guess.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Status tokens: several active per ticket, revocable, attributable
-- ---------------------------------------------------------------------------
ALTER TABLE ticket_recovery_credentials ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'join';
ALTER TABLE ticket_recovery_credentials ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE ticket_recovery_credentials ADD COLUMN IF NOT EXISTS revoked_reason TEXT;
ALTER TABLE ticket_recovery_credentials ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_recovery_credentials_source_chk') THEN
    ALTER TABLE ticket_recovery_credentials
      ADD CONSTRAINT ticket_recovery_credentials_source_chk
      CHECK (source IN ('join', 'recovery', 'staff'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_recovery_credentials_revoked_chk') THEN
    ALTER TABLE ticket_recovery_credentials
      ADD CONSTRAINT ticket_recovery_credentials_revoked_chk
      CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL));
  END IF;
END $$;

-- The M2 unique (ticket_id) index allowed one token per ticket; M5.1 allows up to 3 active
DROP INDEX IF EXISTS ticket_recovery_creds_ticket_idx;
CREATE INDEX IF NOT EXISTS ticket_recovery_creds_active_idx
  ON ticket_recovery_credentials (ticket_id, created_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS ticket_recovery_creds_expiry_idx
  ON ticket_recovery_credentials (expires_at);

-- ---------------------------------------------------------------------------
-- 2. Recovery keys (one per ROOT ticket; follows transfers via the chain)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_recovery_proofs (
  ticket_id       UUID PRIMARY KEY REFERENCES tickets (id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  facility_id     UUID NOT NULL REFERENCES facilities (id) ON DELETE RESTRICT,
  -- HMAC-SHA-256(pepper, ticket_id ':' key). NULL = no valid key (revoked or purged)
  key_hmac        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at      TIMESTAMPTZ
  -- Deliberately no failure counters and no lock state: nothing here can lock a visitor out
);

CREATE INDEX IF NOT EXISTS ticket_recovery_proofs_org_idx
  ON ticket_recovery_proofs (organization_id, facility_id);

-- ---------------------------------------------------------------------------
-- 3. Staff-assisted recovery grants (single use, 10 minutes)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_recovery_grants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       UUID NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  facility_id     UUID NOT NULL REFERENCES facilities (id) ON DELETE RESTRICT,
  -- HMAC-SHA-256(pepper, grant). The grant itself is never stored
  grant_hmac      TEXT NOT NULL,
  assurance       TEXT NOT NULL CHECK (assurance IN ('basic', 'strong')),
  reason_code     TEXT NOT NULL
                    CHECK (reason_code IN ('lost_device', 'cleared_browser', 'no_smartphone', 'other')),
  created_by      UUID NOT NULL REFERENCES staff_users (id) ON DELETE RESTRICT,
  approved_by     UUID REFERENCES staff_users (id) ON DELETE RESTRICT,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  redeemed_at     TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  -- Second-person rule, enforced by the database as well as the API:
  CONSTRAINT ticket_recovery_grants_second_person_chk
    CHECK (approved_by IS NULL OR approved_by <> created_by),
  CONSTRAINT ticket_recovery_grants_approval_pair_chk
    CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  -- A low-assurance grant can never be redeemed without that approval
  CONSTRAINT ticket_recovery_grants_redeem_requires_approval_chk
    CHECK (redeemed_at IS NULL OR assurance <> 'basic' OR approved_by IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ticket_recovery_grants_hmac_idx
  ON ticket_recovery_grants (grant_hmac);
CREATE INDEX IF NOT EXISTS ticket_recovery_grants_ticket_idx
  ON ticket_recovery_grants (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS ticket_recovery_grants_creator_idx
  ON ticket_recovery_grants (created_by, created_at);
CREATE INDEX IF NOT EXISTS ticket_recovery_grants_pending_idx
  ON ticket_recovery_grants (facility_id, created_at)
  WHERE approved_at IS NULL AND redeemed_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Recovery throttle (self-expiring windows; no PII, no secret, no guess)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recovery_throttle (
  scope             TEXT NOT NULL
                      CHECK (scope IN ('source', 'target_source', 'target', 'facility', 'facility_source')),
  key_hash          TEXT NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  failures          INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  PRIMARY KEY (scope, key_hash)
);

CREATE INDEX IF NOT EXISTS recovery_throttle_window_idx ON recovery_throttle (window_started_at);

-- The automatic no-show sweep looks only at called tickets (keep it independent of table size)
CREATE INDEX IF NOT EXISTS tickets_called_idx ON tickets (queue_session_id) WHERE state = 'called';

-- ---------------------------------------------------------------------------
-- 5. Automatic no-show sweep heartbeat (single row; outage detection)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_miss_sweeps (
  id            BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  last_pass_at  TIMESTAMPTZ NOT NULL,
  outage_end_at TIMESTAMPTZ
);
