# M5 Completion Report — Recovery, Accessibility, Device Health and Smart Turn Alerts (F4, F7, F9, F14)

**Branch:** `feature/m5-recovery-accessibility-alerts` (from `staging` `2da1ced`). **Date:** 2026-11-16.
**State:** M5 development complete; manual acceptance Set 1 closed (14 / 14 Pass); Set 2 deferred
to final acceptance after M7 (approved). The checkpoint changes after `4a0431a` are in the
working tree, not yet committed. Nothing pushed; CI not run for this tree.

Detailed evidence: `docs/testing/M5-evidence.md`. Manual record:
`docs/testing/M5-manual-acceptance.md`.

## Delivered functionality

| Area                                      | What M5 delivers                                                                                                                                                                                                                                                                                                                                                                                                | Commit                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| M5.0 stabilization                        | The three intermittent tests carried over from M4 root-caused and fixed (sign-out guard, connectivity validation, test synchronization); no assertion weakened                                                                                                                                                                                                                                                  | `87ec587`                       |
| M5.1 secure ticket recovery (F4, ADR-015) | 160-bit recovery key shown once (QR/link with the key in the URL fragment only, readable groups, copy, share, save, print), HMAC-stored; status tokens capped at 3 and revocable; throttles keyed on public identifiers and source only, never a lockout; staff-assisted recovery with a second-person approval and single-use grants; self-resume and automatic no-show through the authoritative command path | `e0214c5`, `83fbd3b`, `dba73a8` |
| M5.2 accessibility (F7)                   | Device-local display preferences (contrast, text size, motion, quiet alerts) applied before first render; keyboard and focus rules; announcement policy; offline accessibility; 320/375 px; unlocked orientation                                                                                                                                                                                                | `b8bc96f`                       |
| M5.3 device health (F9)                   | Stale and offline detection by server time, automatic in-product alerts with recipients and acknowledgement, lost-device flow; observation only (single-coordinator authority unchanged)                                                                                                                                                                                                                        | `6a75213`                       |
| M5.4 Smart Turn Alerts (F14, ADR-013)     | In-app called alert with optional sound and foreground vibration, opt-in Web Push (RFC 8291 with `http_ece`, VAPID with `node:crypto`), honest delivery states (`sent` is not `delivered`), alert code isolated by a savepoint so it can never fail or alter a queue command                                                                                                                                    | `fd5d52e`                       |
| Integration                               | Cross-feature journeys on real PostgreSQL; recovery L2 limit made atomic under concurrency                                                                                                                                                                                                                                                                                                                      | `dba73a8`                       |
| Set 1 acceptance fixes (working tree)     | Print sheet for the key; recover-form validation; queue-scoped approval list; per-request verification answers; Recovery activity audit view; policy editor for pre-M5 policies (details below)                                                                                                                                                                                                                 | not yet committed               |

## Set 1 manual results (checks 1–14): 14 / 14 Pass

Checks 1, 2, 4, 5, 7, 8, 11 and 14 passed (Check 4 after completing its partial first run).
Checks 3, 6, 9, 10, 12 and 13 passed after a correction or revalidation; each record keeps its
failure, investigation and retest. Check 14's final automatic no-show state was taken from the
saved policy version (v5, off), not inferred.

## Defects found during Set 1 and corrected

Each product defect was reproduced by a regression test that failed before its fix and passes
after it. No security bypass was found.

| Check | Defect                                                                                              | Kind          | Correction and test                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1     | (reported key in the address bar: was the device-local id, not the key)                             | none          | URL-secrecy regression suite `e2e/recovery-url-secrecy.spec.ts` (`4a0431a`)                                              |
| 3     | Recovery key missing from print output (print stylesheet hid the panel)                             | product (UI)  | key-sheet print styles; `e2e/recovery-print.spec.ts`                                                                     |
| 6     | Empty or malformed recovery submissions looked like wrong keys; the limit itself was correct        | product (UI)  | client-side completeness check and a separate format message; `e2e/recovery-throttle.spec.ts`, "manual check 6 sequence" |
| 9     | Approval list offered requests from other queues of the facility, whose Approve could only fail     | product (API) | list scoped to the queue, plain message when an approval is refused; "approval list scope" DB test, browser test         |
| 9     | Earlier manual "pass" not backed by any recorded redemption                                         | evidence      | revalidated with the local helper and database counts (+1/+1/+1, then 0/0/0)                                             |
| 10    | Verification answers carried over from one request (and ticket) to the next                         | product (UI)  | answers cleared after each request and on ticket change; `e2e/recovery-staff-restricted.spec.ts`                         |
| 12    | No screen showed who requested or approved a recovery (records were stored correctly)               | missing view  | approved extension (below); `recovery-audit.db.test.ts`, `e2e/recovery-audit.spec.ts`                                    |
| 13    | Built app's origin missing from `CORS_ORIGIN`, so device registration was refused (`csrf-rejected`) | environment   | local `.env` corrected; no code change                                                                                   |
| 14    | Edit policy page blank for services saved before M5 (missing M5 policy fields)                      | product (UI)  | editor reads the fields with the server's defaults (`recoveryPolicyOf`); `e2e/policy-editor-legacy.spec.ts`              |

Test-infrastructure findings during the checkpoint gate (no product change): two specs no longer
hard-code `localhost:4173`; the `worker --once` harness is shared and diagnosable; an M1 test race
with an optimistic checkbox fixed (details under "Automated test evidence").

## Architecture amendments

- **ADR-015 amendment 1 and design §15.9a (approved 2026-11-16):** read-only
  `GET /api/v1/queues/:id/recovery/audit` and a "Recovery activity" section on the queue Audit
  trail page. Permission `AUDIT_VIEW` (as the queue audit view); tenant, facility and queue scoped;
  keyset pagination; details through an allow-list; staff names resolved at read time from the
  immutable actor id; visitor actions never attributed to staff; no keys, grants, tokens, hashes,
  links, emails or staff ids. Recovery events stay out of the queue's hash-chained event chain;
  nothing was rewritten or backfilled.
- **Design §15.9 table:** the approval list (`GET /queues/:id/recovery/requests`) is scoped to the
  queue, matching approval.
- No other ADR or core invariant changed (server-authoritative sequence, single coordinator,
  fencing, append-only events, outbox isolation).

## Automated test evidence (final tree, 2026-11-16)

| Gate                                        | Result                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm format:check`, `pnpm lint`, typecheck | pass (zero lint warnings)                                                                      |
| `pnpm test`                                 | contracts 118, ui 6, channels 33, domain 109, continuity 64, api 56, worker 12, web 97: pass   |
| `pnpm build`                                | pass                                                                                           |
| `pnpm test:db`                              | api 608 (33 files), worker 61 (4 files): pass                                                  |
| Playwright, all projects                    | **242 passed, 5 skipped, 0 failed** (skips: 4 opt-in capture tests, the Firefox print variant) |
| `pnpm audit --audit-level high`             | no high or critical (2 low, 3 moderate)                                                        |

The browser suite ran with `E2E_WEB_PORT=4174` because a manual preview held 4173; expected links
derive from the configured origin, so results are identical on 4173.

**Checkpoint reliability gate (2026-11-16).** One earlier full run failed in `device-health` when
`worker --once` exceeded the spec's 60 s kill. Findings: a single run takes 0.4–0.8 s on the shared
test database (34,887 facilities, 28,217 open sessions); under two further full-suite loads all 60
recorded runs finished (max 1.5 s). The cause of the single slow run is **unconfirmed**; the most
likely explanation is the recorded local Docker/PostgreSQL connection stall (evidence item 2). The
old harness discarded the worker's output and killed it before the worker's own deadline, so the
failure could not explain itself. Correction (test harness only): one shared helper
(`e2e/worker-once.ts`) sets the worker's own deadline (50 s) below the caller's kill (60 s), so a
stuck run ends through the worker's bounded exit, which logs why, and any failure reports its
duration and the worker's log messages; optional per-run timing. A second failure in the same
gate (M1 `m1-refinements` "inactive counters/services …") was a test race with an optimistic
checkbox: proven by delaying the save (the original test fails with the exact full-run signature,
the fix passes); the test now waits for the server's confirmation. No assertion was weakened.

## Set 2 deferred checks (final acceptance, after M7)

32 records, each **Not tested — scheduled for final acceptance (Set 2)**: Mac and desktop browser
(18D–21D, 25–28); phones on the local network (15–17); Android and Web Push (18–23, 41 TalkBack);
iOS if a device is available (24, 41 VoiceOver iOS); device health and failover (29–33);
accessibility and screen readers (34–40). They include the manual parts of 11.A11 and 14.10.
Rules: a confirmed critical security or integrity defect is never deferred; automated and CI
testing continues on every change; no out-of-pocket spending (free tools and available devices
only). Sequence: **M5 checkpoint → MQ → M6 → M7 → Set 2 acceptance → submission.**

## Known limitations and remaining risks

- **CI (PR #8):** the first run found a worker defect (a malformed outbox row aborted every
  turn-alert batch); fixed with regression tests in a follow-up commit (evidence "First CI run").
  The long-standing `offline-timing-handover` intermittent was traced to a test race and fixed. Under an
  artificial local stress run some visitor pages updated late; cause unconfirmed, not seen in CI.
- **Set 2 not run:** no real-device push, QR scanning on phones, device drills or screen-reader
  passes yet; the related exit criteria close at final acceptance.
- **Worker housekeeping jobs** (turn-alert delivery, the retention purges) have no per-statement
  time limit; only health evaluation does. `--once` is bounded overall (120 s by default) and the
  connection drops idle transactions after 60 s, but in loop mode a statement blocked by a lock
  could hold up later jobs until it is released. Not observed; recommended hardening for M7
  (statement and lock timeouts on those jobs).
- **Shared test database growth:** about 35,000 test facilities accumulate across runs and nothing
  cleans them; a single worker pass is still sub-second, but runs will slow as it grows.
- Recovery only finds tickets of today's operational date (session left open past midnight).
- Recovery activity shows current staff names (renames follow), by approved design.
- The offline refusal message says "Reconnect once" also when registration was refused online.
- Visitor bundle 180.8 kB gzip in one chunk (target under 100 kB; route splitting in M7).
- Per-IP rate limits use an in-process store (recovery and push throttles are database-backed).
- Firefox does not launch headless on this Mac; the WebKit and Firefox print variants do not run
  in CI (Chromium only).

## Checkpoint readiness

Code, tests and documentation are complete for M5 development; every automated gate is green on
the final tree; no known open security or integrity defect; the two-set schedule is recorded
consistently in the acceptance guide, evidence, tasks, steering and `AGENTS.md`. Remaining before
a PR: commit the checkpoint (authorization), push and run CI (authorization).
