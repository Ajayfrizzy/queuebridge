# M2 Completion Report — Core Queue Operations and Visitor Flows

**Branch:** `feature/m2-queue-core`, fast-forwarded from `d0ceb6f` to `staging` @ `1019792` (after Ask Que PR #3). Committed and pushed for review via a pull request to `staging` (not merged).
**Evidence:** `docs/testing/M2-evidence.md` · **Checklist:** `.kiro/specs/queuebridge/tasks.md` (M2)

## Completed scope

**Database — `infra/migrations/0004_queue_core.sql`** (additive, idempotent):

- **Online operations:** `client_operations` accepts online operations (`source='online'`; `device_id` still required for `offline_sync`) and stores `proof_hash`.
- **Ticket codes:** `services.ticket_prefix`, a facility-unique 1–3 letter prefix.
- **Ticket lifecycle:** timestamps, a preserved `joined_at`, the creation channel and transfer links.
- **Database-enforced invariants:**
  - `UNIQUE(session, issued_sequence)`.
  - One called/serving ticket per counter (partial unique index).
  - A ticket can be transferred only once.
  - A session's service belongs to its facility (trigger), and the session has a composite tenant FK.
- **Credential lookup:** `ticket_recovery_credentials` is indexed by hash.
- **Actor FK:** the `queue_events.actor_id` FK changes from `ON DELETE SET NULL` (which would UPDATE an append-only row) to `RESTRICT`. This replaces a constraint, not a column.

**API:**

- **Sessions:** per service per day, in the facility's time zone; open, pause, close and same-day reopen.
- **Commands:** `POST /queues/:id/commands` runs the architecture's transaction steps:
  1. Authenticate and authorize by facility role.
  2. Deduplicate by `(organization_id, operation_id)`.
  3. Lock the session row (or rows) in id order.
  4. Check role, state and policy via the domain transition table.
  5. Apply the change, append a hash-chained event, record the disposition and `pg_notify`.
  6. Return `committed | duplicate | rejected`.
- **Selection:** deterministic next-ticket selection under the service's published, versioned policy.
- **Joins and walk-ins:**
  - Anonymous visitor join is idempotent with lost-ACK recovery: the same operation id and proof returns the same ticket with a rotated token.
  - Staff walk-in endpoint.
  - Ticket codes look like `G001`.
- **Visitor access:** token-protected ticket status (header token, SHA-256 at rest, 24 h validity). Status follows transfers.
- **Public endpoints:** join catalog, display board (codes and counter names only), and SSE change-signal streams for public, visitor and staff views. Streams use LISTEN/NOTIFY, have connection caps, heartbeats and a 15-minute lifetime.
- **Estimates:** explainable wait estimates from real, bounded service samples. They report `insufficient_data` when evidence is missing and are never an exact time.
- **Readiness (M1):** the join link is operational only when configuration is ready **and** an operational service has an open queue today.

**Web:**

- **Visitor join** (`/join/:org/:facility`): idempotency key and proof are persisted _before_ sending; existing tickets are shown; a "for someone else" confirmation is required for a second ticket.
- **Ticket page** (`/ticket/:code`): live status, position, counter, estimate with an explanation, published rules, a "Confirmed" marker, an assertive turn alert, a forget option, a storage-failure warning, and transfer following.
- **Display board** (`/display/:org/:facility`): codes only, with optional spoken announcements switched on by a person.
- **Staff console** (`/staff…`):
  - Facility and today's queues, with open for managers.
  - Counter selection; call next; serve, complete, missed, hold, recall and transfer.
  - Waiting / on-hold / finished lists, with cancel confirmation.
  - Walk-in tickets with a status-link QR; queue controls; a new-visitor estimate.
  - A retry for network failures that reuses the same operation id.
  - Every view refreshes live from SSE, with a 15 s polling fallback.

## Validation results

All local gates pass: format, strict lint, typecheck (8), build, unit tests (212 across 8 workspaces), **312 real-PostgreSQL tests** (10/10 consecutive full runs), **64 Playwright tests** at desktop and 320/375 px (84 after the UI refinement and header fix; see the final section), DB-validation workflow steps, fresh-DB migrate and seed (×2), audit (no high/critical) and a production-mode smoke test. Details are in the evidence file.

## Unresolved risks and explicit deferrals

1. **CI not run.** Nothing is committed or pushed, so GitHub CI hasn't run.
2. **Universal CSRF header requirement.** Every state-changing `/api/*` request now requires `X-QB-CSRF` and an allowed Origin, including anonymous joins. M6 webhooks will need an explicit, signature-verified exemption.
3. **Transfers go to the back of the destination queue.** A transferred ticket gets a new issue number at the destination, while its original join time is preserved and shown. A fairness position policy for transfers belongs to M4 routing.
4. **Priority classes are inert in M2.** All tickets are `normal`; the ordering already honours enabled classes. Overrides with reasons arrive in M4.
5. **No server-side cap on joins per person.** Duplicate prevention is idempotency plus an explicit "for someone else" confirmation on the device. There is no per-IP or per-person cap, deliberately, because clinic Wi-Fi is shared. A configurable stricter policy (REQ-F2.5 "configurable") is only partly met.
6. **No recovery for lost tokens.** A visitor who loses their status token cannot recover it; recovery is M5. Tokens live in `localStorage` on the visitor's device (no PII; a "forget" button is provided).
7. **No automatic no-show or end-of-day handling.** Staff mark missed tickets manually. Sessions don't auto-close at the end of the day, so waiting tickets left in yesterday's session stay there and are not migrated.
8. **Operating hours aren't configurable.** The estimate says so instead of clamping (design §7 step 6).
9. **Some limits are per instance.** Rate limits and SSE connection caps are in-memory per API instance. Live fan-out does work across instances (via NOTIFY).
10. **Projections are computed per request.** Each SSE signal makes every subscriber refetch. This is fine at M2 scale but should be measured in M7.
11. **Spoken announcements vary by browser.** They depend on the browser's speech voices; the visual board is the primary channel.
12. **New UI strings aren't localized.** They aren't routed through i18n yet (same as M1).
13. **Changes to earlier artifacts:**
    - The M0 estimate assertion was changed (REQ-F6.6).
    - One M1 Playwright assertion now expects the real join page instead of the placeholder.
    - The M1 readiness tests now encode the M2 rule.
    - The M1 migration-idempotency test moved to an isolated database (fixing the deadlock flake).
    - Design §4 and §7 were amended additively.

Out of scope and untouched: M3 offline and sync, MQ Ask Que, M6 SMS/USSD, the final UI redesign.

## Environment notes

- **Postgres container:** `queuebridge-pg` (QueueBridge's own disposable container) was stopped externally at 10:35 UTC and I restarted it. Avroqen's containers show `Exited` since about the same time. I did not stop, start or modify them.
- **Python package:** to run the DB-validation workflow steps locally I temporarily installed `pyyaml` for my user, then uninstalled it.
- **Your dev API was stopped by mistake.** During the smoke test I stopped a process on port 3002 that was **your `pnpm dev:api` server** (started Nov 7 15:03), wrongly believing it was my smoke-test server. Restart it with `pnpm dev:api`. The smoke test was then redone on port 3199 with my own, tracked process.

## Manual acceptance steps

Start the stack:

```bash
docker start queuebridge-pg
export DATABASE_URL=postgres://postgres:password@localhost:55433/queuebridge
pnpm install && pnpm build && pnpm db:migrate
export SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
NODE_ENV=development pnpm dev:api   # API on :3002
pnpm dev:web                        # http://localhost:5173 (proxies /api to :3002)
```

1. **Prepare the facility.** Sign in as an org admin (or sign up). Create a facility, a service (e.g. "General Consultation"), a counter, and tick the service on the counter.
2. **Before opening.** On the facility Overview, the join link says "Not live yet — No queue is open today".
3. **Open the queue.** Use **Staff console → facility → Open today's queue → Open console**. The Overview should then show "Live".
4. **Display board.** In another window, open the "public display board" link from the Overview. Tick "Spoken announcements" if you want audio.
5. **Visitor join.** In a private window or on a phone, open the join link and choose **Get a ticket**. You should get `G001`: Waiting, "You are next", Confirmed, an estimate of "Not enough information…", and the queue rules.
6. **Call, serve, complete.** In the console, press **Call next**. The visitor page changes to "It is your turn… Counter 1" and the board shows `G001 → Counter 1`, both without a reload. Then press **Start serving** and **Complete**, and the visitor sees "Your visit is complete".
7. **Walk-in.** Press **Issue walk-in ticket**, then scan the QR (or use "Show status link") on a phone. The ticket opens without an account.
8. **Second ticket for another person.** On the visitor device, open the join link again. It lists your ticket and requires ticking "for someone else" for a second one.
9. **Pause and close rules.** **Pause queue** stops joins and calls, and the visitor sees "paused". **Close queue** is refused while tickets are waiting; complete or cancel them, then close, then reopen.
10. **Transfer.** Open a second service's queue. While serving a ticket, use **Transfer to** with a reason. The visitor's original page follows to the new code, keeping the join time.
11. **Missed ticket.** Call a ticket, press "Did not come (missed)", then use **Return to queue** within 5 minutes; it is refused after the grace window.
12. **Read-only roles.** Sign in as an auditor (invite one). The console is read-only.
13. **Ticket privacy.** In another browser with no token, open `/ticket/G001`. It shows "does not have access".
14. **Estimates.** After 5 or more completed services (each served for a realistic time), new tickets show a range such as "About 2–12 min" with "How this is estimated" factors, never a single time.

Automated suites:

```bash
TEST_DATABASE_URL=postgres://postgres:password@localhost:55433/queuebridge_test pnpm test:db
TEST_DATABASE_URL=postgres://postgres:password@localhost:55433/queuebridge_test pnpm --filter @queuebridge/web test:e2e
```

---

## UI consistency refinement (post manual acceptance, pre-commit)

All 16 manual checks had passed. A visual review then found spacing and layout defects, which are now fixed with shared tokens and patterns rather than page-specific overrides:

- **Spacing tokens.** `--space-1…6` and `--control-h` added.
- **Flow spacing.** Card, alert and column spacing comes from these tokens, which separates the Staff Console side panels and removes stray paragraph margins across M2 and M1 screens.
- **Selects.** One shared `select` style with a reserved arrow gutter, a theme-aware chevron, and a native fallback in forced-colors mode. Native element, keyboard and picker are unchanged.
- **Transfer form.** Rebuilt as a reusable `.form-grid` fieldset, with labels above controls and responsive columns.
- **Walk-in hand-off.** A centred `.qr-panel` with aligned actions.
- **Staff console hierarchy.**
  - A stat row for queue state, waiting count and update mode.
  - A focal current-ticket panel whose primary action comes first.
  - Call next shown as the main action only when the counter is free.
- **Visitor screens.** Join, ticket and board use the same toolbar and card rhythm; board next codes are shown as chips.
- **Accessibility fix found during the review.** Board `aria-labelledby` ids contained spaces (broken labels); they are now index-based.

Evidence: before/after screenshots in `docs/testing/screenshots/m2-ui/`, 12 new geometry-based layout tests at 320/375/1280/1440 px (with negative controls), and full regression green twice. Details are in `docs/testing/M2-evidence.md`.

Remaining UI notes (not defects; for the later brand redesign):

- ~~Mobile header wrapping~~ — resolved before commit (see below).
- **Notification toast:** it overlays content while visible (it is dismissible and auto-hides).
- **Truncated selects at 320 px:** long option text truncates with an ellipsis in the closed select; the full text stays available in the native picker and to assistive technology.
- **Wrapping ticket-row details:** "Walk-in · joined 03:07 PM" wraps onto two or three lines at 320 px.

---

## Pre-commit review (final)

- **Narrow-mobile header (320/375 px).** Measured before the change: no overlap, no clipping and every control at least 44 px, but the wrapping was accidental (the account name sat on the navigation row at 375 px, and Sign out dropped onto a stray row).
  - Now a deliberate three-row layout below 40 rem: brand; navigation links; and an account row with the name left and Sign out right.
  - Account identity and Sign out moved out of the Primary `<nav>` list into a labelled `Account` group, so the navigation landmark contains only navigation.
  - Regression test `@responsive site header` (signed in and anonymous × 4 widths, 8 tests): no clipping, no pairwise overlap, targets of at least 44 px, row order on narrow screens, and keyboard Tab order (skip link → brand → nav links → Sign out).
  - Screenshots: `before-header-signedin-{320,375}.png`, `after-header-signedin-{320,375}.png`.
- **Diff review.** 86 files, all within M2 areas. No secrets, no `.env` (it stays ignored), no `console.log`/`debugger`/`.only`, and no lint or TS suppressions. The only skip is the capture utility below. Modified M1 tests were reviewed: none was weakened (one gained a diagnostic message; one asserts the real join page instead of the M1 placeholder).
- **The 4 skipped Playwright cases** are one test, `ui-layout.spec.ts › @responsive visual capture › M2 screens`, run once per browser project. It is gated by `test.skip(!CAPTURE, 'capture only')` and only writes screenshots. Every flow it drives is asserted, without screenshots, by `queue-journey.spec.ts` and the `UI layout consistency` tests. No behavioural coverage is skipped.
- **Final local results:** format PASS · lint PASS (0 warnings) · typecheck 8/8 · build PASS · unit 212 PASS · real PostgreSQL 312 PASS · **Playwright 84 passed, 4 skipped (capture-only), on 2 consecutive full runs** · audit: no high/critical (5 low/moderate, unchanged).
- **Evidence:** 20 curated screenshots in `docs/testing/screenshots/m2-ui/` (1.6 MB).
