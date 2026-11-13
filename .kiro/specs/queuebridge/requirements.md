# QueueBridge — Spec Requirements

**Spec version:** 1.2 (2026-11-12)  
**Source:** `docs/QueueBridge_PRD_v1.0.md` (including Addenda A and B)  
**Status:** Baseline — all requirements in scope through M7. M0–M4 are implemented and merged into `staging`; REQ-F4.7–F4.15, REQ-F7.10–F7.17, REQ-F9.6–F9.14 (M5 detail), REQ-F11.8–F11.13 (M6), REQ-F14 (M5) and REQ-F15 (M7) were added 2026-11-12. All earlier requirements are unchanged.

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

> **Added 2026-11-12 (milestone M5.1; design §15; ADR-015).** REQ-F4.7–REQ-F4.15 are additive; REQ-F4.1–REQ-F4.6 are unchanged.

- REQ-F4.7: Recovery SHALL NOT be possible from a publicly visible ticket code alone. A visitor SHALL recover only with (a) a **recovery key**, issued privately when the ticket was created and submitted together with the facility and ticket code, or (b) a single-use grant created through the verified staff procedure (REQ-F4.11). The recovery key SHALL have at least 128 bits of entropy (initial design: 160 bits) from a cryptographically secure random generator, SHALL be stored only as an HMAC-SHA-256 (keyed with a server-side pepper), SHALL be shown to the visitor once, SHALL be regenerable, and SHALL authorize nothing except obtaining a new status token for that ticket. Status tokens remain at least 128-bit bearer credentials stored as SHA-256 hashes.
- REQ-F4.8: A ticket SHALL have at most 3 active status tokens. Recovery SHALL add a token (revoking the oldest at the cap); a visitor holding a valid token SHALL be able to sign out all other devices; staff SHALL be able to revoke all visitor access to a ticket. Each rotation or revocation SHALL be atomic and take effect immediately. When a new token is issued by recovery or a grant, the ticket's existing devices SHALL be told that access was granted elsewhere.
- REQ-F4.9: Presentation SHALL be visitor-friendly without weakening security: the recovery key SHALL be offered as a QR code and link that carry the key only in the URL fragment (never in a path or query, never sent to servers, logs or `Referer`, removed from the address bar after reading), and as readable grouped text with a spoken-friendly alphabet and tolerant input (case-insensitive, ignoring spaces and hyphens, folding visually ambiguous characters), with Copy, Share, Save and Print actions. The key SHALL NOT be stored in local storage, the offline outbox or logs.
- REQ-F4.10: Self-service recovery SHALL be throttled with keys derived only from public identifiers and the request source, never from the submitted key, so that changing the guess cannot evade any limit: per source at most 10 attempts per minute (configurable); at most 5 failed attempts per 15 minutes per ticket code per source (REQ-F4.4 applied per client so that an attacker cannot block the rightful holder); aggregate per-ticket and per-facility surge limits that affect only sources that have already failed and raise an abuse alert. Every attempt SHALL be counted before verification. All throttle state SHALL expire on its own within 15 minutes; there SHALL be no lifetime counter, lockout state or unlock action, and a request from a source with no recent failures for that ticket SHALL always be verified. Unknown, wrong, expired and terminal cases SHALL be indistinguishable in status, body and processing time. No CAPTCHA SHALL be required.
- REQ-F4.11: Staff-assisted recovery SHALL be a restricted procedure. Physical presence and quoting the public ticket code SHALL NOT count as proof of identity. With no verified factor staff SHALL provide restricted assistance only (public information, presenting at the counter when called, or a new ticket) and SHALL NOT issue any credential. With only the basic factor (the visitor's account of the service and approximate join time, confirmed against the console) a grant SHALL require approval by a second user holding `QUEUE_MANAGE`; a server-checked factor (consented contact match) SHALL be added only when contact data exists (milestone M6) and then permits any `WALK_IN` role. Grants SHALL be single-use, expire in 10 minutes, be redeemed on the visitor's own device from a QR shown on the staff screen, require a reason code, and be rate-limited; staff SHALL never see, read out or copy a credential. Auditors SHALL NOT use the procedure. Each use SHALL be audited (actor, approver, reason, assurance level, factor booleans; no values or secrets). A facility SHALL be able to disable staff-assisted recovery.
- REQ-F4.12: Recovery actions SHALL NOT create queue events and SHALL NOT change any ticket's state, position or waiting age. They SHALL work while an offline coordinator holds the queue. A ticket created offline and not yet confirmed by the server SHALL NOT be recoverable, and the UI SHALL say so.
- REQ-F4.13: The only grace setting SHALL be the existing per-service `grace_window_seconds` (default 300, range 0–3600). The per-service `rejoin_policy` SHALL be `staff_resume` (default; current behaviour) or `self_resume`. With `self_resume` a visitor MAY return a `missed` ticket to `waiting` only while the grace window is active, through the standard command path, idempotently, with the same placement rules as staff resume, and refused while a coordinator holds the queue. After the window the visitor SHALL be told to join again; a missed ticket SHALL NOT be silently reinstated.
- REQ-F4.14: Automatic no-show SHALL be disabled by default. When a service enables it, the administrator SHALL enter the call-response time explicitly (no default; 60–3600 seconds) and visitors SHALL be shown the rule. It SHALL execute only through the existing authoritative command, transition-rule, event-append and audit mechanisms (a `system` actor for the single transition `called → missed`), under the queue-session and ticket locks, re-checking all conditions with database time and the current policy version. It SHALL be idempotent across concurrent attempts and multiple API instances (deterministic operation id), SHALL be refused whenever a coordinator is assigned and SHALL restart its clock after coordinator authority ends, so it cannot bypass M3 fencing. It SHALL recover from restarts without in-memory state, SHALL treat itself as a "not before" deadline that may run late, and SHALL restart the clock after a detected outage. It SHALL record the reason `call_window_elapsed`, the policy version and the call sequence, and SHALL NEVER use notification, push, SMS or delivery state, success or failure, as evidence for marking a visitor missed (REQ-F14.7.3).
- REQ-F4.15: Retention: status-token rows SHALL be deleted 24 hours after expiry; the recovery-key hash SHALL be removed 24 hours after the ticket reaches a terminal state; grants SHALL be deleted 24 hours after expiry or redemption; throttle rows SHALL be deleted 24 hours after their window. Secrets SHALL NOT appear in logs, audit events or API responses other than the one-time display.

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

> **Added 2026-11-12 (milestone M5.2; design §16).** REQ-F7.10–REQ-F7.17 are additive; REQ-F7.1–REQ-F7.9 are unchanged. No requirement here claims conformance; conformance requires verification (see REQ-F7.9).

- REQ-F7.10: All roles SHALL be able to set device-local display preferences: contrast (system or high), text size (normal, large, extra large), motion (system or reduce) and quiet alerts. Preferences SHALL be applied before first render, take precedence over system settings when explicitly chosen, work offline, contain no personal data, be resettable, and be reachable from the shared header and the ticket page.
- REQ-F7.11: Keyboard use SHALL be complete for all visitor flows with no keyboard trap. On route change focus SHALL move to the page heading and the title SHALL be announced once; dialogs SHALL move focus in, contain it, close on Escape and return focus; focus SHALL be visible and not obscured by sticky elements; interactive targets SHALL be at least 24 × 24 CSS px, and primary mobile actions at least 44 px.
- REQ-F7.12: Announcements SHALL follow a published policy: the called alert and blocking errors are assertive; position, status, connectivity and sync-state changes are polite, throttled to at most one position announcement per 15 seconds and deduplicated; live regions exist before they are populated; all text comes from the localization catalog.
- REQ-F7.13: Text and UI components SHALL meet 4.5:1 and 3:1 contrast respectively in normal mode and 7:1 for text in high-contrast mode. Content SHALL reflow without loss or horizontal scrolling at 320 CSS px and at 200% zoom or extra-large text.
- REQ-F7.14: Reduced motion (system or app setting) SHALL remove non-essential animation and transitions everywhere; nothing SHALL convey information by motion alone or flash more than three times per second.
- REQ-F7.15: Vibration and sound controls SHALL be enabled only where the device supports them and otherwise be shown disabled with an explanation; sound SHALL be off by default; a quiet mode SHALL switch every non-visual cue off; "Test alert" SHALL exercise only the enabled cues and be marked as a test.
- REQ-F7.16: The offline shell, preferences, the stored ticket view, the recovery page (stating that a connection is needed) and the outbox panel SHALL be keyboard- and screen-reader-usable without a network; connectivity and sync-state changes SHALL be announced in text.
- REQ-F7.17: The PWA manifest SHALL NOT lock screen orientation. Core visitor flows SHALL be verified at 320 px and 375 px widths.

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

> **Added 2026-11-12 (milestone M5.3; design §17).** REQ-F9.6–REQ-F9.14 are additive; REQ-F9.1–REQ-F9.5 are unchanged. The single-coordinator authority model (REQ-F1.3, ADR-006) is not changed by any of them.

- REQ-F9.6: Device state SHALL be derived from server time only and SHALL include `offline` (no contact for 120 s, existing) and `stale` (no contact for a configurable period; initial default 900 s, accepted 2026-11-12). The UI SHALL state that a silent device may be offline, asleep, closed or lost, and that pending counts are device-reported and approximate.
- REQ-F9.7: The system SHALL raise automatic health alerts for: coordinator offline or stale while its queue has waiting or called tickets; coordinator authorization expiring (configurable window, initial default 300 s, accepted) or expired; a stale device with pending actions; the same sync failure persisting across 3 consecutive reports; `needs_review` operations unreviewed beyond a configurable time (initial default 900 s, accepted); recovery abuse (REQ-F4.10); and turn-alert pipeline failure. There SHALL be at most one open alert per facility, kind and subject; alerts SHALL resolve automatically after the condition has been clear for two evaluations.
- REQ-F9.8: Alerts SHALL be visible to roles holding `OPERATIONS_VIEW` at the facility (supervisor, facility admin, organization admin; auditors read-only) and SHALL be acknowledgeable only by roles holding `QUEUE_MANAGE`. A staff member SHALL also see a warning about their own device. Delivery SHALL be in-product only (dashboard, banner, console warning); no SMS or email SHALL be sent to staff without a separate decision.
- REQ-F9.9: Device-health evaluation SHALL be read-only with respect to queue sessions, coordinator fields, tickets and events. It SHALL NOT assign, fail over, renew or revoke a coordinator or device. Failover SHALL remain an explicit, authenticated, audited supervisor action that advances the epoch and fences the previous coordinator.
- REQ-F9.10: Device information SHALL be privacy-preserving: stored fields are limited to a user-chosen label, owner, timestamps, reported pending count, last failure code and revocation time. IP address, user agent or hardware fingerprint, location and visitor data SHALL NOT be stored, and the UI SHALL advise against using personal names as device labels.
- REQ-F9.11: A supervisor SHALL be able to revoke a device as lost; the dashboard SHALL then show the last contact and the last reported pending count with wording that those actions may be lost; syncs from a revoked device SHALL be rejected; a revoked device SHALL re-register as a new device; its unsent actions SHALL be shown read-only and SHALL NOT be applied automatically.
- REQ-F9.12: Alert evaluation failure SHALL never block a queue action or a device operation. When automatic evaluation is stale the dashboard SHALL say so, and device states SHALL still be computed on read.
- REQ-F9.13: Resolved alerts SHALL be deleted after 30 days; heartbeat values SHALL overwrite rather than accumulate history; revoked device rows SHALL be retained for audit.
- REQ-F9.14: The alerts panel, banner and console warnings SHALL meet REQ-F7.10–F7.17 (keyboard, announcements, 320 px).

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

> **Added 2026-11-12 (milestone M6 — SMS Turn Alerts).** REQ-F11.8–REQ-F11.13 are additive; REQ-F11.1–REQ-F11.7 are unchanged. Decision record: ADR-013. Design: `design.md` §13.

- REQ-F11.8: A "called to counter" SMS turn alert (`ticket.called`) SHALL be produced from the same committed-event outbox pipeline as other turn alerts (REQ-F14.4), through the existing `ChannelAdapter` interface and idempotency key, and only for committed events (never offline-applied, local-only state).
- REQ-F11.9: SMS SHALL be sent only to a visitor who gave explicit, purpose-stated consent at joining (phone number optional), with an opt-out available in the UI and, where the provider supports inbound messages, by reply keyword; opt-out SHALL stop further SMS for that contact immediately.
- REQ-F11.10: SMS turn alerts SHALL be independent of in-app and push alerts: failure, delay or absence of any one channel SHALL NOT block queue progression, affect the other channels, or mark a visitor missed.
- REQ-F11.11: Every SMS-capable facility SHALL operate under hard spending controls: a configurable per-day message cap, enforced before sending; exceeding the cap SHALL record `failed` with a cap reason and SHALL NOT incur overage. No new out-of-pocket expense by default (PRD §13).
- REQ-F11.12: Real provider support SHALL be preserved: live provider adapters implement `sendMessage`, signed webhook verification with replay defense, and delivery receipts, and are selectable by configuration. Live traffic SHALL be enabled only for a provider whose credentials come from approved sponsored or free resources; until then sandbox mode SHALL be the default and SHALL be unmistakably labelled.
- REQ-F11.13: The UI and knowledge base SHALL NOT state or imply that an SMS was delivered unless a provider receipt of `delivered` is recorded.

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
- REQ-F13.3.7: Each cached restricted bundle SHALL carry a server-issued validity no longer than the issuing session's remaining lifetime. The client SHALL evaluate expiry as elapsed time since receipt (independent of device clock offset), SHALL treat detected clock rollback or missing clock metadata as expiry, and after expiry SHALL stop showing restricted articles and fall back to public help until a fresh authorized fetch succeeds. This offline bound is best-effort against wrong or reset clocks, not against a user in full control of the device; REQ-F13.3.6 (no tenant-sensitive content) is the confidentiality control.
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

---

## REQ-F14: Smart Turn Alerts (planned — milestone M5)

> **Added:** 2026-11-12 (PRD Addendum B, ADR-013). Additive: it does not change REQ-F1–REQ-F13,
> REQ-SEC or REQ-NFR, and it is not one of the ten core feature groups counted in the PRD definition
> of done. It is a required part of the **M5** exit criteria alongside REQ-F4, REQ-F7 and REQ-F9,
> whose requirements are unchanged. SMS turn alerts are REQ-F11.8–REQ-F11.13 (M6).

### REQ-F14.1 In-app alert (primary layer)

- REQ-F14.1.1: When the server-confirmed state of a visitor's ticket becomes `called`, the open ticket page SHALL show a persistent visual alert containing the ticket code and the counter label, and SHALL announce it through an assertive ARIA live region.
- REQ-F14.1.2: The in-app alert SHALL NOT depend on sound, vibration, push, notification permission or any provider.
- REQ-F14.1.3: The alert SHALL convey its meaning in text (and an icon), never by colour or sound alone, and SHALL remain visible until the visitor dismisses it or the ticket leaves `called`.
- REQ-F14.1.4: After a page refresh, device restart or reconnect, the page SHALL re-derive the alert from current server state; a call SHALL NOT produce repeated sound or vibration for the same call event (tracked by event sequence).
- REQ-F14.1.5: While the client cannot reach the server, the page SHALL say alerts may be delayed and point to the public board and staff; it SHALL NOT display local-only state as a call.

### REQ-F14.2 Committed-state trigger

- REQ-F14.2.1: Alerts SHALL be triggered only by server-committed events that leave a ticket `called` (call-next, out-of-order call, counter transfer of a called ticket).
- REQ-F14.2.2: Offline-applied or `local_only`/`pending_sync` actions SHALL NOT alert visitors; the alert fires when the server commits the call.
- REQ-F14.2.3: A release or recall that returns a ticket to `waiting` SHALL clear the in-app alert and SHALL cause any not-yet-sent push alert for that call to be suppressed.

### REQ-F14.3 Optional sound

- REQ-F14.3.1: Sound SHALL be off by default and enabled only by an explicit user action on the ticket page; the preference is stored on the device only.
- REQ-F14.3.2: Sound SHALL use a bundled short asset, play once per call event, never loop, and be controllable (off switch, "Test alert").
- REQ-F14.3.3: If the browser blocks or fails to play audio, the visual and live-region alert SHALL still appear, with no error shown as a failure of the call.

### REQ-F14.4 Optional vibration

- REQ-F14.4.1: Vibration SHALL use the Vibration API only in the foreground, only when feature-detected, with a short pattern (total under one second), and SHALL be switchable off.
- REQ-F14.4.2: QueueBridge SHALL NOT claim, in UI or documentation, that vibration works in the background or on devices without support (including iOS Safari).

### REQ-F14.5 Opt-in Web Push

- REQ-F14.5.1: Web Push SHALL be offered only where `serviceWorker`, `PushManager` and `Notification` exist and the server capability is configured; otherwise the UI SHALL explain plainly that push is unavailable and rely on the in-app alert.
- REQ-F14.5.2: Notification permission SHALL be requested only from an explicit visitor action on the ticket page, never on page load; a denied permission SHALL be respected without repeated prompting, with instructions to re-enable.
- REQ-F14.5.3: A push subscription SHALL be bound to one ticket, removable by the visitor at any time, and revoked automatically when the ticket is completed, cancelled, missed beyond rejoin, or expired. A service transfer SHALL re-bind the ticket's active subscriptions to the destination ticket rather than revoke them.
- REQ-F14.5.4: Where the platform requires installation for push (e.g. iOS), the UI SHALL say so; it SHALL NOT imply push will work without it.
- REQ-F14.5.5: The push payload SHALL contain only a type, a non-secret subscription reference, the ticket code, the counter label, the committed call sequence, a public recovery path (public identifiers only) and a timestamp. It SHALL NOT contain a status token, recovery key, grant, push endpoint, key material, names, phone numbers, tenant configuration or any internal identifier other than the subscription reference.
- REQ-F14.5.6: Each push SHALL carry a short TTL and SHALL be suppressed by the worker if, at send time, the ticket is no longer `called` at that counter.
- REQ-F14.5.7: A push received while a QueueBridge window is focused SHALL be handed to that window instead of showing a duplicate system notification.
- REQ-F14.5.8: The push TTL SHALL default to 120 seconds (configurable) and bound all retries; at most 3 active push subscriptions SHALL exist per ticket (configurable). Subscriptions SHALL be retained and deleted as specified in design §12.13: ciphertext removed on revoke, tombstones kept 24 hours, notification rows kept 30 days.
- REQ-F14.5.9: Notification identity SHALL be the push subscription, never the public ticket code alone. Each subscription SHALL have a server-minted, random, non-secret `subscription_id` (unique per ticket and device, stable under idempotent re-subscription, not derived from the endpoint, accepted by no endpoint without the ticket's status token). The notification `tag`, the push `Topic` and the click destination SHALL be derived from it, so tickets that share a public code (different facilities or queue sessions) on one device never share a tag or destination.
- REQ-F14.5.10: The web client SHALL map a subscription to a saved ticket through the existing saved-ticket identity architecture: the page stores the returned subscription reference as a non-secret field on the saved ticket, and a notification opens `/ticket/<code>?ref=<ref>`, resolved by that field. When both the device-local ticket id and the reference are present they SHALL agree. A bare public code SHALL NOT be used to guess a ticket when a reference is present.
- REQ-F14.5.11: When a notification is opened on a device that has no saved ticket for its reference, the client SHALL show a neutral message that the ticket is not saved on this device, SHALL make no status request, SHALL NOT open another ticket sharing the public code, and SHALL offer credential-based recovery paths (saved link or QR, recovery key, ask staff). Notifications SHALL never carry a bearer credential that would let the receiving device bypass this.

### REQ-F14.6 No guarantee, honest states

- REQ-F14.6.1: No UI text, knowledge-base article or documentation SHALL promise that a visitor will be alerted. Wording SHALL describe push, sound and vibration as best effort and SHALL keep the public board and staff calling as the reliable fallback.
- REQ-F14.6.2: Push delivery state SHALL be recorded as `sent` (accepted by the push service), `delivered` (only on a first-party acknowledgement sent by the visitor's page (the service worker holds no credential) or a provider receipt), `failed` (definitive rejection or retries exhausted) or `unknown`; `delivered` SHALL NOT be inferred from `sent`.
- REQ-F14.6.3: Authorized staff SHALL see the alert state for a called ticket as plain text (for example "push sent, not confirmed") together with a reminder that the public board is the fallback.

### REQ-F14.7 Non-blocking and fairness

- REQ-F14.7.1: A failed, slow, unconfigured or unavailable alert path SHALL NOT block, delay, roll back or alter any queue command or sync disposition.
- REQ-F14.7.2: Enqueuing alert work SHALL be isolated from the queue transaction (savepoint) so that an error in alert code cannot fail the queue command; the failure SHALL be logged and counted.
- REQ-F14.7.3: No alert outcome SHALL change a ticket's state or mark a visitor `missed`. Missed handling SHALL follow only the configured F4 policy; any automatic miss SHALL be disabled by default, opt-in per service, based only on elapsed time since the committed call (REQ-F4.14), and recorded with the reason `call_window_elapsed`, never referencing alert outcomes.
- REQ-F14.7.4: Alert delivery SHALL never be a precondition for calling, serving, completing or transferring a ticket.

### REQ-F14.8 Idempotency and retries

- REQ-F14.8.1: Each subscribed device SHALL receive its own notification and outbox entry for a call event. The idempotency key SHALL include the ticket, the committed event sequence and the subscription identifier (`web_push:ticket.called:<ticket_id>:<event_sequence>:<subscription_id>`), SHALL be unique per outbound notification, and a replayed key SHALL NOT re-send. A conflicting (replayed) row SHALL be skipped without discarding the entries of other devices or the savepoint.
- REQ-F14.8.2: Retries SHALL be bounded, SHALL back off, and SHALL stop when the TTL has elapsed.
- REQ-F14.8.3: A push endpoint answering 404/410 SHALL revoke that subscription and stop further sends to it.
- REQ-F14.8.4: Concurrent workers SHALL claim outbox rows without double-claiming (row locks with a lease). Delivery SHALL be described as at-least-once with collapse (same `Topic` and notification tag), never exactly-once, and one device's failure SHALL NOT affect another device's entry.

### REQ-F14.9 Accessibility

- REQ-F14.9.1: Alert controls (sound, vibration, push, test alert, dismiss) SHALL be operable by keyboard, have visible focus and accessible names, and meet WCAG 2.2 target size.
- REQ-F14.9.2: The alert SHALL NOT steal keyboard focus unexpectedly; dismissal returns focus to a sensible control.
- REQ-F14.9.3: Alert visuals SHALL respect `prefers-reduced-motion`, SHALL NOT flash more than three times per second, and SHALL work in high-contrast and large-text modes.
- REQ-F14.9.4: Every non-visual cue (sound, vibration, system notification) SHALL have an equivalent visual and screen-reader cue.
- REQ-F14.9.5: Controls and alert states SHALL be usable at 320 px and 375 px widths.

### REQ-F14.10 Security, privacy and cost

- REQ-F14.10.1: Push subscription data (endpoint and keys) SHALL be encrypted at rest with an environment-injected key, never returned by any API, and treated as a secret. The endpoint, its hash, the keys and every bearer credential SHALL NOT appear in logs, audit records, URLs, notification tags, payloads or deduplication keys; the non-secret `subscription_id` MAY appear in logs and metrics.
- REQ-F14.10.2: Subscribe/unsubscribe endpoints SHALL require the ticket's status credential, enforce tenant scope, be CSRF-protected and rate-limited, and cap active subscriptions per ticket.
- REQ-F14.10.3: VAPID keys SHALL be provided by environment variables only; when absent, the web-push capability SHALL report `disabled` and the UI SHALL not offer it.
- REQ-F14.10.4: The feature SHALL use only free, open-standard components (Web Push protocol, VAPID, an MIT-licensed library); no paid push service or SaaS.
- REQ-F14.10.5: Alert attempts and outcomes SHALL be counted (aggregate, non-PII) and visible to supervisors on the connectivity dashboard.

### REQ-F14.11 Verification

- REQ-F14.11.1: Automated tests SHALL cover the savepoint isolation, no-state-change on every failure path, idempotency, stale suppression, committed-only triggering, honest state transitions, payload minimality, encryption at rest, tenant isolation, accessibility and reduced motion (testing steering Group 14).
- REQ-F14.11.2: Real-device checks (at least Android Chrome; iOS Safari including the installed-app case) SHALL be recorded in `docs/testing/M5-evidence.md` as observed, with unsupported or flaky results stated rather than omitted.

---

## REQ-F15: Final UI/UX, Branding and Public Landing (planned — milestone M7)

> **Added:** 2026-11-12 (PRD Addendum B, ADR-014). Additive; not one of the ten core feature groups.
> Required for the **M7** exit criteria together with hardening, demo and submission.

### REQ-F15.1 Branding and design system

- REQ-F15.1.1: QueueBridge SHALL have one consistent brand identity: wordmark, logo, colour palette, typography and iconography, applied to all roles' screens, the PWA manifest icons and the favicon.
- REQ-F15.1.2: Brand assets SHALL be original or openly licensed and self-hosted; no paid or third-party-hosted assets, fonts or scripts.
- REQ-F15.1.3: A single design-token set in `packages/ui` (colour, type, spacing, radius, elevation, motion) SHALL drive light, high-contrast and large-text modes.

### REQ-F15.2 Responsive redesign

- REQ-F15.2.1: Every visitor, staff, supervisor, administrator, auditor and public-board screen SHALL be redesigned on the shared tokens and components without removing any existing capability or state indicator.
- REQ-F15.2.2: Screens SHALL be usable without horizontal scrolling at 320, 375, 768, 1280 and 1440 px.
- REQ-F15.2.3: Existing behavioural, accessibility and security tests SHALL pass unchanged in intent; assertions SHALL NOT be weakened to accommodate the redesign.

### REQ-F15.3 Public landing page

- REQ-F15.3.1: The route `/` SHALL be an animated public landing page with clear product messaging: what QueueBridge is, who it is for (visitors, staff, administrators), and the problem it addresses (queues that break when connectivity does).
- REQ-F15.3.2: The page SHALL explain, in plain language, the main capabilities: joining without an account, staff-assisted tickets, offline-safe operation with visible review, fairness and audit, accessibility, and turn alerts.
- REQ-F15.3.3: Content SHALL be truthful: no claims of conflict-free operation, guaranteed alert delivery, live SMS/USSD unless the capability manifest says `live`, or invented metrics, customers, logos or testimonials. Channel and capability statuses shown on the page SHALL come from the capability manifest where available.
- REQ-F15.3.4: The landing page SHALL provide organizational onboarding: a primary call to action to sign up, a sign-in link, and a guided "get started" checklist mapped to the F10 flow (organization, facility, service, counter, staff invitations, QR/join link, first visitor), plus a short explanation for visitors on how joining by QR or link works.
- REQ-F15.3.5: Landing copy SHALL use the localization framework (English baseline).

### REQ-F15.4 Motion

- REQ-F15.4.1: Animation SHALL be CSS/SVG based, use transforms and opacity, respect `prefers-reduced-motion` (static equivalent), never flash more than three times per second, and provide a pause control for any animation that runs longer than five seconds.
- REQ-F15.4.2: Animation SHALL NOT convey information unavailable in text.

### REQ-F15.5 Performance

- REQ-F15.5.1: The landing page SHALL be a separately loaded chunk; visitor and staff routes SHALL NOT download it, and the visitor-flow initial JavaScript budget (REQ-F7.7) SHALL be unaffected.
- REQ-F15.5.2: Performance budgets SHALL be derived from measured baselines (architecture §15.7), enforced in CI, and reported with measured values.

### REQ-F15.6 Accessibility

- REQ-F15.6.1: The landing page and redesigned screens SHALL target WCAG 2.2 AA, verified by automated axe checks, keyboard-only walkthroughs and a recorded manual screen-reader pass, with limits of that verification stated.

### REQ-F15.7 Security and privacy

- REQ-F15.7.1: The landing page SHALL make no third-party requests (no analytics, fonts, trackers or embedded scripts) and SHALL be served with the production security headers (CSP, HSTS, frame and referrer policies).
- REQ-F15.7.2: Sign-up links SHALL use the existing CSRF- and rate-limited sign-up flow; the page SHALL collect no data itself.

### REQ-F15.8 Cross-browser verification

- REQ-F15.8.1: Automated journeys (landing, onboarding entry, visitor join and ticket page, staff call) SHALL run on Chromium, Firefox and WebKit engines at mobile and desktop sizes.
- REQ-F15.8.2: A real-device checklist (Android Chrome; iOS Safari including installed-app behaviour for push) SHALL be completed and recorded, with a published support matrix and known limitations.

### REQ-F15.9 Verification

- REQ-F15.9.1: Automated tests SHALL cover landing truthfulness against the manifest, reduced-motion and pause behaviour, accessibility, responsive layout, bundle budgets, absence of third-party requests, security headers and cross-browser smoke journeys (testing steering Group 15).

---

## Traceability: new requirements

| Requirement      | Design (`design.md`)                              | ADR              | Tasks (`tasks.md`) | Tests                                            |
| ---------------- | ------------------------------------------------- | ---------------- | ------------------ | ------------------------------------------------ |
| REQ-F14.1        | §12.3 in-app alert                                | ADR-013          | M5.4               | Group 14.1, 14.8; Group 11                       |
| REQ-F14.2        | §12.4 triggers and outbox                         | ADR-013          | M5.4               | Group 14.2 (committed-only), Group 6 interaction |
| REQ-F14.3, F14.4 | §12.3.2 sound, §12.3.3 vibration                  | ADR-013          | M5.4               | Group 14.1, 14.8                                 |
| REQ-F14.5        | §12.5 Web Push, §12.5.7 notification identity     | ADR-013          | M5.4               | Group 14.3, 14.5, 14.6, 14.13, 14.14             |
| REQ-F14.6        | §12.6 delivery states                             | ADR-013          | M5.4               | Group 14.4                                       |
| REQ-F14.7        | §12.4 savepoint, §12.7 failure behaviour          | ADR-013          | M5.4               | Group 14.2 (isolation), 14.7 (no state change)   |
| REQ-F14.8        | §12.4.2 per-device enqueue, §12.5.4 worker        | ADR-013          | M5.4               | Group 14.2, 14.4                                 |
| REQ-F14.9        | §12.3 accessibility                               | ADR-013          | M5.2, M5.4         | Group 11, Group 14.8                             |
| REQ-F14.10       | §12.5, §12.8 security                             | ADR-013          | M5.4               | Group 14.5, 14.6; Group 8                        |
| REQ-F14.11       | §12.11 verification                               | ADR-013          | M5 exit            | Group 14, `docs/testing/M5-evidence.md`          |
| REQ-F4.7–F4.12   | §15.2–§15.6, §15.5a, §15.9–§15.13 recovery        | ADR-015          | M5.1               | Group 8: 8.R1–8.R7, 8.R11                        |
| REQ-F4.13, F4.14 | §15.7 grace/rejoin, §15.8 auto no-show            | ADR-015, ADR-013 | M5.1               | Group 8: 8.R8, 8.R9, 8.R12; Group 14.7           |
| REQ-F4.15        | §15.14 retention                                  | ADR-015          | M5.1               | Group 8: 8.R10                                   |
| REQ-F7.10–F7.17  | §16 accessibility                                 | —                | M5.2               | Group 11: 11.A1–11.A9, 11.A11                    |
| REQ-F9.6–F9.9    | §17.3–§17.6 states, alerts, coordinator           | —                | M5.3               | Group 8: 8.D1, 8.D3, 8.D4, 8.D6; Group 6         |
| REQ-F9.10–F9.14  | §17.7–§17.11 privacy, lost device, retention      | —                | M5.3               | Group 8: 8.D2, 8.D5; Group 11: 11.A10            |
| REQ-F11.8–F11.13 | §13 SMS turn alerts                               | ADR-009, 013     | M6.1, M6.3         | Group 10; Group 14 pipeline reused               |
| REQ-F15.1, F15.2 | §14.2 tokens, §14.3 redesign                      | ADR-014          | M7.1               | Group 11, Group 15                               |
| REQ-F15.3, F15.4 | §14.4 landing, §14.5 motion                       | ADR-014          | M7.2               | Group 15                                         |
| REQ-F15.5–F15.9  | §14.6 performance, §14.7 security, §14.8 browsers | ADR-014          | M7.1, M7.2, M7.3   | Group 15                                         |

## Traceability: milestone map (reconciled 2026-11-12)

| Milestone | Scope                                                                         | Requirements                                    | Status                               |
| --------- | ----------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------ |
| M0        | Foundation                                                                    | REQ-NFR, tooling                                | Merged into `staging` (PR #1)        |
| M1        | Tenancy, roles, facility setup                                                | REQ-F10, REQ-SEC                                | Merged (PR #2)                       |
| M2        | Queue core, visitor flows, estimates                                          | REQ-F1 (online), F2, F6                         | Merged (PR #4)                       |
| M3        | Continuity Engine                                                             | REQ-F1 (offline), F9                            | Merged (PR #5)                       |
| M4        | Fairness, overrides, audit, routing                                           | REQ-F3, F5, F8                                  | Merged (PR #6, `01927e4`)            |
| M5        | Recovery, accessibility, device health, **Smart Turn Alerts**                 | REQ-F4, F7, F9, **F14**                         | Planned — stabilization (M5.0) first |
| MQ        | Ask Que Anything (after M5, before M6)                                        | REQ-F13                                         | Planned (spec only)                  |
| M6        | **SMS Turn Alerts** and USSD channels (channel-adapter architecture)          | REQ-F11 (incl. F11.8–F11.13), F12, F2.4         | Planned                              |
| M7        | **Final UI/UX, branding, animated landing page**, hardening, demo, submission | REQ-F15, all features, REQ-F13 final regression | Planned                              |
