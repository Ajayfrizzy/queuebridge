---
inclusion: always
---

# QueueBridge — Security Steering

> Always-on security constraints. Every implementation must satisfy these before code is considered correct.

## Threat model summary

QueueBridge handles multi-tenant operational data for real facilities and visitors. Threats include:

- Cross-tenant data leakage (one facility seeing another's queue data)
- Unauthorized queue manipulation (skipping, calling without permission)
- Visitor PII exposure (phone numbers on public screens, in logs, or events)
- Ticket code theft (recovering another visitor's ticket)
- Stale offline coordinator forging committed events
- Webhook replay attacks from SMS/USSD providers
- Browser storage exposure on shared/lost devices
- Audit log tampering

## Authentication and sessions

- Staff/admin authentication: password hashed with **bcrypt (cost ≥ 12)** or **argon2id**.
- Session tokens: cryptographically random (≥ 128 bits), stored as **HttpOnly, Secure, SameSite=Strict** cookies.
- Device registration: devices carry a signed authorization token scoped to `{ device_id, facility_id, epoch, allowed_commands }`.
- Token expiry: coordinator tokens are short-lived and must be renewed through an authenticated supervisor action.
- Never accept `actor_id`, `organization_id`, or `facility_id` from client payloads as authoritative — derive from authenticated session server-side.

## Authorization (RBAC)

Roles: `visitor_anonymous`, `staff_reception`, `staff_counter`, `supervisor`, `facility_admin`, `org_admin`, `auditor`.

Rules:

- Every protected endpoint validates the session token **before** touching any data.
- Every role check is performed **server-side** — client role claims are advisory only.
- Tenant scope check: every query touching facility/queue/ticket data must WHERE-filter by `organization_id` AND `facility_id` from the authenticated session, not from the request body.
- Cross-tenant access (org A accessing org B's data) is a critical security violation.
- `auditor` role is read-only on all audit endpoints — no write access.
- `visitor_anonymous` role has access only to: join queue (F2), view own ticket status (F4), recover own ticket (F4). No staff actions.

## Input validation

- All API inputs validated with **Zod schemas** at the route handler boundary, before business logic.
- Parameterized queries only — **zero string-concatenated SQL**.
- Reject requests with unexpected extra fields (use Zod `.strict()` where appropriate on admin inputs).
- File uploads (if any): validate MIME type and size before processing.
- All incoming webhook payloads: validate structure before signature verification.

## Ticket recovery security

- Recovery credential: generated as a **high-entropy random secret** (≥ 128 bits via `crypto.randomBytes`).
- Stored as **SHA-256 hash** in `ticket_recovery_credentials.credential_hash` — original is never persisted or logged.
- Recovery flow: rate-limited to **max 5 attempts per 15 minutes per ticket public code**.
- Expired or exhausted credentials return a safe error — no information about whether the code exists.
- Recovery does not expose: phone numbers, names, internal IDs, or other visitors' data.

## Offline and coordinator security

- Coordinator epoch is checked server-side on every sync batch — stale epoch rejected, not silently accepted.
- `(organization_id, operation_id)` deduplication prevents replay even after network timeouts.
- Offline IndexedDB must **not** store raw phone numbers or other sensitive contact data.
- Provide controlled local-data clearing and device revocation via supervisor UI.
- A revoked device's subsequent sync attempts must be rejected with a clear error.

## Webhook security

- Verify provider-supplied HMAC signature on every inbound SMS/USSD webhook before processing payload.
- Reject requests without valid signatures — log the rejection with provider and IP (no payload content in logs).
- Replay defense: reject webhooks with a `timestamp` older than 5 minutes AND/OR a previously seen `nonce`/`message_id`.
- Idempotency: processing the same delivery receipt twice must not double-update notification status.
- Enforce rate limits on webhook ingress endpoints.

## Public display endpoints

- Queue board projection returns: **ticket codes only**. No names, phone numbers, contact details, or internal UUIDs.
- Visitor status endpoint (`GET /tickets/:publicCode/status`) requires the recovery credential token — not open to anonymous access.
- SSE streams for public boards: scoped to non-PII queue state events only.

## PII minimization

- Phone numbers: stored as `phone_ciphertext` in `visitor_contacts` only. Encryption key injected via environment variable.
- `queue_events.payload`: must never contain phone numbers, names, or raw contact data.
- Audit export: PII fields are redacted or replaced with internal reference IDs before export.
- Log lines: never log phone numbers, session tokens, recovery credentials, or password hashes.
- Retention: define and enforce retention windows before production onboarding. `visitor_contacts.retention_until` must be set on creation.

## Transport

- HTTPS only for staging and production — no HTTP fallback on sensitive routes.
- HSTS header on all responses in production.
- All outbound calls to SMS/USSD providers over TLS with certificate validation (no `rejectUnauthorized: false`).
- Local development only: HTTP acceptable on `localhost`.

## Secrets management

- **No secrets in source code** — `.env` files are gitignored.
- `.env.example` at repository root and in each app lists every required variable with safe placeholder values.
- CI secrets injected via GitHub Actions encrypted secrets, never in workflow YAML values.
- Provider credentials (SMS API keys, USSD tokens, DB passwords) injected via environment variables.
- Rotate credentials without code changes — no hardcoded values anywhere.
- Encryption keys for PII fields: injected via env var, never committed.

## Audit integrity

- `queue_events` is append-only. An attempt to UPDATE or DELETE a `queue_events` row must fail at the database level (use a trigger or application-level enforcement + test).
- Hash chain: `event_hash = SHA256(domain_separator || queue_session_id || sequence || prev_hash || canonical_event_json)`.
- `audit_checkpoints` periodically sign a root hash over a range of sequences — verifiable without application code.
- Priority overrides always record: `actor_id`, `policy_version`, `reason_code`, `reason_text`, `queue_event_id`.
- Supervisor failover, coordinator assignment, and device revocation are all audited events.

## Error handling

- Errors returned to clients: structured RFC 9457 problem responses with `type`, `title`, `status`, `detail`, `instance` (correlation ID), `retryable`.
- Do **not** leak stack traces, internal IDs, query details, or data existence hints to unauthenticated callers.
- Log the full error server-side with `trace_id` for debugging.
- Authentication failures: uniform response time (prevent timing attacks on username enumeration).

## Dependency security

- No paid or proprietary dependencies.
- Pin exact versions in `package.json` (`"fastify": "5.x.x"` not `"^5"`).
- Run `pnpm audit` in CI — fail on high/critical vulnerabilities with no exceptions unless explicitly acknowledged.
- Do not use packages with known abandoned maintenance or security issues.

## Compliance notes

- No medical clinical data — urgency categories are staff-configured, not AI-inferred.
- Visitor consent required before storing phone number or sending notifications.
- Define data retention and deletion policy before production visitor data is collected.
- Comply with applicable Nigerian and local privacy obligations before live SMS/USSD activation.
