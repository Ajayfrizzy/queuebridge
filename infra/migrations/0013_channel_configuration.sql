-- 0013_channel_configuration.sql — M6.3 channel configuration and monitoring (REQ-F11.10, F11.11,
-- F12; design §13.4). Additive only: one new column on each of two tables, one new table, one
-- index. Nothing is dropped, renamed or rewritten.

-- ---------------------------------------------------------------------------
-- 1. Optional delayed SMS ("only if the in-app alert was not seen within N seconds")
-- ---------------------------------------------------------------------------
-- NULL = send immediately (the default and the M6.1 behaviour). The upper bound actually allowed
-- is computed by the API from the turn-alert TTL and the facility's automatic no-show policies;
-- this CHECK only keeps the column sane.
ALTER TABLE facility_sms_settings ADD COLUMN IF NOT EXISTS delay_seconds INTEGER;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facility_sms_settings_delay_chk') THEN
    ALTER TABLE facility_sms_settings ADD CONSTRAINT facility_sms_settings_delay_chk
      CHECK (delay_seconds IS NULL OR delay_seconds BETWEEN 10 AND 3600);
  END IF;
END $$;

-- The visitor's page presented the in-app "it is your turn" alert for this committed call event
-- (authenticated by the ticket's status token). Used only to skip a DELAYED SMS; it is not proof
-- that the visitor read it, and its absence is not proof they did not. No device, address or
-- personal data. Removed by the worker after 24 hours.
CREATE TABLE IF NOT EXISTS turn_alert_seen (
  ticket_id       UUID NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  event_sequence  INTEGER NOT NULL CHECK (event_sequence > 0),
  seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ticket_id, event_sequence)
);
CREATE INDEX IF NOT EXISTS turn_alert_seen_retention_idx ON turn_alert_seen (seen_at);

-- ---------------------------------------------------------------------------
-- 2. Monitoring
-- ---------------------------------------------------------------------------
-- Facility SMS history, newest first, bounded pages (organization → channel → time)
CREATE INDEX IF NOT EXISTS notifications_org_channel_created_idx
  ON notifications (organization_id, channel, created_at DESC, id DESC);
-- Why a USSD session ended, so an expiry is never counted as a completed menu (no input, no
-- number, no screen): 'menu' (the menu sent END), 'timeout' (a late input after expiry),
-- 'out_of_step' (a callback out of order). NULL while open, or expired without a late input.
ALTER TABLE ussd_sessions ADD COLUMN IF NOT EXISTS end_reason TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ussd_sessions_end_reason_chk') THEN
    ALTER TABLE ussd_sessions ADD CONSTRAINT ussd_sessions_end_reason_chk
      CHECK (end_reason IS NULL OR end_reason IN ('menu', 'timeout', 'out_of_step'));
  END IF;
END $$;
