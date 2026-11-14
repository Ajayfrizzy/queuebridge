# M5 Test Evidence — Recovery, Accessibility, Device Health and Smart Turn Alerts

**Branch:** `feature/m5-recovery-accessibility-alerts` (from `staging` @ `2da1ced`, which contains M0–M4 and the M5–M7 specification, PR #7).
**Status:** M5.0 (test stabilization) complete locally, **not committed**. M5.1–M5.4 not started.
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
