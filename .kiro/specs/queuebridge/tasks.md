# QueueBridge — Spec Tasks

**Spec version:** 1.1 (2026-11-12)  
**Status:** **M0–M4 complete and merged into `staging`** (PRs #1 M0, #2 M1, #3 F13 spec, #4 M2, #5 M3, #6 M4; `staging` at `01927e4`, M4 merged 2026-11-12 after CI green, manual acceptance 17/17 and Codex review with no open findings). **Next: M5** (Recovery, Accessibility, Device Health **and Smart Turn Alerts**), starting with stabilization task group M5.0. Planned after M5: MQ (Ask Que, F13), M6 (**SMS Turn Alerts** and USSD), M7 (**Final UI/UX, animated landing page**, hardening, demo, submission). Nothing in M5–M7 or MQ is implemented yet.  
**Update (2026-11-16):** M5 is implemented on `feature/m5-recovery-accessibility-alerts` (not yet merged). M5 manual acceptance runs in two sets (approved 2026-11-16): **Set 1 (checks 1–14) closed, 14 / 14 Pass**; **Set 2 (checks 15–41) is final acceptance after M7**. Remaining sequence: **M5 checkpoint → MQ → M6 → M7 → Set 2 acceptance → submission**. Confirmed critical security or integrity defects are never deferred.  
**Update (2026-11-16, MQ reconciliation):** **M5 merged into `staging`** (PR #8, merge commit `cebbe06`, all CI checks green). ADR-011 accepted. **Next: MQ** (entry criteria below). Reconciliation record: `docs/reports/MQ-design-readiness.md`.  
**Each task:** implement → test → validate → mark done

---

## M0 — Project Foundation

> Complete; merged into `staging` via PR #1 (`4ed1478`). Evidence: `docs/testing/M0-evidence.md`,
> `docs/testing/M0-ci-correction.md`. Report: `M0-completion.md`.

### M0.1 Kiro persistent configuration ✅

- [x] `AGENTS.md` — engineering rules, security, git workflow, mandatory validation
- [x] `.kiro/steering/product.md` — always-on product scope
- [x] `.kiro/steering/architecture.md` — always-on architecture invariants
- [x] `.kiro/steering/security.md` — always-on security constraints
- [x] `.kiro/steering/testing.md` — always-on testing requirements
- [x] `.kiro/specs/queuebridge/requirements.md` — full requirement traceability
- [x] `.kiro/specs/queuebridge/design.md` — architecture and module design
- [x] `.kiro/specs/queuebridge/tasks.md` — this file

### M0.2 Monorepo foundation

- [x] Root `package.json` with pnpm workspace scripts
- [x] `pnpm-workspace.yaml` declaring all apps and packages
- [x] Root `tsconfig.base.json` with strict mode settings
- [x] All `apps/` and `packages/` directories initialized with `package.json` and `tsconfig.json`
- [x] Workspace dependency linking verified (`pnpm install` succeeds)

### M0.3 Shared packages skeleton

- [x] `packages/contracts`: Zod schemas for CommandEnvelope, Ticket, QueueSession, QueueEvent, SyncBatch, ApiError, WaitEstimate
- [x] `packages/domain`: ticket state machine stub with all states and transitions declared
- [x] `packages/continuity`: coordinator epoch validation, command envelope creation stubs
- [x] `packages/channels`: `ChannelAdapter` interface, `SandboxSmsAdapter`, `SandboxUssdAdapter`
- [x] `packages/ui`: component stubs with accessible HTML structure for `TicketCard`, `SyncStateIndicator`, `QueueStatusBanner`

### M0.4 Application skeletons

- [x] `apps/api`: Fastify server with health endpoints (`/health`, `/health/ready`), plugin stubs, env validation
- [x] `apps/web`: Vite + React app with PWA manifest, offline shell, routing stubs, i18n setup
- [x] `apps/worker`: process entry point, outbox poll loop stub, graceful shutdown

### M0.5 Database foundation

- [x] `infra/migrations/0001_initial_schema.sql` — all tables from architecture §6 with correct constraints
- [x] `infra/migrations/0002_append_only_trigger.sql` — `queue_events` append-only trigger
- [x] `infra/seeds/dev_seed.sql` — one org, one facility, one service, one counter, one staff user
- [x] Migration runner script in root `package.json` (`pnpm db:migrate`, `pnpm db:seed`)
- [x] Migrations verified idempotent (run twice → no error)

### M0.6 Developer tooling

- [x] ESLint 9 flat config at root with TypeScript plugin, applied to all packages and apps
- [x] Prettier config at root, consistent with 2-space indent, single quotes
- [x] `pnpm lint`, `pnpm format`, `pnpm format:check` scripts working
- [x] `pnpm typecheck` script running `tsc --noEmit` across all packages
- [x] `.env.example` at root and per app with all required variables and safe placeholders
- [x] `.gitignore` covering `.env`, `node_modules`, `dist`, `.turbo`, build artifacts

### M0.7 Initial tests

- [x] `packages/contracts`: Zod schema parse/reject tests (≥ 10 meaningful assertions)
- [x] `packages/domain`: ticket state machine transition tests (all valid and invalid transitions)
- [x] `packages/continuity`: coordinator epoch validation tests
- [x] `packages/channels`: SandboxAdapter tests (no real network, SANDBOX label present)
- [x] `apps/api`: health endpoint tests (200 from `/health`, DB connection check from `/health/ready`)
- [x] `infra`: migration idempotency test (apply migrations twice, verify table structure)
- [x] All tests pass: `pnpm test`

### M0.8 CI

- [x] `.github/workflows/ci.yml`: lint → typecheck → test → build on push/PR
- [x] `.github/workflows/db-validate.yml`: PostgreSQL service container, run migrations, verify constraints
- [x] CI passes on `feature/m0-foundation`

### M0.9 Documentation

- [x] `README.md`: project overview, local setup, architecture diagram reference, Kiro contribution summary
- [x] `docs/adr/ADR-001.md` through `ADR-010.md`: one ADR per architecture decision
- [x] `docs/testing/M0-evidence.md`: test run outputs
- [x] `M0-completion.md`: full implementation report

### M0 exit criteria (ALL must pass before M0 is complete)

- [x] `pnpm typecheck` — zero errors
- [x] `pnpm lint` — zero errors
- [x] `pnpm format:check` — no violations
- [x] `pnpm test` — all tests pass
- [x] `pnpm build` — all packages and apps build
- [x] `pnpm db:migrate` — migrations apply cleanly to fresh DB
- [x] CI green on `feature/m0-foundation`

---

## M1 — Tenancy, Roles, Facility Setup (F10 foundation)

> Complete; merged into `staging` via PR #2 (`d0ceb6f`). Evidence: `docs/testing/M1-evidence.md`.
> Report: `M1-completion.md`.

### M1.1 Organization and facility APIs

- [x] `POST /api/v1/organizations` — create org with admin user
- [x] `POST /api/v1/facilities` — create facility under org
- [x] `POST /api/v1/facilities/:id/services` — add service
- [x] `POST /api/v1/facilities/:id/counters` — add counter
- [x] `POST /counter_service_capabilities` — assign service to counter

### M1.2 Staff and RBAC

- [x] Staff authentication: signup, login, session cookie
- [x] Role assignment: `facility_admin`, `supervisor`, `staff_counter`, `staff_reception`, `auditor`
- [x] RBAC middleware: every protected route validates role against resource scope
- [x] Staff invitation flow: invite → accept → role assignment (email delivery not configured: link is shown once to the admin and shared manually)
- [x] Tenant isolation tests: cross-org access returns 404

### M1.3 Facility admin UI (apps/web)

- [x] Org signup and facility creation form
- [x] Service and counter configuration
- [x] Staff invitation and role management
- [x] QR code and join link generation for facility

### M1.4 Post-review refinements (manual acceptance follow-up)

- [x] Organization/facility "address" fields renamed to "URL identifier (slug)" with explanatory hints
- [x] Notifications: dismissible (button + Escape), auto-dismiss after 8 s, hidden polite live region retained for screen readers
- [x] Facility readiness derived server-side (`GET /facilities/:id/readiness`): an ACTIVE counter must serve an ACTIVE service; counts alone never imply ready
- [x] Join link/QR labelled "Not live yet" until visitor registration exists (M2); API reports `operational: false`
- [x] Service policy display lists only the enabled priority classes
- [x] Inactive services/counters excluded from operational eligibility; assignments on inactive counters remain configurable and preserved
- [x] Staff screen: Active staff / Deactivated staff / Organization administrators / Pending invitations / Invitation history; org_admin deactivate and reactivate with confirmation
- [x] Role revocation, role grant, and deactivation proven effective for already-authenticated sessions (API + browser); UI returns to sign-in with a "session ended" notice on 401
- [x] API default port 3002 (3001 left free for other local projects)
- [x] Desktop layout: 80rem container, two-column workspace at >= 64rem, single column below

Deferred to M2 (not implemented here): routing-engine eligibility tests, visitor registration, making the join link operational.

### M1 exit criteria

- [x] Permission and isolation checks pass (all Group 8 security tests for M1 scope)
- [x] New facility can configure service, counter, invite staff without DB admin

---

## M2 — Queue Core and Visitor Flows (F1 online, F2, F3, F6)

> Complete; merged into `staging` via PR #4 (`25d3686`). Evidence: `docs/testing/M2-evidence.md`.
> Report: `M2-completion.md`.

### M2.1 Online queue operations

- [x] `POST /queues/:id/join` — create confirmed ticket (anonymous, idempotent, lost-ACK recovery)
- [x] `POST /queues/:id/commands` — call, serve, complete, pause, resume/recall, miss, cancel, transfer, queue open/pause/close
- [x] Queue session management: create session (per service per day, facility time zone), open/pause/close/reopen
- [x] Routing engine: select next eligible ticket per deterministic, versioned service policy
- [x] Staff walk-in registration endpoint `POST /queues/:id/walk-ins`
- [x] Hash-chained, append-only `queue_events` for every committed change; replay verified against tables

### M2.2 Visitor flows (apps/web)

- [x] Visitor join flow: QR scan → service selection → ticket issued
- [x] Live ticket status page with SSE updates (polling fallback)
- [x] Queue status and position display with wait estimate
- [x] Public board display with ticket calling (visual + optional spoken announcements)

### M2.3 Staff console (apps/web)

- [x] Staff dashboard: queue view, current ticket, call next button
- [x] Walk-in registration form (staff-assisted) with status-link QR
- [x] Counter controls: call, serve, complete, transfer, pause (plus missed, recall, cancel)

### M2.4 Wait-time estimates

- [x] Implement `computeWaitEstimate` in packages/domain (M2 amendment: non-zero-width interval, design §7)
- [x] Wire to ticket status endpoint
- [x] Display in visitor UI with explanation

### M2 exit criteria

- [x] Full online join-to-completion journey passes for web and staff channels
- [x] Group 1 (domain) and Group 4 (concurrent transactions) tests pass
- [x] Duplicate ticket prevention verified

### M2 deferrals (explicit)

- Priority classes beyond `normal`, priority overrides and routing position policy for transfers → M4
- Ticket recovery for lost status tokens, configurable grace/no-show automation → M5
- Offline capture, coordinator authority and sync batches → M3
- Operating hours (estimate clamp, design §7 step 6) → not yet scheduled; estimate states the limitation
- Final UI redesign → out of scope for M2

---

## M3 — Continuity Engine (F1 offline, F9)

> Complete; merged into `staging` via PR #5 (`f880abb`), CI green. Evidence:
> `docs/testing/M3-evidence.md`. Report: `M3-completion.md`.

### M3.1 Offline command capture

- [x] IndexedDB outbox in apps/web (`apps/web/src/offline/idb.ts`; logic in `packages/continuity/src/outbox.ts`)
- [x] Service worker for offline shell and asset cache (vite-plugin-pwa precache; authorized data in IndexedDB, never in the SW cache)
- [x] Coordinator authority validation (client-side, UI gating only — `evaluateOfflineAction`; the server re-verifies everything)
- [x] Offline ticket capture with `temporary_ticket_ref` (`P-XXXXXX`, never a ticket code)
- [x] `SyncStateIndicator` displayed on all relevant UI states (console tickets, outbox panel, connectivity bar)

### M3.2 Sync protocol

- [x] `POST /api/v1/sync/batches` endpoint with full server transaction (one transaction per command, session row lock)
- [x] `GET /api/v1/sync/queues/:id/snapshot` endpoint (repeatable-read snapshot, events after cursor, signed authority)
- [x] Epoch and revision checks in sync handler (stale epoch → needs_review; future epoch / wrong device / no token → rejected)
- [x] Per-command dispositions: `committed | duplicate | rejected | needs_review`

### M3.3 Conflict and recovery UI

- [x] Connectivity and recovery dashboard (F9) — `/staff/facilities/:fid/connectivity`
- [x] Device health view for supervisor (last contact, approx. pending, health, coordinator, failure code)
- [x] Conflict review queue: `needs_review` operations surfaced; apply (re-validated) or dismiss, with reason
- [x] Coordinator failover flow (assign / failover / renew / revoke; device revoke)

### M3.4 Offline acceptance tests

- [x] Architectural acceptance gate (architecture §16) answered in code and tests (`apps/api/src/acceptance-gate.db.test.ts`)
- [x] Group 3, 5, 6 tests pass (continuity unit tests, `sync-*.db.test.ts`, `coordinator.db.test.ts`, `e2e/offline.spec.ts`)
- [x] Partition simulation test: two call-next → only one committed (both arrival orders + simultaneous)

### M3 exit criteria

- [x] All six architectural acceptance gate questions answered with passing tests
- [x] `pnpm test` — Groups 3, 5, 6 all pass
- [x] Offline behavior NOT described as conflict-free (conflicts are surfaced for review, never merged)

### M3 deferrals (explicit)

- Offline `ticket.pause`, `resume`, `cancel`, `transfer` and queue session actions are online-only (rejected `action_not_offline` if synced)
- Server-side caps on device registration are per user/facility (20); no device attestation (devices are session-bound)
- Supervisor UI for device health shows server knowledge; automatic alerting/notification → M5
- Group 9 audit verification endpoint and checkpoints → M4 (M3 events are hash-chained like all others)

---

## M4 — Fairness, Overrides, Audit, Routing (F3, F5, F8)

> Complete; merged into `staging` via PR #6 (`01927e4`, 2026-11-12) — CI green, manual acceptance
> 17/17, Codex review with no open findings. Evidence: `docs/testing/M4-evidence.md`. Report:
> `M4-completion.md`. Decisions: ADR-012. Each box below names the test that evidences it.

### M4.1 Fairness and priority

- [x] Priority class configuration per service (`priority_order`, override reasons, transfer placement; editor + history in `FacilityServices`) — `contracts/admin.test.ts`, `e2e/fairness.spec.ts` "policy versions"
- [x] Supervisor priority override flow with reason codes (supervisor / facility admin only; denied attempts 403 + logged) — `fairness.db.test.ts`, `e2e/fairness.spec.ts` "priority override"
- [x] Fairness policy version tracking (server-assigned `vN`, immutable `service_policy_versions`, `policy.changed` event) — `fairness.db.test.ts` ("server-managed policy versions", "append-only: UPDATE and DELETE are refused")
- [x] Override audit event with full required fields (actor, ticket, from/to class, reason code, hashed free text, policy version, timestamp; DB check constraints) — `fairness.db.test.ts`, `audit.db.test.ts`
- [x] Deterministic ordering `priority_class > wait_since > issued_sequence > id`, equal-priority FIFO, stable ties — `domain/fairness-routing.test.ts`, `domain/queue.test.ts` (property test)

### M4.2 Routing

- [x] Deterministic routing: service match → priority class → waiting age → counter availability (every call records `payload.routing`) — `domain/fairness-routing.test.ts`, `fairness.db.test.ts`
- [x] Transfer between counters/services with audit trail (`ticket.counter_transfer`; service transfer keeps original waiting age per policy) — `fairness.db.test.ts`, `e2e/fairness.spec.ts` "routing"
- [x] Counter unavailable: no new assignments; a CALLED visitor is released to the head of the line (`ticket.release`); closing while serving refused — `fairness.db.test.ts`, `e2e/fairness.spec.ts`. Manual-acceptance fix: the admin Deactivate path now obeys the same invariant and serve requires an in-service counter — `counter-closure.db.test.ts`, `e2e/counter-closure.spec.ts`
- [x] Duplicate calls and unauthorized transfers prevented; M3 coordinator fence applies to every new action — `fairness.db.test.ts` (concurrency + coordinator cases), existing `queue-concurrency.db.test.ts`
- [x] Offline projection mirrors the server order and refuses closed counters — `continuity/projection.test.ts`

### M4.3 Audit integrity

- [x] Hash chain implementation in queue event insertion (primitives moved to `packages/domain/src/audit.ts`) — `domain/audit.test.ts`, `api/queue/hash.test.ts`
- [x] `audit_checkpoints` job in worker (HMAC-SHA256, verifies chain + earlier checkpoints first; never signs a broken chain; raises append-only alerts) — `worker/checkpoints.db.test.ts`
- [x] Audit verification endpoint (`verified | failed | incomplete`; incomplete is never success) + read-only view + redacted export — `audit.db.test.ts`, `e2e/fairness.spec.ts` "audit trail"
- [x] Tamper-detection test with known modified event (isolated database: modified, deleted, re-hashed and override-text tampering) — `audit.db.test.ts`, `worker/checkpoints.db.test.ts`

### M4 exit criteria

- [x] Groups 7, 8, 9 tests pass (see evidence for exact counts; Group 8 recovery/webhook items remain M5/M6)
- [x] Deterministic policy replay verified (`verifyRoutingDecisions` + verification endpoint replay)
- [x] Append-only trigger prevents UPDATE/DELETE (and now TRUNCATE) on queue_events and all M4 audit tables

### M4 deferrals (explicit)

- Strict priority between classes can starve lower classes while higher-class tickets keep arriving (policy limitation, ADR-012; no aging/interleaving — requires a future ADR)
- Checkpoint signatures are HMAC: verifying them needs the key (no public verification yet; Ed25519 → later)
- Call events committed before M4 carry no routing explanation: reported as `not_replayable`, not verified
- Releasing a called visitor when closing a counter requires a supervisor; there is no automatic reassignment push (routing stays pull-based)
- Recovery rate limits (Group 8) → M5; webhook signature/replay tests (Group 8) → M6

---

## M5 — Recovery, Accessibility, Device Health and Smart Turn Alerts (F4, F7, F9, F14)

> Planned; next milestone. M5.1–M5.3 (recovery, accessibility, device health) are the original M5
> scope and are unchanged. M5.0 (stabilization) and M5.4 (Smart Turn Alerts, REQ-F14, ADR-013,
> design §12) are added by the 2026-11-12 plan. Branch: `feature/m5-recovery-accessibility-alerts`
> from `staging`. Evidence: `docs/testing/M5-evidence.md`. Report: `docs/reports/M5-completion.md`.
> **Order:** M5.0 first (a green, trustworthy test base), then M5.1–M5.4.
> **Migrations** follow implementation order and are numbered at implementation time (indicatively M5.1 `0007`, M5.3 `0008`, M5.4 `0009`); all are additive.
> Confirm the open decisions in design §12.12 at kickoff.

### M5.0 Stabilization of known intermittent tests (carry-over from M4; no assertion may be weakened)

- [x] `e2e/security-isolation.spec.ts` "sign out ends the server session; the back button does not resurrect data" (M1): failed once in the PR #6 pull-request CI run (URL stayed `/admin` for 10 s after Sign out + Back) on unchanged code; passed in the push run on the same commit and 15/15 under local stress. Reproduce under CI-like conditions (2 workers, constrained CPU, repeated runs), find the root cause (candidates: Back-forward cache restoring the page, race between logout response and navigation, `pageshow` handling in `RequireAuth.tsx`/`auth.tsx`), fix the product code or the test's synchronization, and prove it with a recorded stress run (≥ 50 consecutive passes in CI-equivalent conditions) and, where the cause is product code, a regression test that fails before the fix — **done:** root cause in `RequireAuth` (one-shot redirect lost under render coalescing); fixed in product code; slow-device regression test fails 15/15 before, passes after (`M5-evidence.md`)
- [x] `e2e/review-fixes.spec.ts` "the notice can be dismissed without signing out" (M1, same logout area): fails locally and passes in CI because an aborted logout can also raise the offline toast, so `getByRole('button', { name: 'Dismiss' })` matches two buttons (strict mode). Make the locator unambiguous (scope to `logout-error` or use `exact: true`) without weakening what it asserts, and record why CI and local differed — **done:** ambiguous locator raced with the offline toast; scoped and exact (`M5-evidence.md`)
- [x] `e2e/offline.spec.ts` "a browser that cannot store offline data says so and refuses to pretend" (M3): failed once in seven local runs; likely clicks before the app registers the loss of connectivity. Synchronize on the app's connectivity state instead of timing; stress 50 runs — **done:** click-before-offline (test sync, `goOffline`) plus stale in-flight success flipping the app online (product fix in `api.ts`, unit regression) (`M5-evidence.md`)
- [x] Record each root cause, fix and stress result in `docs/testing/M5-evidence.md`; any flake that cannot be reproduced stays listed there as open with its observed frequency, never deleted — **done**

### M5.1 Ticket recovery (F4; design §15; ADR-015; Group 8: 8.R1–8.R12)

Original tasks (unchanged):

- [x] Recovery credential generation and secure storage
- [x] Rate-limited recovery endpoint
- [x] Grace window and rejoin policy configuration
- [x] Recovery UI flow

Design-derived tasks (revised 2026-11-12; ADR-015, design §15):

- [x] Contracts: recovery request/response (key or grant), staff assist/approve, policy additions (`rejoin_policy`, `auto_miss`, `staff_recovery`), error problem types; `JoinQueueResponse` gains the one-time `recovery_key`
- [x] M5.1 migration (additive; indicatively `0007`): `ticket_recovery_credentials` gains `source`, `revoked_at`, `revoked_reason`, `last_used_at` and the unique `ticket_id` index is replaced by a plain partial index; new `ticket_recovery_proofs` (no failure/lock columns), `ticket_recovery_grants` (basic assurance needs a different approver, enforced by CHECK), `recovery_throttle`, `auto_miss_sweeps`; migration guard and idempotency tests updated
- [x] Credential service: 160-bit CSPRNG recovery key (Crockford base32, 32 chars), HMAC-SHA-256 with an HKDF-derived pepper from `CONTACT_ENCRYPTION_KEY`, constant-time compare, tolerant input normalization; status tokens capped at 3 active with the rotation/invalidation matrix of design §15.6; join replay keeps its proof-based re-issue; "access granted elsewhere" notice to existing devices
- [x] Presentation: QR + link with the key in the URL fragment only (read, then removed with `history.replaceState`, sent in a POST body), readable 8×4 grouped text, Copy/Share/Save/Print; key never in `localStorage`, outbox or logs
- [x] `POST /tickets/recover` (key or grant): uniform failure and constant work; throttle layers L1–L5 keyed only on public identifiers and the source (never the guess), `RECOVERY_RATE_LIMIT_MAX` = 10 per minute, 5 failures per 15 min per ticket code per source, no lifetime lock, no unlock endpoint, clean sources always verified; atomic counters; `recovery_abuse` alert
- [x] `POST /tickets/:code/recovery-key`, `…/sessions/revoke-others`
- [x] Staff-assisted recovery per design §15.5a: `…/recovery/assist`, `…/recovery/approve`, `…/recovery/revoke-all`; assurance rules (no factor ⇒ restricted assistance and no credential; basic factor ⇒ second `QUEUE_MANAGE` approver; strong factor only from M6), single-use 10-minute grants redeemed on the visitor's device, reason code, rate limits, audit without values, `staff_recovery` policy switch, restricted-assistance script in the console
- [x] `rejoin_policy`: `POST /tickets/:code/rejoin` through the standard command path (`visitor_self` role for `missed → waiting` in `grace_window_active` only), idempotent, fenced while a coordinator holds the queue; default `staff_resume` leaves current behaviour unchanged; policy replay of earlier snapshots verified
- [x] Automatic no-show (opt-in, default off) per design §15.8: policy form with required seconds (60–3600) and visitor-facing rule text; API sweep (every `AUTO_MISS_SWEEP_SECONDS`, initial 15) that calls the standard command executor with a `system` role for `called → missed` only; per-candidate transaction (session then ticket lock, re-check with database time and current policy version); deterministic version-7-layout `operation_id`; refused while a coordinator is assigned; clock restarts after the last coordinator event and after a detected outage (`auto_miss_sweeps`); stateless restart; no import path to notification code
- [x] Web: recovery key display, `/recover` and fragment-link page (offline message, no CAPTCHA), "Sign out other devices", rejoin button with grace text, access-granted banner, staff console procedure, supervisor approval queue, admin policy fields, offline-ticket "recovery unavailable until confirmed" message
- [x] Retention job: tokens 24 h after expiry, `key_hmac` 24 h after ticket end, grants and throttle rows 24 h after expiry/window (idempotent; shares the §12.13 job)
- [x] Group 8 items 8.R1–8.R12 implemented on real PostgreSQL; Playwright for the visitor and staff flows; evidence in `docs/testing/M5-evidence.md` (manual device passes still to be recorded; strong-factor tests arrive with M6)

### M5.2 Accessibility (F7; design §16; Group 11: 11.A1–11.A11)

Original tasks (unchanged):

- [x] Keyboard navigation for all visitor flows
- [x] ARIA live regions for status updates
- [x] High-contrast and large-text modes
- [x] `prefers-reduced-motion` support
- [x] Mobile viewport testing at 320px and 375px

Design-derived tasks:

- [x] Preferences module (`qb.a11y.v1`) applied before first render via `data-contrast`, `data-text-size`, `data-motion`; "Display and alerts" panel in the shared header and on the ticket page; reset; no server copy
- [x] High-contrast and text-size (100/125/150 %) styles on the existing CSS custom properties; 4.5:1 / 3:1 normal and 7:1 high-contrast; reflow at 320 px and 200 % zoom; forced-colors kept
- [x] Route-change focus and title announcement; dialog focus handling; scroll-padding for sticky bars; target-size audit (24 px minimum, 44 px primary)
- [x] Announcement policy implemented in `Announcer` (assertive vs polite, 15 s position throttle, 2 s dedup, catalog strings)
- [x] Reduced-motion override (system or app) across toasts, banners, spinners and the alert banner
- [x] Vibration/audio preference controls with feature detection, explanations, quiet mode and "Test alert" (shared with M5.4)
- [x] Offline accessibility: preferences and shell precached; recover page and outbox panel verified offline; connectivity/sync text announcements
- [x] Remove `orientation: 'portrait'` from the PWA manifest; verify installed/portrait/landscape layouts
- [x] Group 11 items 11.A1–11.A9 automated (`accessibility-m52.spec.ts`); **11.A11 manual passes are OUTSTANDING** (listed in `M5-evidence.md`; no conformance claim)

### M5.3 Device health dashboard (F9; design §17; Group 8: 8.D1–8.D6; Group 11: 11.A10)

Original tasks (unchanged):

- [x] Device last-contact display
- [x] Sync health indicators
- [x] Coordinator status and failover controls
- [x] Automatic alerting for unhealthy devices (carried over from the explicit M3 deferral "automatic alerting/notification → M5"; in-dashboard flags first, no new external channel)

Design-derived tasks:

- [x] `stale` state and thresholds from server time (`DEVICE_STALE_AFTER_SECONDS` = 900, `COORDINATOR_EXPIRY_WARN_SECONDS` = 300, `CONFLICT_REVIEW_WARN_SECONDS` = 900 as accepted initial defaults; all configurable); `deviceHealthState` extended; honest "approximate / may be offline, asleep or lost" wording
- [x] M5.3 migration (additive; indicatively `0008`): `health_alerts` with a unique partial index for one open alert per (facility, kind, subject)
- [x] Worker `evaluateDeviceHealth` (every 30 s): read-only on queue/coordinator/ticket tables, upsert/resolve alerts with two-evaluation damping, facility change signal, "paused" indicator when stale; never assigns, fails over, renews or revokes anything
- [x] Alert kinds and severities of design §17.4 including `recovery_abuse` and `alert_pipeline_failing`; recipients and acknowledge rules (`OPERATIONS_VIEW` view, `QUEUE_MANAGE` acknowledge, own-device warning); audited acknowledge/clear
- [x] Dashboard: state filter/sort, alerts panel, last-evaluated line, counters for recovery and turn alerts; supervisor/admin alert banner; staff console own-device warning
- [x] Lost-device flow: revoke-as-lost with last-contact/pending wording; revoked device re-registers as new; revoked device's unsent actions shown read-only, never auto-applied; confirm failover stays explicit with the existing fencing warning
- [x] Privacy review: no IP/user agent/fingerprint/location fields or logs; minimal heartbeat schema (unknown fields rejected); label guidance text
- [x] Retention: resolved alerts deleted after 30 days (shares the retention job)
- [x] Group 8 items 8.D1–8.D6; Group 6 fencing tests re-run unchanged; Group 11 item 11.A10 (automated; manual screen-reader pass of the dashboard still outstanding, see `M5-evidence.md`)

Security follow-up from M5.1 (separate change, recorded in `M5-evidence.md`, "M5 hardening"):

- [x] Per-staff assisted-recovery limit made atomic (organization- and staff-scoped advisory lock, lock order staff → ticket, 3 s lock timeout → retryable 503); concurrency regression test (20 simultaneous requests → exactly 5)
- [x] Grant redemption lock order corrected (ticket → grant, as revoke-all), removing a deadlock found while reviewing lock order; deterministic and repeated regression tests

### M5.4 Smart Turn Alerts (F14; ADR-013, design §12)

- [x] Contracts: alert/subscription/payload schemas, `ticket.called` template key, alert state enum (`sent | delivered | failed | suppressed | unknown`) in `packages/contracts` — done (`packages/contracts/src/push.ts`; states also include `pending`)
- [x] M5.4 migration (additive; take the next free number after the M5.1 and M5.3 migrations): `push_subscriptions` (random `id` = the non-secret `subscription_id`), `notifications.push_subscription_id`, `notification_deliveries.detail_code`, widen `notifications.channel` (+`web_push`) and `notifications.status` (+`suppressed`) CHECKs; migration guard and idempotency tests updated — done (`0009_turn_alerts.sql`; also `notification_outbox.processed_at`, `health_evaluations.worker_config`)
- [x] `enqueueTurnAlerts` helper called from every committed-call path including sync, inside a savepoint: **one `notifications` + `notification_outbox` pair per active subscription**, created together in one CTE with `ON CONFLICT (dedup_key) DO NOTHING`; dedup key `web_push:ticket.called:<ticket_id>:<event_sequence>:<subscription_id>` (the global unique index on `dedup_key` requires the subscription in the key); service transfer re-binds subscriptions to the destination ticket; failure logged and counted, never propagated — done as a savepoint-isolated transition hook registered on `appendEvent` (ADR-013 implementation note 2)
- [x] `PushTransport` interface, `SandboxPushTransport` (test-only label, no network) and `WebPushTransport` (VAPID from env) in `packages/channels` — done with `http_ece@1.2.1` (MIT, exact-pinned) + `node:crypto` VAPID; the `web-push` package originally named here is MPL-2.0 and is not used (ADR-013 decision 8, as corrected); endpoint policy re-checked at every send and connected address must be public
- [x] Worker `processNotificationOutbox` for `web_push`: `FOR UPDATE SKIP LOCKED` claim with a lease so concurrent workers never double-claim, one device per row, `Topic = subscription_id`, stale suppression, TTL, bounded backoff, 404/410 revokes only that subscription, honest outcome codes, at-least-once with collapse (never claim exactly-once); never writes to ticket or queue tables — done (`processTurnAlerts`, `apps/worker/src/turn-alerts.ts`)
- [x] API: `GET /push/capability`, subscribe/unsubscribe/ack on `/tickets/:publicCode/…` (status credential, CSRF, rate limit, strict Zod, tenant scope; subscribe returns the non-secret `subscription_ref`, ack takes `{ subscription_ref, event_sequence }`, a ref that does not belong to the token's ticket is 404), staff `GET /queues/:id/alerts` (per device); subscription data encrypted with the derived key; endpoint, hash, keys and credentials never returned, logged, audited or placed in URLs, tags or dedup keys — done (`apps/api/src/routes/push.ts`; plus an endpoint allow-list against SSRF)
- [x] Web: `TurnAlert` banner + live region + title prefix; settings panel (sound off by default with "Enable sound" gesture and "Test alert", vibration toggle, push opt-in/opt-out with plain-language unsupported/denied/iOS-install states); once-per-call-event rule; offline "alerts may be delayed" note — done; push opt-in/out is on the ticket page (per ticket, needs its token), sound/vibration/"Test alert" stay in the M5.2 settings dialog (ADR-013 note 5)
- [x] Saved-ticket identity for push: `StoredTicket.pushRef` (non-secret, saved when subscribe returns), `resolveByPushRef`, `resolveSaved`/`TicketPage` extended so `?ref=` (or `?k=`, which must agree) wins and a bare code is never used to guess; neutral "not saved on this device" screen with no status request and credential-based recovery paths; focused-window hand-off compares `ref` — done
- [x] Service worker push handler via `workbox.importScripts` (payload v2; tag `qb-call-<ref>`; click opens `/ticket/<code>?ref=<ref>`; focused-window hand-off; no credentials in the worker); the page sends the first-party ack; M3 offline shell behaviour re-verified unchanged — done (`public/push-handler.js`; click URL also carries public `seq` and `rp`, ADR-013 note 3); the real built service worker is exercised in `e2e/turn-alerts-sw.spec.ts`; M3 offline suites re-run
- [x] Staff console: per-called-ticket alert state in plain text with the public-board fallback reminder; supervisor alert counters panel on the connectivity dashboard — done
- [x] `.env.example`, `docs/local-environment.md` and `pnpm env:generate` extended for VAPID keys, TTL and subscription cap (placeholders only; no secrets committed) — done (`pnpm env:generate --vapid`, `env:check` validates the pair)
- [x] Copy review: no text promises delivery; push/vibration/sound described as best effort; platform limits stated — done (`src/lib/copyTruthfulness.test.ts`)
- [x] Group 14 tests (testing steering, 14.1–14.14): per-subscription outbox entries, notification identity and safe opening, savepoint isolation, no state change and no `ticket.miss` on any failure path, idempotency, stale suppression, committed-only triggering, honest states, minimal payload, encryption at rest, tenant isolation, keyboard/axe/reduced-motion at 320 and 375 px — done (automated; real devices are the next item)
- [ ] Real-device checks recorded in `docs/testing/M5-evidence.md` (Android Chrome; iOS Safari including installed-app); results as observed, gaps stated — **not done:** procedure and support matrix recorded in `M5-evidence.md`; no real device was tested in this session
- [x] Knowledge-base inventory (design §11.10) row for M5 includes turn alerts, so MQ.5 authors the articles — already present in design §11.10 (M5 row)
- [x] M5 final integration (2026-11-15): cross-feature journeys (`m5-integration.db.test.ts`), recovery L2 limit made atomic under concurrency (defect fix), recover-page note for temporary tickets (REQ-F4.12), manual acceptance guide (`docs/testing/M5-manual-acceptance.md`)
- [x] Final review (2026-11-15): send-time SSRF policy and connect-time address check, database-backed per-ticket change limit shared across instances, lease renewal before each send, deleted-token revocation, bounded `worker --once` (deadline, stop signal, idle-transaction guard); each with a regression test and a killed mutation; licence wording corrected across AGENTS.md, steering, design, requirements, ADR-013 and the architecture document (`M5-evidence.md`)

### M5 manual acceptance schedule (approved by the product owner, 2026-11-16)

- [x] **Set 1 — development acceptance (manual checks 1–14): closed 2026-11-16, 14 / 14 Pass.** Product defects found were fixed with regression tests (print, recover form, approval-list scope, restricted-assistance answers, recovery audit view per ADR-015 amendment 1, policy editor on pre-M5 policies); results and history in `docs/testing/M5-manual-acceptance.md` and `M5-evidence.md`
- [ ] **Set 2 — final acceptance (manual checks 15–41, desktop and device variants):** run at the final integration and pre-submission stage, after M7 (see M7.6). Until then each record is "Not tested — scheduled for final acceptance (Set 2)". The manual parts of the M5 exit criteria below (11.A11 screen readers, zoom and orientation; 14.10 real-device push; device-drill checks) are verified there
- Rules: a confirmed critical security or integrity defect is never deferred (fixed and re-verified before the next checkpoint); automated regression, security, database, integration and CI testing continues on every change; no out-of-pocket spending
- Remaining sequence: **M5 checkpoint → MQ → M6 → M7 → Set 2 acceptance → submission**

### M5 exit criteria

- [x] M5.0: the M1 sign-out test and the related flaky tests are root-caused and fixed (or recorded as open with evidence) and CI is stable across consecutive runs — **done locally:** 449–450 of 450 per test across five waves; one environment stall recorded as open (`M5-evidence.md`). CI confirmation pending (not pushed) — _2026-11-16: CI green on PR #8 after two fixes found by CI (`2542263` worker malformed-row defect, `ee30105` handover test race)_
- [ ] Groups 8 (recovery and device-health access/privacy), 11 (accessibility) and 14 (turn alerts) tests pass; Groups 1–7, 9 and 12 still pass (M1–M4 routing rules, coordinator fencing and the audit chain unchanged) — automated parts pass locally (2026-11-15, `M5-evidence.md` acceptance report); 11.A11 and 14.10 manual not executed
- [ ] Keyboard-only visitor journey end-to-end verified, including the turn alert controls — automated (11.A1, turn-alert keyboard tests); manual check 34 not executed
- [ ] Recovery: impossible from the public ticket code alone; 160-bit HMAC-stored keys; throttles that the guess cannot evade and that never lock out the rightful holder; uniform oracle-free errors; restricted staff procedure and audit verified; recovery creates no queue event and changes no ticket state, position or age (Group 8: 8.R1–8.R8, 8.R10, 8.R11)
- [x] Grace/rejoin use the existing `grace_window_seconds`; `self_resume` works only inside the window; automatic no-show is off by default, executes only through the authoritative command path with locking and idempotency across API instances and restarts, respects coordinator fencing, and is never alert-driven (Group 8: 8.R9, 8.R12)
- [x] Push subscription retention and deletion verified (design §12.13; Group 14.11); confirmed defaults verified (Group 14.12) — M5.4 worker/API DB tests
- [ ] Accessibility: preferences, keyboard, announcement policy, contrast/reflow, reduced motion, vibration/audio preferences, offline and 320/375 px verified (Group 11: 11.A1–11.A10); manual passes recorded with limits stated (11.A11); manifest orientation unlocked
- [x] Device health dashboard shows last contact, sync health, coordinator status and failure reasons; stale detection and automatic alerts with recipients verified; evaluation leaves the single-coordinator authority model, queue state and event chain unchanged (Group 8: 8.D1–8.D6; Group 6)
- [x] An alert failure of every kind leaves ticket state, queue revision and the event chain unchanged and never marks a visitor missed — M5.4 (14.7 worker, API and browser tests)
- [ ] No copy, article or documentation promises alert delivery — UI copy and the service worker verified by `copyTruthfulness.test.ts`; KB articles do not exist until MQ
- [ ] Full gate set green: format, lint, typecheck, build, `pnpm test`, `pnpm test:db`, Playwright (all projects), DB validation and security audit; no assertion weakened — **green locally (2026-11-15); CI not run** — _2026-11-16: all six CI jobs green on PR #8 (CI runs Playwright on Chromium only; Firefox/WebKit locally)_
- [ ] Evidence recorded in `docs/testing/M5-evidence.md` and `docs/reports/M5-completion.md` — evidence, Set 1 manual results and the completion report recorded (2026-11-16); Set 2 results at final acceptance

---

## MQ — Ask Que Anything (F13, planned; scheduled after M5, before M6)

> Added 2026-11-07 (PRD Addendum A, ADR-011, REQ-F13, design §11). Inserted without renumbering
> M0–M7. **Entry gate:** M5 exit criteria met (visitor join/status/recovery, sync states,
> accessibility baseline, device health and turn alerts exist, so help can describe real behaviour;
> turn-alert articles describe push, sound and vibration only as best effort).
>
> **Entry gate as reconciled on 2026-11-16** (`docs/reports/MQ-design-readiness.md` §8). The
> original wording "M5 exit criteria met" predates the approved two-set acceptance schedule:
> several M5 exit boxes stay open until Set 2 because they include manual checks. MQ entry is
> therefore read as:
>
> - [x] M5 merged into `staging` (PR #8, `cebbe06`, 2026-11-16)
> - [x] M5 manual acceptance Set 1 (checks 1–14): 14 / 14 Pass
> - [x] Set 2 (checks 15–41) deferred to final acceptance after M7, as approved; the M5 exit boxes
>       that depend on it remain open and are not claimed
> - [x] CI green on the merged tree (all six jobs on PR #8)
> - [x] No known open critical security or integrity defect
> - [x] ADR-011 accepted; MQ specification reconciled with M5 (design §11.2, §11.3.1, §11.10a, §11.11)
> - [x] Remaining M5 limitations recorded and accepted as non-blocking for MQ (`M5-completion.md`
>       "Known limitations"); those that affect Que content are listed in the readiness report §8
> - [x] Decisions D1–D4 approved by the product owner (2026-11-16): capability availability
>       indicator, server-issued role fingerprint, permission synchronization checks, recovery
>       verification privacy (readiness report §7; design §11.2, §11.5.4, §11.3, §11.5.1)
>
> The AI layer (MQ.4) is optional: MQ is complete with the AI layer disabled if no approved
> free-tier or sponsored provider is available. No subscription or paid inference may be activated.

### MQ.1 Contracts and deterministic core (`packages/assist`)

- [x] ADR-011 formally accepted (it remains Proposed until this task); `packages/assist` added to package-boundary tables (imports `contracts` only) — _ADR-011 accepted 2026-11-16 (spec reconciliation); the boundary tables (`AGENTS.md` §2, architecture steering, adding `assist` to the `apps/web` row; `apps/api` already imports all packages) are updated when the package is created_ — **MQ.1 (2026-11-17):** package created; `AGENTS.md` §2 table and tree, architecture steering boundary rules updated; static boundary test `packages/assist/src/boundary.test.ts`
- [x] `KbArticle`, `CapabilityManifest`, `RouteId`, `QueAnswer` schemas in `packages/contracts` — `packages/contracts/src/que.ts` (strict Zod; SafeMarkdown with route links only; D1 `availability` with fail-closed `isCapabilityUsable`); tests `que.test.ts`
- [x] Shared permission map moved to `packages/contracts` and used by both API and Que route registry — `packages/contracts/src/permissions.ts` (unchanged matrix, snapshot test); `rbac.ts` re-exports it; D3 checks 1–5 in `apps/api/src/que-consistency.test.ts`, `apps/web/src/lib/queConsistency.test.ts`, `packages/assist/src/registry.test.ts`
- [x] Route/screen registry with required permissions and default articles per screen — `packages/assist/src/registry.ts` (design §11.3.1: 16 screens, permissions, audiences, default article ids from §11.10a, console operations resolved from the state machine; `/supervisor/*` not registered)
- [x] Deterministic search and answer builder (no I/O) — `packages/assist/src/{search,answer,links,capabilities}.ts`: TF-IDF-style ranking with screen boost and id tie-break, role/capability filtering, safe links, screen-default fallback with "ask staff"
- [x] Capability manifest generated from server flags; `GET /api/v1/que/capabilities` — `apps/api/src/que/capabilities.ts`, `routes/que.ts` (public, rate-limited, no DB, no secrets; Web Push availability from the same `webPushAvailable` check as `/push/capability`); tests `que-capabilities.test.ts`. Evidence: `docs/testing/MQ-evidence.md`

### MQ.2 Knowledge-base delivery and offline

- [x] Build step compiling Markdown articles to versioned per-audience bundles — `packages/assist/src/kb-compile.ts` (pure) + `scripts/build-kb.mjs` (part of the package build); `knowledge/<audience>/<id>.md`, `kb.json`, `kb.lock.json`; four initial delivery articles only (MQ.5 owns the inventory)
- [x] `GET /api/v1/que/kb/public` (precached) and authenticated `GET /api/v1/que/kb` (role-filtered) — `apps/api/src/routes/que.ts`, `que/kb.ts`; audiences from the server-loaded session grants; server-issued role fingerprint (D2, `auth/role-digest.ts`)
- [x] Service-worker precache for public bundle; per-user cache for restricted bundles — built-in public bundle precached as a hashed asset, runtime copy of the endpoint; restricted bundle in IndexedDB `queuebridge-que` only; public-facility runtime rule corrected (`apps/web/src/pwa/swRules.ts`)
- [x] Offline staff-help authorization expiry (`authorizedUntil`), role-digest binding and invalidation triggers per design §11.5.2–§11.5.3 — `apps/web/src/que/{offlineHelp,helpClient,store}.ts`, wired in `auth.tsx`
- [x] Build check: restricted bundles contain no tenant-sensitive content (design §11.5.1) — emails, phone numbers, UUIDs, ticket codes, placeholders and secret-like strings fail the build; D4 `privatePhrases` check
- [x] Incremental update by bundle/article version — `known=id:version` on `GET /que/kb` (unchanged articles not resent); version discipline enforced by `kb.lock.json`. Evidence: `docs/testing/MQ-evidence.md` (MQ.2)

### MQ.3 Que UI (accessible, mobile-first)

- [x] "Ask Que" trigger in the page shell for every role including visitors — `apps/web/src/que/AskQue.tsx` in `Layout` header tools; panel lazy-loaded (separate precached chunk)
- [x] Panel/sheet with search, "On this screen", article view, permitted links only — `QuePanel.tsx` (non-modal desktop panel, full-height modal sheet ≤ 40rem), `SafeArticle.tsx`, `routeContext.ts`; links only via the MQ.1 `buildPath`
- [x] Offline / built-in help / AI badges with text labels; live-region announcements; focus management — text badges ("Built-in help", "Offline", "Help version N"); no AI badge because no AI layer exists (MQ.4); polite debounced result announcements; focus to search on open, to the article heading, back to the button on close
- [x] No operation buttons inside Que — controls limited to Close, search, article titles, Back to results and Try again (checked by Playwright); Ask Que issues GET requests only. Evidence: `docs/testing/MQ-evidence.md` (MQ.3)

### MQ.4 Optional AI explanation layer (disabled by default)

- [x] `InferenceAdapter` interface; `DisabledInferenceAdapter` (default); `SandboxInferenceAdapter` (tests) — `apps/api/src/que/inference.ts`; sandbox refused in production; no real provider adapter exists
- [x] `POST /api/v1/que/ask` with strict validation, rate limits, PII redaction, daily cap, timeout — `routes/que.ts`, `que/ask.ts`; facility-scoped (`FACILITY_READ`, cross-tenant 404); per-user and per-IP limits; shared UTC daily cap (`que_ai_daily_usage`, migration `0010`); timeout and client-disconnect cancellation
- [x] Output guard (citations, links, capability truthfulness, markup) with deterministic fallback — `packages/assist/src/ai-guard.ts` (also sensitive data, claimed actions, injection artefacts, ungrounded numbers and content); links only from the server
- [x] Facility opt-in setting (admin-only, audited) and AI disclosure in UI — `GET|PUT /facilities/:id/que-ai` (`FACILITY_CONFIGURE`, consent `que-ai-consent-v1`, DB consent CHECK, `admin_events`); admin page section; Ask Que "AI-generated" label, sources, "Check with staff…", fallback reasons
- [x] AI endpoint requires a staff session; anonymous visitors get deterministic help only — 401 for anonymous and forged sessions; no AI control or text in the visitor panel
- [x] Provider research recorded against design §11.8 (research only; no account requiring payment details; no selection or integration without a separate explicit decision) — `docs/testing/MQ-evidence.md` (MQ.4): **No provider selected — AI disabled by default.**

### MQ.5 Knowledge-base content (seed)

- [ ] Articles for live M1–M5 behaviour per design §11.10 (visitor, reception, counter, supervisor, admin, auditor, connectivity); M5 articles and capability entries per design §11.10a
- [ ] Coverage check: every essential workflow step has a deterministic article and route (no AI-only answers)
- [ ] Non-live capabilities (e.g. SMS/USSD before M6) documented only as `sandbox`/`planned`
- [ ] Content review checklist: accurate, no promised times, no fabricated capabilities, plain language

### MQ.6 Incremental KB maintenance rule (applies to M6, M7 and later)

- [ ] Each later milestone updates affected articles and capability entries in the same PR
- [ ] Group 13.5 KB consistency test in CI blocks merges when articles and manifest disagree

### MQ exit criteria

- [ ] Group 13 tests pass (role restrictions, tenant isolation, offline fallback, navigation accuracy, KB consistency, accessibility, inference failures, zero-cost guard, privacy, read-only, prompt injection)
- [ ] Que fully usable offline and with AI disabled; no workflow depends on AI
- [ ] Offline staff-help expiry and invalidation verified (Group 13.12)
- [ ] No Que endpoint or UI path can modify tickets, priorities, staff, permissions or facility settings
- [ ] Every AI answer (if enabled) is disclosed, cited and validated; failures fall back deterministically
- [ ] Evidence recorded in `docs/testing/MQ-evidence.md`

---

## M6 — SMS Turn Alerts and USSD Channels (F11, F12)

> Planned; follows MQ. SMS turn alerts (REQ-F11.8–REQ-F11.13, design §13, ADR-013) are added to the
> original M6 scope; the USSD scope (F12) is unchanged. The outbox/worker consumer, savepoint
> enqueue helper, idempotency and honest-state model are built in M5.4 and reused here.
> The zero-personal-spending rule (PRD §13) governs every live-provider task.

### M6.1 SMS adapter and outbox

- [ ] `SandboxSmsAdapter` with full interface compliance
- [ ] Notification outbox worker: SMS consumer on the M5.4 pipeline (committed events only, savepoint enqueue, `FOR UPDATE SKIP LOCKED`, bounded retries)
- [ ] SMS templates for all 5 notification types, with `ticket.called` (the SMS turn alert) first
- [ ] Consent at joining (separate, unticked, purpose-stated), `visitor_contacts.phone_ciphertext` with `consent_at` and `retention_until`; opt-out in the ticket page, staff UI and (where supported) inbound keyword
- [ ] Delivery receipt handling and status recording (`delivered` only from a provider receipt)
- [ ] `SMS_DAILY_CAP` enforced before every send (cap reason, no overage); per-facility cap setting
- [ ] Provider research recorded (tariffs, sender-ID, sandbox, webhooks, receipts, spending controls, free/sponsored credits); no account requiring a payment card or personal funds
- [ ] Live provider adapter (post provider selection; real provider support preserved: send, signed webhook verification with replay defense, receipt parsing) — enabled only with approved sponsored/free credentials; otherwise sandbox stays the default and is labelled

### M6.2 USSD adapter

- [ ] `SandboxUssdAdapter` with stateful session menus
- [ ] USSD webhook handler with replay defense
- [ ] Menu flows: join, status, service discovery, recovery
- [ ] Session expiration handling
- [ ] Live USSD adapter (post provider selection and approval)

### M6.3 Channel configuration UI

- [ ] Per-facility SMS/USSD channel configuration
- [ ] Sandbox vs. live mode toggle with clear labeling
- [ ] Delivery status monitoring
- [ ] Optional "SMS only if the in-app alert was not seen within N seconds" cost-control setting (default: send immediately)
- [ ] Knowledge-base articles and capability manifest entries for SMS turn alerts and USSD updated in the same PR (MQ.6)

### M6 exit criteria

- [ ] Group 10 (channel adapter) tests pass in sandbox
- [ ] SMS turn alert: sandbox end-to-end from committed call to recorded receipt; consent, opt-out, cap, replay and signature tests pass
- [ ] SMS failure, cap or opt-out never blocks or alters queue progression, never affects in-app/push alerts, never marks a visitor missed (Group 14 invariants hold for SMS)
- [ ] Live delivery only if approved provider and credentials available; no personal spending
- [ ] Sandbox traffic labeled unmistakably as test

---

## M7 — Final UI/UX, Branding, Landing Page, Hardening, Demo, Submission (F15 and all features)

> Planned. F15 (REQ-F15, ADR-014, design §14) is added to the original hardening/demo/submission
> scope. The redesign is presentation-only: every existing behavioural, accessibility and security
> test must keep passing without weakened assertions.

### M7.1 Design system, branding and responsive redesign (F15)

- [ ] Design tokens in `packages/ui` (colour roles with light/high-contrast sets, type scale with large-text multiplier, spacing, radii, elevation, motion with reduced-motion override)
- [ ] Original, self-hosted brand assets: wordmark, logo, favicon, PWA icons; system or self-hosted open-licence fonts; manifest updated
- [ ] Redesign of every role's screens on the shared tokens/components: visitor (join, ticket, recovery, alerts), reception, counter console, supervisor (fairness, audit, connectivity), administration, public board, Ask Que panel
- [ ] No horizontal overflow at 320, 375, 768, 1280 and 1440 px; existing responsive/overflow/axe Playwright checks pass unchanged in intent
- [ ] Statuses remain text + icon (never colour alone); high-contrast and large-text modes verified on the redesigned screens

### M7.2 Animated public landing page and onboarding (F15)

- [ ] Route `/` replaced by the landing page as a separately lazy-loaded chunk (design §14.1, §14.6); existing route paths unchanged
- [ ] Content per design §14.4: hero with clear message and CTAs, CSS/SVG animated continuity story with text captions, audiences, capabilities, honest channel status from the capability manifest, get-started checklist mapped to the F10 flow, privacy and accessibility statements
- [ ] Motion policy (design §14.5): reduced-motion static equivalent, pause control for loops over 5 s, no flashing, no scroll-jacking
- [ ] No third-party requests; production CSP/HSTS/frame/referrer/permissions headers verified
- [ ] Landing copy through the localization framework (English baseline)
- [ ] Truthfulness review: no conflict-free, guaranteed-delivery or invented-metric claims; SMS/USSD shown as live only if the manifest says so

### M7.3 Performance, security and cross-browser verification

- [ ] `pnpm audit` — zero high/critical vulnerabilities
- [ ] Load testing: 1,000+ scripted operations reconcile idempotently
- [ ] Rate limiting verified on all public endpoints
- [ ] Webhook signature verification verified under adversarial test
- [ ] Performance baseline measured (Lighthouse CLI and bundle sizes per route); budgets derived from it and enforced in CI; visitor-flow initial JS budget (REQ-F7.7) unaffected by the landing page
- [ ] Playwright `firefox` and `webkit` projects added for smoke journeys (landing, sign-up entry, visitor join and ticket page, staff call) at mobile and desktop sizes
- [ ] Real-device checklist (Android Chrome; iOS Safari including installed-app push) completed and recorded; support matrix and known limitations published
- [ ] Accessibility: axe on landing and redesigned screens, keyboard-only walkthroughs, recorded manual screen-reader pass; limits stated (no claim of full WCAG conformance without expert review)

### M7.4 Demo preparation

- [ ] `infra/seeds/demo_seed.sql` — clinic/service-desk demo scenario
- [ ] End-to-end demo script for all 6 journeys (A–F), including a turn alert
- [ ] Outage and reconnect demo runs deterministically

### M7.5 Documentation and submission

- [ ] `README.md` updated with diagrams, screenshots, setup instructions
- [ ] `docs/testing/` contains evidence for all test groups
- [ ] All 10 core capabilities demonstrated end-to-end
- [ ] Kiro contribution documented with concrete artifacts
- [ ] Public demo video ≤ 3 minutes

### M7.6 Final acceptance (Set 2 of the M5 manual acceptance; before submission)

- [ ] Re-read M5 manual checks 15–41 against the final screens; update wording only where a screen or label changed, never a criterion
- [ ] Run Set 2 by environment group (`docs/testing/M5-manual-acceptance.md` section 0a): Mac and desktop browser; phones on the local network; Android and Web Push; iOS if a device is available; device health and failover; accessibility and screen readers
- [ ] Record each result as observed; a check without a compatible device is "Not tested — no compatible device", never a Pass
- [ ] Any confirmed critical security or integrity defect is fixed and re-verified before submission

### M7 exit criteria

- [ ] M5 manual acceptance Set 2 (checks 15–41) recorded in `docs/testing/M5-manual-acceptance.md` (M7.6)

- [ ] All ten core feature groups demonstrated in integrated workflows
- [ ] All test groups 1–12 passing, plus Group 14 (turn alerts) and Group 15 (final UI/UX, landing, cross-browser)
- [ ] Landing page live with truthful content, onboarding path and verified motion/accessibility/performance/security behaviour
- [ ] Cross-browser automated matrix (Chromium, Firefox, WebKit) green and real-device checklist recorded
- [ ] Group 13 (Ask Que) passing in the final regression, including runs with AI disabled and offline
- [ ] Public repo, working app, demo video complete
- [ ] Feature-to-requirement mapping table published
- [ ] Ask Que acceptance (REQ-F13, MQ exit criteria) re-verified against the final capability manifest
