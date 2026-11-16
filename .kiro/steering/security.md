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

**M5.1 clarifications (design §15, ADR-015; additive, the rules above stand):**

- The public ticket code is an identifier, never a credential. Recovery requires the **recovery key** (privately issued at join, submitted with the facility and ticket code), a single-use grant from the restricted staff procedure, or nothing. A bare code never yields a token, status or data.
- Two secrets: the 256-bit **status token** is the device bearer credential (SHA-256 at rest, at most 3 active per ticket); the **recovery key** has at least 128 bits (initial design 160 bits, CSPRNG), is stored as HMAC-SHA-256 with an HKDF-derived pepper, is shown once, is regenerable, and authorizes only a new status token for its ticket.
- Presentation: QR/link with the key in the URL fragment only (never path or query), read then removed from the address bar, sent in a POST body; readable grouped text with tolerant input. The key is never in `localStorage`, the offline outbox, logs or audit events.
- Throttle keys use only public identifiers and the request source, never the submitted secret, so changing a guess cannot evade a limit: 10 attempts per source per minute; 5 failed attempts per 15 minutes per ticket code per source (REQ-F4.4 applied per client); aggregate limits that only affect sources that already failed. All state self-expires within 15 minutes: there is no lifetime lock and no unlock action, and a correct key from a clean source always succeeds, so an attacker cannot lock the rightful holder out. Unknown, wrong, expired and terminal cases are indistinguishable. No CAPTCHA.
- **Staff-assisted recovery is a restricted procedure.** Presence and knowledge of the public code do not prove identity. No verified factor means restricted assistance and no credential; the basic factor (service and join time confirmed against the console) needs a second `QUEUE_MANAGE` approver; a server-checked contact factor arrives with M6. Grants are single use, expire in 10 minutes and are redeemed on the visitor's own device from a QR; staff never see, read out or copy a credential. Roles `WALK_IN` only (never auditors); reason code mandatory; rate-limited; audited without values or secrets; the rightful holder's other devices are notified. A facility can switch the path off.
- Recovery never creates queue events or changes ticket state, position or waiting age.
- **Automatic no-show** is off by default and executes only through the authoritative command, transition and audit path (`system` role for `called → missed`), under the session and ticket locks, with database time, a deterministic idempotent operation id, coordinator fencing (refused while a coordinator is assigned; clock restarts after coordinator authority ends and after a detected outage), stateless restart, and no use of notification or delivery state.

## Device health (F9) security (M5.3; design §17)

- Device information is minimized: label, owner, timestamps, reported pending count, last failure code, revoked time. Never IP address, user agent, fingerprint, location or visitor data. Heartbeat payloads are strict and minimal.
- Health alerts are visible to `OPERATIONS_VIEW` roles (auditors read-only) and acknowledgeable only by `QUEUE_MANAGE` roles; staff see only their own device's warning; cross-tenant is 404.
- Health evaluation is read-only on queue, coordinator and ticket data and never assigns, fails over, renews or revokes anything. Failover remains an explicit, audited supervisor action that fences the previous coordinator.

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

## Smart Turn Alerts (F14) security (planned; applies from milestone M5; ADR-013)

- Push subscription endpoint URLs and keys are secrets (capability URLs): encrypt at rest with the environment-injected key (derived per purpose), never log, never return from any API.
- Subscribe/unsubscribe/ack endpoints require the ticket's status credential, the CSRF header and an allowed Origin, strict Zod validation, rate limits per IP and per ticket, a cap on active subscriptions per ticket, and tenant scope (cross-tenant = 404).
- VAPID private key: worker environment only; never in the browser, repository, logs or CI output. Absent keys disable the capability.
- Push endpoints are an SSRF surface (the worker POSTs to them): HTTPS on the default port, a host name (no IP literal, no credentials) under an allow-listed push service (`PUSH_ENDPOINT_HOSTS` extends it), checked at subscribe AND again by the worker before every send; the address actually connected to (after DNS) must be public; no redirects, a hard timeout, and the response body is never read.
- Per-ticket subscription-change limits are stored in PostgreSQL so every API instance shares them; turning push off is never refused.
- Push payloads contain only type, the non-secret `subscription_id` reference, ticket code, counter label, call sequence, a public recovery path and a timestamp: no status token, recovery key, grant, endpoint, key material, names, phone numbers, other internal ids or tenant configuration. The endpoint, its hash, the keys and every bearer credential never appear in logs, audit records, URLs, notification tags, `Topic`s or deduplication keys. Logs record counts, outcome codes and `subscription_id` only.
- Notification identity is the subscription, never the public ticket code alone: tag, `Topic` and click destination derive from `subscription_id`. A notification opened on a device without the matching saved ticket shows a neutral screen, makes no status request and never opens another ticket with the same code. The service worker holds no credential; the page sends the acknowledgement.
- Request notification permission only from an explicit user action; never on page load.
- Alert code must not be able to fail, delay or alter a queue command (savepoint isolation), and no alert outcome may change ticket state or mark a visitor missed.
- Never claim delivery without a first-party acknowledgement or provider receipt.
- SMS turn alerts (M6): explicit consent and opt-out, phone numbers as ciphertext only, daily cap before send, signed and replay-defended receipt webhooks, no real traffic in sandbox, no personal spending.

## Final UI/UX and landing page (F15) security (planned; applies from milestone M7; ADR-014)

- The landing page makes no third-party requests (no analytics, fonts, trackers, embeds); production CSP restricts sources to the app origin; HSTS, frame-ancestors, referrer and permissions policies are verified by test.
- The landing page collects no data itself; sign-up uses the existing CSRF- and rate-limited flow.
- Landing content must not make unverified security or reliability claims (no "tamper-proof", "conflict-free" or "guaranteed delivery").

## Ask Que (F13) security (planned; applies from milestone MQ)

- Que is read-only: no endpoint or tool may change tickets, priorities, queue state, staff, roles,
  permissions or facility settings.
- Authorize content: role-restricted KB articles are returned only by an authenticated endpoint
  filtered by session roles; visitors receive the public bundle only. Tenant scoping as for any API.
- Treat user questions, KB text and model output as untrusted data. The output guard (citations,
  permitted links, capability truthfulness, safe markup) is authoritative; failure → deterministic help.
- Never send tenant operational data, phone numbers, emails, ticket codes or recovery secrets to an
  inference provider; redact likely PII from questions. Do not log question or answer text by default.
- Sending questions to a third-party provider requires facility-admin opt-in (audited) and visible
  disclosure in the UI.
- Inference provider credentials are server-side environment variables only; the AI layer is off
  unless `QUE_AI_COST_MODE` is `free_tier` or `sponsored`, with a hard daily cap. No paid inference,
  no subscriptions, no automatic overage.
- Rate-limit `POST /api/v1/que/ask` per user and per IP.
- AI inference is unavailable to `visitor_anonymous`; the AI endpoint requires a staff session.
- Offline staff help caches only generic role-level procedures, never tenant-sensitive content.
  Cached bundles are bound to user ID and role digest, expire by elapsed time (with clock-rollback
  detection) no later than the session, and are purged on confirmed sign-out, 401, role change,
  user switch or expiry (design §11.5). Offline expiry is a best-effort display bound, not a
  confidentiality control — which is why tenant-sensitive content is never cached.
- No inference provider may be selected or integrated without a separate explicit decision; no
  payment card, personal spending or automatic paid overage.
