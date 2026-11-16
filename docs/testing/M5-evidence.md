# M5 Test Evidence — Recovery, Accessibility, Device Health and Smart Turn Alerts

**Branch:** `feature/m5-recovery-accessibility-alerts` (from `staging` @ `2da1ced`, which contains M0–M4 and the M5–M7 specification, PR #7).
**Status (2026-11-15):** M5.0–M5.4 implemented and checkpointed locally (`87ec587`, `e0214c5`, `b8bc96f`, `83fbd3b`, `6a75213`, `fd5d52e`); M5 integration checkpoint `dba73a8`; development database migrated to 9/9; manual acceptance not yet executed. See the **M5 acceptance report** at the end of this file. Sections below are kept as written at each checkpoint (historical record).
**Environment:** macOS, 11 cores, Node 24, pnpm 9, Playwright Chromium, PostgreSQL in the disposable Docker container `queuebridge-pg` (port 55433, database `queuebridge_test`). Playwright runs the built API and web app, `workers: 2` (as in CI) unless stated.

---

## M5.0 — Stabilization of known intermittent tests

Three intermittent failures were carried over from M4 (`M4-completion.md`, testing steering "Stabilization rule"). Each was reproduced first, then root-caused, then fixed. No assertion was removed or loosened, and no retry, timeout increase or `test.skip` was added.

### Summary

| #   | Test                                                                                                          | Reproduced                                                                                                                 | Root cause                                                                                                                                         | Kind                                             | Fix                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `security-isolation.spec.ts` "sign out ends the server session; the back button does not resurrect data" (M1) | Yes: 31 of 40 at 20× CPU throttling, same symptom as the failed PR #6 CI run                                               | One-shot `<Navigate>` route guard skipped its redirect when React coalesced the sign-out navigation, the guard redirect and Back into one render   | **Production code** (browser timing exposes it)  | `RequireAuth` redirects from an effect re-evaluated on every location change; sign-out navigates home before the user is cleared          |
| 2   | `review-fixes.spec.ts` "the notice can be dismissed without signing out" (M1)                                 | Yes: 8 of 40 locally (unloaded); 3 of 40 under CPU load                                                                    | Ambiguous locator: the aborted logout can also raise the "You are offline" toast, whose button "Dismiss notification" also matches `'Dismiss'`     | **Test implementation** (race with a toast)      | Locator scoped to the sign-out notice with `exact: true`; also asserts the notice is visible first                                        |
| 3   | `offline.spec.ts` "a browser that cannot store offline data says so and refuses to pretend" (M3)              | Yes: 1 of 30 and 2 of 50 in the targeted mix; 3 of 100 with only the product fix reverted; deterministic unit reproduction | (a) The test clicked before the app had registered the outage. (b) A response to a request sent before the outage flipped the app back to "online" | **Test synchronization** and **production code** | `goOffline()` waits for the app's own "Offline" state; responses received after the browser reported offline no longer report "reachable" |

### 1. M1 sign-out and Back

**Historical evidence.** GitHub Actions run `43235014591` (PR #6 pull-request run on `3c46343`) failed this test at `security-isolation.spec.ts:58`: after Sign out and Back, the URL stayed `http://localhost:4173/admin` for 10 s instead of moving to `/login`. The push-triggered run on the same commit passed.

**Baseline on the untouched code** (`--repeat-each=40`, unthrottled): 40 of 40 passed. The failure does not show on a fast, idle machine.

**Reproduction.** I wrote a temporary harness with the same steps (since deleted), with the page CPU-throttled through the Chrome DevTools Protocol after sign-in:

| CPU throttling | Passed | Failed |
| -------------- | ------ | ------ |
| 1×             | 40     | 0      |
| 6×             | 40     | 0      |
| 20×            | 9      | 31     |

Every failure had the CI symptom: URL `/admin`, an empty `<main>`, no heading. An instrumented run recorded `pushState /` → `replaceState /` → `popstate /admin` and then nothing else. The guard never redirected again. Calling `history.back()` from a microtask, a task or 15 ms after the sign-out navigation, without throttling, did **not** reproduce it (20 of 20 each). The defect needs slow rendering, not just a fast Back.

**Root cause.** `RequireAuth` rendered `<Navigate to=… replace />`, which redirects once, when it mounts. Under slow rendering React folded these into a single render whose final router location equalled the first: the `navigate('/')` after sign-out, the guard's own redirect for the now-signed-out user on `/admin`, and the immediate Back to `/admin`. The guard had already "fired" and never fired again. A signed-out visitor was left on a blank protected URL. No data was shown, because the guard renders nothing without a user, and the server session was destroyed. It is a broken screen, not a data exposure. The sign-out navigation also ran only after the user state was cleared, so for one render the guard saw "no user" while the URL was still `/admin`.

**Fix (production code).**

- `apps/web/src/components/RequireAuth.tsx`: the redirect to `/login` is an effect re-evaluated on every router location change. It is skipped only while the browser URL has already moved past the location being rendered, because that newer navigation is the one that counts.
- `apps/web/src/auth.tsx` and `apps/web/src/components/Layout.tsx`: `logout(afterConfirmed)` runs the home navigation after the server confirms and local data is erased, and **before** the user is cleared, so no guard ever sees "no user" on a protected URL during sign-out. The now-unneeded `signedOut` / `acknowledgeSignedOut` flag is removed. The rule that only a server-confirmed sign-out (or a 401) signs the user out is unchanged.

**Regression test.** `security-isolation.spec.ts` "signing out and pressing Back on a slow device never leaves a blank protected page": four sign-in, sign-out and Back cycles at 20× CPU throttling, asserting `/login`, a visible heading, no facility data, and a server-side 401.

| Code                                      | Passed | Failed                           |
| ----------------------------------------- | ------ | -------------------------------- |
| Fixed                                     | 15     | 0                                |
| Original (product fix stashed, test kept) | 0      | 15 (14 in cycle 1, 1 in cycle 2) |

The harness reproduction after the fix: 40 of 40 at 20× and 40 of 40 at 40×.

### 2. M1 logout "Dismiss" notice

**Baseline on the untouched code:** 32 of 40 passed (unloaded), 37 of 40 under CPU load. Every failure was the same: `strict mode violation: getByRole('button', { name: 'Dismiss' }) resolved to 2 elements`. The second element is the toast's button, whose accessible name is "Dismiss notification" (`getByRole` name matching is substring by default).

**Root cause (test implementation).** The aborted logout request makes the API client report the server unreachable. The connectivity layer then announces "You are offline" in a visible toast. Whether that toast exists at click time is a race, which explains both the intermittency and why CI usually passed. The application is correct: both buttons are legitimate and correctly named.

**Fix.** The locator is scoped to the sign-out notice (`getByTestId('logout-error')`) and uses `exact: true`. The test also asserts the notice is visible before clicking. All original assertions remain: the notice disappears, and the user is still signed in. If Dismiss stops working, or if the notice never appears, the test still fails.

### 3. M3 storage-unavailable test

This one had two causes, found one after the other.

**3a. Clicking before the app knew it was offline (test synchronization).** `ctx.setOffline(true)` changes the network immediately, but the page learns about it from a later browser `offline` event. A click before that event takes the app's online path. The online path correctly answers "Cannot reach the server …", which is not the offline behaviour the test checks. I confirmed this by delaying the app's `offline` listener by 1.5 s in a temporary harness: 2 of 10 runs failed with exactly that message. Waiting for the app's own "Offline" indicator removed the failures (10 of 10).

Fix: `goOffline(ctx, page)` in `e2e/offline-helpers.ts` takes the context offline and waits until the connectivity bar reads "Offline". It is used in this test and in four other offline tests that had the same unsynchronized `setOffline` → click pattern. This only adds a precondition, so it makes them stricter.

**3b. A stale success flipped the app back online (production code).** After 3a, a 50-run stability wave still failed twice, once _inside_ `goOffline` with the app showing "● Online" for the full 10 s. The trace showed the mechanism. A queue refresh sent just before `setOffline` received its 200 response just after the browser's `offline` event. The API client reported every successful response as "server reachable", so the stale success switched an offline app back to online. Nothing switched it off again, because no new request failed. With the app wrongly "online", a staff action is sent to the server instead of being captured locally, which is a behaviour change, not just a wrong label.

Deterministic reproduction: the new unit test `apps/web/src/lib/reachability.test.ts` sends a request, fires the browser `offline` event while it is in flight, then resolves it with 200. On the original code the observer receives `true` (test **fails**). After the fix it does not (test passes). Three companion cases keep the intended behaviour: an online success reports reachable, a network failure reports unreachable, and the `/health` probe still restores reachability.

Fix (`apps/web/src/lib/api.ts`), tightened during the M5.0 checkpoint review (below): negative signals take effect at once, and only a server health probe restores reachability.

**Connectivity rule after the checkpoint review.** The first version of the fix still had two gaps: a stale response arriving after the browser reported `online` again (but before any health check) could restore "reachable", and after a _server_ failure with the browser still online any ordinary API success restored "reachable" without a health check. Final rule, implemented in `api.ts`:

1. **Negative signals take effect at once.** The browser's `offline` event, any network failure and a failing `/health` probe report "unreachable" and start a new _outage epoch_. The API module now listens for `offline` itself, so this holds even without the offline provider mounted.
2. **Only server health validation restores reachability.** A `/health` probe restores "reachable" only if it was sent and answered within the current outage epoch while the browser reports online. A probe in flight when an outage began does not count.
3. **Ordinary API responses never restore reachability.** While reachable they change nothing. During an outage, a response to a request sent within the current epoch triggers a probe, and the probe decides. A response to a request sent before the outage is ignored.

Startup is unchanged from M3: the initial state follows `navigator.onLine` until the first request or probe answers. That is an initial assumption, not a restoration after an outage.

`reachability.test.ts` (10 cases) covers each rule. Against the original pre-M5 `api.ts`, 7 of 10 fail. Against the first M5.0 version, the same 7 fail: the two gaps above, plus the cases that need the API module's own `offline` listener. All 10 pass on the final version. The affected browser suites (`offline`, `offline-review-fixes`, `offline-timing-handover`, `review-fixes`, `security-isolation`, `queue-journey`; 46 tests) pass with the final version.

**Isolated vs mixed runs.** Run alone, the storage test passed 150 of 150 with 4 workers both with and without the `api.ts` fix, so the race does not show in isolation on this machine. In the targeted mix (four tests interleaved, 2 workers):

| Code                            | Storage test passed | Failed                                                          |
| ------------------------------- | ------------------- | --------------------------------------------------------------- |
| `api.ts` fix reverted (3a kept) | 97                  | **3**, each with the original "Cannot reach the server" message |
| Fixed, waves 1–3 (300 runs)     | 299                 | 1, an environment stall, see below                              |

### Stability after the fixes

Targeted mix of the four tests (the three tracked plus the new regression test), `--repeat-each`, 2 workers:

| Run                                              | Sign out + Back | Slow-device regression | Dismiss notice | Storage unavailable |
| ------------------------------------------------ | --------------- | ---------------------- | -------------- | ------------------- |
| 50-run wave                                      | 50 / 50         | 50 / 50                | 50 / 50        | 50 / 50             |
| 100-run wave 1                                   | 100 / 100       | 100 / 100              | 100 / 100      | 100 / 100           |
| 100-run wave 2                                   | 99 / 100        | 99 / 100               | 100 / 100      | 99 / 100            |
| 100-run wave 3                                   | 100 / 100       | 100 / 100              | 100 / 100      | 100 / 100           |
| 100-run wave 4 (final, strict connectivity rule) | 100 / 100       | 100 / 100              | 100 / 100      | 100 / 100           |
| **Total**                                        | **449 / 450**   | **449 / 450**          | **450 / 450**  | **449 / 450**       |

**The three wave-2 failures were one environment event, not product or test defects.** They happened in the same window and in test _setup_, before any code under test ran. Two `apiRequestContext.post` calls (`apiFacility`, `apiQueueSetup`) hung until the 45 s test timeout, and one `uiLogin` never completed (the page still showed "Sign in"). These calls go from Playwright straight to the API and do not run any of the changed application code. The API logged no error, and the next 400 runs (wave 3) were clean. The cause of the stall was not identified. It is recorded as an open observation: if it recurs, check the local API and PostgreSQL. The test database had accumulated 18,570 organizations (343 MB) from repeated runs at this point. Tests use unique slugs, so this is not shared state between tests, but database growth is a candidate.

### Checkpoint review of the M5.0 diff (security and unintended changes)

- **Route guard (`RequireAuth`).** While it redirects, the guard renders nothing (`null`), never the protected outlet, so no protected content is shown in the interval. Unauthenticated access still lands on `/login` ("anonymous visitors are redirected away from administration" passes). The skip condition ("browser URL already differs from the rendered location") only defers to a newer navigation. The effect re-runs when the router catches up, so it cannot suppress a redirect permanently.
- **Sign-out (`auth.tsx`, `Layout.tsx`).** The user is still cleared only after the server confirms the sign-out or answers 401, and after local data is erased. A network failure, 5xx or 403 still keeps the user signed in with the accessible error. The `afterConfirmed` callback only navigates. The removed `signedOut` flag only redirected guards to `/` instead of `/login` during sign-out; navigating home before the user is cleared replaces it. The 500 → retry, network failure, 401 and Dismiss tests all pass.
- **Connectivity (`api.ts`).** Only in-memory reachability state changes. No storage, credential, endpoint or request content changes. The change can only make the app _more_ conservative about believing it is online. The worst case is that a staff action is captured locally (and synced later) when it could have gone online, which is the safe direction.
- **Unintended changes.** None found. The diff touches the files listed below. `offline.spec.ts` changes only replace `setOffline(true)` with `goOffline(...)`, which adds a precondition. The temporary harnesses were deleted.
- **Regression coverage.** Each product fix has a test that fails on the previous code: the slow-device Back test (0 of 15 on the old guard) and `reachability.test.ts` (7 of 10 on the old and first versions). The test-only fix (Dismiss) keeps its original assertions and adds a visibility check.

### Environment-stall investigation (open)

The three simultaneous wave-2 setup hangs (13:46–13:50 UTC on 2026-11-13) were investigated read-only. No data was deleted and no schema was changed.

| Check                                                | Finding                                                                                                                                                                                                                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL log in the window                         | No error, deadlock, termination, connection refusal or resource message. The only event: a **timed checkpoint 13:46:51–13:48:05** (74 s spread write, 717 buffers), inside the window                                                                                 |
| Deadlocks in `queuebridge_test` (`pg_stat_database`) | 5 in total, all on 2026-11-08 (M3 concurrency tests). None in the window                                                                                                                                                                                              |
| Connections                                          | `max_connections` 100. At inspection: one client backend (the inspection itself), no idle-in-transaction sessions, no lingering `LISTEN` connections                                                                                                                  |
| API pool in Playwright runs                          | The Playwright API server runs with `NODE_ENV=test`, so `createDb` uses **`max: 5` connections, shared by every tenant**. `connect_timeout` 5 s, no query timeout                                                                                                     |
| Server timeouts                                      | `statement_timeout` 0, `lock_timeout` 0, `idle_in_transaction_session_timeout` 0: a slow or blocked query waits indefinitely, and the test sees a silent hang instead of an error                                                                                     |
| Fixture accumulation                                 | 355 MB; 19,584 organizations, 16,655 facilities, 36,974 staff users, 32,603 tickets, 100,506 queue events, 134,560 admin events. Tests use unique slugs and tenants, so there is no shared state between tests                                                        |
| Sequential scans (costs grow with accumulation)      | `admin_events` 309 scans averaging 69,348 rows; `client_operations` 97 averaging 20,289; `ticket_recovery_credentials` 105 averaging 19,200; `tickets` 1,073 averaging 6,965. Which statements cause them (production paths or test assertions) is not yet attributed |

**Assessment.** The simultaneous hang of three requests from three different tenants points to a shared resource rather than row locks. The most likely candidate is the 5-connection pool, saturated by statements slowed by the coinciding checkpoint on Docker Desktop's virtualized storage, together with growing sequential scans. Because no timeout is configured, saturation shows up as a 45 s hang. **This is a hypothesis, not a proven cause.** It was not reproduced.

**Next steps (not done here, to keep M5.0 within scope and avoid changing database settings):** enable `pg_stat_statements` in a throwaway database to attribute the sequential scans; set a test-only `statement_timeout`/`lock_timeout` so a recurrence fails loudly with the blocking statement; consider a separate test database per run instead of an ever-growing shared one. M5.1+ evidence will record whether the stall recurs.

### Validation gates (final tree)

| Gate                                                                                     | Result                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                                                      | PASS                                                                                                                                                                                      |
| `pnpm lint` (`--max-warnings 0`)                                                         | PASS                                                                                                                                                                                      |
| `pnpm typecheck`                                                                         | PASS                                                                                                                                                                                      |
| `pnpm build`                                                                             | PASS                                                                                                                                                                                      |
| `pnpm test` (no DB)                                                                      | PASS: contracts 102, domain 98, channels 18, continuity 64, ui 6, worker 10, api 53, web **44** (M4: 34; +10 reachability tests)                                                          |
| `pnpm test:db` (real PostgreSQL)                                                         | PASS: api 26 files / 478 tests, worker 13 (unchanged from M4)                                                                                                                             |
| Playwright offline suites (`offline`, `offline-review-fixes`, `offline-timing-handover`) | PASS: 18 / 18                                                                                                                                                                             |
| Playwright full suite, all projects (1280, 1440, 375, 320 px), run twice                 | PASS three runs (the last on the final strict connectivity rule): **132 passed**, 4 skipped (the opt-in screenshot capture, `CAPTURE` unset), 0 failed (M4 locally: 130 passed, 1 failed) |
| DB validation workflow                                                                   | Not re-run: no migration or schema change                                                                                                                                                 |

### Files changed in M5.0

- `apps/web/src/components/RequireAuth.tsx`: effect-based guard (root cause 1)
- `apps/web/src/auth.tsx`: `logout(afterConfirmed)`, `signedOut` flag removed (root cause 1)
- `apps/web/src/components/Layout.tsx`: navigates home through `logout` (root cause 1)
- `apps/web/src/lib/api.ts`: no "reachable" report from responses received after the browser reported offline (root cause 3b)
- `apps/web/src/lib/reachability.test.ts`: new; deterministic regression for 3b
- `apps/web/e2e/security-isolation.spec.ts`: new slow-device regression test for 1
- `apps/web/e2e/review-fixes.spec.ts`: scoped Dismiss locator (2)
- `apps/web/e2e/offline-helpers.ts`: `goOffline()` (3a)
- `apps/web/e2e/offline.spec.ts`: `goOffline()` in the storage test and four tests with the same pattern (3a)
- `docs/testing/M5-evidence.md`: this document
- `.kiro/specs/queuebridge/tasks.md`: M5.0 boxes checked

The temporary reproduction harnesses (`e2e/zz-m50-repro*.spec.ts`) were deleted. Raw logs are kept outside the repository under `/tmp/qb-m50/`.

---

## M5.1 — Secure ticket recovery (F4; design §15; ADR-015; Group 8: 8.R1–8.R12)

Status: implemented and verified locally; **not committed, not pushed**. Everything below was run on the working tree on top of the M5.0 checkpoint (`87ec587`).

### What was built

- **Credentials.** A 160-bit CSPRNG recovery key (Crockford base32, 32 characters), shown once at join and on staff walk-ins. Stored only as HMAC-SHA-256 with an HKDF-derived pepper from `CONTACT_ENCRYPTION_KEY` (separate derivations for key, grant and throttle), compared in constant time, bound to the root ticket (it follows transfers). Without the environment key recovery is **disabled**, never weakened (join returns `recovery_key: null`, `/tickets/recover` answers 503).
- **Status tokens.** At most 3 active; the oldest is revoked on the 4th. A replayed join revokes earlier join tokens; "sign out other devices" and staff revoke-all revoke the rest. Revoked rows are kept and purged by retention.
- **Throttling.** Keys are HMACs of public identifiers and the source only, never the guess. L1 10 attempts/min/source (every attempt counts, malformed ones included); L2 5 failures/15 min per ticket per source; L3 50 failures per ticket and L4 100 per facility refuse only sources that already failed and raise an audited abuse event; L5 caps concurrent verifications per process (503). No lockout state and no unlock action exists: all windows expire within 15 minutes, a clean source with the right key always succeeds.
- **Staff-assisted recovery.** No verified factor ⇒ restricted assistance, no credential. Basic factor ⇒ request needing a **different** `QUEUE_MANAGE` approver (API and table CHECKs). Single-use grant, 10 minutes, redeemed only on the visitor device from a QR, never shown to staff as text. Limits 3 per ticket/hour and 5 per staff/10 min; auditors and visitors refused; `staff_recovery=false` switches the path off; audit events carry no values.
- **Rejoin and auto no-show.** `rejoin_policy` (`staff_resume` default, `self_resume`) through the standard command path with a `visitor_self` transition actor, inside the existing `grace_window_seconds` only. Automatic no-show is off by default, needs explicit seconds (60–3600), runs as an API sweep through `executeSystemTransition` (session lock, deduplication, M3 coordinator fence, ticket lock, domain transition table, hash-chained event, `client_operations` record), deterministic UUID-v7-layout operation id, database time, clock restart after the last coordinator event and after a detected outage, no import path to notification code.
- **Web.** Recovery key panel (readable groups, QR, Copy/Share/Save/Print), `/recover` pages (fragment read once then removed, POST body, uniform failure, offline message, no CAPTCHA), ticket-page actions (new key, sign out others, rejoin, access-granted notice, published auto no-show rule), staff recovery panel with supervisor approval list, admin policy fields, retention job in the worker.
- **Migration `0007_ticket_recovery.sql`** (additive; the only drop is the superseded unique `ticket_id` index).

### Deviations from the design (recorded; design §15.4 updated)

1. **Grant CHECK split.** The design's single `CHECK (assurance <> 'basic' OR (approved_by IS NOT NULL AND approved_by <> created_by))` would reject a pending request. It became three CHECKs: approver differs from creator, approval pair, and "no redemption of a basic grant without approval". The API also checks the second person and returns 403 `second-person-required`.
2. **Throttle scope `facility_source`** added to the four in the design, so L4 can refuse only sources that already failed in that facility.
3. **Grant minted at assist time.** The secret is created with the request and returned to the requester, but cannot be redeemed until approved.
4. **Revoked tokens are retained** (marked, purged 24 h later) instead of being deleted at once.
5. **`testClockOffsetSeconds`** on the sweep: `queue_events` is append-only, so tests cannot backdate a call; they move the sweep's clock. Production always uses the database clock.
6. **Staff revoke-all also removes the recovery key** (the phone may have been stolen with it). The visitor needs the assisted procedure to regain access. The UI says so.

### Test evidence

| Suite                                                     | Result                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recovery.db.test.ts` (real PostgreSQL; 8.R1–R8, R11, L5) | 44 / 44, three consecutive runs (the 44th, added at checkpoint review: replacement key, sign-out-others and the ticket routes are 404 with a public code alone, a malformed, unknown, another tenant's or a revoked token; a token acts only on its own ticket even when two tenants share a public code) |
| `auto-miss.db.test.ts` (8.R9, 8.R12)                      | 21 / 21, three consecutive runs                                                                                                                                                                                                                                                                           |
| `apps/worker/src/retention.db.test.ts` (8.R10)            | 7 / 7 (own throwaway database)                                                                                                                                                                                                                                                                            |
| `policies.test.ts`, `recovery.test.ts`, domain additions  | pass                                                                                                                                                                                                                                                                                                      |
| `recoveryKey.test.ts` (web unit)                          | 5 / 5                                                                                                                                                                                                                                                                                                     |
| Playwright `recovery.spec.ts`                             | 15 / 15 across 1280, 1440, 375 and 320 px (axe, overflow, keyboard-only, offline, two staff)                                                                                                                                                                                                              |

Coverage by requirement (all on real state, nothing mocked):

- **8.R1** a code alone, a code with a wrong key, a bare status read and a guessed grant yield nothing; the QR/link path holds no secret outside the fragment.
- **8.R2** unknown ticket, wrong key, ended ticket and cross-facility attempts return identical status and body; the browser shows one message for all failures.
- **8.R3** 1,000-style distinct wrong guesses count against the same keys; L1–L4 each exercised; no lock state; clean-source holder succeeds during an attack; counters exact under parallel guesses.
- **8.R4** length, alphabet, uniqueness, HMAC-only storage, normalization, cap of 3, rotation matrix, no key in `localStorage`, `sessionStorage`, URLs requested by the browser or the address bar.
- **8.R5** the whole staff flow in the UI with two different people; requester cannot approve (button disabled, API 403, table CHECK); grant single-use and unusable before approval.
- **8.R6** no recovery action appends a `queue_events` row or changes state, position or waiting age; works while a coordinator holds the queue.
- **8.R7** concurrent correct recoveries, recovery vs new key, vs sign-out-others, grant redeemed twice, vs completion.
- **8.R8** `self_resume` inside the window only; refused after it, under `staff_resume` and while a coordinator holds the queue; idempotent by `operation_id`.
- **8.R9 / 8.R12** (a)–(f) as listed in the testing steering, including four concurrent sweepers on separate connections producing exactly one miss per ticket, a ticket the coordinator served offline not being missed, outage detection restarting the clock, a fresh process behaving identically, and a static import-graph check.
- **8.R10** retention windows, bounded batches, idempotence, transfer chains and closed sessions.
- **8.R11** cross-tenant 404, CSRF, no secret in events, audit, grants, throttle rows or error bodies.

### Mutation checks (the tests fail against the wrong implementation)

| Mutation                                      | Result                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| Token lookup ignores `revoked_at`             | 6 failures (cap, sign-out-others, join replay, staff revoke-all, 2 sync-handover) |
| Throttle keys include the guess               | 7 failures (L1, L2 ×2, L3, L4, no-lockout, parallel counting)                     |
| Unapproved basic grant usable                 | 1 failure                                                                         |
| Requester may approve own request             | 1 failure                                                                         |
| System executor ignores the coordinator fence | 2 failures (auto no-show fence, rejoin fence)                                     |
| Old `samePolicy` (earlier check)              | `policies.test.ts` fails                                                          |

Every mutation was reverted and the files compared byte for byte with the backup.

### Gates (final tree)

| Gate                                                 | Result                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check` / `lint` / `typecheck` / `build` | PASS (lint `--max-warnings 0`)                                                                                                                                                                                                                                                        |
| `pnpm test` (no DB)                                  | PASS: contracts 116, domain 103, channels 18, continuity 64, ui 6, worker 10, api 56, web 49                                                                                                                                                                                          |
| `pnpm test:db`                                       | PASS: api 28 files / 543 tests, worker 2 files / 20 tests                                                                                                                                                                                                                             |
| Playwright full suite, all projects                  | PASS: 147 passed, 4 skipped (opt-in screenshot capture), 0 failed. A first run found 2 real regressions from a staff button labelled "Sign out all…" colliding with existing "Sign out" locators; the button was renamed ("End access on all…") and no existing assertion was changed |
| Fresh migration + re-run                             | PASS: 7 migrations apply to an empty database; a second run skips all                                                                                                                                                                                                                 |

### Remaining risks and limits (stated, not hidden)

- **The basic factor is a human check.** Service and approximate join time are things a person who watched the visitor could also know. The second-person approval and audit trail raise the cost of abuse but cannot prove identity. The stronger contact-based factor arrives with M6.
- **KNOWN LIMITATION: the per-staff assist limit (5 per 10 minutes) is not atomic.** `staffAssist` counts the staff member's recent grants and then inserts, inside a transaction that locks only the TICKET's proof row. The per-ticket limit (3 per hour) is therefore exact, but several simultaneous requests by one staff member for DIFFERENT tickets can each read the same count and together exceed 5. The overshoot is bounded by the number of concurrent requests that member can make, and every request is still audited, needs a second person's approval, and yields a single-use 10-minute grant. It is not covered by a concurrency test (the exact-limit behaviour is tested sequentially). A fix needs a per-staff advisory lock or a counter row, and is left for a later milestone; it is not hidden by any test.
- **Shared addresses.** Throttling is per source (IPv4 address, IPv6 /64). Many visitors behind one NAT share L1; a shared source that fails repeatedly on one ticket is slowed for 15 minutes, never locked out for good.
- **Automatic no-show is late by up to a sweep interval** and by design never earlier than the deadline; while a coordinator is assigned it does not run at all.
- **The key lives in page memory only.** A reload before the visitor saves it loses it (they can make a new one from the ticket page). This is the intended trade-off.
- **Environment stall (M5.0, open).** Not observed during any M5.1 run (db suite, Playwright full suite ×2, mutation runs). Still unexplained; remains open.
- **Not verified here:** real-device camera scanning of the QR codes, screen readers on the recover and staff panels, print output of the key page, native share sheets and clipboard on iOS. These need the manual passes below.

### Manual acceptance (ALL OUTSTANDING: none has been performed; to be recorded before M5 closes)

1. On a phone, scan the key QR from another phone and confirm the ticket opens and the address bar shows no key.
2. VoiceOver (iOS) and TalkBack or NVDA: complete the recover form, hear the failure message and the "ticket recovered" announcement; use the staff panel's approval list.
3. Print the key panel: only the key text and ticket code print (the buttons and hints are hidden by the print rule).
4. At 200 % zoom and extra-large text, confirm the 32-character key wraps without horizontal scrolling.
5. With two real staff accounts at a desk, run the assisted recovery end to end and check that the requester cannot approve.

### Files (M5.1)

Added: `infra/migrations/0007_ticket_recovery.sql`; `packages/contracts/src/recovery.ts` (+test); `apps/api/src/recovery/{crypto,credentials,throttle,service}.ts`; `apps/api/src/routes/recovery.ts`; `apps/api/src/queue/auto-miss.ts`; `apps/api/src/queue/policies.test.ts`; `apps/api/src/{recovery,auto-miss}.db.test.ts`; `apps/worker/src/retention.ts` (+db test); web `RecoverPage`, `RecoveryKeyPanel`, `StaffRecoveryPanel`, `lib/recoveryKey.ts` (+test); `e2e/recovery.spec.ts`.
Modified: contracts (`admin`, `queue`, `schemas`, `enums`), domain state machine, API commands/tickets/joins/sync/views/policies/app/env/routes, test harness, worker, `db-identity.js`, web API client, tickets lib, JoinPage, TicketPage, StaffConsole, FacilityServices, App, styles, Playwright config, `.env.example`, `docs/local-environment.md`, design §15.4, tasks.

### Checkpoint review (before the M5.1 commit)

- Diff reviewed file by file: 61 files, all inside M5.1 scope (no M5.2–M5.4 code). `.env` is git-ignored and not staged; `.env.example` holds placeholders only. A scan of changed files found no private keys, provider tokens or committed secrets. The only fixed key strings are the two TEST-ONLY values (`harness.ts`, `playwright.config.ts`), which are labelled as such. No log call in the API or worker mentions keys, grants, tokens or hashes. The only `unsafe()` uses interpolate constant SQL fragments, never request data.
- Tenant isolation: staff routes resolve the ticket through `organization_id` and facility; visitor routes resolve through the token. Cross-tenant requests return 404 (covered in 8.R11 and the new test).
- The replacement-key workflow (`POST /tickets/:code/recovery-key`) requires the ticket's status token; the public code alone is refused (new test).
- M5.0 checkpoint `87ec587` is the parent of the M5.1 checkpoint; history is not rewritten.

---

## M5.2 — Accessibility (F7; design §16; Group 11: 11.A1–11.A9, 11.A11)

Status: implemented and verified locally; **not committed** (awaiting review). Base: `e0214c5` (M5.1). These are automated checks and recorded manual requirements. **They do not establish WCAG conformance**; conformance needs the manual passes and expert review listed below.

### What was built

- **Device-local preferences** (`lib/a11yPrefs.ts`, key `qb.a11y.v1`): contrast (system/high), text size (100/125/150 %), motion (system/reduce), quiet, sound (off by default), vibration (on where supported). Validated field by field, stored in `localStorage` only (six fields, no personal data, never sent, never in the outbox), applied as `data-*` attributes on `<html>` in `main.tsx` before React renders, followed across tabs, reset to defaults, and kept for the page session if storage fails (the dialog says so).
- **"Display and alerts" dialog** (native modal `<dialog>`; header on every page and on the ticket page): focus moves in, Tab wraps inside, Escape or Close closes, focus returns to the opener; works offline; at 320 px it scrolls inside itself. Sound and vibration are disabled with a text reason when unsupported or when quiet mode is on. **Test alert** runs only the enabled cues (at most one short tone, one short vibration), is labelled "Test" and announced.
- **Cue rule shared with M5.4** (`cuesFor`): visual alert always on; sound and vibration only if chosen, supported and not quiet. The existing foreground vibration on the ticket page now obeys it. **No notification delivery was added**; the settings text says alerts are never promised when the page is closed.
- **High contrast / text size / reduced motion** through the existing CSS custom properties and root font size; high contrast has a light and a dark palette (text 7:1 or better) and thicker borders and focus rings. The app has no animations or transitions of its own (verified in the built CSS), and the OS or in-app reduced-motion setting also removes any others.
- **Announcement policy** (`lib/announcePolicy.ts`, `Announcer`): identical messages inside 2 s are dropped; position announcements are throttled to one per 15 s (later changes skipped, not queued); the polite region and a new assertive region exist at page load. The ticket page announces position changes (polite, throttled) and keeps its assertive "called" alert (once per call). Sync-state changes are announced in words ("No unsent actions remain on this device", "N actions need a supervisor to review").
- **Route-change focus** (`lib/routeFocus.ts`): after in-app navigation focus goes to the page `h1` (to `<main>` first while data loads, then to the heading if the person has not moved focus) and the title becomes "Heading — QueueBridge". Closing the recovery-key panel keeps focus on the heading instead of dropping it.
- **Offline ticket view:** the ticket page stores its last confirmed status per saved ticket (`qb.ticketView.v1`: exactly what the page shows, no token or key) and, when the server cannot be reached, shows it labelled "You are offline. This is the last information we confirmed at …". Refusals (404/401) are never masked by it.
- **PWA manifest:** `orientation: 'portrait'` removed.
- **Targets:** checkboxes are 24 CSS px and no longer shrink in narrow rows.
- Offline-recover page text, outbox panel and connectivity bar already existed (M5.1/M3) and are now covered by Group 11 tests.

### Deviations and decisions (recorded)

1. **Title announcement.** The design says the title is "announced once". Moving focus to the `h1` already makes a screen reader read it, so a separate live announcement would read it twice. The title is updated and focus moves; no extra live message is made (tested: the polite region does not repeat it). **The manual screen-reader pass must confirm it is heard exactly once.**
2. **Focus target.** REQ-F7.11 says the heading, so the old behaviour (focus `<main>` on every navigation) changed. Two existing assertions were updated to the heading (`accessibility.spec.ts` after sign-up, `queue-journey.spec.ts` after joining). The skip-link-to-`#main` assertion is unchanged. No assertion was weakened: the new target is stricter.
3. **Header test.** The header gained a control, so `ui-layout.spec.ts` now includes it in its overlap/size/clipping checks and in the keyboard order. The row and size assertions are unchanged.
4. **Assertive region has no `role="alert"`** (only `aria-live="assertive"`): an always-present empty `role="alert"` broke the single-alert locators of existing tests and adds nothing for assistive technology. The called alert on the ticket page keeps `role="alert"`.
5. **Sync announcement wording.** "No unsent actions remain on this device" is deliberately neutral: the same count drops to zero when work is discarded on purpose, so the message never says "confirmed".
6. **Dialog containment** uses the native modal (page behind is inert) plus Tab wrapping, because native modals let focus leave to browser chrome in some browsers.
7. **200 % zoom** is equivalent to 320 CSS px on a 640 px window (and 400 % on a 1280 px window), so the 320 px tests cover reflow; real zoom is part of the manual pass.

### Test evidence

| Suite                                                                                                               | Result                                                                                        |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `a11yPrefs.test.ts`, `announcePolicy.test.ts`, `routeFocus.test.ts`, `Announcer.test.tsx`, ticket-copy tests (unit) | pass (web unit total 78)                                                                      |
| `e2e/accessibility-m52.spec.ts` (Group 11), 49 tests across 1280, 1440, 375 and 320 px                              | 49 / 49, **three consecutive full runs** after the checkpoint-review fixes (five before them) |
| Full Playwright suite, all projects                                                                                 | 194 passed, 4 skipped (opt-in screenshot capture), 0 failed                                   |
| `pnpm test:db` (PostgreSQL)                                                                                         | api 543, worker 20 (unchanged; no API change in M5.2)                                         |

Group 11 coverage: **11.A1** keyboard-only join → ticket → settings → recover and rejoin; **11.A2** heading focus, title, dialog trap/Escape/return, focus preserved when the person has moved, visible focus ring, 24 px / 44 px targets, scroll padding; **11.A3** live regions exist at load, called alert assertive and once, position announcements 1 per burst; **11.A4** applied before first render (observed at first render), persistence, reset, offline change, cross-tab, no network traffic, six fields only; **11.A5** 7:1 in high contrast, axe (WCAG 2.1 A/AA incl. contrast) on join, recover, ticket, key panel, settings and test-alert banner in normal and high contrast, extra-large text without horizontal scrolling at 320/375; **11.A6** OS and in-app reduced motion remove transitions and animation (control case proves the probe), no keyframes in the shipped CSS; **11.A7** defaults, unsupported controls disabled with an associated reason, quiet mode, Test alert counts (one tone, one vibration), real call vibrates once and never in quiet mode, no delivery promises; **11.A8** recover page offline, ticket offline copy, no masking of refusals, staff offline announcements (each exactly once), outbox labels and axe; **11.A9** manifest has no orientation, viewport allows zoom, every visitor route fits in portrait and landscape.

A first run of the staff-offline test failed intermittently (2 of 3 repeats). Cause, found by reading the traces: the test read the announcement log before the 30 ms write, and, more importantly, the announcer could **cancel a message announced within 30 ms of another**. Fixed in the product (distinct messages now replace the text immediately; only an identical repeat is cleared and re-written) and in the test (it waits for the message). 5/5 consecutive runs since.

### Bundle size (REQ-F7.7)

| Build           | Raw      | gzip     |
| --------------- | -------- | -------- |
| M5.1 checkpoint | 552.9 kB | 166.8 kB |
| M5.2            | 565.6 kB | 170.7 kB |

M5.2 adds about 3.9 kB gzip (+2.3 %). **The app ships as one chunk that was already above the 100 kB visitor-flow target before M5.2.** That is a pre-existing gap, not fixed here; route-level code splitting belongs with M7 (F15.5 budgets in CI). Recorded as unresolved.

### Limitations (stated, not hidden)

- axe finds only a subset of problems. Passing it, and the checks above, is **not** WCAG conformance.
- Sound and vibration are verified through stubs for call counts; real tone audibility and real vibration need real devices. Vibration is unsupported on iOS Safari, and the control says so.
- The `qb.ticketView.v1` copy is trusted only for display and is labelled with when it was confirmed; it is not a source of truth.
- Position announcements are skipped (not queued) inside the 15 s window, so a rapid burst reports the first value; the visible position is always current.
- Public display board audio (F7.6) is unchanged.
- The unexplained M5.0 environment stall did not recur.

### Manual acceptance (ALL OUTSTANDING: recorded here, none performed)

1. **Screen readers:** VoiceOver (iOS Safari) and TalkBack or NVDA: join, ticket status, called alert (heard once, assertively), position updates (not chatty), recover page and failure message, the settings dialog (name, state of each control, disabled reasons), and the route-change behaviour: the new page title must be heard **once**.
2. **Zoom and text:** 200 % browser zoom and OS extra-large text on a real phone: no clipped or overlapping content, no horizontal scrolling, the settings dialog usable.
3. **Contrast and colour:** high-contrast setting in light and dark OS themes; Windows forced-colors; confirm status never relies on colour.
4. **Reduced motion:** OS setting on iOS and Android, and the in-app setting.
5. **Orientation:** installed PWA in landscape and portrait on Android and iOS.
6. **Vibration and sound:** a real Android device (Chrome) for vibration and the test tone (device volume, silent mode); iOS for the "not supported" explanations.
7. **Keyboard:** hardware keyboard on a tablet or desktop across all visitor routes, including the focus ring over the fixed notification.
8. Expert accessibility review before any conformance statement.

### Unresolved

- Visitor-flow bundle above the 100 kB target (pre-existing; M7).
- The non-atomic per-staff recovery limit (below; M5.4 hardening, not part of M5.2).
- Staff-console pages were checked for the new header control, focus rule and the existing axe suite, but no new staff-specific accessibility journeys were added (M5.3 adds the device-health surfaces, 11.A10).

### Security follow-up: database-atomic per-staff assist limit (proposal for final M5 hardening; NOT implemented)

**Problem.** `staffAssist` counts a staff member's grants in the last 10 minutes and then inserts, holding only the **ticket's** proof-row lock. One staff member's simultaneous requests for different tickets can each read the same count and together exceed 5.

**Proposed fix: a per-staff transaction-scoped advisory lock, taken first.**

1. At the start of the transaction, before the ticket lock: `SELECT pg_advisory_xact_lock(hashtextextended('qb:recovery:assist:' || <organization_id> || ':' || <staff_user_id>, 0))`.
2. Then lock the ticket proof row (unchanged), count per ticket and per staff, insert.
3. **Lock order is always staff, then ticket**, and no other code path takes a ticket's proof lock and then a staff lock (approve, revoke-all and recovery take only the ticket lock), so no cycle and no deadlock.
4. Add `SET LOCAL lock_timeout = '3s'` and map a timeout to 503 `retryable` so a stuck holder cannot hang requests.

**Why this fits the constraints.**

- _Tenant isolation:_ the key contains the organization and staff ids; staff of other organizations never share a lock.
- _No global lock:_ different staff never contend; the same staff member's requests serialize, which is exactly the invariant.
- _No schema change or migration;_ the sliding-window semantics stay (the existing `COUNT` is correct once it is serialized). A hash collision only causes harmless extra waiting.
- _Alternative considered:_ a counter table with `INSERT … ON CONFLICT DO UPDATE … WHERE n < 5`. Atomic without locks, but it needs a migration and fixed windows instead of a sliding one. Not chosen.

**Regression tests (real PostgreSQL, concurrent):**

1. 20 parallel assists by ONE staff member for 20 different tickets: exactly 5 `approval_required`, 15 × 429, exactly 5 grant rows. (Fails today by design: the count is exceeded.)
2. Two staff members in one facility: while staff A's transaction is held open (a second connection holds A's advisory lock), staff B's request completes within the timeout, and A's request waits (proves no global lock).
3. The lock key embeds the organization: same-numbered ids in two tenants never block each other.
4. The per-ticket limit (3 per hour) stays exact; sequential behaviour is unchanged.
5. Mutation check: removing the lock fails test 1; swapping the lock order in a test harness path is checked for deadlock by running 50 mixed assist/approve/revoke-all requests concurrently with no deadlock error.

Status: proposal recorded; to be implemented and tested in the final M5 hardening pass.

### Files (M5.2)

Added: `apps/web/src/lib/{a11yPrefs,alertCues,announcePolicy,routeFocus}.ts` (+ tests for prefs, policy, route title); `apps/web/src/components/DisplaySettings.tsx`; `apps/web/e2e/accessibility-m52.spec.ts`.
Modified: `apps/web/src/{main.tsx,App.tsx,styles.css}`, `components/{Announcer,Layout,ConnectivityBar}.tsx`, `pages/TicketPage.tsx`, `lib/tickets.ts`, `apps/web/vite.config.ts` (orientation); e2e `accessibility.spec.ts`, `queue-journey.spec.ts`, `ui-layout.spec.ts` (updated as described above); this document, `tasks.md`, design §16.

### Checkpoint review (before the M5.2 commit)

Findings and what was done about them:

1. **Diff scope.** 26 files, all in `apps/web`, the M5 evidence document, `tasks.md` and design §16. No API, database, worker or package change; no M5.3/M5.4 code. No secrets, keys, `.env` values or build artifacts (scan of every changed file).
2. **Offline last-confirmed ticket copy.** It is written only after a successful token-authenticated status read, keyed by the device-local id of the saved ticket, and shown only for that saved ticket. It contains what the page shows (no token, key or contact data; unit test). **Finding fixed:** before the review, a copy survived a server refusal and would have been shown again if the device later went offline. Now a 401/403/404 removes it at once (e2e: staff "end access on all devices", then reload online shows the no-access screen, then offline shows nothing). "Forget this ticket" removes it too. It never reaches the server or the outbox. Staff sign-out does not touch it, exactly as for the existing saved-ticket list (`qb.tickets.v1`): visitor tickets on a device are not part of any staff session. Tenant isolation is unaffected because nothing new is requested from the server.
3. **Modal, route focus and live regions.** No route change can happen while the modal is open (the page behind is inert), and closing the modal returns focus to its opener without a route change, so the route-focus rule and focus restoration never compete. **Finding fixed:** an inert page also hides its live regions and alerts, so a turn alert or a blocking device/session problem arriving while the settings dialog was open would not have been heard. Both now raise an "urgent alert" event that closes the dialog first. The called banner still never takes focus; the device-problem alert takes focus after the dialog is gone (e2e: a call while the dialog is open closes it and the alert is the only `role="alert"` with the counter).
4. **Announcer scheduling.** **Finding fixed:** the first revision wrote distinct messages immediately, but React batches state updates made in the same instant, so of two messages sent together only the last reached the region (proved by a new fake-timer unit test). The announcer now keeps an ordered queue per level (polite and assertive are independent) and writes each message at least 300 ms after the previous one in that region, never dropping a distinct message (up to 8 waiting, the oldest discarded beyond that). The called alert on the ticket page keeps its own `role="alert"` region, unaffected by the queue. Unit tests cover: two messages at once, a message 10 ms after another, assertive not displaced by polite, a burst in order, dedupe and re-announce after 2 s, and the position throttle letting an offline message through. One e2e test was changed to wait for the announcement instead of reading it immediately (synchronization only; its assertions are unchanged).
5. **M5.0 and M5.1 commits** are unchanged (`87ec587`, `e0214c5`).

The bundle-size gap and every manual check above remain **outstanding**.

---

## M5 hardening — atomic per-staff recovery limit (security follow-up to M5.1; separate from M5.3)

Status: implemented and verified locally; **not committed**. Isolated to `apps/api/src/recovery/service.ts`, `apps/api/src/errors.ts` + `app.ts` (a `retryable` flag on problems) and the new test file `apps/api/src/recovery-staff-limit.db.test.ts`. No migration.

### Lock-order review

Before the change, every recovery path took at most these locks: the ticket's proof row (`lockProof`), the grant row (`FOR UPDATE`), and (revoke-all) the ticket's pending grants. No advisory locks existed. Recovery never takes the queue-session lock. The review found **two** problems:

1. **The per-staff limit was not atomic** (as documented at M5.1). Reproduced: 20 simultaneous requests by one staff member for 20 different tickets created **8** grants against a limit of 5.
2. **A deadlock between grant redemption and staff revoke-all** (not previously known). Redemption locked the grant row and then the proof row; revoke-all locked the proof row and then the grants. Reproduced: 2 of 25 simultaneous redeem/revoke-all pairs failed with a PostgreSQL deadlock (HTTP 500).

### Fix

- `staffAssist` takes `pg_advisory_xact_lock(key)` first, where `key` is a 64-bit hash of (organization id, staff user id): count-then-insert is serialized for one person only. Different staff never contend, and staff of different organizations never share a key. The transaction has `SET LOCAL lock_timeout = '3s'`; a timeout returns **503 `recovery-busy`, `retryable: true`**, with nothing written.
- Grant redemption now locks **ticket (proof row) then grant**, the same order as revoke-all. The grant is first read without a lock to learn its ticket, then locked and re-checked.
- Resulting lock order for all recovery paths: **staff advisory lock → ticket proof row → grant rows**. The advisory lock is taken only by `staffAssist`, so no cycle is possible.

### Tests (real PostgreSQL, separate connections)

| Test                                                                                         | Result                               |
| -------------------------------------------------------------------------------------------- | ------------------------------------ |
| 20 simultaneous requests, one staff member, 20 tickets → exactly 5 succeed, 15 × 429, 5 rows | pass (failed before the fix: 8 rows) |
| 5 bursts of 12 parallel requests (fresh staff each) → never more than 5                      | pass                                 |
| Staff B completes while staff A's lock is held by another connection; A waits, then succeeds | pass (proves no global lock)         |
| Lock wait beyond 3 s → 503 retryable, no grant                                               | pass                                 |
| Lock key differs per organization for the same staff id                                      | pass                                 |
| Per-ticket limit (3/hour) exact with 6 staff in parallel                                     | pass                                 |
| Deterministic: while redemption waits for the ticket lock it holds no grant lock             | pass (fails 3/3 with the old order)  |
| 25 rounds of simultaneous redemption + revoke-all: no 500, no live token left                | pass (old order: deadlocks)          |

**Test synchronization (found at the pre-commit full run).** The deterministic lock-order test failed once in the full parallel database suite. It inferred "the holder has its lock" and "the redemption is waiting" from global `pg_locks`/`pg_stat_activity` counts, which locks held by other suites running in parallel could satisfy early; the redemption then completed before the holder's lock existed. The three lock-observing tests now use a holder that signals once it really holds its lock and wait for a backend blocked by that holder's pid (`pg_blocking_pids`). Assertions are unchanged. Since then: three consecutive full parallel runs (api 569) pass, and both mutations below are still caught.

Mutation checks: removing the advisory lock fails 3 tests; restoring the old grant-first order fails the deterministic test 3/3 (the 25-round stress test caught it 1 time in 3, which is why the deterministic test was added). The M5.1 suite (`recovery.db.test.ts`, 44) passes unchanged.

---

## M5.3 — Device health (F9; design §17; Group 8: 8.D1–8.D6; Group 11: 11.A10)

Status: implemented and verified locally; **not committed** (awaiting review). Single-coordinator authority (ADR-006) is unchanged: health observes and recommends; nothing assigns, fails over, renews or revokes automatically.

### What was built

- **States by server time** (`@queuebridge/domain` `deviceHealthState`): `healthy · pending · offline (120 s) · stale (900 s) · needs_review · revoked`; coordinator `expiring` (300 s window) and `expired`. All thresholds are environment-configurable (API and worker read the same variables). The database clock is used for the dashboard read.
- **Migration `0008_device_health.sql`** (additive): `health_alerts` (unique partial index = one open alert per facility, kind and subject), `health_evaluations`, `devices.failure_streak`, partial indexes for the evaluator.
- **Worker `evaluateDeviceHealth`** (every `HEALTH_EVALUATION_INTERVAL_SECONDS`, default 30): the eight kinds of design §17.4 with their severities; one transaction; plain reads only; writes only `health_alerts` and `health_evaluations`; damping (resolve after two clear evaluations); subject-gone resolution; a `pg_notify` change signal without data; resolved alerts deleted after 30 days.
- **API:** `operations/health` extended (stale threshold, `expiring`, revoke reason, failure streak, alerts, evaluation status, recovery-abuse and turn-alert counters); `POST /facilities/:id/health/alerts/:alertId/acknowledge` (`QUEUE_MANAGE`, idempotent, audited `health_alert.acknowledge` with the kind only); `GET /health/alerts/summary` (banner; only facilities where the caller has `OPERATIONS_VIEW`); `GET /devices/:id/health` (own device only, 404 otherwise). The heartbeat stays strict; it now maintains the failure streak.
- **Web:** alerts panel on the connectivity dashboard (open / acknowledged / resolved today, severity as text and symbol, advice text that recommends and never acts, "alerts last checked", "automatic alerts are paused"), device filter and severity order, `stale` badge, honest silence wording, revoke flow with last contact and pending-count warning, revoked-row wording ("Up to N actions were pending … may be lost"; "register it again as a new device"), counters, a signed-in banner for alert recipients, and a non-blocking own-device warning on the console that stays readable offline with its check time.

### Deviations and decisions (recorded; design §17.11a)

1. `subject_gone` resolves at once (a revoked device or closed queue cannot recover); everything else uses damping.
2. `--once` waits for a running evaluation instead of skipping (found by an intermittent browser test, below).
3. No "stale with pending" warning to the device itself (it is reading the warning, so it is not silent).
4. The dashboard keeps polling every 5 s; the new change signal has no consumer yet.
5. **One existing M3 assertion changed by requirement:** `coordinator.db.test.ts` expected a device silent for one hour to be `offline`; REQ-F9.6 makes it `stale`. The test now checks both tiers (5 minutes → `offline`, 1 hour → `stale`): one more assertion, none weakened.
6. **Bounded evaluation (found at the pre-commit review).** `--once` waited for the evaluation lock with no limit, so a stuck evaluator could stall it indefinitely. Every evaluation now sets `lock_timeout` (30 s) and `statement_timeout` (60 s): a wait or a statement beyond that aborts and rolls back the pass (nothing changes) and the next interval retries. The normal loop never waits (try-lock). Test: with another connection holding the evaluation lock, a waiting evaluation fails with a lock timeout within the bound, the try-lock path skips at once, nothing changes, and the next pass works.
7. **One existing accessibility defect fixed:** the device table's horizontal scroll container (M3) was not keyboard-focusable; axe flagged it at 320/375 px once the table grew wider. It is now a focusable, labelled region (as in the audit page).

### Test evidence

| Suite                                                                                        | Result                                           |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `apps/worker/src/health.db.test.ts` (8.D3, 8.D4, 8.D6; isolated database)                    | 23 / 23                                          |
| `apps/api/src/device-health.db.test.ts` (8.D1, 8.D2, 8.D4, 8.D5, 8.D6)                       | 18 / 18                                          |
| `packages/domain/src/device-health.test.ts`                                                  | 6 / 6                                            |
| `apps/web/e2e/device-health.spec.ts` at 1280, 1440, 375 and 320 px (axe, overflow, keyboard) | 11 / 11, three consecutive full runs             |
| `pnpm test:db`                                                                               | api 569, worker 42                               |
| Full Playwright suite, all projects                                                          | 207 passed, 4 skipped (opt-in capture), 0 failed |
| Group 6 fencing suites (`sync-*`, `acceptance-gate`, `coordinator` fencing blocks)           | unchanged files, all pass                        |

Coverage: **8.D1** recipients (supervisor, facility admin, org admin see; auditor reads only; counter/reception see only their own-device warning; cross-tenant 404 on read, acknowledge, own-device and summary). **8.D2** no IP/user-agent/fingerprint/location columns; heartbeat rejects `ip`, `user_agent`, `location`, `client_time`, `label`; responses carry no network identifiers; static check that device/health code reads no request address or user-agent. **8.D3** each of the eight kinds with severity and counts; refresh instead of duplicate; 8 concurrent evaluators without the lock still produce one alert per subject; the database refuses a second open alert; damping including a flapping case; recurrence opens a new, unacknowledged alert; acknowledgement persists; acknowledgement is audited once and changes no queue, coordinator or device row; failing evaluation changes nothing. **8.D4** three evaluations leave `queue_sessions` (epoch, device, expiry), tickets, events, devices, operations and admin events byte-for-byte unchanged; an acknowledged `coordinator_offline` alert leaves the coordinator in place until the supervisor's explicit failover, which advances the epoch and keeps the chain intact. **8.D5** revoke as lost keeps last contact and pending count with the reason; sync, heartbeat and own-health refused; re-registration creates a new device; the row stays for audit; the browser wording for both. **8.D6** offline/stale and expiring/expired by server time; the device cannot send a time; configured thresholds honoured; paused indicator after 3 intervals.

Mutation checks (each reverted, files compared with backups): no damping → 8 failures; plain insert instead of the deduplicating upsert → 4; coordinator alert without the busy-queue rule → 1; acknowledge allowed with `OPERATIONS_VIEW` → 1; own-device health for any device of the organization → 1; no stale tier → 2.

**Intermittent failure found and fixed (stabilization rule).** The supervisor journey failed 1 in 6 under two workers. Cause: two tests ran the worker `--once` at the same moment; the second skipped on the evaluation try-lock, so its page loaded before its alert existed and the 30 s banner poll missed it. Fix in the product (`--once` waits for the lock; new DB test proves every waiting evaluator evaluates), not in the test. 10/10 repeats and three full runs since.

### Remaining risks and limits

- Alert latency is up to one evaluation interval (30 s) plus the dashboard poll (5 s) or banner poll (30 s).
- The evaluator scans every facility each pass using partial indexes; it was not load-tested beyond the shared test database (about 20,000 organizations).
- `alert_pipeline_failing` reads failed `notifications` rows; nothing produces turn-alert failures until M5.4. _(Superseded: M5.4 produces them; the worker test raises the alert from real failed deliveries.)_
- The worker's thresholds must match the API's; nothing enforces it beyond documentation. _(Superseded in M5.4: the dashboard names any setting that differs.)_
- A pass slower than 60 s (for example on a much larger database) aborts and is retried; alerts would then stop updating and the dashboard would show "Automatic alerts are paused". Device states on the dashboard stay current either way.
- The environment stall from M5.0 did not recur.

### Manual acceptance (OUTSTANDING; none performed)

1. Screen reader (VoiceOver and NVDA or TalkBack): dashboard alerts panel, acknowledge button names, the polite announcement of a new high-priority alert, the banner and the console warning.
2. A real outage drill: two tablets, assign a coordinator, switch its Wi-Fi off; confirm `offline` then `stale`, the `coordinator_offline` alert and its advice, then an explicit failover and the fenced reconnect.
3. A lost-device drill: revoke a tablet as lost, confirm the wording, confirm it cannot sync, and re-register it.
4. 200 % zoom on the dashboard on a phone.

## M5.4 — Smart Turn Alerts (F14; design §12; ADR-013; Group 14: 14.1–14.14)

Status: implemented, reviewed (security review 2026-11-15, below) and verified locally; committed as one local checkpoint on `feature/m5-recovery-accessibility-alerts` (not pushed). Base: `6a75213`.
Alerts follow server-committed calls only. No alert outcome can block, delay or change a queue
command, change a ticket, or mark a visitor missed.

### What was built

- **Migration `0009_turn_alerts.sql`** (additive; constraint replacement only): `push_subscriptions`
  (random id = the non-secret `subscription_id`; encrypted endpoint and keys; a CHECK that
  ciphertext exists only while active; one row per ticket and endpoint), `notifications`
  (+`web_push` channel, +`suppressed` status, `push_subscription_id`, `event_sequence`,
  `detail_code`), `notification_outbox.processed_at`, `notification_deliveries.detail_code`
  (+`sent`/`suppressed` receipts), `health_evaluations.worker_config`.
- **Contracts** (`packages/contracts/src/push.ts`): capability, strict subscribe/ack bodies, strict
  v2 payload (8 fields), staff alert view, counters, tag/path/Topic helpers;
  `TicketStatus.call_sequence`.
- **Channels:** `PushTransport`; `SandboxPushTransport` (TEST-ONLY, no network, refused in
  production); `WebPushTransport` (RFC 8291 `aes128gcm` via `http_ece@1.2.1`, RFC 8292 VAPID via
  `node:crypto`); subscription cipher (AES-256-GCM, HKDF-derived from `CONTACT_ENCRYPTION_KEY`);
  endpoint allow-list.
- **API:** turn-alert hook registered on `appendEvent`, which covers every committed call path,
  including sync and conflict apply. Each hook runs in its own SAVEPOINT and enqueues one
  notification/outbox pair per active subscription, keyed
  `web_push:ticket.called:<ticket>:<seq>:<subscription>`. Service transfers re-bind subscriptions.
  Routes: `GET /push/capability`, subscribe/unsubscribe/ack, staff `GET /queues/:id/alerts`.
  Token revocations revoke their subscriptions. Dashboard counters and the configuration check are
  served alongside the health data.
- **Worker:** `processTurnAlerts` claims due rows with `FOR UPDATE SKIP LOCKED`, holds a lease, and
  guards every finish by the attempt it claimed. It suppresses stale alerts at send time. Limits:
  3 attempts, exponential backoff inside the 120 s TTL. A 404/410 revokes only that subscription.
  Outcomes are recorded honestly. `purgeAlertData` implements the §12.13 retention rules. Every job
  has its own try/catch, and the worker reports its configuration for the consistency check.
- **Web:**
  - Visual and announcements: a persistent banner (code, counter, "Status: Called", service, an
    icon, a Dismiss button that returns focus to the `h1`); the assertive region speaks once per
    committed call sequence; the title becomes "Your turn: A012".
  - Cues and focus: sound and vibration follow the M5.2 preferences, and quiet mode wins. If the
    alert closes the settings dialog and focus would otherwise drop to the document body, focus
    moves to the banner.
  - Offline: an "alerts may be delayed" note.
  - Push panel (ticket page): consent only on click; specific text for unsupported, blocked and
    iPhone-not-installed browsers; the documented 409 message; turning push off unsubscribes the
    browser only when no other saved ticket uses it.
  - Identity: `pushRef`, `resolveByPushRef`, `?ref=` decides; a neutral "not saved on this device"
    screen.
  - Service worker: `public/push-handler.js` via `workbox.importScripts`; a global hand-off
    listener.
  - Staff: per-device alert state on the console; counters and the configuration warning on the
    connectivity dashboard.
- **Ops:** `pnpm env:generate --vapid` (with `--rotate-vapid`); `env:check` validates the pair;
  `.env.example` and `docs/local-environment.md` updated.

### Deviations (recorded in ADR-013 "Implementation notes and deviations")

1. `web-push` is MPL-2.0 in every version, not MIT as ADR-013, AGENTS.md §3, the architecture
   steering and REQ-F14.10.4 state. I implemented the standards with `http_ece` (MIT) and
   `node:crypto` instead. AGENTS.md, the architecture and security steering, design §2,
   REQ-F14.10.4, ADR-013 and the architecture document now state this (final review).
2. Enqueue is a registered transition hook, not per-call-site calls. Found by the full DB run: a
   direct import gave the automatic no-show sweep an import path to alert code, which test
   8.R12(f) forbids. The dependency was inverted; the test was not changed.
3. The click URL also carries the public `seq` (for an exact acknowledgement) and `rp` (for the
   neutral screen's recovery link); both are validated.
4. An SSRF allow-list for push endpoints was added (not in the design).
5. Push controls are on the ticket page, not in the settings dialog.
6. No banner animation: a pulse was tried and removed because the M5.2 test "the app declares no
   animation" forbids it; that test was not changed.

### Test evidence

| Suite                                                                                                | Result                                                  |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `packages/channels/src/push.test.ts` (RFC 8291 §5 vector, local push-server round trip, VAPID, SSRF) | 15 / 15                                                 |
| `apps/api/src/turn-alerts.db.test.ts` (14.2, 14.3, 14.5, 14.7, 14.11–14.13 server side)              | 22 / 22, three consecutive runs                         |
| `apps/worker/src/turn-alerts.db.test.ts` (14.4, 14.5, 14.6, 14.7, 14.11, 14.12; isolated DB)         | 18 / 18, three consecutive runs                         |
| `apps/worker/src/once.test.ts` (built worker against a stalled "database")                           | 2 / 2                                                   |
| `apps/web` unit: `turnAlert`, `pushHandler` (the real SW file), `copyTruthfulness` (14.9)            | 19 / 19                                                 |
| `apps/web/e2e/turn-alerts.spec.ts` at 1280, 1440, 375 and 320 px                                     | 20 / 20, three consecutive runs                         |
| `apps/web/e2e/turn-alerts-sw.spec.ts` (the built `sw.js` receiving a DevTools-delivered push)        | 1 / 1, three consecutive runs                           |
| `pnpm test`                                                                                          | all packages pass (web 97, contracts 116, domain 109 …) |
| `pnpm test:db`                                                                                       | api 591 / 591, worker 61 / 61                           |
| Full Playwright, all projects                                                                        | 228 passed, 4 skipped (opt-in capture), 0 failed; ×3    |
| Fresh database: `pnpm db:migrate` twice; `0009` SQL executed twice                                   | applied, then skipped; idempotent                       |

**Coverage highlights:**

- **14.2 isolation.** A `SELECT 1/0` inside the savepoint still commits `call_next` with the
  expected sequence and an intact chain. Three subscriptions produce three pairs with distinct
  keys. A replay adds none. A forced conflict skips only that device.
- **14.4 delivery semantics.** Six workers on separate connections claim and send each row once. A
  stalled worker's late result never overwrites the newer attempt, in both orders (gated
  transports, no sleeps). Crash loops are bounded. `delivered` is never downgraded.
- **14.5 payload and storage.** Exactly 8 payload fields. No endpoint, credential or internal id in
  the payload or the Topic. The ciphertext is unreadable in the row.
- **14.7 neutrality.** Every outcome leaves tickets, sessions, events and transitions byte-for-byte
  unchanged. A 410 leaves the ticket called and servable, with no `ticket.miss`.
- **14.13 / 14.14 identity.** Two tickets with the same code from different organizations each open
  their own ticket. A contradicting `k` resolves to nothing. A forgotten ticket opens the neutral
  screen with no `/api/v1/tickets/` request.

**Mutation checks** (`/tmp/qb-mutate.py`: each defect applied, the targeted suite run, the file
restored and compared by SHA-256):

- Killed, first pass (11): no savepoint · dedup key without subscription · no stale suppression ·
  no endpoint allow-list · `gone` counted as failure (API and worker) · alert repeats on refresh ·
  a forbidden promise in the copy · unresolved `ref` falls back to the public code (browser test) ·
  alert from a cached offline copy · SW destination without `ref`.
- **Survived at first: the claimed-attempt guard.** The existing test only covered the order the
  `processed_at` guard already protects (and used a 1.1 s sleep). It was replaced by a
  deterministic two-order test; the mutation is now killed.

**Device health.** Real delivery failures (failed but not `gone`, or `unknown`) feed
`alert_pipeline_failing`. A refused permission or missing push support creates no row, so it never
counts. The evaluator stays read-only.

**Threshold-consistency issue (M5.3 risk).** Now mechanised. The worker stores its non-secret
settings with each evaluation. The dashboard names any setting that differs from the API's: the
four M5.3 thresholds, the VAPID public key and `TURN_ALERT_TTL_SECONDS`. Names only, no values.

### Operational checks

- **API, push misconfigured.** With no VAPID key or a malformed one, the API starts and is ready;
  capability is `disabled` (one warning, no key material). With a valid key, push is `live`.
- **Worker, push misconfigured.** With push off, `web` without keys, a private key that does not
  match, or no contact key, the worker logs one error, completes its other jobs and exits 0.
  `PUSH_TRANSPORT=sandbox` with `NODE_ENV=production` is refused; the other jobs still ran.
- **Side effect of that run.** It wrote audit checkpoints, signed with a throwaway key, into this
  project's disposable test database. Assessed in the final review (section D below): no action
  required.
- **Overlap.** Overlapping workers are covered by the six-worker test and by parallel `--once` runs
  in the browser suite. One push failure cannot stop the jobs that follow.
- **`pnpm audit`.** 2 low and 3 moderate findings, all pre-existing (workbox, eslint); none from
  M5.4.

### Browser support (stated in the UI; nothing here was verified on a real device)

| Platform                                 | Push                                                      | In-app alert |
| ---------------------------------------- | --------------------------------------------------------- | ------------ |
| Android Chrome                           | expected to work with the browser closed (battery limits) | yes          |
| Desktop Chrome / Edge / Firefox          | needs the browser running                                 | yes          |
| iOS / iPadOS Safari 16.4+, installed app | expected to work after opt-in inside the installed app    | yes          |
| iOS Safari in a tab, older iOS, no push  | not offered; specific text                                | yes          |

Vibration from a system notification depends on the device and is not relied on. Sound plays only
when the browser allows it (the page has had a user gesture); a blocked tone leaves the visual
alert intact.

### Limits (stated, not hidden)

- Browser tests use an in-page `PushManager`/`Notification` double and the sandbox transport. The
  real `sw.js` is exercised only through DevTools push delivery. Headless Chromium reports the page
  as focused and keeps notification permission `denied`, so the system-notification branch and the
  click handler are unit-tested against the real file but not run in a browser.
- `WebPushTransport` was never exercised against FCM, Mozilla, Apple or WNS. Only the RFC vector
  and a local push server were used.
- The enqueue-error counter lives in each API process's memory (diagnostic only). The per-ticket
  subscription-change limit is now shared through PostgreSQL (final review).
- **Open intermittent (stabilization rule).**
  `offline-timing-handover.spec.ts` › "lost acknowledgement …" failed 2 times in about 37
  executions during this session: once in a full run, once in five file runs. It then passed 356
  times without a failure in targeted reproduction (isolated ×12, with the offline and turn-alert
  suites ×4, with the heaviest suites ×3) and in three full runs. The error text was not captured
  (output filtering), so the cause is unknown. M5.4 adds two things on that path: a no-op hook
  call for a `→ waiting` walk-in, and one push-revocation UPDATE when a credential is reissued.
  It stays open until reproduced with a trace. Final-review investigation: section C below.

### Manual acceptance (OUTSTANDING; none performed)

1. **Android Chrome, real push service.** Set real VAPID keys and a contact; join; turn push on;
   lock the phone; call the ticket. Record whether a notification appears, its latency, and that
   tapping it opens the right ticket. Then turn it off and confirm nothing arrives on a new call.
2. **iOS 16.4+.** Confirm that Safari in a tab shows the Home Screen text. Add to Home Screen, open
   the installed app, opt in, and repeat step 1. Record the result as observed.
3. **Two saved tickets with the same code on one phone.** Confirm each notification opens its own
   ticket.
4. **Screen reader (VoiceOver, TalkBack or NVDA).** The banner and the single assertive
   announcement; the push panel states; the neutral screen; the staff alert line.
5. **Display modes.** High contrast, 200 % zoom and extra-large text on a phone, with a call
   arriving while the settings dialog is open.

## M5.4 final review and checkpoint (2026-11-15)

Scope: the complete M5.4 diff before the checkpoint commit. No redesign, nothing from MQ/M6/M7.

### A. Security review: findings and fixes (each with a regression test and a killed mutation)

| #   | Finding                                                                                                                                                                                                                                                                | Severity                | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Regression                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **SSRF at send time.** The allow-list was enforced only when subscribing; the worker's transport POSTed to any decrypted endpoint (its own test posted to `http://127.0.0.1`). A narrowed `PUSH_ENDPOINT_HOSTS`, or a row written outside the API, would be contacted. | High (defence in depth) | `WebPushTransport` re-checks the endpoint policy on every send (worker passes the same allow-list as the API; new worker env `PUSH_ENDPOINT_HOSTS`); IP literals refused; the address actually connected to (custom DNS `lookup` on the request, so no gap for DNS rebinding) must be public: loopback, RFC 1918, link-local (incl. 169.254.169.254), CGNAT, documentation, benchmarking, multicast, reserved and IPv4-mapped forms are refused, and a mixed DNS answer is refused, not filtered. Now `node:http(s)`: no redirects (3xx = rejected), one deadline for connect + send + headers, body discarded unread, TLS validation untouched. | `push.test.ts`: policy refuses before any request (server hit count 0); a name resolving to 127.0.0.1 and IP literals refused at connect; `isBlockedAddress` table. Mutations M13, M14 killed |
| 2   | **Per-ticket limit per process.** 20 changes/min was in each API process's memory, so N instances allowed N×20. (The 3-device cap was already database-enforced under an advisory lock and held.)                                                                      | Medium                  | One atomic PostgreSQL upsert per change (`push_subscription_throttle`, added to `0009`), self-expiring 1-minute window, no lock-out; turning push off is counted but never refused (privacy); the worker deletes windows after an hour.                                                                                                                                                                                                                                                                                                                                                                                                          | API test with two API instances: alternating calls → 21st refused; concurrent burst of 30 over both → exactly 20 accepted; turn-off over the limit → 204; window expiry. Mutation M16 killed  |
| 3   | **Lease shorter than a slow batch.** A 50-row claim processed 8 at a time with 10 s sends can outlive the 30 s lease; another worker re-claims and sends again (results stayed correct thanks to the attempt guard, but the device got a duplicate).                   | Low                     | The worker renews its lease in one guarded statement immediately before each send and skips (`superseded`) a row that another worker re-claimed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Gated two-worker test: the stalled worker sends only its first row and skips the second; one delivery row. Mutation M15 killed                                                                |
| 4   | **Deleted status token not treated as revoked.** Retention deletes token rows (FK `ON DELETE SET NULL`); the send-time check and retention treated `credential_id IS NULL` as "not revoked". Expiry ordering made it unreachable in practice, but it was not enforced. | Low                     | NULL credential = revoked at send time and in retention.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Worker test: token deleted → suppressed, then revoked with ciphertext erased. Mutation M17 killed                                                                                             |

Reviewed without change: VAPID JWT (ES256, `aud` = push-service origin, `exp` ≤ 24 h, subject
validated, private key never logged), RFC 8291 encryption (fresh ECDH key and 16-byte salt per
message, RFC §5 vector), subscription consent (permission only from the click; denied respected),
authorization (status token required; foreign `subscription_ref` and cross-tenant 404; staff view
`QUEUE_VIEW`-scoped by organization), the 3-device cap (DB count under a per-ticket advisory lock),
revocation on every token revocation, ciphertext CHECK, secrecy (no endpoint, hash, key or token in
payloads, tags, Topics, URLs, logs or responses), same-code identity (reference-based), outbox
claim (`SKIP LOCKED`), attempt guard, bounded retries inside the TTL, crash bound, `delivered`
never downgraded. Per-IP limits use `@fastify/rate-limit` with its default in-process store, as for
every other endpoint of the API (pre-existing; recovery throttles and now push changes are
database-backed).

### B. Documentation

AGENTS.md (stack table and §4.6), the architecture and security steering, design §2, REQ-F14.10.4,
ADR-013 (decision 8 corrected; notes 1, 4, 9, 10) and the technical architecture document now
state the implementation: RFC 8291 encryption with `http_ece@1.2.1` (MIT, exact-pinned) and RFC
8292 VAPID with `node:crypto`; the MPL-2.0 `web-push` package is not used. `http_ece` is a
dependency of `packages/channels` only: package boundaries unchanged.

### C. Intermittent-failure investigation

Five full-suite runs with unfiltered logs, then three more after the fixes:

- **Hand-over "lost acknowledgement" test:** 0 failures in 8 completed full runs (and 356 targeted
  runs before). Not reproduced; its original error text was never captured.
- **Failure signature characterised (controlled experiment, temporary spec deleted afterwards):**
  one injected retryable failure (503) on the retry makes the test fail exactly at
  `expect(stored.map((o) => [o.status, o.attempts])).toEqual([['duplicate', 2]])` with
  `attempts: 3`, while product behaviour is correct (one ticket, a `duplicate`, a working link).
  The test therefore fails on any transient server-side hiccup during the retry. The assertion was
  not changed (it is the stated property "learned from the second attempt").
- **A different infrastructure failure was captured** (run 5): `device-health.spec.ts` at 320 px,
  `worker --once` → `write CONNECT_TIMEOUT localhost:55433` (30 s TCP connect to the Docker
  container). The PostgreSQL log shows no error in the window except expected test-induced
  constraint errors, and a **timed checkpoint starting at 21:54:29 UTC inside that window**, the
  same coincidence as the M5.0 stall. Classification: test infrastructure (Docker Desktop
  forwarding / virtualised I/O), not application.
- **A hang was captured and turned into a fix** (run 6): a `worker --once` started 23:04 local
  never finished. PostgreSQL showed its connection `idle in transaction` right after `BEGIN`
  (waiting for the client); the worker's sockets had nothing queued on the host and its process
  had no pending writes (inspected read-only through the Node inspector). Whether traffic was lost
  in Docker's forwarder or the client never sent the next statement could not be decided, so the
  cause stays unresolved. But it exposed a **real defect**: `--once` had no overall bound and
  ignored SIGTERM, so `execFileSync`'s 60 s timeout could not stop it and the suite hung (the
  machine later slept; sleep began 06:02 local, seven hours after the hang, and is not the cause).
  **Fix:** in `--once`, a stop signal exits at once and `WORKER_ONCE_TIMEOUT_MS` (default 120 s)
  bounds the run; every worker connection sets `idle_in_transaction_session_timeout = 60 s`, so a
  stalled client cannot hold locks. Regression: `once.test.ts` runs the built worker against a
  TCP server that never answers (deadline → exit 1; SIGTERM → exit 1 promptly). Mutations M18,
  M19 killed.

**Status: unresolved risk, recorded with evidence.** The hand-over failure (2 in about 37 runs on
2026-11-14, 0 in about 600 runs since) is most consistent with a transient server or connection
hiccup during the retry, of the kind captured twice in this environment; this is a hypothesis,
not a proven cause.

### D. Database hygiene: the operations-check audit checkpoints

- Database: `queuebridge_test` (this project's disposable test database). The development database
  `queuebridge` has none (it is at migration 0006 and was not touched).
- Key id `ops-check`; **50 checkpoints**, one each for 50 queue sessions, written 2026-11-14
  18:58:16–17 UTC.
- Effect: a checkpoint signed with a key the verifier does not hold is `unverifiable`; root and
  head links still verify. The real verifier was run read-only on three affected sessions: status
  **`incomplete`** with the test key configured and with no key, never `failed`. Future checkpoints
  for those sessions extend after them unchanged. They are old fixture sessions that no test
  re-verifies (the same situation as the existing `retired-key` checkpoints).
- **No action required.** No audit record was modified or deleted.

### E. Final verification (final tree)

| Gate                                                             | Result                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build` | clean, 0 errors                                                                                                                                                                                                                                                                 |
| `pnpm test`                                                      | all pass (channels 33, worker 12, web 97, contracts 116, domain 109, continuity 64, api 56, ui 6)                                                                                                                                                                               |
| `pnpm test:db`                                                   | api 591 / 591, worker 61 / 61                                                                                                                                                                                                                                                   |
| Migrations                                                       | fresh isolated DB: applied, then skipped; `0009` SQL executed a second time: OK; migrate-guard 14 / 14                                                                                                                                                                          |
| Full Playwright, all projects                                    | 228 passed, 4 skipped, 0 failed; three consecutive runs on the final tree                                                                                                                                                                                                       |
| Mutation regressions                                             | 19 / 19 killed (M1–M12 earlier, M13–M19 from this review)                                                                                                                                                                                                                       |
| Sensitive artifacts                                              | no `.env`, logs, traces, keys or backups in the change set; no private key, VAPID secret or real credential in source (the only private key is the published RFC 8291 §5 example; test VAPID keys are generated at runtime; the e2e public key's private half was never stored) |

## M5 acceptance report (final integration, 2026-11-15)

Baseline: branch `feature/m5-recovery-accessibility-alerts`, clean at `fd5d52e` with the six M5
checkpoints on top of `staging` @ `2da1ced`. This report covers the final-integration work done on
top of that (uncommitted at the time of writing) and the state of every M5 acceptance item.
Manual instructions: `docs/testing/M5-manual-acceptance.md`.

Status words: **Pass (automated)** = a real-PostgreSQL or real-browser test asserts it; **Partial**
= the named part is automated, the rest is stated; **Manual** = only a person can settle it;
**Not executed** = not done yet.

### Changes made during final integration

| Change                                                                                                                                                                                                                                                                                                                                       | Why                                                                                                           | Evidence                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fix (defect, medium):** recovery L2 limit was check-then-act. 24 parallel wrong guesses from one source produced 10 failures instead of the stated 5 (L1's 10/min still held). The failure is now charged in the same atomic upsert that checks it and refunded on success or refusal (`apps/api/src/recovery/throttle.ts`, `service.ts`). | Steering 8.R3: "the 6th failure … gets 429"; the existing concurrency test only asserted `≤ 10`, which hid it | New two-instance test; existing test tightened to `≤ 5` failures and `≥ 15` refusals (stronger, not weaker); a partial revert of the fix fails 3 tests; recovery suites 60/60 |
| REQ-F4.12 UI half: the recover page now says a temporary (offline-captured) ticket can be recovered only after the server confirms it                                                                                                                                                                                                        | requirement said the UI SHALL say so; only the staff console did                                              | static text, no oracle (same for every visitor); axe runs on the recover page in the browser suites                                                                           |
| New `apps/api/src/m5-integration.db.test.ts` (8 tests)                                                                                                                                                                                                                                                                                       | cross-feature journeys were missing                                                                           | see "Cross-feature journeys"                                                                                                                                                  |
| Stale text: worker header (outbox "not implemented"), README F14 "planned", this file's status line, two superseded M5.3 risks                                                                                                                                                                                                               | audit                                                                                                         | —                                                                                                                                                                             |

### Cross-feature journeys (real PostgreSQL, `m5-integration.db.test.ts`, 8/8 ×3)

1. Join → a second device recovers with the key → the key is rotated (old key 404, new key works)
   → "sign out other devices" revokes both other devices **and their push subscription** → a
   signed-out device cannot re-subscribe or acknowledge → the committed call enqueues an alert for
   the surviving device only → recovery appended no queue event; chain intact.
2. Staff-assisted recovery: requester (counter) cannot approve (403); grant unusable before
   approval; a supervisor approves; the grant opens the ticket on a new device; the original
   device sees "access granted elsewhere"; the new device subscribes and is the one alerted; audit
   rows name requester and approver and contain no grant, key or token.
3. Offline coordinator (epoch 1) records a call → explicit supervisor failover (epoch 2) → the new
   coordinator's synced call alerts exactly once → the fenced old call is `needs_review`
   (`stale_epoch`) and alerts nobody → dismissing it alerts nobody → a failed push leaves serving
   unaffected, no `ticket.miss`, one `call_next`, chain intact.
4. Tenants and roles: another organization gets 404 on queue alerts, operations health and
   recovery requests; another organization's visitor token cannot remove a subscription even with
   its reference; reception, counter and auditor read queue alerts; only auditor (not counter or
   reception) reads operations health; auditors cannot assist or command; counter staff cannot
   acknowledge health alerts.
5. Recovery racing "sign out other devices" (×10 rounds): no revived token, no lost update, never
   above 3 tokens, database and status endpoint agree.
6. Recovery racing ticket completion (×10): completed wins, nothing recovers it afterwards,
   recovery changed no queue state.
7. Secrets never reach logs: the API at `trace` level through recovery, wrong key, rotation, push
   subscribe/ack/unsubscribe, assisted recovery and redemption logs none of 9+ secrets (keys,
   grant, tokens, endpoint, push keys). Verified non-vacuous: logging the endpoint makes it fail.
8. Recovery throttling across two API instances: one source's parallel guesses split over both
   instances give at most 5 failures; the rightful holder from a clean source still gets in.

Journeys covered by existing suites rather than new tests: Group 6 fencing (`coordinator`,
`acceptance-gate`, `sync-*`), turn-alert identity with two same-code tickets (browser), device
health stale/conflict/pipeline-failure detection (`apps/worker/src/health.db.test.ts`,
`turn-alerts.db.test.ts`), notification failure vs auto no-show (`auto-miss` 8.R12(f), 14.7).
Not covered end to end by an automated test: a browser journey that runs the worker after an
offline coordinator's synced call (the API part and the worker part are each tested), and the
`alert_pipeline_failing` alert shown on the dashboard in a browser.

### Requirement-by-requirement status

**Group 8 — recovery (F4) and device health (F9)**

| Item                                | Status                                                                       | Note                                                                                                                                                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.R1 code alone never recovers      | Pass (automated)                                                             |                                                                                                                                                                                                                     |
| 8.R2 oracle-free failure            | Pass (automated)                                                             | timing bound is loose (40 ms medians)                                                                                                                                                                               |
| 8.R3 throttling                     | **Pass (automated) after the L2 fix above**                                  |                                                                                                                                                                                                                     |
| 8.R4 credentials                    | Partial                                                                      | not asserted: status token stored as SHA-256 specifically (plaintext absence is tested), fragment absent from access logs/`Referer` (Referrer-Policy header is tested); key absent from logs now tested (journey 7) |
| 8.R5 staff-assisted recovery        | Pass (automated); Manual check 9–12 outstanding                              | strong (contact) factor is M6                                                                                                                                                                                       |
| 8.R6 queue neutrality               | Pass (automated); provisional ticket: server refusal untested, UI note added |                                                                                                                                                                                                                     |
| 8.R7 concurrency                    | Pass (automated)                                                             | sign-out-others and completion races added (journeys 5, 6)                                                                                                                                                          |
| 8.R8 grace and rejoin               | Pass (automated)                                                             |                                                                                                                                                                                                                     |
| 8.R9 auto no-show semantics         | Pass (automated)                                                             |                                                                                                                                                                                                                     |
| 8.R10 retention                     | Pass (automated)                                                             |                                                                                                                                                                                                                     |
| 8.R11 secrets and tenancy           | Pass (automated)                                                             | hostile-Origin request not asserted separately (CSRF header and allowed Origin are)                                                                                                                                 |
| 8.R12 auto no-show execution safety | Pass (automated)                                                             |                                                                                                                                                                                                                     |
| 8.D1–8.D6                           | Pass (automated)                                                             | auto-resolve audit event and heartbeat-history absence not separately asserted                                                                                                                                      |

**Group 11 — accessibility (F7)**: 11.A1–11.A9 Pass (automated; do not establish WCAG
conformance). 11.A10 Partial (announcement of new high-severity alerts not asserted in a browser).
**11.A11 Manual — Not executed** (checks 34–41).

**Group 14 — Smart Turn Alerts (F14)**: 14.1–14.9, 14.11–14.14 Pass (automated), with the stated
limits (push double and sandbox transport; system-notification and click branches unit-tested
against the real file only; blocked-audio fallback not asserted in a browser). **14.10 Manual —
Not executed** (checks 18–24).

**M5 exit criteria (`tasks.md`)**

| Criterion                                               | Status                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Groups 8, 11, 14 pass; 1–7, 9, 12 unchanged             | Automated parts pass (all suites green, below); 11.A11 and 14.10 manual not executed |
| Keyboard-only visitor journey incl. turn-alert controls | Pass (automated: 11.A1 and turn-alert keyboard tests); manual check 34 not executed  |
| Recovery (8.R1–8.R8, 8.R10, 8.R11)                      | Pass (automated) except the 8.R4/8.R11 partial items listed                          |
| Grace / rejoin / auto no-show                           | Pass (automated)                                                                     |
| Push retention and defaults                             | Pass (automated)                                                                     |
| Accessibility incl. manual passes                       | Automated parts pass; manual passes not executed                                     |
| Device-health dashboard                                 | Pass (automated); manual drills 29–33 not executed                                   |
| Alert failure never changes the queue                   | Pass (automated)                                                                     |
| No copy promises delivery                               | UI copy and service worker pass; knowledge base does not exist until MQ              |
| Full gate set green                                     | **Locally green; CI not run (nothing pushed)**                                       |
| Evidence in this file and `M5-completion.md`            | this file updated; `M5-completion.md` not written                                    |

### Automated evidence (final tree, 2026-11-15)

| Gate                                                             | Result                                                                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build` | clean (0 errors)                                                                                               |
| `pnpm test`                                                      | channels 33, worker 12, web 97, contracts 116, domain 109, continuity 64, api 56, ui 6: all pass               |
| `pnpm test:db`                                                   | **api 599 / 599** (32 files), **worker 61 / 61** (4 files)                                                     |
| `m5-integration.db.test.ts`                                      | 8 / 8, three consecutive runs                                                                                  |
| Migrations                                                       | fresh isolated database: applied 9, second run skipped, all 9 files re-executed on top: OK; dropped afterwards |
| Full Playwright, all projects (1280, 1440, 375, 320 px)          | **228 passed, 4 skipped (opt-in capture), 0 failed — three consecutive runs**                                  |
| Mutation regressions                                             | 19 / 19 scripted killed (M1–M19) + 2 manual (L2 race, log leak)                                                |
| `pnpm audit`                                                     | 2 low, 3 moderate; all pre-existing build/lint dependencies (workbox, eslint); none high/critical              |
| Secrets scan of the change set                                   | no `.env`, keys, tokens, logs or traces                                                                        |

### Manual results

_(As of 2026-11-15. Superseded by "M5 manual acceptance: Set 1 results and the two-set schedule"
at the end of this file.)_

**None executed.** All checks 1–41 in `M5-manual-acceptance.md` are **Not executed** as of this
report. This includes every real-device check (QR scanning, Android Chrome push and clicks, iOS
installed-PWA push, two same-code tickets on one phone, two-device outage and failover, lost-device
revocation), every screen-reader pass, real 200 % zoom and orientation.

### Open defects and risks

| #   | Item                                                                                                                                                                                                                                                  | Severity                                                              | Status                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | `offline-timing-handover` "lost acknowledgement" intermittent (2 in ~37 runs on 2026-11-14; 0 in 11 full runs and ~600 targeted runs since). Failure signature reproduced by one transient retry failure; most consistent with environment transients | Low (test reliability; product behaviour correct in the reproduction) | Open, unresolved cause                                                                       |
| 2   | Docker Desktop connection stalls in the local test environment (CONNECT_TIMEOUT once; one `--once` hang; coinciding PostgreSQL checkpoints)                                                                                                           | Low (test infrastructure)                                             | Open; `--once` now bounded                                                                   |
| 3   | Visitor bundle 597.7 kB raw / 180.8 kB gzip in one chunk; target < 100 kB initial JS for visitor flows (REQ-F7.7)                                                                                                                                     | Medium (low-bandwidth visitors)                                       | Pre-existing; route splitting planned in M7 (F15.5)                                          |
| 4   | Per-IP rate limits use the in-process store (`@fastify/rate-limit`), so they multiply with API instances; recovery and push-change throttles are database-backed                                                                                      | Low                                                                   | Pre-existing platform-wide; documented                                                       |
| 5   | Recovery only finds tickets of today's operational date: a session left open past midnight cannot be recovered after midnight                                                                                                                         | Low                                                                   | Documented limitation (codes are unique per facility per day; this keeps lookup unambiguous) |
| 6   | Enqueue-error counter per API process                                                                                                                                                                                                                 | Low                                                                   | Diagnostic only; documented                                                                  |
| 7   | 8.R4/8.R11/11.A10 partial items listed above                                                                                                                                                                                                          | Low                                                                   | Documented gaps                                                                              |
| 8   | Real Web Push delivery never exercised against FCM/Mozilla/Apple/WNS                                                                                                                                                                                  | Medium (claim scope)                                                  | Manual checks 18–24                                                                          |

No open security defect is known after the M5.4 review and the L2 fix.

### Real-device support and limitations

As stated in the UI and in the M5.4 section: Android Chrome (push expected with the browser closed,
battery permitting), desktop Chrome/Edge/Firefox (browser must be running), iOS/iPadOS 16.4+ only as
an installed Home Screen app, iOS Safari tabs and older systems without push (specific text). None
of this has been verified on a real device in M5. The in-app alert, the public board and staff
calling are the reliable channels.

### Operational performance observations

- **Device-health evaluator vs facility count** (throwaway database; 3 devices, one open session
  with an offline coordinator and 2 waiting tickets per facility; local Docker PostgreSQL):

  | Facilities | Devices | First pass (opens alerts) | Steady passes  |
  | ---------- | ------- | ------------------------- | -------------- |
  | 100        | 300     | 55 ms                     | 8 ms, 8 ms     |
  | 1,000      | 3,000   | 236 ms                    | 45 ms, 41 ms   |
  | 5,000      | 15,000  | 922 ms                    | 173 ms, 194 ms |
  | 20,000     | 60,000  | 4,854 ms                  | 723 ms, 720 ms |

  Linear (about 0.04 ms per facility per steady pass); far inside the 30 s lock and 60 s statement
  bounds and the 30 s interval. Not measured: much larger devices-per-facility ratios, production
  hardware.

- **API/worker configuration consistency:** mechanised (dashboard names differing thresholds,
  VAPID public key and push TTL).
- **Worker termination and recovery:** `--once` bounded (deadline, stop signal); idle-in-transaction
  guard 60 s; lease renewal before each send; attempt-guarded finish; 3 attempts inside the TTL.
- **Recovery rate limits under concurrency:** exact after the L2 fix, also across two instances.

### Recommendation

**Ready for a PR with documented limitations; M5 milestone closure is blocked on your actions.**
The code is complete, reviewed and green on every local automated gate, with no known open
security defect. Closing M5 against its exit criteria still requires:

1. Manual acceptance (`M5-manual-acceptance.md`), at minimum the screen-reader passes (11.A11) and
   the real-device push checks (14.10), recorded here with results as observed.
2. A CI run on GitHub Actions (needs a push, which needs your authorization).
3. Committing the final-integration changes (needs your authorization), then `M5-completion.md`.

## M5 integration checkpoint and environment preparation (2026-11-15)

### Pre-commit review of the integration changes

- Working tree: 10 files, all M5 integration (throttle fix and its tests, cross-feature suite,
  recover-page note, stale-text fixes, acceptance docs). No secrets, environment values, logs or
  generated artifacts.
- **Throttle pre-charge/refund review.** Refunds happen only after a refusal (the request never
  tested a key) or after a successful recovery (the key was right). A wrong or malformed key, a
  lost race with a key rotation, and any exception after the charge all keep it; each retry is
  charged again; the per-source minute limit (L1) is checked before and is unaffected. A refused
  request adds and removes exactly its own charge, so refunds cannot cancel other requests'
  failures. Staff grants (single-use, 160-bit) use their own path, unchanged.
- **Regression tests against the vulnerable code.** With the committed (`fd5d52e`) `throttle.ts`
  and `service.ts` restored and the new tests kept: exactly the two concurrency tests fail
  ("parallel wrong guesses … split over two instances …" and "parallel wrong guesses from one
  source are counted exactly"); the other 50 pass. The fix was restored byte for byte.
- Cross-feature tests use fresh tenants and random sources; they assert tenant isolation (404),
  credential and log secrecy, coordinator fencing (`needs_review`, `stale_epoch`) and notification
  independence (failed push, no miss).
- The recover-page note is identical static text for every visitor; the server's refusal of a
  temporary ticket is the same uniform response as any other failure: no existence disclosure.

### Integration checkpoint

Commit **`dba73a8`** on `feature/m5-recovery-accessibility-alerts` (parent `fd5d52e`; all earlier
M5 checkpoints preserved). Not pushed. Gates for that tree are the "Automated evidence" table of
the acceptance report above (no code changed after them).

### Development database migration

| Step             | Result                                                                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target           | `DATABASE_URL` → `localhost:55433/queuebridge` (container `queuebridge-pg`, PostgreSQL 17.10); `TEST_DATABASE_URL` is the separate `queuebridge_test`; no other project's container or database involved                                                                                    |
| Identity         | `_queuebridge_identity` = `queuebridge`; `db:check`: applied 6, pending 0007, 0008, 0009                                                                                                                                                                                                    |
| Running clients  | none (no dev API/worker; 0 other connections)                                                                                                                                                                                                                                               |
| Backup           | `~/queuebridge-backups/queuebridge-20261115-121152-pre-0007.dump` (custom format, 230 KB, mode 600, outside the repository)                                                                                                                                                                 |
| Backup integrity | `pg_restore --list`: 58 tables incl. `_migrations`, `_queuebridge_identity`, `queue_events`; restored into a scratch database: identical row counts for 15 key tables, history 0001–0006, marker `queuebridge`; scratch database dropped                                                    |
| Effects reviewed | additive only; new columns on existing tables have safe defaults (57 credentials get `source='join'`); the dropped index is the old one-token-per-ticket unique index (replaced as designed); widened CHECKs on an empty `notifications` table                                              |
| Migration        | `pnpm db:migrate`: APPLY 0007, 0008, 0009 → "Applied 3 migration(s)"; `db:check`: applied 9, pending none                                                                                                                                                                                   |
| After            | row counts identical to before (organizations 3, facilities 4, services 12, sessions 20, tickets 71, events 336, staff 6, devices 5, operations 307, admin events 129, checkpoints 8); all 8 new tables present; audit verification of all 20 sessions: `verified`; `pnpm env:check`: READY |

### Manual acceptance

Prepared in `docs/testing/M5-manual-acceptance.md` (41 checks, each with preconditions, steps,
expected result and Actual / Result / Evidence fields; the guide was checked against the current
UI labels and local configuration). **All 41 checks: Not tested.** Configuration still to be done
by the tester for later phases: VAPID keys and contact (desktop and phone push), LAN origin
(phase C), HTTPS address (phase D).

## M5 manual acceptance: Set 1 results and the two-set schedule (2026-11-16)

**Decision (product owner, 2026-11-16):** manual acceptance runs in two sets so the remaining
development can continue without dropping any required verification. The procedures, numbering
and criteria in `M5-manual-acceptance.md` are unchanged; its section 0a holds the schedule.

### Set 1 — development acceptance (checks 1–14): closed, 14 / 14 Pass

| Check | Subject                               | Result                                           | Defect found and fixed during Set 1 (tests that prove it)                                                                                                                                      |
| ----- | ------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Recovery key shown once               | Pass                                             | none (address-bar value was the device-local id); URL-secrecy suite added (`e2e/recovery-url-secrecy.spec.ts`, commit `4a0431a`)                                                               |
| 2     | Copy key                              | Pass                                             | —                                                                                                                                                                                              |
| 3     | Print                                 | Pass — verified after correction                 | key missing from print output: print stylesheet hid the panel (`e2e/recovery-print.spec.ts`)                                                                                                   |
| 4     | Share / Save as file                  | Pass — fully verified                            | —                                                                                                                                                                                              |
| 5     | Recover with a typed key              | Pass                                             | —                                                                                                                                                                                              |
| 6     | Throttle and uniform failures         | Pass — verified after correction                 | empty or malformed submissions looked like wrong keys; limit itself correct (`e2e/recovery-throttle.spec.ts`, "manual check 6 sequence")                                                       |
| 7     | New recovery key                      | Pass                                             | —                                                                                                                                                                                              |
| 8     | Sign out other devices                | Pass                                             | —                                                                                                                                                                                              |
| 9     | Staff-assisted recovery, two people   | Pass — independently verified after revalidation | approval list offered other queues' requests (queue-scoped now; "approval list scope"); grant redemption confirmed with database counts (local helper `e2e/manual/check9-grant-redemption.ts`) |
| 10    | Restricted assistance                 | Pass — verified after correction                 | verification answers carried over between requests (`e2e/recovery-staff-restricted.spec.ts`)                                                                                                   |
| 11    | Auditor cannot assist                 | Pass                                             | —                                                                                                                                                                                              |
| 12    | Audit trail of recovery               | Pass — verified after correction                 | no view of recovery audit records: approved extension, ADR-015 amendment 1, design §15.9a (`recovery-audit.db.test.ts`, `e2e/recovery-audit.spec.ts`)                                          |
| 13    | Temporary tickets not recoverable yet | Pass — verified after environment correction     | none in the product; built app's origin missing from `CORS_ORIGIN` (local `.env` corrected)                                                                                                    |
| 14    | Missed turn and rejoin                | Pass                                             | Edit policy page blank for services saved before M5 (`e2e/policy-editor-legacy.spec.ts`); final automatic no-show state taken from the saved policy version (v5, off)                          |

No security bypass was found in Set 1. Every product defect above was reproduced by a regression
test that failed before its fix and passes after it. All Set 1 fixes after `4a0431a` are in the
working tree, not yet committed (M5 checkpoint).

### Set 2 — final acceptance (checks 15–41): deferred

Scheduled for the final integration and pre-submission stage, after M7. Every record reads **Not
tested — scheduled for final acceptance (Set 2)** until a person runs it; deferral is never a
Pass, Fail or Skip. 32 records, grouped by environment in `M5-manual-acceptance.md` section 0a:
Mac and desktop browser (18D–21D, 25–28); phones on the local network (15–17); Android and Web Push
(18–23, 41 TalkBack); iOS if a device is available (24, 41 VoiceOver iOS); device health and
failover (29–33); accessibility and screen readers (34–40). These include the manual items of
11.A11 (screen readers, zoom, orientation) and 14.10 (real-device push).

### Rules for the rest of the project

1. A confirmed critical security or integrity defect is never deferred: it is fixed and
   re-verified before the next checkpoint, whichever set or milestone it is found in.
2. Automated regression, security, database, integration and CI testing continues on every change
   through MQ, M6 and M7; Groups 8, 11 and 14 stay green.
3. No out-of-pocket spending: Set 2 uses available devices and free tools only; a check without a
   compatible device is recorded as such, never as a Pass.
4. Remaining sequence: **M5 checkpoint → MQ (Ask Que) → M6 (SMS turn alerts and USSD) → M7 (final
   product) → Set 2 acceptance → submission.**

## M5 checkpoint readiness (2026-11-16, after Set 1)

Working tree on `feature/m5-recovery-accessibility-alerts` above `4a0431a`: 23 modified and 9 new
files (the Set 1 fixes, their regression tests, ADR-015 amendment 1, design §15.9a, the local
check 9 helper and the documentation). Not committed, not pushed.

### Automated gates (full tree)

| Gate                                        | Result                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`, `pnpm lint`, typecheck | pass (lint: zero warnings)                                                                                |
| `pnpm test`                                 | pass: contracts 118, ui 6, channels 33, domain 109, continuity 64, api 56, worker 12, web 97              |
| `pnpm build`                                | pass                                                                                                      |
| `pnpm test:db`                              | pass: api 608 (33 files), worker 61 (4 files)                                                             |
| Playwright, all projects                    | 241 passed, 5 skipped (4 opt-in capture tests, Firefox print variant), **1 failed** (see open item below) |
| `pnpm audit --audit-level high`             | pass: no high or critical (2 low, 3 moderate)                                                             |

The browser suite ran with `E2E_WEB_PORT=4174` because the tester's phase B preview held 4173; two
specs now derive expected links from the configured origin instead of a literal `localhost:4173`
(identical on 4173).

### Open items

- **Intermittent (environment item 2 above, recurred once):** `device-health.spec.ts` "an auditor
  reads alerts …" failed once in the full run when `worker --once` exceeded its 60 s bound
  (`spawnSync ETIMEDOUT`); the spec then passed 33 / 33 in isolation (3 repeats). Not fixed by
  retrying: recorded as open, frequency 1 in this full run. Device-health code is unchanged since
  `fd5d52e`.
- **CI not run** for this tree (needs a push, which needs authorization).
- **Manual:** Set 2 (checks 15–41) at final acceptance; the M5 exit criteria that depend on manual
  passes (11.A11, 14.10, device drills) close there.
- **Minor, not changed:** the offline refusal says "Reconnect once" also when registration was
  refused while online (check 13 finding).
- **Not verified here:** the WebKit and Firefox variants of the print test skip in CI (CI installs
  Chromium only); Firefox does not launch headless on this Mac.
- `M5-completion.md` not yet written.

No known open security or integrity defect.

### Checkpoint reliability gate (2026-11-16)

- **`device-health` `worker --once` timeout:** not reproduced. A single run takes 0.4–0.8 s on
  the shared test database (34,887 facilities, 28,217 open sessions, 23,339 devices); under two
  more full-suite loads all 60 recorded runs finished (12 runs: max 1,544 ms; 48 runs: mean 456 ms,
  max 751 ms; none failed). Cause of the single slow run unconfirmed; most consistent with open
  item 2 (local Docker/PostgreSQL stall). The old harness discarded the worker's output and killed
  it at 60 s, before the worker's own deadline, so it could not explain itself. Corrected (test
  harness only): shared `e2e/worker-once.ts` (worker deadline 50 s below the 60 s kill; failures
  report duration and the worker's log messages; optional timing log `QB_WORKER_TIMING_LOG`).
- **`m1-refinements` "inactive counters/services …" (found in the same gate):** test race with an
  optimistic checkbox; with the save delayed by 1.5 s the original test fails with the exact
  full-run signature and the fixed test (waits for the server's confirmation) passes.
- **Final full run:** Playwright 242 passed, 5 skipped, 0 failed; changed specs 147 / 147 over
  three repeats. Completion report: `docs/reports/M5-completion.md`.
