-- QueueBridge — Initial Schema
-- Migration: 0001_initial_schema
-- Idempotent: uses CREATE TABLE IF NOT EXISTS throughout
-- Do NOT add UPDATE or DELETE on queue_events — enforced by trigger in 0002

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_idx ON organizations (slug);

CREATE TABLE IF NOT EXISTS facilities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive', 'suspended')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS facilities_org_idx ON facilities (organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS facilities_org_slug_idx ON facilities (organization_id, slug);

-- ---------------------------------------------------------------------------
-- Staff and roles
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS staff_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  email           TEXT NOT NULL,
  -- Password hash (bcrypt cost >= 12 or argon2id) — never plaintext
  password_hash   TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive', 'suspended')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_users_org_email_idx ON staff_users (organization_id, email);
CREATE INDEX IF NOT EXISTS staff_users_org_idx ON staff_users (organization_id);

CREATE TABLE IF NOT EXISTS role_assignments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id UUID NOT NULL REFERENCES staff_users (id) ON DELETE CASCADE,
  facility_id   UUID NOT NULL REFERENCES facilities (id) ON DELETE CASCADE,
  role          TEXT NOT NULL
                  CHECK (role IN (
                    'staff_reception', 'staff_counter', 'supervisor',
                    'facility_admin', 'org_admin', 'auditor'
                  )),
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by   UUID REFERENCES staff_users (id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS role_assignments_user_facility_role_idx
  ON role_assignments (staff_user_id, facility_id, role);
CREATE INDEX IF NOT EXISTS role_assignments_facility_idx ON role_assignments (facility_id);

-- ---------------------------------------------------------------------------
-- Sessions (staff authentication)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS staff_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id   UUID NOT NULL REFERENCES staff_users (id) ON DELETE CASCADE,
  -- Token stored as SHA-256 hash; original never persisted
  token_hash      TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_sessions_token_hash_idx ON staff_sessions (token_hash);
CREATE INDEX IF NOT EXISTS staff_sessions_user_idx ON staff_sessions (staff_user_id);
CREATE INDEX IF NOT EXISTS staff_sessions_expires_idx ON staff_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Services and counters
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS services (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id     UUID NOT NULL REFERENCES facilities (id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive')),
  -- JSON: { "version": "...", "priority_order": [...], "grace_window_seconds": ... }
  policy          JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS services_facility_idx ON services (facility_id);
CREATE INDEX IF NOT EXISTS services_org_idx ON services (organization_id);

CREATE TABLE IF NOT EXISTS counters (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id     UUID NOT NULL REFERENCES facilities (id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS counters_facility_idx ON counters (facility_id);

CREATE TABLE IF NOT EXISTS counter_service_capabilities (
  counter_id  UUID NOT NULL REFERENCES counters (id) ON DELETE CASCADE,
  service_id  UUID NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (counter_id, service_id)
);

-- ---------------------------------------------------------------------------
-- Devices
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS devices (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id           UUID NOT NULL REFERENCES facilities (id) ON DELETE CASCADE,
  organization_id       UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  staff_user_id         UUID NOT NULL REFERENCES staff_users (id) ON DELETE CASCADE,
  -- Public key or session reference for device authentication
  public_key_or_session TEXT NOT NULL,
  label                 TEXT,
  revoked_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS devices_facility_idx ON devices (facility_id);
CREATE INDEX IF NOT EXISTS devices_staff_user_idx ON devices (staff_user_id);

-- ---------------------------------------------------------------------------
-- Queue sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS queue_sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id           UUID NOT NULL REFERENCES facilities (id) ON DELETE RESTRICT,
  organization_id       UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  service_id            UUID NOT NULL REFERENCES services (id) ON DELETE RESTRICT,
  operational_date      DATE NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'open'
                          CHECK (state IN ('open', 'paused', 'closed')),
  -- Incremented on every committed command — used for concurrency control
  revision              INTEGER NOT NULL DEFAULT 0,
  -- Monotonically increasing sequence assigned to each committed queue_event
  last_sequence         INTEGER NOT NULL DEFAULT 0,
  -- Coordinator epoch — incremented on every coordinator assignment/revocation
  coordinator_epoch     INTEGER NOT NULL DEFAULT 0,
  coordinator_device_id UUID REFERENCES devices (id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS queue_sessions_facility_service_date_idx
  ON queue_sessions (facility_id, service_id, operational_date);
CREATE INDEX IF NOT EXISTS queue_sessions_facility_idx ON queue_sessions (facility_id);
CREATE INDEX IF NOT EXISTS queue_sessions_org_idx ON queue_sessions (organization_id);

-- ---------------------------------------------------------------------------
-- Tickets
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tickets (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_session_id        UUID NOT NULL REFERENCES queue_sessions (id) ON DELETE RESTRICT,
  organization_id         UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  public_code             TEXT NOT NULL,
  -- Set when ticket was created offline; cleared after server confirms
  provisional_source_op_id UUID,
  state                   TEXT NOT NULL DEFAULT 'waiting'
                            CHECK (state IN (
                              'waiting', 'called', 'serving', 'paused',
                              'missed', 'completed', 'cancelled', 'transferred', 'needs_review'
                            )),
  priority_class          TEXT NOT NULL DEFAULT 'normal'
                            CHECK (priority_class IN ('normal', 'priority', 'urgent')),
  -- Position in the original issue order — preserved through transfers
  issued_sequence         INTEGER NOT NULL,
  current_counter_id      UUID REFERENCES counters (id) ON DELETE SET NULL,
  -- Optimistic locking version
  version                 INTEGER NOT NULL DEFAULT 0,
  -- ID of contact record if visitor provided phone
  contact_id              UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Authoritative uniqueness: no two confirmed tickets may share a code in one session
CREATE UNIQUE INDEX IF NOT EXISTS tickets_session_code_idx
  ON tickets (queue_session_id, public_code)
  WHERE provisional_source_op_id IS NULL;

CREATE INDEX IF NOT EXISTS tickets_queue_session_idx ON tickets (queue_session_id);
CREATE INDEX IF NOT EXISTS tickets_state_idx ON tickets (queue_session_id, state);
CREATE INDEX IF NOT EXISTS tickets_org_idx ON tickets (organization_id);

-- ---------------------------------------------------------------------------
-- Ticket transitions (history, linked to queue events)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ticket_transitions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       UUID NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  from_state      TEXT NOT NULL,
  to_state        TEXT NOT NULL,
  queue_event_id  UUID,
  transitioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ticket_transitions_ticket_idx ON ticket_transitions (ticket_id);

-- ---------------------------------------------------------------------------
-- Queue events (APPEND-ONLY — trigger added in 0002)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS queue_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  queue_session_id UUID NOT NULL REFERENCES queue_sessions (id) ON DELETE RESTRICT,
  -- Monotonically increasing, unique per queue session — authoritative sequence
  sequence         INTEGER NOT NULL,
  actor_id         UUID REFERENCES staff_users (id) ON DELETE SET NULL,
  operation_id     UUID,
  event_type       TEXT NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}',
  -- SHA-256 hash of previous event (genesis uses SHA-256 of domain separator)
  prev_hash        CHAR(64) NOT NULL,
  -- SHA-256(domain_separator || queue_session_id || sequence || prev_hash || canonical_json)
  event_hash       CHAR(64) NOT NULL,
  committed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Authoritative sequence invariant — core architectural constraint
CREATE UNIQUE INDEX IF NOT EXISTS queue_events_session_seq_idx
  ON queue_events (queue_session_id, sequence);

-- Deduplication index
CREATE INDEX IF NOT EXISTS queue_events_operation_id_idx ON queue_events (operation_id)
  WHERE operation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS queue_events_org_idx ON queue_events (organization_id);

-- ---------------------------------------------------------------------------
-- Audit checkpoints
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_checkpoints (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_session_id UUID NOT NULL REFERENCES queue_sessions (id) ON DELETE RESTRICT,
  from_sequence    INTEGER NOT NULL,
  to_sequence      INTEGER NOT NULL,
  -- SHA-256 of all event hashes in range concatenated
  root_hash        CHAR(64) NOT NULL,
  -- Identifies the signing key (key itself never stored here)
  key_id           TEXT NOT NULL,
  signature        TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_checkpoints_session_idx ON audit_checkpoints (queue_session_id);

-- ---------------------------------------------------------------------------
-- Client operations (sync deduplication)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS client_operations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  queue_session_id UUID NOT NULL REFERENCES queue_sessions (id) ON DELETE RESTRICT,
  device_id        UUID NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  actor_id         UUID REFERENCES staff_users (id) ON DELETE SET NULL,
  -- Deduplication key: (organization_id, operation_id) must be globally unique
  operation_id     UUID NOT NULL,
  client_sequence  INTEGER NOT NULL,
  action           TEXT NOT NULL,
  -- committed | duplicate | rejected | needs_review
  status           TEXT NOT NULL
                     CHECK (status IN ('committed', 'duplicate', 'rejected', 'needs_review', 'pending')),
  -- Full server response stored for exact replay
  result_json      JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Deduplication invariant — core architectural constraint
CREATE UNIQUE INDEX IF NOT EXISTS client_operations_org_op_idx
  ON client_operations (organization_id, operation_id);

CREATE INDEX IF NOT EXISTS client_operations_queue_session_idx ON client_operations (queue_session_id);
CREATE INDEX IF NOT EXISTS client_operations_device_idx ON client_operations (device_id);

-- ---------------------------------------------------------------------------
-- Device sync cursors
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS device_sync_cursors (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id            UUID NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  queue_session_id     UUID NOT NULL REFERENCES queue_sessions (id) ON DELETE CASCADE,
  last_server_sequence INTEGER NOT NULL DEFAULT 0,
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS device_sync_cursors_device_session_idx
  ON device_sync_cursors (device_id, queue_session_id);

-- ---------------------------------------------------------------------------
-- Priority overrides (supervisor-only)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS priority_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       UUID NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  actor_id        UUID NOT NULL REFERENCES staff_users (id) ON DELETE RESTRICT,
  reason_code     TEXT NOT NULL,
  reason_text     TEXT NOT NULL,
  policy_version  TEXT NOT NULL,
  queue_event_id  UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS priority_overrides_ticket_idx ON priority_overrides (ticket_id);

-- ---------------------------------------------------------------------------
-- Visitor contacts (PII-isolated)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS visitor_contacts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  -- AES-256-GCM encrypted phone number — key injected via CONTACT_ENCRYPTION_KEY env var
  -- NEVER store plaintext phone numbers here or in any other table
  phone_ciphertext TEXT,
  consent_at       TIMESTAMPTZ,
  -- Must be set when a phone is stored; enforced at application layer
  retention_until  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS visitor_contacts_org_idx ON visitor_contacts (organization_id);

-- ---------------------------------------------------------------------------
-- Ticket recovery credentials
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ticket_recovery_credentials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       UUID NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  -- SHA-256 hash of the recovery secret — original never stored
  credential_hash TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  -- Failed attempt counter for rate limiting (max 5 per 15 minutes)
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ticket_recovery_creds_ticket_idx
  ON ticket_recovery_credentials (ticket_id);

-- ---------------------------------------------------------------------------
-- Notifications and outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  ticket_id       UUID REFERENCES tickets (id) ON DELETE SET NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('sms', 'ussd', 'in_app')),
  template_key    TEXT NOT NULL,
  -- pending | sent | delivered | failed | unknown
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'unknown')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_ticket_idx ON notifications (ticket_id);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  -- Idempotency key — same key must not trigger a second send
  dedup_key       TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}',
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  -- Worker polls: WHERE next_attempt_at <= NOW() AND attempt_count < max_attempts
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_dedup_idx ON notification_outbox (dedup_key);
CREATE INDEX IF NOT EXISTS notification_outbox_next_attempt_idx ON notification_outbox (next_attempt_at);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id     UUID NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,
  provider_message_id TEXT,
  -- delivered | failed | unknown
  receipt_status      TEXT NOT NULL CHECK (receipt_status IN ('delivered', 'failed', 'unknown')),
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notification_deliveries_notification_idx
  ON notification_deliveries (notification_id);

-- ---------------------------------------------------------------------------
-- USSD sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ussd_sessions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 hash of provider session key — never store raw
  provider_session_key_hash TEXT NOT NULL,
  facility_id              UUID NOT NULL REFERENCES facilities (id) ON DELETE CASCADE,
  -- JSON: current menu state, intent, ticket_ref, etc.
  state                    JSONB NOT NULL DEFAULT '{}',
  expires_at               TIMESTAMPTZ NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ussd_sessions_key_hash_idx
  ON ussd_sessions (provider_session_key_hash);
CREATE INDEX IF NOT EXISTS ussd_sessions_expires_idx ON ussd_sessions (expires_at);
