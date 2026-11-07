# QueueBridge — Spec Tasks

**Spec version:** 1.0  
**Status:** M0 complete; M1 complete (merged into `staging`, CI passing); M2–M7 planned; MQ (Ask Que, F13) planned between M5 and M6  
**Each task:** implement → test → validate → mark done

---

## M0 — Project Foundation

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

- [ ] Root `package.json` with pnpm workspace scripts
- [ ] `pnpm-workspace.yaml` declaring all apps and packages
- [ ] Root `tsconfig.base.json` with strict mode settings
- [ ] All `apps/` and `packages/` directories initialized with `package.json` and `tsconfig.json`
- [ ] Workspace dependency linking verified (`pnpm install` succeeds)

### M0.3 Shared packages skeleton

- [ ] `packages/contracts`: Zod schemas for CommandEnvelope, Ticket, QueueSession, QueueEvent, SyncBatch, ApiError, WaitEstimate
- [ ] `packages/domain`: ticket state machine stub with all states and transitions declared
- [ ] `packages/continuity`: coordinator epoch validation, command envelope creation stubs
- [ ] `packages/channels`: `ChannelAdapter` interface, `SandboxSmsAdapter`, `SandboxUssdAdapter`
- [ ] `packages/ui`: component stubs with accessible HTML structure for `TicketCard`, `SyncStateIndicator`, `QueueStatusBanner`

### M0.4 Application skeletons

- [ ] `apps/api`: Fastify server with health endpoints (`/health`, `/health/ready`), plugin stubs, env validation
- [ ] `apps/web`: Vite + React app with PWA manifest, offline shell, routing stubs, i18n setup
- [ ] `apps/worker`: process entry point, outbox poll loop stub, graceful shutdown

### M0.5 Database foundation

- [ ] `infra/migrations/0001_initial_schema.sql` — all tables from architecture §6 with correct constraints
- [ ] `infra/migrations/0002_append_only_trigger.sql` — `queue_events` append-only trigger
- [ ] `infra/seeds/dev_seed.sql` — one org, one facility, one service, one counter, one staff user
- [ ] Migration runner script in root `package.json` (`pnpm db:migrate`, `pnpm db:seed`)
- [ ] Migrations verified idempotent (run twice → no error)

### M0.6 Developer tooling

- [ ] ESLint 9 flat config at root with TypeScript plugin, applied to all packages and apps
- [ ] Prettier config at root, consistent with 2-space indent, single quotes
- [ ] `pnpm lint`, `pnpm format`, `pnpm format:check` scripts working
- [ ] `pnpm typecheck` script running `tsc --noEmit` across all packages
- [ ] `.env.example` at root and per app with all required variables and safe placeholders
- [ ] `.gitignore` covering `.env`, `node_modules`, `dist`, `.turbo`, build artifacts

### M0.7 Initial tests

- [ ] `packages/contracts`: Zod schema parse/reject tests (≥ 10 meaningful assertions)
- [ ] `packages/domain`: ticket state machine transition tests (all valid and invalid transitions)
- [ ] `packages/continuity`: coordinator epoch validation tests
- [ ] `packages/channels`: SandboxAdapter tests (no real network, SANDBOX label present)
- [ ] `apps/api`: health endpoint tests (200 from `/health`, DB connection check from `/health/ready`)
- [ ] `infra`: migration idempotency test (apply migrations twice, verify table structure)
- [ ] All tests pass: `pnpm test`

### M0.8 CI

- [ ] `.github/workflows/ci.yml`: lint → typecheck → test → build on push/PR
- [ ] `.github/workflows/db-validate.yml`: PostgreSQL service container, run migrations, verify constraints
- [ ] CI passes on `feature/m0-foundation`

### M0.9 Documentation

- [ ] `README.md`: project overview, local setup, architecture diagram reference, Kiro contribution summary
- [ ] `docs/adr/ADR-001.md` through `ADR-010.md`: one ADR per architecture decision
- [ ] `docs/testing/M0-evidence.md`: test run outputs
- [ ] `M0-completion.md`: full implementation report

### M0 exit criteria (ALL must pass before M0 is complete)

- [ ] `pnpm typecheck` — zero errors
- [ ] `pnpm lint` — zero errors
- [ ] `pnpm format:check` — no violations
- [ ] `pnpm test` — all tests pass
- [ ] `pnpm build` — all packages and apps build
- [ ] `pnpm db:migrate` — migrations apply cleanly to fresh DB
- [ ] CI green on `feature/m0-foundation`

---

## M1 — Tenancy, Roles, Facility Setup (F10 foundation)

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

### M2.1 Online queue operations

- [ ] `POST /queues/:id/join` — create confirmed ticket
- [ ] `POST /queues/:id/commands` — call, serve, complete, pause, miss, cancel
- [ ] Queue session management: create session, open/close
- [ ] Routing engine: select next eligible ticket per deterministic policy

### M2.2 Visitor flows (apps/web)

- [ ] Visitor join flow: QR scan → service selection → ticket issued
- [ ] Live ticket status page with SSE updates
- [ ] Queue status and position display with wait estimate
- [ ] Public board display with ticket calling

### M2.3 Staff console (apps/web)

- [ ] Staff dashboard: queue view, current ticket, call next button
- [ ] Walk-in registration form (staff-assisted)
- [ ] Counter controls: call, serve, complete, transfer, pause

### M2.4 Wait-time estimates

- [ ] Implement `computeWaitEstimate` in packages/domain
- [ ] Wire to ticket status endpoint
- [ ] Display in visitor UI with explanation

### M2 exit criteria

- [ ] Full online join-to-completion journey passes for web and staff channels
- [ ] Group 1 (domain) and Group 4 (concurrent transactions) tests pass
- [ ] Duplicate ticket prevention verified

---

## M3 — Continuity Engine (F1 offline, F9)

### M3.1 Offline command capture

- [ ] IndexedDB outbox in apps/web
- [ ] Service worker for offline shell and asset cache
- [ ] Coordinator authority validation (client-side)
- [ ] Offline ticket capture with `temporary_ticket_ref`
- [ ] `SyncStateIndicator` displayed on all relevant UI states

### M3.2 Sync protocol

- [ ] `POST /api/v1/sync/batches` endpoint with full server transaction
- [ ] `GET /api/v1/sync/queues/:id/snapshot` endpoint
- [ ] Epoch and revision checks in sync handler
- [ ] Per-command dispositions: `committed | duplicate | rejected | needs_review`

### M3.3 Conflict and recovery UI

- [ ] Connectivity and recovery dashboard (F9)
- [ ] Device health view for supervisor
- [ ] Conflict review queue: `needs_review` operations surfaced
- [ ] Coordinator failover flow

### M3.4 Offline acceptance tests

- [ ] Architectural acceptance gate (architecture §16) answered in code and tests
- [ ] Group 3, 5, 6 tests pass
- [ ] Partition simulation test: two call-next → only one committed

### M3 exit criteria

- [ ] All six architectural acceptance gate questions answered with passing tests
- [ ] `pnpm test` — Groups 3, 5, 6 all pass
- [ ] Offline behavior NOT described as conflict-free until this passes

---

## M4 — Fairness, Overrides, Audit, Routing (F3, F5, F8)

### M4.1 Fairness and priority

- [ ] Priority class configuration per service
- [ ] Supervisor priority override flow with reason codes
- [ ] Fairness policy version tracking
- [ ] Override audit event with full required fields

### M4.2 Routing

- [ ] Deterministic routing: service match → priority class → waiting age → counter availability
- [ ] Transfer between counters/services with audit trail
- [ ] Counter unavailable: reassign eligible waiting tickets

### M4.3 Audit integrity

- [ ] Hash chain implementation in queue event insertion
- [ ] `audit_checkpoints` job in worker
- [ ] Audit verification endpoint
- [ ] Tamper-detection test with known modified event

### M4 exit criteria

- [ ] Groups 7, 8, 9 tests pass
- [ ] Deterministic policy replay verified
- [ ] Append-only trigger prevents UPDATE/DELETE on queue_events

---

## M5 — Recovery, Accessibility, Device Health (F4, F7, F9)

### M5.1 Ticket recovery

- [ ] Recovery credential generation and secure storage
- [ ] Rate-limited recovery endpoint
- [ ] Grace window and rejoin policy configuration
- [ ] Recovery UI flow

### M5.2 Accessibility

- [ ] Keyboard navigation for all visitor flows
- [ ] ARIA live regions for status updates
- [ ] High-contrast and large-text modes
- [ ] `prefers-reduced-motion` support
- [ ] Mobile viewport testing at 320px and 375px

### M5.3 Device health dashboard

- [ ] Device last-contact display
- [ ] Sync health indicators
- [ ] Coordinator status and failover controls

### M5 exit criteria

- [ ] Groups 8 (recovery), 11 (accessibility) tests pass
- [ ] Keyboard-only visitor journey end-to-end verified

---

## MQ — Ask Que Anything (F13, planned; scheduled after M5, before M6)

> Added 2026-11-07 (PRD Addendum A, ADR-011, REQ-F13, design §11). Inserted without renumbering
> M0–M7. **Entry gate:** M5 exit criteria met (visitor join/status/recovery, sync states,
> accessibility baseline and device health exist, so help can describe real behaviour).
> The AI layer (MQ.4) is optional: MQ is complete with the AI layer disabled if no approved
> free-tier or sponsored provider is available. No subscription or paid inference may be activated.

### MQ.1 Contracts and deterministic core (`packages/assist`)

- [ ] ADR-011 formally accepted (it remains Proposed until this task); `packages/assist` added to package-boundary tables (imports `contracts` only)
- [ ] `KbArticle`, `CapabilityManifest`, `RouteId`, `QueAnswer` schemas in `packages/contracts`
- [ ] Shared permission map moved to `packages/contracts` and used by both API and Que route registry
- [ ] Route/screen registry with required permissions and default articles per screen
- [ ] Deterministic search and answer builder (no I/O)
- [ ] Capability manifest generated from server flags; `GET /api/v1/que/capabilities`

### MQ.2 Knowledge-base delivery and offline

- [ ] Build step compiling Markdown articles to versioned per-audience bundles
- [ ] `GET /api/v1/que/kb/public` (precached) and authenticated `GET /api/v1/que/kb` (role-filtered)
- [ ] Service-worker precache for public bundle; per-user cache for restricted bundles
- [ ] Offline staff-help authorization expiry (`authorizedUntil`), role-digest binding and invalidation triggers per design §11.5.2–§11.5.3
- [ ] Build check: restricted bundles contain no tenant-sensitive content (design §11.5.1)
- [ ] Incremental update by bundle/article version

### MQ.3 Que UI (accessible, mobile-first)

- [ ] "Ask Que" trigger in the page shell for every role including visitors
- [ ] Panel/sheet with search, "On this screen", article view, permitted links only
- [ ] Offline / built-in help / AI badges with text labels; live-region announcements; focus management
- [ ] No operation buttons inside Que

### MQ.4 Optional AI explanation layer (disabled by default)

- [ ] `InferenceAdapter` interface; `DisabledInferenceAdapter` (default); `SandboxInferenceAdapter` (tests)
- [ ] `POST /api/v1/que/ask` with strict validation, rate limits, PII redaction, daily cap, timeout
- [ ] Output guard (citations, links, capability truthfulness, markup) with deterministic fallback
- [ ] Facility opt-in setting (admin-only, audited) and AI disclosure in UI
- [ ] AI endpoint requires a staff session; anonymous visitors get deterministic help only
- [ ] Provider research recorded against design §11.8 (research only; no account requiring payment details; no selection or integration without a separate explicit decision)

### MQ.5 Knowledge-base content (seed)

- [ ] Articles for live M1–M5 behaviour per design §11.10 (visitor, reception, counter, supervisor, admin, auditor, connectivity)
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

## M6 — SMS and USSD Channels (F11, F12)

### M6.1 SMS adapter and outbox

- [ ] `SandboxSmsAdapter` with full interface compliance
- [ ] Notification outbox worker implementation
- [ ] SMS templates for all 5 notification types
- [ ] Delivery receipt handling and status recording
- [ ] Live provider adapter (post provider selection)

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

### M6 exit criteria

- [ ] Group 10 (channel adapter) tests pass in sandbox
- [ ] Live delivery only if approved provider and credentials available
- [ ] Sandbox traffic labeled unmistakably as test

---

## M7 — Hardening, Demo, Submission (all features)

### M7.1 Performance and security hardening

- [ ] `pnpm audit` — zero high/critical vulnerabilities
- [ ] Load testing: 1,000+ scripted operations reconcile idempotently
- [ ] Rate limiting verified on all public endpoints
- [ ] Webhook signature verification verified under adversarial test

### M7.2 Demo preparation

- [ ] `infra/seeds/demo_seed.sql` — clinic/service-desk demo scenario
- [ ] End-to-end demo script for all 6 journeys (A–F)
- [ ] Outage and reconnect demo runs deterministically

### M7.3 Documentation and submission

- [ ] `README.md` updated with diagrams, screenshots, setup instructions
- [ ] `docs/testing/` contains evidence for all test groups
- [ ] All 10 core capabilities demonstrated end-to-end
- [ ] Kiro contribution documented with concrete artifacts
- [ ] Public demo video ≤ 3 minutes

### M7 exit criteria

- [ ] All ten core feature groups demonstrated in integrated workflows
- [ ] All test groups 1–12 passing
- [ ] Group 13 (Ask Que) passing in the final regression, including runs with AI disabled and offline
- [ ] Public repo, working app, demo video complete
- [ ] Feature-to-requirement mapping table published
- [ ] Ask Que acceptance (REQ-F13, MQ exit criteria) re-verified against the final capability manifest
