-- =============================================================================
-- 0010 — MQ.4 Ask Que optional AI explanation layer (REQ-F13.4, design §11.7, ADR-011)
--
-- Additive only: two new tables. Nothing is dropped, renamed or altered.
--
-- * facility_que_ai_settings: a facility administrator's explicit, audited opt-in. Off unless
--   a row says otherwise, and the database refuses "on" without a recorded consent. Opting in
--   never makes AI work by itself: the deployment must also have an enabled, zero-cost adapter.
-- * que_ai_daily_usage: one aggregate counter per UTC day for the hard daily request cap,
--   shared by every API instance (REQ-F13.4.6). No question text, user, facility or ticket.
-- =============================================================================

CREATE TABLE IF NOT EXISTS facility_que_ai_settings (
  facility_id     UUID PRIMARY KEY REFERENCES facilities (id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  -- The disclosure version the administrator acknowledged when turning it on
  consent_version TEXT,
  consented_by    UUID REFERENCES staff_users (id) ON DELETE RESTRICT,
  consented_at    TIMESTAMPTZ,
  updated_by      UUID NOT NULL REFERENCES staff_users (id) ON DELETE RESTRICT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facility_que_ai_consent_chk') THEN
    ALTER TABLE facility_que_ai_settings ADD CONSTRAINT facility_que_ai_consent_chk CHECK (
      NOT enabled
      OR (consent_version IS NOT NULL AND consented_by IS NOT NULL AND consented_at IS NOT NULL)
    );
  END IF;
  -- Tenant consistency: the organization must be the facility's own (same rule as 0003-0009)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'facility_que_ai_settings_facility_org_fk'
  ) THEN
    ALTER TABLE facility_que_ai_settings ADD CONSTRAINT facility_que_ai_settings_facility_org_fk
      FOREIGN KEY (facility_id, organization_id) REFERENCES facilities (id, organization_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS facility_que_ai_settings_org_idx
  ON facility_que_ai_settings (organization_id);

CREATE TABLE IF NOT EXISTS que_ai_daily_usage (
  usage_date DATE PRIMARY KEY,
  requests   INTEGER NOT NULL DEFAULT 0
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'que_ai_daily_usage_nonneg_chk') THEN
    ALTER TABLE que_ai_daily_usage ADD CONSTRAINT que_ai_daily_usage_nonneg_chk CHECK (requests >= 0);
  END IF;
END $$;
