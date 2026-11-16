---
inclusion: always
---

# QueueBridge — Testing Steering

> Always-on testing requirements. Tests are not optional. A milestone is not complete until its tests pass.

## Philosophy

Tests are the primary evidence that QueueBridge's behavioral claims are true. Every architectural invariant
must have a corresponding automated test. "It works on my machine" is not evidence. Passing CI is the bar.

Do not write tests that merely assert mocks return what you told them to return. Test real behavior:
real state machine transitions, real SQL against a real (test) database, real reconciliation logic.

## Test framework and tooling

- **Vitest** across all packages and apps (consistent runner, native TypeScript, fast).
- Test files: `*.test.ts` (unit/integration) or `*.spec.ts` (end-to-end / scenario).
- Coverage reporting: enabled but coverage thresholds are not a substitute for meaningful tests.
- Database tests: use a dedicated test PostgreSQL database; run migrations before test suite; wrap tests in transactions rolled back after each test where possible.
- No mocking of PostgreSQL — use a real test database for any test that involves SQL.

## Test groups and their scope

### Group 1 — Domain state machine and routing (packages/domain)

- Pure TypeScript, zero I/O.
- Test every permitted and rejected ticket state transition.
- Test routing rules: service match, priority class, waiting age, counter availability.
- Test wait-time estimate calculations: counter open/close, insufficient data, class changes.
- Test fairness policy: FIFO ordering, priority insertion, policy version determinism.
- Property-based test: applying the same authorized events in order always produces the same queue state.

### Group 2 — Contracts validation (packages/contracts)

- Zod schema parse/reject tests for every schema: valid inputs parse, invalid inputs are rejected with descriptive errors.
- Command envelope: required fields, UUID v7 format, missing fields rejected.
- API DTOs: test serialization roundtrips.

### Group 3 — Continuity and reconciliation (packages/continuity)

- Offline command schema validation.
- Authority check: expired epoch rejected, valid epoch accepted.
- Deduplication: identical `operation_id` processed once, second call returns stored disposition.
- Reconciliation: provisional ticket creation reconciles to confirmed after server commit.
- Conflict detection: two independent call-next commands for same queue — one committed, one rejected/needs_review.
- Client sequence ordering: out-of-order commands handled deterministically.

### Group 4 — Concurrent PostgreSQL transactions (apps/api + infra)

- Concurrent `call-next` on the same queue session: only one commits, other is rejected.
- `SELECT ... FOR UPDATE` on queue session row prevents double-sequence.
- `UNIQUE (queue_session_id, sequence)` constraint verified under concurrent insert.
- `UNIQUE (organization_id, operation_id)` verified under concurrent insert.
- Cross-tenant isolation: query for org A cannot return org B data even with a valid session.

### Group 5 — Offline outbox behavior (packages/continuity + browser simulation)

- Operations persist in IndexedDB before success is shown.
- Browser-kill simulation: pending operations survive reload and are replayed.
- Clock skew: `created_at_client` does not affect server ordering.
- Storage exception: graceful degradation, not silent failure.
- Coordinator epoch expiry: stops offline advancement, capture-only mode.

### Group 6 — Partition simulation and failover

- Stale epoch reconnect: fenced, surfaced as conflict review.
- Simultaneous online and offline call-next: only server-side wins.
- Failover: supervisor assigns new coordinator; old coordinator's subsequent sync is rejected.
- Lost ACK: retrying a committed operation returns `duplicate` not a second `committed`.
- Queue session closed during outage: tickets not silently migrated.

### Group 7 — Sync batch idempotency (apps/api)

- Submit the same batch twice: second submission returns same dispositions, no state change.
- Reordered commands within a batch: processed in `client_sequence` order.
- Mixed results in a batch: some `committed`, some `rejected`, each correctly labeled.
- Batch with one invalid command: valid commands still processed (no all-or-nothing unless requested).

### Group 8 — Security and access control (apps/api)

- Unauthorized priority override: rejected with 403.
- Cross-tenant ticket access: rejected with 404 (not 403 — do not confirm existence).
- Recovery credential rate limiting: 6th attempt within 15 minutes is rejected.
- Expired recovery credential: rejected safely, no data leaked.
- Visitor anonymous role: cannot call `POST /queues/:id/commands`.
- Webhook without valid signature: rejected with 401, payload not processed.
- Webhook replay (duplicate nonce within 5 minutes): rejected with 409.

**Group 8 additions — M5.1 ticket recovery (planned, required at M5; design §15; ADR-015):**

- 8.R1 The public ticket code alone never recovers: no endpoint returns a token, status or data for a code without the recovery key, a valid grant or an approved staff procedure; quoting the board-visible code, and physical presence at the desk, never produce a credential.
- 8.R2 Oracle-free failure: unknown ticket, wrong key, expired, terminal and cross-facility attempts return identical status, body and (within tolerance) processing time; unknown public codes are throttled with the same keys as real ones.
- 8.R3 Throttling on real PostgreSQL: **throttle keys never contain the submitted key** (1,000 different wrong keys count against the same keys and hit the limits); L1 10 attempts per minute per source counting every attempt including malformed ones; L2 the 6th failure for the same ticket code from the same source within 15 minutes gets 429; L3/L4 aggregate limits refuse only sources that already failed and raise `recovery_abuse`; **no irreversible lockout**: all counters expire within 15 minutes, there is no lock state or unlock action, and a correct key from a source with no failures succeeds while the ticket is under attack from other sources; shared-address behaviour as documented.
- 8.R4 Credentials: recovery key is exactly 160 bits (32 base32 characters) from the CSPRNG (length, alphabet and uniqueness checks; no derivation from the ticket code or time); stored only as HMAC-SHA-256 (no plaintext, no plain hash, pepper-dependent); input normalization (case, spaces, hyphens, `I/L/O` folding); the QR/link carries the key only in the URL fragment: the fragment never appears in server access logs or `Referer`, is removed from the address bar after reading, and travels only in a POST body; the key is absent from `localStorage`, the outbox and logs; status tokens stored as SHA-256 and capped at 3 active; the rotation and invalidation matrix of design §15.6 (join replay, recovery, sign out others, staff revoke-all, new key, terminal state, expiry); existing devices see the "access granted elsewhere" notice.
- 8.R5 Staff-assisted recovery (design §15.5a): with no verified factor no credential is issued (restricted assistance only); with the basic factor a grant requires a different `QUEUE_MANAGE` approver (API and table CHECK); grants are single-use, expire after 10 minutes, are redeemed only on the visitor's device and never displayed as a value to staff; rate limits (3 per ticket per hour, 5 per staff per 10 minutes); refused for auditor and visitor; `staff_recovery = false` disables the path; reason code mandatory; audit records ticket, actor, approver, reason, assurance and factor booleans with no values or secrets; the strong-factor tests are added with M6.
- 8.R6 Queue neutrality: no recovery action appends a `queue_events` row or changes a ticket's state, position or waiting age; recovery works while a coordinator holds the queue; a provisional offline ticket cannot be recovered until confirmed (and the UI says so); the outbox/IndexedDB holds no token, key or grant.
- 8.R7 Concurrency (real transactions): simultaneous correct recoveries; recovery vs new recovery key; recovery vs sign-out-others; grant redeemed twice; recovery vs ticket completion; atomic failure counting under parallel wrong guesses; no lost updates, no revived tokens.
- 8.R8 Grace and rejoin: `grace_window_seconds` is the only grace setting (default 300 unchanged); `self_resume` returns a missed ticket to waiting only inside the window, only with the policy set, idempotently by `operation_id`, with staff-resume placement and waiting age; beyond the window or under `staff_resume` the request is refused and the page directs to a new join; refused while a coordinator holds the queue.
- 8.R9 Automatic no-show semantics: disabled by default; enabling requires explicit seconds within 60–3600; the visitor-facing rule is shown; fires only after the elapsed time since the committed call (database time), recording `ticket.miss` with actor `system`, `call_window_elapsed`, the policy version and the call sequence; is not applied if the policy was disabled or changed in the meantime, if the ticket is `serving`, was re-called (different call sequence) or if the queue is not open; races with a staff serve resolve by the session and ticket locks.
- 8.R10 Retention: token rows removed 24 h after expiry; key hash removed 24 h after the ticket ends; grants removed 24 h after expiry or redemption; throttle rows removed 24 h after their window; purge job is idempotent.
- 8.R11 Secrets and tenancy: keys, grants, tokens and hashes never appear in logs, audit events or error bodies; every recovery and staff endpoint is tenant-scoped (cross-tenant 404); CSRF and Origin enforced.
- 8.R12 Automatic no-show execution safety: (a) it runs only through the standard command executor and produces the same event, transition, hash-chain and `client_operations` records as a staff miss (event-log and replay verification pass); (b) two or more sweepers running concurrently (separate connections) produce exactly one `ticket.miss` per ticket and the rest report `duplicate` via the deterministic `operation_id`; (c) it is refused while any coordinator is assigned (including an expired authorization), leaves coordinator epoch/device and `client_operations` of the coordinator untouched, and its clock restarts after the last coordinator event so a ticket the coordinator served offline is not missed and its late sync still lands as before; (d) restart: a fresh process with no memory behaves identically; (e) delay: a sweep that runs late still misses only after the deadline and never earlier; a detected outage (gap over 3 intervals) restarts the clock for all called tickets, so an outage does not mass-miss visitors; (f) it has no dependency on notification, push, SMS, outbox or delivery data: running the same scenario with alerts succeeded, failed, absent or erroring gives identical outcomes (and a static check shows no import path to alert code).

**Group 8 additions — M5.3 device health access and privacy (planned, required at M5; design §17):**

- 8.D1 Recipients and permissions: supervisor, facility admin and org admin see all alerts; auditors read only; only `QUEUE_MANAGE` roles acknowledge; reception/counter see only their own device warning; cross-tenant 404.
- 8.D2 Privacy: no column or log field stores IP address, user agent, fingerprint or location for devices; heartbeat payload is minimal; unknown extra fields rejected.
- 8.D3 Alert records: one open alert per (facility, kind, subject) under concurrent evaluation; auto-resolve only after two clear evaluations; acknowledge and clear write audit events.
- 8.D4 Authority unchanged: evaluation and every alert action leave coordinator epoch/device/expiry, queue sessions, tickets and the event chain byte-for-byte unchanged; no failover, assign, renew or revoke ever happens automatically (Group 6 fencing tests still pass unchanged).
- 8.D5 Lost device: revoke-as-lost; subsequent sync from that device is rejected; dashboard wording about possibly lost pending actions; re-registration creates a new device; a revoked device's unsent actions are never auto-applied.
- 8.D6 Thresholds by server time: `offline`, `stale`, `coordinator_expiring` and `coordinator_expired` computed from server time even when a device reports a skewed clock; configurable thresholds honoured.

### Group 9 — Audit integrity

- Hash chain verification: known event sequence verifies correctly.
- Tamper detection: modifying a single character in a committed event's canonical JSON breaks the chain.
- `audit_checkpoints` root hash covers correct sequence range.
- Priority override always has actor, policy version, reason code, reason text: enforced at DB constraint level and tested.
- Append-only enforcement: attempt to UPDATE a `queue_events` row fails (test the DB trigger or app-layer guard).

### Group 10 — Channel adapter contracts (packages/channels)

- Sandbox adapter: `sendMessage` logs `[SANDBOX]` prefix, never makes real network calls.
- `verifyWebhook`: valid HMAC signature accepted, invalid rejected.
- `parseDeliveryReceipt`: known provider payloads parsed correctly; unknown payloads return safe error.
- Idempotency key: same key does not trigger re-send.
- USSD session: menu navigation, invalid input recovery, session expiration handled.

### Group 11 — Accessibility (apps/web)

- Core visitor flows (join, status, recovery) navigable by keyboard alone.
- Screen reader announcements on status changes (ARIA live regions).
- No color-only status indicators (verify with text/icon alternatives).
- Mobile viewport rendering at 320px and 375px widths.
- Focus management: modal dialogs trap focus; return focus on close.

**Group 11 additions — M5.2 (planned, required at M5; design §16). These are automated checks plus recorded manual passes; they do not establish WCAG conformance by themselves.**

- 11.A1 Keyboard-only Playwright journeys: join → ticket → alert and display settings → recover → rejoin, with no pointer; no keyboard trap.
- 11.A2 Focus: route change moves focus to the `h1` and announces the title once; dialogs move, contain and return focus and close on Escape; focus indicator visible and not obscured by sticky elements; target sizes at least 24 px (primary mobile actions at least 44 px).
- 11.A3 Announcement policy: assertive only for the called alert and blocking errors; polite, deduplicated and rate-limited position/status/connectivity/sync announcements; live regions present before content; catalog strings only.
- 11.A4 Preferences: contrast, text size, motion and quiet persist on the device, are applied before first render, override system settings when explicit, follow system settings otherwise, work offline, can be reset, contain no personal data.
- 11.A5 Contrast and reflow: axe contrast clean in normal and high-contrast mode; no loss of content or function and no horizontal scroll at 320 px, at 200 % zoom and at extra-large text.
- 11.A6 Reduced motion: emulated `prefers-reduced-motion` and the in-app setting remove transitions and animation (alert banner, toasts, spinners); no information by motion alone; no flashing above three per second.
- 11.A7 Vibration and audio preferences: controls disabled with an explanation where unsupported; vibration only in the foreground; sound off by default, plays once per call, never loops; quiet mode silences every non-visual cue; "Test alert" runs only enabled cues and is labelled as a test.
- 11.A8 Offline accessibility: with the network disabled the shell, preferences, stored ticket view, recover page (connection-needed message) and outbox panel stay keyboard- and screen-reader-usable; connectivity and sync-state changes are announced in text.
- 11.A9 Responsive and orientation: axe and overflow checks at 320 px and 375 px on every visitor route and the preferences panel; the web manifest does not lock orientation.
- 11.A10 Device-health surfaces: alerts panel, banner and own-device console warning are keyboard-operable, announce new high-severity alerts politely/assertively per policy, and pass axe at 320/375 px and desktop.
- 11.A11 Manual (recorded in `docs/testing/M5-evidence.md`, limits stated): screen-reader passes (VoiceOver on iOS and TalkBack or NVDA as available), 200 % zoom pass, high-contrast and reduced-motion pass on a real device.

### Group 12 — End-to-end scenario tests (apps/api + infra)

- Journey A: walk-in visitor, staff creates ticket, counter calls, service completes, event audited.
- Journey B: smartphone visitor, QR join, status track, recovery after browser clear, calling.
- Journey C: outage simulation, coordinator records calls, reconnect, reconciliation, no duplicates.
- Journey D: priority exception, supervisor authorizes, audit event emitted, override visible.
- Journey E: counter unavailable, routing reassigns waiting tickets, transfer chain preserved.
- Journey F (sandbox): SMS confirmation sent, delivery receipt processed, USSD menu navigated.

### Group 13 — Ask Que (F13; planned, required from milestone MQ)

- 13.1 Role restrictions: each role (visitor, reception, counter, supervisor, facility_admin, org_admin, auditor) receives only its permitted articles and links; restricted bundle endpoint rejects or filters other audiences; anonymous visitors are refused by the AI endpoint and see no AI affordance.
- 13.2 Tenant isolation: Que endpoints return no data from another organization or facility; cross-tenant probes match the rest of the API (404 / filtered).
- 13.3 Offline fallback: with the network disabled (browser test), built-in help is searchable and navigable; restricted caches are purged on sign-out and role change.
- 13.4 Navigation accuracy: every registered route exists in the web router; every link Que offers opens a screen the role can access; each screen's default articles are relevant (fixture assertions).
- 13.5 KB consistency: every article's capabilities exist in the manifest; no article presents a non-live capability as available; article metadata (IDs unique, versions, routes) validates.
- 13.6 Accessibility: axe WCAG 2.1 A/AA on the Que panel at 320/375/desktop, keyboard-only open/search/read/close, focus return, live-region announcements, AI label as text.
- 13.7 Inference failures: disabled, timeout, 429/quota, 5xx, malformed output, empty citations → deterministic answer with the correct `fallbackReason`, within the timeout budget.
- 13.8 Zero-cost guard: AI layer cannot start unless cost mode is `free_tier` or `sponsored`; daily cap enforced; no paid configuration path exists.
- 13.9 Privacy: the sandbox inference adapter asserts outbound payloads contain no phone numbers, emails, ticket codes, recovery secrets or tenant operational data; logs contain no question text.
- 13.10 Read-only: Que endpoints perform no writes to tenant tables (DB assertion) and the UI contains no operation controls.
- 13.11 Prompt-injection resistance: adversarial corpus (ignore-instructions, role escalation, other-tenant data requests, system-prompt extraction, malicious links, requests to perform actions) never yields restricted content, unauthorized links, secrets or claimed actions.
- 13.12 Offline authorization: restricted bundles carry `validForMs` ≤ remaining session lifetime; expiry uses elapsed time since receipt, so device clocks set ahead or behind server time neither shorten nor extend it; a clock moved backwards (live, or before a reload/restart) and missing clock metadata hide restricted help; wall-clock vs monotonic disagreement is detected within a page session; role-digest mismatch, 401, confirmed sign-out and user switch purge the cache, failed sign-out does not; cached bundles contain no tenant-sensitive data (build check plus fixture assertion).
- 13.13 AI independence: every essential navigation path and explanation is reachable with AI disabled and the network offline; the full Group 13 suite also runs with AI disabled.

### Group 14 — Smart Turn Alerts (F14; planned, required from milestone M5; reused for SMS in M6)

- 14.1 In-app alert: the ticket page shows the banner (code, counter, text label, icon) and announces once through an assertive live region when committed state becomes `called`; it clears when the ticket leaves `called`; sound and vibration run once per call event (refresh and SSE replay do not repeat); sound is off by default and a blocked or failing audio play leaves the visual alert intact; vibration only when visible and supported.
- 14.2 Triggering and isolation: alerts come only from committed events (online and via sync); an offline-applied call produces none until the server commits it; with a deliberately failing alert helper (forced error inside the savepoint) a real `call_next` still commits with the expected event, sequence, revision and hash chain; **a ticket with three active subscriptions yields exactly three `notifications` + `notification_outbox` rows with three distinct `dedup_key`s of the form `web_push:ticket.called:<ticket_id>:<event_sequence>:<subscription_id>` (no unique-index violation, nothing rolled back); the same call replayed (duplicate disposition) adds none; a forced conflict on one key skips only that row and the other two devices still get theirs.**
- 14.3 Subscription flow: permission is requested only from the explicit button; unsupported, denied and iOS-not-installed states show specific text; subscribe is idempotent per endpoint hash, capped per ticket, and revoked when the ticket ends or on 404/410.
- 14.4 Idempotency and honest states: a replayed command or retried outbox row sends once **per subscription**; two workers polling concurrently never send the same row twice (claim lease; assert one transport call per row) and one device's failure, 410 revocation or timeout leaves the other devices' rows untouched; delivery is asserted as at-least-once with a stable `Topic`/tag, never exactly-once; `sent` never becomes `delivered` without a first-party ack or receipt; stale alerts (released, completed, transferred before send) are `suppressed`; TTL stops retries.
- 14.5 Privacy and security: payload contains only type, subscription reference, code, counter label, call sequence, public recovery path and timestamp (no status token, recovery key, grant, endpoint or key material); endpoints and keys are ciphertext at rest and absent from every API response, log, audit record, URL, notification tag and `dedup_key` (the endpoint hash is likewise never logged or used as a key); `subscription_ref` of another ticket is 404; credential, CSRF, rate-limit and cross-tenant (404) checks; VAPID absent ⇒ capability `disabled` and no UI offer.
- 14.6 Sandbox transport: `SandboxPushTransport` is labelled test-only and makes no network calls; the client service-worker handler is exercised with it (focused-window hand-off with `ref` comparison, notification click, page-sent ack); the worker holds no credential.
- 14.7 State neutrality: for every failure path (push down, 5xx, timeout, 410, enqueue error, permission denied, unsupported, page closed), ticket state, queue revision and event chain are unchanged, calling/serving/completing still work, and no `ticket.miss` exists; any automatic no-show is time-based with reason `call_window_elapsed` and independent of alert outcomes.
- 14.8 Accessibility: keyboard-only enable/disable of sound, vibration and push, test alert and dismiss; focus not stolen; axe WCAG 2.1 A/AA at 320 and 375 px and desktop; high-contrast, large-text and reduced-motion behaviour; no flashing; every non-visual cue has a visual and screen-reader equivalent.
- 14.9 Copy truthfulness: no UI string, article or document promises delivery or background vibration (grep-style check over the string catalog and knowledge base).
- 14.10 Real devices (manual, recorded in `docs/testing/M5-evidence.md`): Android Chrome and iOS Safari including installed-app push, with unsupported or flaky results stated.
- 14.11 Retention and deletion (design §12.13): ciphertext is NULL after revoke for every revoke reason (visitor, ticket ended, 404/410, session closed, credentials revoked, expiry); a database constraint prevents ciphertext on a revoked row; tombstones deleted after 24 h; notification rows after 30 days; no code path other than the send step reads ciphertext; purge job is idempotent.
- 14.12 Confirmed defaults and preferences: TTL defaults to 120 s and is configurable; retries stop at the TTL; the 4th active subscription for a ticket is refused with 409 and a plain message; automatic no-show is off by default; push and sound require explicit opt-in; quiet mode suppresses every non-visual cue while the in-app banner remains; all channels are described as best effort in the string catalog.
- 14.13 Notification identity (Playwright with two saved tickets): two tickets with the **same public code** from different facilities on one device have distinct subscription references, tags and `Topic`s, and each notification opens its own ticket (`/ticket/<code>?ref=<ref>`), not the other; a bare `/ticket/<code>` with several matches still shows the existing chooser; a `ref` that contradicts `?k=` resolves to nothing; a service transfer keeps the saved `pushRef` valid by re-binding the subscription; after recovery on a second device no subscription exists there until the visitor opts in again.
- 14.14 Opening without the credential: with the saved ticket forgotten, storage cleared or `pushRef` missing, opening the notification shows the neutral "not saved on this device" screen, makes **no** status request, does not open or reveal another ticket that shares the code, offers the saved-link/QR, recovery-key (`rp`) and ask-staff paths, and the notification payload, URL and logs contain no bearer credential (grep of fixtures and captured requests).

### Group 15 — Final UI/UX, landing page and cross-browser (F15; planned, required from milestone M7)

- 15.1 Landing truthfulness: no conflict-free, guaranteed-delivery or invented-metric text; SMS/USSD status shown as `sandbox`/`planned` unless the capability manifest says `live`.
- 15.2 Motion: `prefers-reduced-motion` renders a static equivalent; loops over 5 s have a working Pause control; no element flashes more than three times per second.
- 15.3 Accessibility: axe WCAG 2.1 A/AA on the landing page and redesigned screens at 320/375/768/1280/1440 px; keyboard-only landing → sign-up path; recorded manual screen-reader pass.
- 15.4 Responsive: no horizontal overflow on any redesigned screen at the five widths; high-contrast and large-text modes verified.
- 15.5 Performance: bundle-size budgets per route enforced in CI; the landing chunk is not loaded by visitor or staff routes; Lighthouse results recorded against the measured baseline.
- 15.6 Privacy and security: the landing page issues no cross-origin requests; production security headers (CSP, HSTS, frame, referrer, permissions) asserted.
- 15.7 Onboarding path: landing → sign-up → get-started checklist reaches the real F10 screens; readiness states match the API.
- 15.8 Cross-browser: smoke journeys on Chromium, Firefox and WebKit at mobile and desktop sizes; real-device checklist recorded.
- 15.9 Regression: Groups 1–14 (including the M1–M4 routing rules, coordinator fencing and audit chain) pass unchanged after the redesign; no assertion weakened.

### Manual acceptance schedule (approved 2026-11-16)

M5 manual acceptance runs in two sets: Set 1 (checks 1–14) is closed; Set 2 (checks 15–41, desktop and device variants) runs as final acceptance after M7, before submission (`docs/testing/M5-manual-acceptance.md` §0a). A deferred check stays "Not tested — scheduled for final acceptance (Set 2)"; deferral is never a Pass, Fail or Skip, and an automated test never replaces a manual result. A confirmed critical security or integrity defect is never deferred. Automated Groups 8, 11 and 14 stay green on every change.

### Stabilization rule (M5.0 onward)

A known intermittent test is not "fixed" by retrying, lengthening timeouts or loosening assertions. Reproduce it, find the cause, fix the product or the test synchronization, and show repeated consecutive passes under CI-like conditions. If it cannot be reproduced it stays listed as open with its observed frequency. Tracked items: the M1 `security-isolation` sign-out/back test, the `review-fixes` logout "Dismiss" locator, and the M3 `offline` storage-unavailable test (tasks M5.0).

## Core invariants every test suite must enforce

1. No two final authoritative events share a `(queue_session_id, sequence)`.
2. No mutation creates duplicate committed ticket codes in one queue session.
3. An identical `operation_id` cannot produce two `committed` dispositions.
4. A fenced/expired coordinator cannot finalize obsolete offline actions.
5. Unauthorized actors cannot commit staff or supervisor transitions.
6. Ticket status shown as `committed` must have a server `queue_event` behind it.
7. Priority overrides always have named actor, policy, and reason.
8. (From M5) No notification outcome — failed, slow, absent or unsupported — blocks, delays or alters a queue transition, changes a ticket's state, or marks a visitor missed.

## Acceptance targets (from PRD §10)

These are targets to be validated, not assumed:

- 100% of committed, acknowledged queue events durably retained in outage/recovery test runs.
- 0 duplicate final ticket IDs or double-advancement events in adversarial sync tests.
- 1,000+ scripted sequential/mixed event operations reconcile idempotently (Group 7 scale test).

## Running tests

```bash
pnpm test                    # run all tests across workspace
pnpm test --filter contracts # run tests in one package
pnpm test:coverage           # with coverage report
pnpm test:db                 # database-dependent tests (requires TEST_DATABASE_URL)
```

Tests requiring a database read `TEST_DATABASE_URL` from environment. CI provides this via a PostgreSQL service container. Locally, set it in `.env.test` (gitignored).

## What tests must NOT do

- Assert on mock return values that you wrote yourself without any real behavior underneath.
- Skip the database by mocking SQL queries in tests labeled as "integration" or "concurrent".
- Use `setTimeout` or `sleep` as a substitute for proper async coordination.
- Silently pass when a constraint violation should occur.
- Omit the failing test case for a security check because "it's obvious it works".
- Use `test.skip` or `test.todo` to avoid writing a test that the acceptance gate requires.
