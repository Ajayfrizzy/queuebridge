# QueueBridge — Spec Requirements

**Spec version:** 1.0  
**Source:** `docs/QueueBridge_PRD_v1.0.md`  
**Status:** Baseline — all requirements in scope through M7

---

## REQ-F1: Offline-first queue operations

- REQ-F1.1: The application shell and essential authorized facility data SHALL be cached for offline use via service worker.
- REQ-F1.2: All local queued operations SHALL be persisted to IndexedDB before any success acknowledgement is shown to the user.
- REQ-F1.3: There SHALL be exactly one designated offline coordinator per queue session; non-authoritative devices MUST NOT independently commit call/advance decisions.
- REQ-F1.4: The coordinator designation SHALL carry a signed authorization containing `{ device_id, queue_id, epoch, allowed_commands }` with a defined expiry.
- REQ-F1.5: On reconnection, the system SHALL deduplicate using stable `operation_id` values and reconcile provisional operations without silently overwriting committed events.
- REQ-F1.6: Conflicts between local and committed server state SHALL be surfaced to authorized staff for explicit resolution.
- REQ-F1.7: Every operation visible to staff or visitors SHALL display one of: `Local`, `Pending Sync`, `Synced`, `Needs Review`.
- REQ-F1.8: Visitor-facing status views SHALL NOT display offline-local progress as globally confirmed state.
- REQ-F1.9: When coordinator credentials expire, the system SHALL stop offline advancement and permit provisional ticket capture only.
- REQ-F1.10: When a coordinator is missing or unrecoverable, offline advancement SHALL be suspended until an authorized supervisor performs explicit failover.

## REQ-F2: Inclusive registration

- REQ-F2.1: Visitors SHALL be able to join a queue via web/QR without creating an account.
- REQ-F2.2: Staff SHALL be able to create walk-in tickets on behalf of visitors.
- REQ-F2.3: A short ticket code fallback SHALL be available without requiring a printer.
- REQ-F2.4: Entry-point adapters SHALL exist for SMS and USSD; each facility SHALL be able to configure which channels are active.
- REQ-F2.5: The system SHALL implement a configurable duplicate-prevention policy that does not exclude shared-phone households.
- REQ-F2.6: Tickets created via web and staff-assisted entry SHALL be interoperable and visible in the same queue.

## REQ-F3: Queue fairness and transparency

- REQ-F3.1: Each service SHALL have an explicit, published ordering policy (default FIFO with configurable priority classes).
- REQ-F3.2: Visitors SHALL be able to view their queue position, join time, queue rules, and reasons for status changes.
- REQ-F3.3: Priority overrides SHALL require a supervisor role, a valid configured reason code, and a free-text explanation.
- REQ-F3.4: Private override reasons SHALL NOT appear on public displays.
- REQ-F3.5: Unauthorized override attempts SHALL be rejected AND logged.
- REQ-F3.6: Authorized overrides SHALL be visible in audit reports with actor, reason, policy context, and timestamp.
- REQ-F3.7: Pauses, skips, no-shows, and late arrivals SHALL be handled consistently per configured policy.

## REQ-F4: Ticket recovery and missed-turn handling

- REQ-F4.1: Visitors SHALL be able to recover their ticket using a scoped ticket code plus additional verification.
- REQ-F4.2: Visitor ticket state SHALL persist across browser refresh, device restart, and temporary connectivity loss.
- REQ-F4.3: Grace windows, rejoin policies, and no-show outcomes SHALL be configurable per facility/service.
- REQ-F4.4: Recovery credentials SHALL be high-entropy, stored as SHA-256 hashes, and rate-limited (max 5 attempts / 15 min / ticket code).
- REQ-F4.5: Recovery SHALL NOT expose: phone numbers, names, internal IDs, or data about other visitors.
- REQ-F4.6: Expired or invalid recovery attempts SHALL return a safe, uniform error response.

## REQ-F5: Adaptive service routing

- REQ-F5.1: Facilities SHALL be able to define services, service eligibility, counter capabilities, queue policies, and opening status.
- REQ-F5.2: Ticket routing SHALL use explicit deterministic rules: service match → priority class → waiting age → counter availability.
- REQ-F5.3: Tickets SHALL be transferable between counters/services while preserving the original audit trail and service history.
- REQ-F5.4: A transfer SHALL NOT duplicate a visitor or erase previous wait time — original join time is preserved.
- REQ-F5.5: Supervisor routing overrides SHALL require a recorded rationale.
- REQ-F5.6: Routing policy SHALL be versioned so replay over the same event history produces the same selection.

## REQ-F6: Explainable wait-time estimates

- REQ-F6.1: Wait estimates SHALL be computed from: active compatible counter count, eligible tickets ahead by class, bounded observed service-time samples, and configured operating schedule.
- REQ-F6.2: Estimates SHALL be expressed as an interval or range with a confidence/data-sufficiency indicator.
- REQ-F6.3: A short human-readable explanation of the estimate factors SHALL accompany every estimate.
- REQ-F6.4: When insufficient data exists, the system SHALL state this explicitly — not fabricate a number.
- REQ-F6.5: Estimates SHALL recalculate after: service completion, counter open/close, routing changes, reconnection.
- REQ-F6.6: The system SHALL NEVER display or imply an exact serving time.

## REQ-F7: Accessibility-first visitor experience

- REQ-F7.1: All critical visitor flows SHALL be operable via keyboard alone (no pointer required).
- REQ-F7.2: Status changes SHALL be announced via ARIA live regions for screen readers.
- REQ-F7.3: No status SHALL be conveyed by color alone; text or icon alternatives SHALL be present.
- REQ-F7.4: The UI SHALL support high-contrast and large-text display modes.
- REQ-F7.5: The UI SHALL respect `prefers-reduced-motion`.
- REQ-F7.6: Public display mode SHALL show ticket codes with optional audio announcements; no PII.
- REQ-F7.7: Pages SHALL be mobile-first and usable on low-bandwidth connections (target: < 100KB initial JS for visitor flows).
- REQ-F7.8: A localization framework SHALL be implemented; English is the required baseline; a validated second language SHALL be added only if translations can be verified for accuracy.
- REQ-F7.9: Core visitor flows SHALL target WCAG 2.2 AA, subject to verification.

## REQ-F8: Tamper-evident operational history

- REQ-F8.1: A `queue_events` table SHALL be append-only; UPDATE and DELETE SHALL be blocked at the application layer and ideally at the database level.
- REQ-F8.2: Each event SHALL carry `prev_hash` and `event_hash = SHA256(domain_separator || queue_session_id || sequence || prev_hash || canonical_event_json)`.
- REQ-F8.3: `audit_checkpoints` SHALL periodically record root hashes verifiable independently of application code.
- REQ-F8.4: All auditable actions SHALL be logged: permission checks, routing overrides, ticket transitions, sync conflicts, coordinator assignments, device revocations.
- REQ-F8.5: A searchable, paginated, scoped, read-only audit view SHALL be available to auditor role.
- REQ-F8.6: Audit export SHALL redact sensitive PII and replace with internal reference IDs.
- REQ-F8.7: The system SHALL detect modification of finalized events in a controlled integrity-check test.

## REQ-F9: Connectivity and recovery dashboard

- REQ-F9.1: The dashboard SHALL show for each authorized device: last contact time, approximate pending-action count, sync health, coordinator status, and failure reason where available.
- REQ-F9.2: Retry and conflict-resolution UI SHALL be available to privileged staff with safe, idempotent operations.
- REQ-F9.3: Server API health and client connectivity SHALL be monitored separately.
- REQ-F9.4: Unconfirmed client actions SHALL be visually distinguished from server-confirmed state.
- REQ-F9.5: Simulated outages SHALL appear in dashboards; recovery SHALL reconcile and update state without marking unsent actions as synced.

## REQ-F10: Portable facility setup

- REQ-F10.1: A new organization SHALL be able to sign up and create a facility without manual database changes.
- REQ-F10.2: Facility setup SHALL include: services, service types, counters, staff invitations, role assignments, operating hours, fairness policies, grace periods, and QR/link generation.
- REQ-F10.3: Multi-tenant isolation SHALL prevent any facility from accessing another organization's data.
- REQ-F10.4: A new facility SHALL be able to configure a service, create a counter, issue a QR code, invite staff, and serve the first visitor without administrator intervention.

## REQ-F11: Real SMS

- REQ-F11.1: The system SHALL send: ticket confirmation, nearing-turn notification, called-to-counter notice, significant delay, and missed-turn outcome messages.
- REQ-F11.2: All SMS SHALL require visitor consent and provide opt-out controls.
- REQ-F11.3: A provider-neutral `ChannelAdapter` interface SHALL abstract provider-specific behavior.
- REQ-F11.4: Delivery status SHALL be recorded as `delivered | failed | unknown`; `delivered` requires provider confirmation.
- REQ-F11.5: Every outbound message SHALL carry an idempotency key; the same key SHALL NOT re-trigger a send.
- REQ-F11.6: Sandbox mode SHALL be unmistakably labeled and SHALL NOT make real network calls.
- REQ-F11.7: Live SMS delivery SHALL only be activated after a provider with approved affordable credentials is selected.

## REQ-F12: Real USSD

- REQ-F12.1: The system SHALL implement a stateful server-side USSD flow for: join queue, check status, service discovery, and ticket recovery.
- REQ-F12.2: The USSD adapter SHALL use a provider-neutral webhook interface.
- REQ-F12.3: Session expiration, invalid input recovery, short menus, and replay defense SHALL be implemented.
- REQ-F12.4: The system SHALL NOT claim a live USSD code or production access without an authorized network/aggregator relationship.
- REQ-F12.5: End-to-end sandbox session tests SHALL pass before any live activation.

## REQ-SEC: Security requirements

- REQ-SEC.1: All inputs SHALL be validated with Zod schemas at the API boundary before business logic.
- REQ-SEC.2: All SQL queries SHALL use parameterized statements — zero string-concatenated SQL.
- REQ-SEC.3: Session tokens SHALL be cryptographically random (≥ 128 bits), HttpOnly, Secure, SameSite=Strict.
- REQ-SEC.4: Passwords SHALL be hashed with bcrypt (cost ≥ 12) or argon2id.
- REQ-SEC.5: Webhook signatures SHALL be verified before processing any payload.
- REQ-SEC.6: Every protected endpoint SHALL enforce server-side RBAC with tenant scope checks.
- REQ-SEC.7: Cross-tenant data access SHALL be impossible through any API endpoint.
- REQ-SEC.8: Phone numbers SHALL be stored as ciphertext; encryption key injected via environment variable.

## REQ-NFR: Non-functional requirements

- REQ-NFR.1: API responses SHALL include structured RFC 9457 problem responses for all errors.
- REQ-NFR.2: Structured JSON logs SHALL include `trace_id`, `facility_id`, `queue_session_id` on every log line.
- REQ-NFR.3: Health check endpoints SHALL be available at `/health` (liveness) and `/health/ready` (readiness).
- REQ-NFR.4: The system SHALL support horizontal scaling of `apps/api` and `apps/worker`.
- REQ-NFR.5: Core visitor flows SHALL be usable on Android devices with constrained connections.
- REQ-NFR.6: All environment variables SHALL be validated at startup using Zod; missing required vars SHALL prevent startup.

---

## REQ-F13: Ask Que Anything — context-aware self-service navigation assistant (planned)

> **Added:** 2026-11-07 as a planned feature (PRD Addendum A, ADR-011). Additive: it does not change
> REQ-F1–REQ-F12, REQ-SEC or REQ-NFR, and it is not one of the ten core feature groups counted in
> the PRD definition of done. Scheduled for milestone **MQ** (between M5 and M6; see `tasks.md`).
> Que is a navigation and help assistant, **not** a general-purpose chatbot.

### REQ-F13.1 Guided navigation

- REQ-F13.1.1: Que SHALL derive context from the current screen (route identifier), the user's server-derived roles at the current facility (or `visitor_anonymous`), and the capability manifest.
- REQ-F13.1.2: Que SHALL offer next-step guidance and navigation links only to screens the user's roles are permitted to open, using the same permission map the API enforces.
- REQ-F13.1.3: When a task requires a role the user lacks, Que SHALL say which role is required (by role name, never by naming individuals) and SHALL NOT link to the restricted screen.
- REQ-F13.1.4: Every route referenced by Que SHALL exist in the web router; dead or unregistered routes SHALL fail CI.

### REQ-F13.2 Searchable help

- REQ-F13.2.1: Que SHALL provide keyword search over KB articles visible to the user's audience.
- REQ-F13.2.2: The KB SHALL cover: visitor registration, ticket status, ticket recovery, staff operations (reception, counter, supervisor), facility configuration, and connectivity/sync states.
- REQ-F13.2.3: Each article SHALL declare: stable ID, audiences, required capabilities, related route IDs, `available_since` milestone, content version and last-reviewed date.

### REQ-F13.3 Offline knowledge base

- REQ-F13.3.1: Essential instructions SHALL be available offline through the PWA: public (visitor) articles via the service-worker precache; role-restricted articles via a per-user authenticated cache.
- REQ-F13.3.2: Deterministic search and navigation SHALL work fully offline once content is cached.
- REQ-F13.3.3: Que SHALL indicate when it is offline and showing built-in help, and SHALL show the content version in use.
- REQ-F13.3.4: Role-restricted cached content SHALL be cleared on sign-out, session end, deactivation or role change detected by the client.
- REQ-F13.3.6: Offline staff help SHALL contain only generic, role-level procedural articles. It SHALL NOT cache tenant-sensitive content: no organization, facility, service, counter, staff, visitor or ticket data, no names, emails, phone numbers, ticket codes, recovery secrets, internal IDs, or facility configuration.
- REQ-F13.3.7: Each cached restricted bundle SHALL carry an authorization expiry no later than the issuing session's expiry; after expiry the client SHALL stop showing restricted articles (offline or online) and fall back to public help until a fresh authorized fetch succeeds.
- REQ-F13.3.8: Cached restricted bundles SHALL be bound to the user ID and a digest of the user's role grants at issue time; on every successful `/auth/me` or Que API response with a different user or role digest, the client SHALL purge the cache before showing restricted help.
- REQ-F13.3.9: Cache invalidation SHALL also occur on: confirmed sign-out, any 401 from an authenticated request, KB bundle version change, and when a different user signs in on the same device. Failed sign-out (server not confirmed) SHALL NOT be treated as signed out.
- REQ-F13.3.5: The KB SHALL support incremental updates (versioned bundle, per-article versions) without app redeploys of unrelated features.

### REQ-F13.4 Optional AI explanation layer

- REQ-F13.4.1: Natural-language questions MAY be answered by an AI layer that rephrases or combines only KB articles already authorized for the user.
- REQ-F13.4.2: The AI layer SHALL be disabled by default and SHALL only be enabled with an approved free-tier or sponsored inference provider. No paid mode SHALL exist in configuration.
- REQ-F13.4.3: Inference SHALL run server-side through a provider-neutral `InferenceAdapter`; provider credentials SHALL never reach the browser.
- REQ-F13.4.4: Enabling the AI layer for a facility SHALL require an explicit `facility_admin` or `org_admin` opt-in, recorded as an audited admin event.
- REQ-F13.4.5: Questions SHALL be redacted of likely personal data (phone numbers, emails, ticket recovery secrets, ticket codes) before leaving the server; tenant operational data SHALL NOT be sent to the provider.
- REQ-F13.4.6: A hard daily request cap SHALL keep usage within the provider's free/sponsored allowance; exceeding it SHALL trigger deterministic fallback, never a paid overage.
- REQ-F13.4.7: AI inference SHALL be unavailable to `visitor_anonymous`. The AI endpoint SHALL require an authenticated staff session; anonymous visitors SHALL continue to receive public deterministic help.
- REQ-F13.4.8: No inference provider SHALL be selected or integrated before a separate, explicit project decision. Candidate providers SHALL be researched during MQ and are eligible only if they require no personal spending, no payment card and have no automatic paid overage.

### REQ-F13.5 Role-based access and tenant isolation

- REQ-F13.5.1: Que SHALL never disclose content, data or navigation targets the user is not authorized to access.
- REQ-F13.5.2: Role-restricted KB content SHALL be filtered server-side by the authenticated session; client-side filtering is advisory only.
- REQ-F13.5.3: Que SHALL NOT read or reveal another organization's or facility's data; any facility-specific context SHALL come only from endpoints the user is already authorized to read.
- REQ-F13.5.4: Visitors SHALL receive only public articles and never staff procedures, internal IDs or other visitors' data.

### REQ-F13.6 Read-only behaviour

- REQ-F13.6.1: Que SHALL NOT create, modify or delete tickets, priorities, queue state, staff, roles, permissions or facility settings.
- REQ-F13.6.2: Que SHALL expose no tool/function-calling capability to the AI layer.
- REQ-F13.6.3: Que endpoints SHALL write no tenant operational data; only aggregate, non-PII usage counters MAY be recorded.

### REQ-F13.7 Safe fallback

- REQ-F13.7.1: When AI is disabled, unavailable, slow (timeout), rate-limited, out of quota, erroring, or produces output that fails validation, Que SHALL return deterministic help for the same question and context.
- REQ-F13.7.2: Fallback SHALL be visible to the user with a plain reason (e.g. "AI explanation unavailable — showing built-in help").
- REQ-F13.7.3: Core queue operations SHALL never depend on Que or on inference availability.
- REQ-F13.7.4: All essential Que navigation and explanations SHALL be available through deterministic help with AI disabled and with no network access (from cached content). AI SHALL NOT be a dependency for completing any QueueBridge workflow.

### REQ-F13.8 Accessibility and disclosure

- REQ-F13.8.1: Que SHALL be mobile-first, operable by keyboard alone, and announce results through an ARIA live region; opening and closing SHALL manage focus correctly.
- REQ-F13.8.2: Every AI-generated answer SHALL be labelled as AI-generated, list its source articles, and advise verifying with staff for operational decisions.
- REQ-F13.8.3: Que SHALL meet the same WCAG 2.1 A/AA checks applied to other screens, at 320px, 375px and desktop widths.

### REQ-F13.9 Truthfulness — no fabricated capabilities

- REQ-F13.9.1: Que SHALL describe only capabilities whose manifest status is `live`, and SHALL label `preview`, `sandbox` and `planned` capabilities as such.
- REQ-F13.9.2: Que SHALL NOT promise service times, queue positions, delivery of notifications, or outcomes; wait information SHALL defer to F6 estimates and their stated uncertainty.
- REQ-F13.9.3: AI output that cites no authorized article, cites an unauthorized article, links an unauthorized route, or references a non-live capability as available SHALL be rejected and replaced by deterministic help.

### REQ-F13.10 Verification

- REQ-F13.10.1: Automated tests SHALL cover role restrictions, tenant isolation, offline fallback, navigation accuracy, KB/capability consistency, accessibility, prompt-injection resistance, inference failures and the zero-cost guard (testing steering Group 13).

### F13 requirement traceability

| Requirement | Design (`design.md`)                                          | Architecture addendum | Tasks (`tasks.md`) | Tests (Group 13)                                                   |
| ----------- | ------------------------------------------------------------- | --------------------- | ------------------ | ------------------------------------------------------------------ |
| REQ-F13.1   | §11.3 route registry                                          | A.2, A.3              | MQ.1               | 13.4 navigation accuracy, 13.1 roles                               |
| REQ-F13.2   | §11.2 KB model, §11.4 search                                  | A.2                   | MQ.1, MQ.5         | 13.4, 13.5 KB consistency                                          |
| REQ-F13.3   | §11.5 offline delivery, §11.5.1–§11.5.3 offline authorization | A.4                   | MQ.2               | 13.3 offline fallback, 13.12 offline authorization                 |
| REQ-F13.4   | §11.7 AI layer, §11.8 provider research                       | A.5                   | MQ.4               | 13.1 roles (visitor AI denied), 13.7, 13.8 zero-cost, 13.9 privacy |
| REQ-F13.5   | §11.6 authorization                                           | A.3                   | MQ.1, MQ.2         | 13.1 roles, 13.2 tenant isolation                                  |
| REQ-F13.6   | §11.1, §11.7                                                  | A.1                   | MQ.1, MQ.4         | 13.10 read-only                                                    |
| REQ-F13.7   | §11.4 deterministic coverage, §11.7 fallback ladder           | A.5                   | MQ.1, MQ.4, MQ.5   | 13.3, 13.7, 13.13 AI independence                                  |
| REQ-F13.8   | §11.9 UI                                                      | A.6                   | MQ.3               | 13.6 accessibility                                                 |
| REQ-F13.9   | §11.2 capability manifest, §11.7 output guard                 | A.2, A.5              | MQ.1, MQ.4, MQ.5   | 13.5, 13.11 prompt injection                                       |
| REQ-F13.10  | §11.10                                                        | A.7                   | MQ exit            | Group 13                                                           |
