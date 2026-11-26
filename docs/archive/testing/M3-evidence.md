# M3 Test Evidence — Continuity Engine (F1 offline, F9)

**Branch:** `feature/m3-continuity-engine` (created from `staging` @ `25d3686`, M2 merged). Committed and pushed; PR #5 → `staging` (not merged).
**Date:** 2026-11-08 · **Node:** 24 · **pnpm:** 9 · **PostgreSQL:** 17 (disposable Docker container `queuebridge-pg`, port 55433)
**Status:** all local gates and all GitHub CI jobs pass (see "GitHub CI — PR #5").

## GitHub CI — PR #5 (final)

Head before this documentation commit: `071dfc73eff530c725f8e7b1a15edf72271e2b68`. Both workflow runs (push run 42540488564, pull-request run 42540493199) and the migration-validation run (42540493192) passed every job:

| Job                                                                     | Result                                                                                                      |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Lint and typecheck (format:check, eslint `--max-warnings 0`, typecheck) | PASS                                                                                                        |
| Tests (without DB)                                                      | PASS                                                                                                        |
| Build all packages and apps                                             | PASS                                                                                                        |
| Tests with PostgreSQL — real PostgreSQL                                 | PASS: 21 files, **395** tests                                                                               |
| Tests with PostgreSQL — Playwright (real API + PostgreSQL + built web)  | PASS: **108 passed**, 4 pre-existing capture-only skips                                                     |
| Apply migrations and validate constraints (`db-validate.yml`)           | PASS: 0005 applied, idempotent re-run, append-only UPDATE/DELETE rejected, both unique constraints enforced |
| Security audit (`pnpm audit --audit-level high`)                        | PASS: 0 high/critical (5 low/moderate, unchanged from M2)                                                   |

History: on `1676de4` the pull-request run failed one boundary test (`sync-timing.db.test.ts`) — a test defect, fixed in `071dfc7` without relaxing any assertion (see completion report).

**Codex review:** reviewed `1676de4` → 3 P2 findings, all fixed in `071dfc7` with regression tests. A re-review of `071dfc7` was requested (`@codex review`) and **did not run: the account has reached its Codex code-review usage limits** (connector message, 2026-11-09 00:38 UTC). No Codex review of the fixes exists; CI does not depend on it.

## Gate results (local)

| Gate                                                                 | Result                                                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm format:check`                                                  | PASS                                                                                                                           |
| `pnpm lint` (`--max-warnings 0`)                                     | PASS (0 errors, 0 warnings)                                                                                                    |
| `pnpm typecheck`                                                     | PASS (8/8 workspaces, 0 errors)                                                                                                |
| `pnpm build`                                                         | PASS                                                                                                                           |
| `pnpm test` (no DB)                                                  | PASS: contracts 68, domain 67, channels 18, continuity 61, ui 6, worker 6, api 45, web 28 (= 299)                              |
| `pnpm test:db` (real PostgreSQL)                                     | PASS: 21 files, **395** tests (M2 baseline on this branch: 13 files, 313); 5 consecutive runs before the review round, 3 after |
| Playwright (`pnpm --filter @queuebridge/web test:e2e`)               | PASS: **108 passed**, 4 capture-only skips (pre-existing), at 1280, 1440, 375 and 320 px                                       |
| DB validation (all 7 run-steps of `db-validate.yml`, fresh database) | PASS                                                                                                                           |
| `db:migrate` fresh DB, then again; `db:seed` twice                   | PASS: 5 applied (incl. `0005_continuity_engine.sql`), then no-op; seed idempotent                                              |
| Migration 0005 re-executed on an isolated DB                         | PASS (`schema-m3.db.test.ts`)                                                                                                  |
| `pnpm audit --audit-level high`                                      | No high/critical. 5 low/moderate — unchanged from M2 (no dependency was added or changed)                                      |

## Architectural acceptance gate (architecture §16 / ADR-006)

`apps/api/src/acceptance-gate.db.test.ts` has one end-to-end check per question; variants are in the files below.

| Question                                         | Answer in code                                                                                                                                                                      | Tests                                                                                                         |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1. Who may advance the queue offline?            | Only the device a supervisor designated, holding a server-signed, unexpired token for that queue/epoch, for granted actions. Others may only capture. Online advancement is fenced. | Q1; `coordinator.db.test.ts` token/device/action cases; `authority-device.test.ts`; e2e "without authority"   |
| 2. Local only vs globally confirmed?             | Everything recorded offline is `local_only`/`pending_sync` until the server returns `committed`; visitor views show server state only; every committed change has a `queue_event`.  | Q2; `flush.test.ts`; `projection.test.ts`; e2e Journey C (board/visitor unchanged while Local)                |
| 3. Two devices or the server disagree?           | The server sequence wins. Stale epoch → `needs_review`; other mismatches → `needs_review` with a reason. Nothing is merged or overwritten.                                          | Q3; partition tests (both arrival orders, simultaneous ×3); e2e two-Call-Next                                 |
| 4. Can duplicates change state twice?            | No. `(organization_id, operation_id)` unique; stored disposition replayed (`duplicate`).                                                                                            | Q4; 12× concurrent capture; 8× concurrent lost-ACK retry; 1,000-op double submission; randomized flush replay |
| 5. Coordinator loses device or storage?          | Advancement suspends (fence) until explicit, audited failover; old epoch fenced; a wiped browser re-registers as a new device with no authority.                                    | Q5; revoked-device tests; expiry tests; e2e expiry                                                            |
| 6. How do staff recognise and resolve conflicts? | Outbox rows and connectivity bar show "Needs review" with a plain reason; supervisors resolve in the dashboard (apply re-validated / dismiss, with reason), audited; device learns. | Q6; conflict review tests; e2e supervisor dismiss → device shows outcome                                      |

## What the tests prove

### Group 3 — continuity (pure, `packages/continuity`)

- `authority-device.test.ts`: token decoding rejects malformed/invalid claims; capture always allowed; advancement denied for no authority, wrong queue, wrong device, expiry, action outside grant, superseded epoch; device-clock offset compensated; **winding the clock back cannot revive expired authority** (high-water mark).
- `outbox.test.ts`: an operation is durable when `record` resolves; storage failure raises (never acknowledged); `client_sequence` strictly increases per device even when the wall clock goes backwards; envelopes are schema-valid; visitor status tokens are never copied into local results.
- `flush.test.ts`: order by `client_sequence`; network failure keeps everything pending; **lost ACK → retry returns `duplicate`, server commits once**; needs_review/rejected surfaced, never "synced"; needs_review re-polled so resolutions are learned; another user's operations never sent; 100-command batches; unanswered operations not assumed synced; **25 randomized rounds with 40% lost responses converge to exactly one commit per operation**.
- `projection.test.ts`: provisional tickets show the temporary reference marked Local; untouched server tickets carry no local status; call/serve/complete fold deterministically; local call decision mirrors server rules.

### Groups 4 and 7 — real PostgreSQL (`apps/api`)

- `sync-batches.db.test.ts`: capture → confirmed code + status token (token not persisted); lost-ACK capture → same ticket; events carry origin/device/epoch and no personal data; `client_sequence` order regardless of array order and client clocks; same batch twice → same dispositions, no state change; mixed batch labels each command and still processes valid ones; temporary refs resolve within a batch; operation-id reuse refused.
- `sync-concurrency.db.test.ts`: 12× concurrent identical capture → 1 ticket, 1 event; two devices + online joins racing → gap-free numbers and sequences; concurrent lost-ACK retries never advance twice; coordinator batch racing joins and renewal → one linear replayable history, no ticket called twice; **1,000 scripted operations (250 visits × 4) commit, a full resubmission returns 1,000 `duplicate` with revision unchanged, the hash-chained log replays to the same state**.
- `schema-m3.db.test.ts`: 0005 idempotent; constraints present; epoch cannot decrease (trigger); coordinator requires expiry; resolution must name resolver/time/reason; dedupe index intact.

### Group 6 — partitions and failover (`coordinator.db.test.ts`)

- Who may designate (403/404/401); one coordinator per queue; unqualified owner, foreign, revoked device and closed queue refused; all authority changes hash-chained with actor, epochs and reason; idempotent by operation id; coordinator actions cannot be performed offline.
- Signed token required; tampered/garbage/other-device tokens and ungranted actions refused; renewal keeps the epoch.
- Expired authority: actions claimed before expiry commit, after expiry → `needs_review`; expired authority not re-delivered.
- Online fence while designated (and after expiry), lifted by revoke.
- **Two conflicting Call Next** (failover mid-outage), both arrival orders and simultaneous: exactly one `ticket.call_next` event, the current epoch's; the stale one is `needs_review`, listed for review, and replays stably.
- Revoked device: `403 device-revoked`, no state change, coordinator stripped (epoch+1), audited.
- Queue closed during outage: capture held, not migrated; cannot be applied while closed; applied after reopen, attributed to the original capturer; device replay → `duplicate`.
- Conflict review: dismiss (idempotent, not flippable, audited), RBAC and tenant isolation, listing.
- Snapshot delivers authority only to the active coordinator; device health states.

### Group 8 — security (`sync-security.db.test.ts`)

- 401 on every continuity endpoint unauthenticated; CSRF header required.
- Cross-tenant: snapshot/register/revoke/heartbeat/health 404; a rival tenant's sync into our queue → `queue_not_found` even with our org id in the envelope; nothing written.
- Another user's / unknown device → `403 device-not-authorized`; another user's recorded action → `actor_mismatch` (never re-attributed); no-role staff → 404; a coordinator who loses the counter role cannot commit.
- Strict validation (unknown fields, batch size, PII-looking extra payload fields refused, values not echoed); device cap; auditors read-only; counters cannot see device health.
- Stored envelopes, results and events contain no emails, names or phone numbers; the authority token carries ids/epoch/actions/expiry only.

### Groups 5, 11, 12 — browser (`apps/web/e2e/offline.spec.ts`, real stack)

- **PWA:** with the service worker, the shell, the last authorized queue and facility pages reopen with the network off (marked "last saved copy"); a never-visited page says it has no saved copy.
- **Journey C:** offline walk-in → temporary reference `P-XXXXXX`, persisted in IndexedDB before the message; Local indicator; board/server unchanged; survives reload; on reconnect it syncs once to `G001`, provisional row disappears.
- No authority → capture only, Call next disabled. Coordinator offline call shows Local while the server still says waiting; **authority expiry (fake clock +45 min) disables advancement, capture still works**.
- **Two conflicting Call Next in the browser:** the online supervisor call commits; the coordinator's call becomes Needs review with a plain reason; supervisor dismisses in the dashboard; the device shows the outcome.
- Sign-out with unsent actions warns; after sync, sign-out erases caches and identity. Shared device: one person's unsent action is never sent under another person's sign-in and stays stored. No-IndexedDB browser: offline mode says it is off and refuses to record.
- Dashboard: designate, end authority, revoke device (confirmed); the revoked device is told; counter staff cannot see the dashboard.
- **Accessibility:** axe WCAG 2.1 A/AA clean on the offline console (with outbox) and dashboard at 320, 375, 1280 and 1440 px; no horizontal overflow.

### Offline authority timing vs untrusted device clocks (second pass)

Root cause of the reported issue: `sync.ts` compared `created_at_client` (device wall clock) with the expiry. Removed; replaced by signed `delivered_at` + device elapsed-time evidence (design.md "Offline authority timing").

- `apps/api/src/queue/timing.test.ts` (unit, 14 cases): server timeline = `delivered_at + elapsed`; holds for missing evidence, rollback, floor > estimate, exactly-at and after expiry, floor after expiry, restarted-and-synced-after-expiry, future claims, forged `delivered_at`, tokens without `delivered_at`; accepts restarted evidence received before expiry; uses the earlier of signed and stored expiry; detects elapsed going backwards beyond jitter.
- `packages/continuity/src/authority-device.test.ts` (rewritten, 18 cases): a device clock 3 h wrong is irrelevant; sleep is counted (conservative); clock wound back while open → `clock_unverifiable`, capture still allowed; rollback is sticky; jitter tolerated; clock wound back before a restart detected against the persisted floor; floor carried across restarts and never decreases; token re-delivery keeps the monotonic anchor unless epoch/expiry/page session changes.
- `apps/api/src/sync-timing.db.test.ts` (real PostgreSQL, 20 cases):
  - **the reported issue:** an action with a wall-clock stamp before expiry but evidence after it → `authority_expired`, ticket unchanged; a far-future stamp with valid evidence still commits; device-reported rollback → `clock_rollback`; elapsed going backwards → second action held;
  - **delayed sync:** monotonic evidence inside the window commits 2 h after expiry; at/after expiry held; wall clock jumped forward → treated as later;
  - **restarts:** synced before expiry commits; synced after expiry held (`authority_timing_unverifiable`); floor past expiry → `authority_expired`;
  - **forgery:** no evidence, evidence for an unpresented token, forged `delivered_at`, future-dated, inconsistent floor → held; negative elapsed → `invalid_command`;
  - **renewal/failover:** offline renewal does not retro-extend; shortened authority honoured; failover fences first (`stale_epoch`); a supervisor can deliberately apply a held action, after which the device's replay is `duplicate`.
- Browser (`e2e/offline-timing-handover.spec.ts`): with Playwright's fake clock, 40 min pass and the wall clock is wound back → console shows "clock was changed", advancement disabled, capture still works, and the earlier in-window call carries clean monotonic evidence. With the service worker: offline call → **reload while offline** → serve (evidence `restarted`) → reconnect inside the window → both commit exactly once.
- Existing expiry test (`coordinator.db.test.ts`) now mints a signed token delivered 10 min ago / expired 1 min ago: the action timed at +5 min commits on late sync, the one at +9.5 min is held.

### One-time status link for offline captures (second pass)

- `apps/api/src/sync-handover.db.test.ts` (real PostgreSQL, 6 cases, TRACE-level logs captured): the committed capture returns a 43-char credential that works for the confirmed code and not for the temporary reference; the credential appears nowhere else — `client_operations`, `queue_events`, `admin_events`, credential table (hash only), public board, staff queue view, conflicts list, **server logs**. Advancement results carry none. **Lost ACK:** retry → `duplicate` with a new credential; the unseen one stops working; one ticket. **6 concurrent retries:** one ticket, exactly one valid credential. Only the capturing user on the capturing device gets one (same user on another device, a supervisor, another tenant → no credential, visitor's link unaffected). A held capture returns no code and no credential; after supervisor apply (whose response contains none), the capturing device's replay gets one.
- `packages/continuity/src/flush.test.ts`: credentials surface in the flush report but never in the store; never for rejected/needs_review, non-capture actions or missing codes.
- Browser: offline capture → reconnect → "Confirmed: G001" (never the `P-` reference) with QR and link; the secret is not in IndexedDB; a visitor context opening the link sees the confirmed ticket and the fragment is scrubbed from the address bar; **Done** removes it (also gone after reload); **New status link** gives a different link and the old one shows no access; neither secret appears on the public board. **Lost ACK in the browser** (first `/sync/batches` processed by the server, response aborted): the retry hands over a working link, the operation is `duplicate` on its 2nd attempt, one ticket. Another staff member on the same queue sees the ticket but no hand-over.

### PR #5 review regressions

- `apps/web/e2e/offline-review-fixes.spec.ts` (identity changes happen inside the running SPA — sign-in form and in-app links, never a reload):
  - **finding 1:** A signs out, B signs in on the same tab → B's offline capture is recorded under B's own device and syncs (`committed`, hand-over shown). Failed before the fix (recorded under A's device).
  - **finding 2:** session ends while offline → reconnect shows "sign-in ended", action kept `pending_sync` → same person signs in again in-app → the action syncs and the notice clears. Failed before the fix.
  - **finding 3:** an online coordinator's Call next goes through the outbox with its exact token and commits immediately; afterwards only the queue's current token remains stored.
- `packages/continuity/src/flush.test.ts` "authority selection per batch": 45 commands timed against 45 different authorities → batches of 20/20/5, each presenting exactly its commands' tokens (≤ 20), order preserved, all 45 committed; asynchronous lookup supported. Failed before the fix.
- `apps/web/e2e/offline.spec.ts` shared-device test: the 1.5 s sleep was replaced by a deterministic check (a real flush under the second user; no request contains the first user's operation id).
- `apps/web/e2e/offline-timing-handover.spec.ts`: the replacement warning ("Replace the status link for G001? … stop working immediately"); "Keep current link" leaves the visitor's link valid; confirming replaces it and the old link loses access.
- `apps/api/src/sync-timing.db.test.ts`: all instants derived from one per-test anchor; the exact-expiry window is asserted to be exactly 30 min (fixes the CI-only boundary failure without relaxing the assertion).

### Regression (M1, M2)

All pre-existing DB tests (313) and Playwright journeys pass unchanged in intent; the first-pass M3 suites (fencing, conflicts, partitions, offline storage, sync labels, staff authorization, 1,000-op idempotency) pass after the timing change. Two M2 Playwright failures seen mid-development (duplicate "Staff console" link and a second live region in the new connectivity bar) were fixed in the new component, not by editing the tests.
