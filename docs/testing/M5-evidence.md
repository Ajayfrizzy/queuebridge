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
