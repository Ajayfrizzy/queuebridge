# M2 Test Evidence — Core Queue Operations and Visitor Flows

**Branch:** `feature/m2-queue-core` (fast-forwarded to `staging` @ `1019792`, Ask Que PR #3 merged)
**Date:** 2026-11-08 · **Node:** 24.22.1 · **pnpm:** 9.15.9 · **PostgreSQL:** 17.10 (disposable Docker container `queuebridge-pg`, port 55433)
**Status:** all local gates pass (sections below). GitHub CI results for the pull request are recorded at the end of this file.

## Gate results (local)

| Gate                                                                                 | Result                                                                                                                                                                |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                                                  | PASS                                                                                                                                                                  |
| `pnpm lint` (`--max-warnings 0`)                                                     | PASS (0 errors, 0 warnings)                                                                                                                                           |
| `pnpm typecheck`                                                                     | PASS (8/8 workspaces)                                                                                                                                                 |
| `pnpm build`                                                                         | PASS                                                                                                                                                                  |
| `pnpm test` (no DB)                                                                  | PASS: contracts 53, domain 65, channels 18, continuity 11, ui 6, worker 6, api 31, web 22                                                                             |
| `pnpm test:db` (real PostgreSQL)                                                     | PASS: 13 files, **312** tests (M1: 251). **10 consecutive full runs passed** after the flake fix below                                                                |
| Playwright (`pnpm --filter @queuebridge/web test:e2e`)                               | PASS: **64** tests (M1: 49) at 1280, 1440, 375 and 320 px; 2 consecutive full runs. **Final (after UI refinement and header fix): 84 passed, 4 capture-only skipped** |
| DB validation (`.github/workflows/db-validate.yml` steps, run locally on a fresh DB) | PASS: all 7 steps                                                                                                                                                     |
| `pnpm db:migrate` fresh DB, then again                                               | PASS: 4 applied, then "No new migrations"                                                                                                                             |
| `pnpm db:seed` twice                                                                 | PASS                                                                                                                                                                  |
| Migration 0004 re-executed (isolated DB)                                             | PASS (`schema-m2.db.test.ts`)                                                                                                                                         |
| `pnpm audit --audit-level high`                                                      | No high/critical (5 low/moderate, unchanged from M1)                                                                                                                  |
| Production-mode smoke (built API, own process, port 3199)                            | `/health/ready` 200 with DB check; HSTS, nosniff and DENY headers present; join without CSRF 403; status without token 404; logs contain path and problem only        |

## What the tests prove

### Group 1 — domain (pure)

- `packages/domain/src/queue.test.ts` (new):
  - Published ordering: FIFO; enabled classes first; non-enabled classes cannot jump; paused, missed and terminal tickets excluded; deterministic tiebreak; no input mutation.
  - Session state machine: allowed and rejected transitions.
  - Replay: rebuilds state; rejects gaps, re-ordering, illegal transitions, `from_state` mismatches and duplicate tickets or issue numbers.
  - **Property test:** 200 seeded random legal histories of 60 events replay to identical state, and derived ordering is input-order independent.
- `wait-estimate.test.ts`: position 0 now yields a non-zero-width interval (REQ-F6.6). This is the only change to an M0 assertion.

### Group 4 — concurrent PostgreSQL transactions (`queue-concurrency.db.test.ts`)

- **Joins:** 40 simultaneous joins produce 40 distinct codes, gap-free issue numbers 1–40, revision and sequence 41, and a valid hash chain.
- **Join replay:** the same join replayed 8× concurrently creates exactly one ticket and one `ticket.create` event.
- **Call-next:**
  - Two counters calling concurrently get two different tickets: exactly the first two issued, one per counter (5 rounds).
  - With one ticket left, one call commits and the other is rejected `queue_empty`.
  - The same counter clicked 3× concurrently: 1 commits, 2 are rejected `counter_busy`.
  - One counter racing across two services' sessions is never given two tickets.
- **Idempotency:**
  - One operation id sent 10× concurrently: 1 committed, 9 duplicates, one event, one `client_operations` row.
  - The same operation id raced on two different queues commits once.
- **Sessions and transfers:**
  - Concurrent session open creates one session and one genesis event.
  - Opposite-direction transfers run concurrently (3 rounds) without deadlock.
  - A mixed burst of joins, walk-ins, calls and a pause keeps every invariant.
- **Database backstops:** `UNIQUE(session, issued_sequence)`, `UNIQUE(session, public_code)`, the partial unique index of one active ticket per counter, `UNIQUE(session, sequence)`, and the `client_operations` device-required CHECK for offline sync.

### Journeys, lifecycle and audit (`queue-core.db.test.ts`)

- **Web journey:** join → status → call → serve → complete. The event log is exactly `queue.open, ticket.create, call_next, serve, complete`, the actor is recorded, the hash chain verifies, and **replaying the log reproduces the `tickets` and `queue_sessions` rows**. `ticket_transitions` history is recorded.
- **Shared FIFO:** walk-in and web tickets share one queue in issue order (`R001 web`, `R002 staff`, `R003 web`).
- **Lifecycle:**
  - Illegal transitions are rejected with a recorded disposition that replays identically.
  - Pause and resume work; supervisor recall frees the counter.
  - A missed ticket can return within the grace window and is rejected (`grace_window_expired`) after it.
  - A counter can hold only one called/serving ticket.
  - Inactive and unassigned counters cannot call.
- **Sessions:**
  - Opening is idempotent (200, no extra event).
  - Prefixes are facility-unique (`P`, then `A` for a second "P…" service).
  - Pause blocks joins and calls, and the visitor sees "paused".
  - Close is refused while tickets are active; reopen works the same day.
  - An inactive service cannot be opened.
- **Transfers:**
  - The original join time is preserved, the source ticket becomes `transferred`, and the visitor's original link follows the new code.
  - Both chains stay valid and the source event links to the destination.
  - A ticket cannot be transferred twice; transfers to a not-open or same service are rejected.
  - A reason code is required, and free text is not accepted.
- **Estimates (F6):**
  - `insufficient_data` with fewer than 5 real samples.
  - With 5 four-minute services and 1 ticket ahead: exactly 168–720 s, confidence `low`, with factors including "Operating hours are not configured" and "not an appointment".
  - With no active counter it says so.
- **Data minimization:**
  - The catalog lists open queues.
  - The board contains no UUIDs, tokens or emails; `now_calling` keys are exactly `counter_name, public_code, state`.
  - Unknown, suspended and malformed facility lookups return the same 404.
- **Append-only:**
  - UPDATE and DELETE are blocked; tampering is detected at the exact sequence.
  - Payload keys are limited to ids, codes, states and policy references (no PII).

### Group 8 — security (`queue-security.db.test.ts`, 30 tests)

- **RBAC matrix:**
  - `call_next`: reception, auditor and facility_admin get 403; counter, supervisor and org_admin get 200.
  - `queue.pause`: reception, counter and auditor get 403; supervisor, facility_admin and org_admin get 200.
  - Recall is supervisor-only.
  - Reception may register walk-ins and cancel waiting tickets but not serve.
  - Auditors can read only.
  - Role revocation applies to the next command.
  - Every staff route returns 401 when unauthenticated.
- **Tenant isolation:**
  - Organization B probing A's queue (view, pause, call, walk-in, stream) gets 404, identical to a random id.
  - Opening a queue on A's facility, using A's counter, or opening A's service in B's facility all return 404.
  - A's ticket id smuggled into B's queue returns 404 and A's ticket is untouched.
  - A supervisor of another facility in the same organization gets 404, and cross-facility transfer is invisible.
- **Status tokens:**
  - No token, wrong token, another visitor's token, wrong code, malformed token and expired credential all return the same 404.
  - Responses contain no UUIDs.
  - Tokens and join proofs are never stored in clear.
- **Lost acknowledgement:**
  - The same operation id and proof returns `duplicate` for the same ticket with a rotated token (the old token is dead).
  - A different proof, or another queue, gets 409 and learns nothing.
  - Reusing a command operation id for a different command is a 409.
- **Validation and abuse:**
  - Strict bodies reject `priority_class`, `organization_id`, `actor_id`, v4 operation ids, short proofs and M4 actions.
  - Anonymous joins need the CSRF header and an allowed Origin.
  - The join rate limit returns 429.
- **SSE (real HTTP server and real LISTEN/NOTIFY):**
  - The public stream signals once and is filtered by facility: a change in another facility is not delivered.
  - Payload keys are exactly `revision`.
  - The visitor stream requires the token header.
  - The staff stream requires a session with a facility role (401 / 404).

### Group 11 — accessibility, plus browser journeys (`e2e/queue-journey.spec.ts`)

- **M2 exit journey, across three independent browsers (staff, visitor phone, display board):**
  - Opening the queue in the staff UI flips the admin join link to "Live".
  - The visitor gets `G001` with "Confirmed", a position, an honest estimate and the policy.
  - Call next, start serving and complete update the visitor page **and** the board live, without reloads.
  - The board announces "please go to Counter 1", the visitor gets an assertive turn alert, and the board DOM has no UUIDs.
- **Walk-in:** the code and status-link QR are issued; the exact link opens on another device, the token is scrubbed from the URL, and the ticket survives a reload.
- **Lost response:** the server commits but the response is dropped; the UI explains that retrying is safe, and the retry yields the same `G001` with exactly one ticket server-side.
- **Persistence and household:** the ticket survives reload and a new tab; a second ticket for another person needs explicit confirmation (`G002`, "2 in line"); "forget this ticket" works.
- **Privacy:** another device without the token sees "does not have access" (API 404).
- **Polling fallback:** with every stream request refused (counted, 0 served), a server change still reaches the page through the 15 s poll.
- **Read-only console:** an auditor sees no Call/Walk-in/Pause controls, and a forged command returns 403.
- **@responsive (320, 375, 1280, 1440):**
  - axe WCAG 2.1 A/AA passes on the join page, ticket page (with the estimate explanation open), staff console (before and after a call) and display board, with no horizontal overflow.
  - Keyboard-only join works.
  - The status message is `role="status"`, focus moves to `main`, and touch targets are at least 44 px.

## Defects found and fixed during M2 validation

1. **Pre-existing test-isolation flake (M1 test).** `schema-m1.db.test.ts` re-executed migration 0003's DDL on the shared test database while other files ran. Postgres logged `deadlock detected` 5× with that migration's process, and the M1 concurrent-deactivation test returned 500/500.
   - Fix: migration-idempotency tests now run in a throwaway database (`testing/isolated-db.ts`).
   - Result: 10/10 full-suite runs pass and 0 deadlocks were logged afterwards. The repro's diagnostic assertion message was kept.
2. **Zero-width wait estimate.** `computeWaitEstimate` returned `0–0 s` for the next person, which implies an exact time (REQ-F6.6). The upper bound now uses `(position + 1)`; design §7 is amended.
3. **Canonical JSON pitfall.** The design §6 sample `JSON.stringify(event, Object.keys(event).sort())` drops nested keys, so payloads would not have been hashed. A recursive canonicalizer is implemented and unit-tested against that exact pitfall.
4. **Privacy.** The first draft of the transfer contract accepted free-text reasons, which would have been written into `queue_events.payload`. Replaced with fixed reason codes.

## Not covered by M2 (see `M2-completion.md` → deferrals)

Offline/sync (Groups 3, 5, 6, 7), priority overrides and audit endpoints (Groups 8 override parts, 9 checkpoints), channels (Group 10), Ask Que (Group 13).

---

# M2 UI consistency refinement (after manual acceptance, before commit)

**Scope:** spacing, alignment and visual hierarchy only. No queue behaviour, API, authorization or real-time logic changed. Screenshots are in `docs/testing/screenshots/m2-ui/` (`before-*` / `after-*`, width in the file name). Regenerate them with:

```bash
TEST_DATABASE_URL=… CAPTURE=after pnpm --filter @queuebridge/web exec playwright test e2e/ui-layout.spec.ts
```

## Defects observed in the before screenshots, and root causes

| Defect                                                                                                | Root cause                                                                                                          | Fix (shared, reusable)                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Walk-in, Queue controls and Estimate panels touching                                                  | `.card` had no margin and columns had no gap                                                                        | Column flow spacing: `.split-main/.split-side > * + *` = `--space-5`                                                                                                                                                                                             |
| Dropdown arrow tight against the border; inconsistent select padding                                  | Native appearance with symmetric padding (browser-dependent arrow placement); `.inline-form` select at `width:auto` | Shared `select` style: `appearance:none`, 2.75 rem arrow gutter, theme-aware chevron token (`--select-arrow`, light and dark), `text-overflow: ellipsis`; **forced-colors** restores the native arrow                                                            |
| Transfer controls cramped, with inline labels wrapping unevenly                                       | Ad-hoc `.inline-form` of label/select/label/select/button                                                           | `.form-grid` (label above control, auto-fit columns, actions aligned to the controls) inside a `fieldset` with legend "Transfer this ticket"                                                                                                                     |
| QR panel: QR left-aligned in its frame, misaligned actions, QR touching text                          | Default margins; no panel layout                                                                                    | `.qr-panel`: centred content, QR centred with flow spacing, centred action row                                                                                                                                                                                   |
| Weak hierarchy: queue state and waiting count buried in a sentence; Call next below the transfer form | Single muted text line; button rendered regardless of state                                                         | Labelled stat row (`<dl>`: Queue / Waiting / Updates); `.current-ticket` focal panel with 2.5–3.5 rem code and the primary action first; Call next is the primary action only while the counter is free, otherwise a hint "Finish G001 to call the next visitor" |
| Uneven spacing inside cards (default `<p>` margins, extra bottom space) on join, ticket and board     | Browser default margins                                                                                             | Card/alert flow spacing: children have no outer margins and are separated by `--space-3`                                                                                                                                                                         |
| Board status line off-baseline; join "Live" badge wrapping oddly                                      | Text and controls in one paragraph                                                                                  | `.toolbar` / `.toolbar-spread` pattern; next codes as `.code-chips`                                                                                                                                                                                              |
| Ticket rows wrapping "Cancel" onto its own line at 320 px                                             | Flex row with a large meta basis                                                                                    | 3-column grid row (code / details / right-aligned actions)                                                                                                                                                                                                       |
| **Accessibility bug:** board section labels                                                           | `aria-labelledby` ids built from service names containing spaces (invalid id, so the label is broken)               | Index-based ids `board-svc-N`                                                                                                                                                                                                                                    |

Spacing tokens added: `--space-1…6` (0.25–2 rem) and `--control-h` (44 px). The new and changed M2 rules use only tokens.

## Regression tests added (`apps/web/e2e/ui-layout.spec.ts`, @responsive: 320, 375, 1280, 1440)

Geometry and computed-style assertions, no pixel snapshots:

- **Panel spacing:** every sibling panel in both console columns is at least 16 px apart.
- **Selects:** every `select` has a right gutter of at least 40 px (larger than its left padding), a height of at least 44 px and `appearance: none`. In forced-colors emulation, `appearance` is `auto` (native arrow).
- **Transfer form:** it is a named group ("Transfer this ticket"). Each label sits above and aligned with its control, and controls and the action stay inside the fieldset.
- **QR panel:** the QR is horizontally centred (within 3 px) with at least 8 px of space above and below.
- **Hierarchy:** the current ticket code is at least 40 px; the first action is the primary "Complete"; the waiting count is shown as a stat.
- **Ticket rows:** row actions are right-aligned at every width.
- **Focus:** the keyboard focus indicator is a solid outline of at least 3 px.
- **Visitor screens:**
  - Join card internal gaps are a uniform 12 px.
  - The ticket page stack has uniform 16 px gaps.
  - Board toolbar items are vertically centred against each other (within 6 px) when they share a row. When fonts make them wrap (Linux CI at 320 px), they must align to the row start (within 2 px), sit below the first row and stay inside the viewport. This was amended after PR #4 CI; see the end of this file.
  - There is no horizontal overflow.
- **Negative controls:** removing the panel-gap rule fails the gap assertion, and removing the select gutter fails it at 10.4 px vs ≥ 40. Both were confirmed, then the styles were restored.

## Results after the refinement

format PASS · lint PASS · typecheck 8/8 · build PASS · unit 212 PASS · real PostgreSQL 312 PASS · **Playwright 76 passed** (+12 layout checks; 4 capture-only runs skipped) on **two consecutive full runs**, including all existing axe WCAG 2.1 A/AA, keyboard, overflow and live-update tests · audit: no high/critical.

## Final pre-commit addendum: narrow-mobile header

- **Header layout.** Deliberate three-row header below 40 rem (brand / navigation / account). The account name and Sign out moved from the Primary nav list into a labelled `Account` group.
- **8 new header tests** (`@responsive site header`): signed in and anonymous at 320, 375, 1280 and 1440 px. They check:
  - no element clipped or overlapping;
  - targets of at least 44 px;
  - row order on narrow screens;
  - keyboard order skip link → brand → nav → Sign out.
- **Final results:** **Playwright 84 passed, 4 skipped** on 2 consecutive full runs.
  - The 4 skips are the screenshot-only capture utility, gated by `CAPTURE`; its flows are asserted elsewhere.
  - Unit 212 · real PostgreSQL 312 · format, lint, typecheck and build PASS · audit no high/critical.

# Pull request #4 (`feature/m2-queue-core` → `staging`): CI and review

## First CI run (`4283d8e`): 2 of 6 jobs failed, both fixed without weakening checks

- **Lint and typecheck: `TS2307 Cannot find module '@queuebridge/domain'`.**
  - Cause: the workflow built only `contracts` before typecheck, but M2's API now imports `domain`, which resolves through its `dist`. Local runs passed only because `dist` already existed.
  - Reproduced locally by deleting `packages/*/dist`: 15 errors with the old step, 0 after the fix.
  - Fix: the step now builds every library package (`pnpm --filter "./packages/*" build`). Typecheck itself is unchanged.
- **Tests with PostgreSQL: 1 Playwright failure (`[mobile-320] … aligned toolbars`).** On Linux fonts the board's Live badge and Spoken announcements toggle wrap onto two rows, so the "same-row centre within 6 px" check measured 43 px.
  - The assertion now handles both layouts deliberately. On a shared row, centres must be within 6 px (unchanged). When wrapped, both items must start at the toolbar's row edge (within 2 px), the second must sit below the first, and both must stay inside the viewport. The tolerance was not loosened.
  - Negative controls, by injected CSS:
    - forced wrap: passes;
    - wrapped and indented 24 px: fails ("wrapped toolbar item aligned to row start");
    - same row offset 9 px: fails (17.9 px vs ≤ 6);
    - offset 20 px: fails.
- **Re-run (`2821134`):** all 11 checks passed (push and PR runs).

## Codex review (4 × P2): all valid, all fixed with regression tests (`865b206`)

| Finding                                                                                                                | Fix                                                                                                                                                                                                            | Regression test (shown to fail on the previous code)                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved tickets keyed by public code, so `G001` from facility B replaced facility A's `G001`                             | A device-local id per saved ticket. Storage, links and navigation use `/ticket/:code?k=<id>`. Ambiguous bare-code links show a chooser; legacy entries get a stable id. The ticket view is keyed by code + id. | `tickets.test.ts` (4 tests); Playwright `the same public code at two facilities keeps both tickets on the device` (old code: 1 listed instead of 2)                                         |
| SSE `writeHead` after `hijack()` dropped CORS headers, so cross-origin deployments got no live updates                 | Copy `reply.getHeaders()` into the stream response. Security headers are now also set in `onRequest`, so streams carry them; previously they were `onSend`-only and skipped by hijack.                         | `queue-security.db.test.ts › streams keep CORS and security headers…` (real HTTP; 3 stream types; foreign origin still denied). Fails without the fix (`access-control-allow-origin` null). |
| Join with `localStorage` unavailable lost the pending operation id, so a retry after a lost response made a 2nd ticket | Pending join kept in page memory when storage fails. The UI tells the visitor to keep the page open.                                                                                                           | `tickets.test.ts` (setItem throws, retry reuses id + proof); Playwright `with browser storage unavailable, retrying a lost join still cannot duplicate` (old code: G002, 2 tickets)         |
| Walk-in operation id discarded after an uncertain response, so reissuing created a 2nd ticket                          | Operation id kept after a network error or 5xx, with a **Finish issuing walk-in ticket** replay. It is cleared on success or a 4xx refusal.                                                                    | Playwright `a walk-in whose response is lost is finished with the same operation, not reissued` (old code: G002, 2 tickets)                                                                 |

While verifying finding 1, the new test caught a second defect. Moving from the chooser to a specific ticket reused the mounted page with stale state. Keying the view by code + id fixed it.

## Results at `865b206`

- **Local:** format PASS · lint PASS (0 warnings) · typecheck 8/8 (from clean package `dist`) · build PASS · unit **218** · real PostgreSQL **313** · **Playwright 87 passed, 4 skipped** (capture-only) · audit: no high/critical (5 low/moderate, unchanged).
- **GitHub CI:** all 11 checks pass on push and PR runs:
  - lint + typecheck, tests without DB, tests with PostgreSQL (313 DB tests and 87 Playwright passed, 4 capture-only skipped);
  - build, security audit, migration apply + constraint validation.
