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
