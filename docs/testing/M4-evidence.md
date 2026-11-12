# M4 Test Evidence — Fairness, Overrides, Audit and Adaptive Routing (F3, F5, F8)

**Branch:** `feature/m4-fairness-routing-audit` (created from `staging` @ `f880abb`, M0–M3 merged).
**Merged into `staging` via PR #6 (https://github.com/Ajayfrizzy/queuebridge/pull/6), squash commit `01927e4`, 2026-11-12.** Local gate results below; GitHub CI results in `M4-completion.md` → "Final state".
**Date:** 2026-11-08 · **Node:** 24 · **pnpm:** 9 · **PostgreSQL:** 17.10 (disposable Docker container `queuebridge-pg`, port 55433)
**GitHub CI:** all 11 jobs green on `014389d` (push and pull-request runs); counts identical to the local runs.

## Gate results (local, final run on the finished tree)

| Gate                                                                | Result                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm format:check`                                                 | PASS                                                                                                                                                                                                                                       |
| `pnpm lint` (`--max-warnings 0`)                                    | PASS (0 errors, 0 warnings)                                                                                                                                                                                                                |
| `pnpm typecheck`                                                    | PASS (all workspaces, 0 errors)                                                                                                                                                                                                            |
| `pnpm build`                                                        | PASS                                                                                                                                                                                                                                       |
| `pnpm test` (no DB)                                                 | PASS: contracts 102, domain 98, channels 18, continuity 64, ui 6, worker 10, api 53, web 34 (= **385**; M3 baseline 299)                                                                                                                   |
| `pnpm test:db` (real PostgreSQL; api + worker)                      | PASS: api 25 files / **465** tests (M3 baseline 21 / 395; incl. 14 migration-guard and 16 counter-closure tests) + worker 1 file / **13** tests; 2 consecutive runs on the final tree (earlier rounds: 3 runs + 1 on a brand-new database) |
| Playwright (all projects: 1280, 1440, 375, 320 px)                  | PASS: **127 passed**, 4 skipped (the pre-existing opt-in screenshot-capture test, `CAPTURE` unset); M3 baseline 108                                                                                                                        |
| Playwright `e2e/fairness.spec.ts` alone                             | PASS: **13** (3 `@responsive` journeys × 4 widths + policy versions at 1280)                                                                                                                                                               |
| Playwright `e2e/counter-closure.spec.ts` alone                      | PASS: **5** (deactivation journey × 4 widths + policy-permission check at 1280)                                                                                                                                                            |
| DB validation (every run-step of `db-validate.yml`, fresh database) | PASS: 8/8 run-steps — 6 migrations applied (identity guard: empty → initialized), idempotent re-run, UPDATE/DELETE rejected, TRUNCATE rejected on 6 tables, both unique constraints                                                        |
| `db:migrate` fresh DB twice; `db:seed` twice                        | PASS: 6 applied then no-op; seed idempotent; seeded services now have a `v1` policy snapshot                                                                                                                                               |
| `pnpm audit --audit-level high`                                     | PASS (exit 0): 0 high/critical; 2 low + 3 moderate, all pre-existing dev-tooling transitives. Lockfile change: only the worker→domain link                                                                                                 |

Fresh-database note: the API and worker DB suites start in parallel; their shared global setup now
takes a PostgreSQL advisory lock before applying migrations (CI pre-migrates, so this race was
latent; verified by a run against a newly created database).

## GitHub CI — PR #6

See `M4-completion.md` → "GitHub — PR #6 and CI" for the job-by-job results. First round:
M3 offline-sync test defect fixed (assertion made precise and stronger, mutation-checked); an
M1 sign-out test failure not reproduced (unchanged code, recorded). Codex review (2 × P2) — false `failed`
under concurrent writes (single-snapshot fix) and operation-id reuse after a refusal (tracker
fix) — both fixed with regression tests that fail without the fix; details in `M4-completion.md`. Codex re-review of `14de6d1` (1 × P2): silently truncated audit export over 50,000 events — now refused with 413 and every export states its count and head; regression test fails without the fix.

## Final routing invariant: capability removal (commit `5bd18d5`)

A service capability could be removed from a counter that was calling or serving a visitor of that
service. `DELETE /counter_service_capabilities/:counterId/:serviceId` now runs under the shared M4
counter locks (sessions in id order, then the counter `FOR UPDATE`) and answers 409 while a called
or serving ticket of that service is at the counter; nothing changes on refusal. Details and risk
in `M4-completion.md` → "Final routing invariant".

| Evidence                                                  | Result                                                                                                                                                                                                                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capability-removal.db.test.ts` (real PostgreSQL)         | 13 tests; **7 fail on the unfixed route**, 13 pass with the fix. Called/serving refusal with exact unchanged state; other-service tickets; 403 before 409; 404; races vs Call Next, Start Serving, Complete (12 rounds each); racing removals; coordinator-held queue |
| `pnpm test:db`                                            | PASS: api 26 files / **478** tests, worker 13 (M4 before: 465)                                                                                                                                                                                                        |
| `pnpm test` (no DB)                                       | PASS: 385                                                                                                                                                                                                                                                             |
| format check, ESLint `--max-warnings 0`, typecheck, build | PASS                                                                                                                                                                                                                                                                  |
| Playwright `counter-closure.spec.ts`                      | PASS: 10 (deactivation journey ×4, capability-removal journey ×4 widths with axe and overflow checks, policy check, operation-id retry)                                                                                                                               |
| Playwright full suite                                     | 130 passed, 4 opt-in skips, 1 pre-existing unrelated failure (`review-fixes.spec.ts` logout "Dismiss" strict-mode match; identical with the change stashed; passed in CI)                                                                                             |

## Manual acceptance result (human tester, reported 2026-11-12)

**All 17 M4 manual acceptance scenarios PASSED** on the local stack (`m4-acceptance`
organization, single-role accounts, worker checkpointing with the configured key). The tester's
own numbered checklist is the source of record; this document reproduces the scenarios whose
content was shared with the implementer:

| Scenario                                                           | Result                                        | Notes                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 — priority-class configuration by an administrator               | PASS (with the org admin `m4-admin`)          | First attempt was with an account without `FACILITY_CONFIGURE`; refusal is by design (see "Manual test 1 — finding")                                                                                                                                                                                               |
| Counter closure: serving counter must not close                    | **FAILED first** → fixed → **PASS on retest** | Defect 1 below                                                                                                                                                                                                                                                                                                     |
| Counter closure: called visitor requeued, old counter cannot serve | **FAILED first** → fixed → **PASS on retest** | Defect 2 below                                                                                                                                                                                                                                                                                                     |
| 12 — offline coordinator fencing                                   | PASS, all 8 checks                            | (1) coordinator device appears in the dashboard; (2) supervisor designates it; (3) conflicting online Call next refused; (4) out-of-order call refused; (5) counter close refused; (6) administrative counter deactivation refused; (7) supervisor ends coordinator authority; (8) normal online operations resume |
| 15 — private-data redaction in audit exports                       | PASS                                          | Procedure below                                                                                                                                                                                                                                                                                                    |
| All other scenarios of the checklist                               | PASS                                          | As reported by the tester                                                                                                                                                                                                                                                                                          |

No manual failure remains. Automated evidence for every scenario's server-side rule is listed in
the sections below.

## Manual-acceptance defects (2026-11-10) — found, root-caused, fixed

Both blocking failures were reproduced from the evidence in the development database
(`m4-acceptance` organization): `admin_events` and `queue_events` show that neither went through
the M4 close control (`POST /counters/:id/availability`, used only twice, with nothing called).
Both went through the **admin Activate/Deactivate switch** (Administration → Counters,
`PATCH /facilities/:id/counters/:id {active}`, 14 toggles between 22:24 and 22:34):

- G006 was SERVING at Counter 1 from 22:29:07; Counter 1 was toggled at 22:29:43 (Defect 1).
- G005 was CALLED to Counter 2 at 22:25:24; Counter 2 was deactivated at 22:25:35; G005 was
  then served (22:31:09) and completed (22:32:18) at Counter 2 (Defect 2).

| #   | Root cause                                                                                                                                                                                                                                                                                                | Fix (server-side)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The admin `active` switch was an independent second "out of service" path from M1. It locked only the counter row (not the queue sessions, so it was not serialized with queue commands), never checked for a SERVING ticket, never released a CALLED one, wrote no queue event and signalled no console. | `PATCH` now runs the SAME locked procedure as closing (`lockCounterScope` → `vacateCounter`, `apps/api/src/queue/counters.ts`): sessions in id order, then the counter (`FOR UPDATE`), then the counter's tickets (`FOR UPDATE`) in a fresh statement. SERVING → 409; CALLED → atomic `ticket.release` (called → waiting, counter cleared, waiting age kept, reason `counter_deactivated`), only for supervisor/facility admin, refused while an offline coordinator holds the queue; consoles are signalled; the admin event records `active` and `released`. |
| 2   | Starting service (`ticket.serve`) never re-checked the ticket's counter — only calls did — so a visitor stranded at an inactive/closed counter could still be served and completed there.                                                                                                                 | The generic ticket path refuses called → serving unless the ticket's counter is active AND open (`counter_inactive` / `counter_closed`, counter row `FOR SHARE` under the session lock). Recall (called → waiting) still works, so a stranded visitor can be returned to the queue.                                                                                                                                                                                                                                                                            |
| —   | The M4 close control itself was correct (locks, serving refusal, release).                                                                                                                                                                                                                                | Refactored to share the procedure above; behaviour unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| UI  | Admin page only _announced_ refusals (transient); the console offered "Start serving" for a visitor at an out-of-service counter.                                                                                                                                                                         | Admin page shows a persistent per-counter alert (refusal) or status ("G00x returned to the front of the queue"); the console shows "deactivated by an administrator", disables "Start serving" there with an explanation; audit trail labels releases with their cause. These are courtesy only — the API enforces every rule.                                                                                                                                                                                                                                 |

Not the cause (checked): ticket state machine (serve requires `called`, so a requeued ticket is
refused); database locking of the close control (sessions → counter → tickets, serialized with
every queue command); stale frontend state (consoles are now signalled; a stale action is refused
server-side and the console reloads — proven with live updates blocked).

### Regression evidence

`apps/api/src/counter-closure.db.test.ts` (16, real PostgreSQL) — **run against the unfixed code
first: 8 failed, 8 passed**; after the fix: **16 passed** (3 consecutive full-suite runs). The 8
that failed before the fix:

- admin deactivation of a SERVING counter is refused (409) and nothing changes;
- admin deactivation with a CALLED visitor requeues them atomically (state, counter cleared,
  `called_at` cleared, `wait_since` unchanged), a stale serve/miss is refused, the next open
  counter calls them first, the release event explains it, audit verification `verified`;
- the admin event records `released`, and the console revision advances;
- a visitor stranded CALLED at an inactive counter cannot be served there (recall works);
- the same at a closed counter;
- admin deactivation racing a serve: exactly one wins; never a called/serving ticket at an
  out-of-service counter (8 rounds; both orderings observed);
- after a release, priority order is kept (higher class first, then the released visitor by
  waiting age, then later arrivals) and all 4 decisions replay;
- admin deactivation that would release a visitor is refused while an offline coordinator holds
  the queue (idle counters may still be deactivated).

Passing before and after (the M4 close control and permissions): idle close/deactivate;
operational close of a serving counter refused; operational close requeues; deactivation role
rules (supervisor, counter operator, auditor 403; facility admin 200); calls to inactive/closed
counters refused; operational close racing a serve (8 rounds); deactivation racing a call; policy
configuration permissions.

`apps/web/e2e/counter-closure.spec.ts` (Playwright, real stack; `@responsive` at 1280, 1440, 375,
320 px with axe and overflow checks): serving counter → "Deactivate" refused with a visible alert
and the visit completes; calling counter → "returned to the front of the queue"; the live
console updates without a reload (deactivated notice, visitor back at the head, Call next
disabled); a console with live updates blocked still shows "Start serving" — clicking it is
refused by the server and the console corrects itself; Counter 2 then calls the visitor first;
the audit trail shows "counter deactivated by an administrator". This spec was written after the
fix and was not run against the defective build (the DB tests above are the before/after proof).

### Manual test 1 (priority classes) — finding

The database shows the policy change **did** succeed for the org administrator
(`m4-admin@acceptance.local`, `service.updated` → v2 at 21:25:10); no other account changed a
service, and service-policy refusals are not logged, so which account was "selected" for the
failed attempt cannot be read from the data. Policy editing requires `FACILITY_CONFIGURE`
(facility admin or org admin); the supervisor, counter operator and auditor accounts in
`~/.config/queuebridge/m4-test-accounts.txt` correctly cannot — and the evidence document's
earlier step text said "as facility admin" while the prepared file lists an `org_admin`, which
is a plausible source of confusion. Verified now: org admin and facility admin → v2/v3;
supervisor, counter operator, reception, auditor → 403 and no change (`counter-closure.db.test.ts`);
a supervisor sees no "Edit policy" in the UI while the org admin does (`counter-closure.spec.ts`).
Use **m4-admin** (org admin) for test 1.

## New and changed tests (M4)

| File                                           |   Tests | Group         | What it proves                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | ------: | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/domain/src/fairness-routing.test.ts` |      22 | 1, 7          | Ordering key `priority_class > wait_since > issued_sequence > id`; equal-priority FIFO; disabled classes rank last; counter eligibility (inactive, closed, incapable, busy); routing explanation; replay detects rewritten calls, wrong snapshots, unknown versions, missing `would_have_called`; release keeps waiting age; property test: 300 random sessions always verify and a single swapped call is always caught |
| `packages/domain/src/audit.test.ts`            |       8 | 9             | Canonical JSON; known chain verifies; one changed character breaks it at that sequence; checkpoint root/message; checkpoint verification (valid / invalid / unverifiable)                                                                                                                                                                                                                                                |
| `packages/domain/src/queue.test.ts`            |  28 (+) | 1             | Property test regenerated with priority classes and `wait_since`: same events in order → same state; policy description incl. override and transfer wording                                                                                                                                                                                                                                                              |
| `packages/contracts/src/fairness.test.ts`      |      17 | 2             | Override / call-out-of-order / counter-transfer / availability requests parse; missing, malformed, too-short, over-long and unexpected fields (actor, position, policy version) rejected; verification status enum                                                                                                                                                                                                       |
| `packages/contracts/src/admin.test.ts`         |  18 (+) | 2             | Policy defaults (override reasons, transfer placement) and validation                                                                                                                                                                                                                                                                                                                                                    |
| `packages/continuity/src/projection.test.ts`   | 13 (+3) | 3, 5          | Offline call order mirrors the server (class, waiting age, provisional last); closed counter refused locally; pre-M4 cached snapshot defaults safely                                                                                                                                                                                                                                                                     |
| `apps/web/src/lib/policy.test.ts`              |  5 (+1) | 11            | UI uses the same published wording as the server                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/api/src/fairness.db.test.ts`             |      22 | 4, 7, 8, 9    | See below                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/api/src/audit.db.test.ts`                |      13 | 8, 9          | See below                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/worker/src/checkpoints.db.test.ts`       |       9 | 9             | See below                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/web/e2e/fairness.spec.ts`                |      13 | 11, 12 (D, E) | See below                                                                                                                                                                                                                                                                                                                                                                                                                |

Existing tests changed (expectation updates only, no assertion weakened): default policy now
includes `override_reasons` and `transfer_placement` (`admin.test.ts`, `facility-setup.db.test.ts`);
the staff-ticket field allow-list includes `wait_since` (`queue-core.db.test.ts`); projection
fixtures carry the new `StaffQueue` fields. The checkpoint cross-app "test vector" placeholder was
replaced by a real constant computed independently with Node `crypto` and asserted in both the API
and worker suites.

### `fairness.db.test.ts` (real PostgreSQL)

- **Policy versions:** server assigns `v1`, `v2`…; client labels ignored; no-op edit creates nothing; every snapshot kept; `policy.changed` appended to today's session; snapshots immutable; decisions cite the version in force. Only facility admins change policy; staff read history; other tenants 404. A service created outside the API keeps its pre-existing rules as `v1` on first change.
- **Ordering:** equal priority is FIFO; every call records its routing explanation.
- **Priority override:** reorders by class; records actor, ticket, from/to class, reason code, policy version, time; free text only in `priority_overrides`, its SHA-256 in the event, absent from public/visitor views. Counter operators, reception and auditors → 403 **and** a `*.denied` admin event; nothing changes. Only enabled classes, configured reasons, ≥ 5-character explanations, waiting tickets. A class later disabled cannot jump the queue. The database refuses override rows without actor/policy/reason/explanation/event (check constraints) and refuses UPDATE/DELETE on overrides and policy versions.
- **Transfers:** `by_original_join_time` keeps waiting age; `end_of_queue` joins the end; original join time recorded in both.
- **Counter availability (Journey E):** closed or inactive counters get no assignment; closing a counter with a CALLED visitor returns them to the head of the line (supervisor only); closing while SERVING refused; an idle counter can be closed by its operator; services left without an open counter are reported.
- **Routing override:** records rationale and `would_have_called`; counter operators refused (403, logged); counter must be open and free.
- **Counter transfer:** only to an active, open, capable, free counter.
- **Concurrency (Group 4):** overrides racing calls at several counters → no duplicate calls and every decision replays; closing a counter while it is being called is serialized (call or closure wins, never both).
- **M3 interaction:** overrides, routing overrides and releases are fenced while a coordinator holds the queue; an offline call to a counter closed online, or to a visitor no longer first under a changed policy, is held for review (`needs_review`).

### `audit.db.test.ts` (real PostgreSQL; tampering in a throwaway database)

- **Access (Group 8):** auditor, supervisor, facility admin and org admin read view/verify/export; counter operator and reception 403; other tenant 404; anonymous 401; no write method on the audit resource (404).
- **View vs export:** the view shows actor names and override explanations (with matching SHA-256); the export is redacted (no names, no free text, hash present, `redacted: true`); visitor status tokens and e-mail addresses appear in neither.
- **Verification never reports a false success:** clean session → `verified` (chain, 2 replayed decisions across a policy change and an override); valid signed checkpoint → `verified`, covered to the head; **no signing key on this server → `incomplete`**, never verified; wrong key → `failed`; unknown key id → `incomplete`; a worker integrity alert → `failed`.
- **Tampering (isolated DB, triggers disabled only there):** one changed character in an event → `failed` at that sequence (`event_hash mismatch`); a deleted event → `failed` (event count vs `last_sequence`); a rewritten override explanation → `failed` although the chain is intact (sealed hash mismatch); a **consistent forgery** (call re-pointed at another visitor, whole chain re-hashed) → chain valid but **decision replay fails** → `failed`; with a signed checkpoint, a consistent re-hash → `root_hash mismatch` → `failed`.
- **Cross-app signature compatibility:** fixed HMAC test vector `6e553bfb…a8f3` asserted in API and worker.

### `checkpoints.db.test.ts` (worker, real PostgreSQL)

Signs a verified range whose root PostgreSQL recomputes without application code; idempotent, then
extends contiguously; defers small recent ranges, checkpoints once old enough or closed; two workers
at once write exactly one checkpoint; checkpoints and alerts refuse UPDATE/DELETE/TRUNCATE (and
TRUNCATE is refused on `queue_events`, `service_policy_versions`, `priority_overrides`). Isolated DB:
a modified event → no checkpoint, an append-only alert at the right sequence, session stays blocked;
a deleted event and a rewritten checkpoint are detected; a consistent forgery is caught by the
signed checkpoint.

### `e2e/fairness.spec.ts` (real API + PostgreSQL + built web app)

Each `@responsive` journey runs at 1280, 1440, 375 and 320 px with axe (WCAG 2.0/2.1 A/AA) and a
no-horizontal-overflow check at the key states:

1. **Supervisor priority override (Journey D):** supervisor opens "Supervisor actions" for G003, picks class, reason and explanation (disabled below 5 characters), sees an explicit confirmation naming what will be recorded, confirms; list becomes G003, G001, G002 with a text "Priority" badge; "Call next" calls G003. A counter operator sees no override control, and a direct API attempt returns 403 with the order unchanged.
2. **Routing when counters close (Journey E):** operator calls G001, cannot close (hint: supervisor only), sends G001 to Counter 2; supervisor at Counter 2 closes it → G001 back at the front; "Call next" disabled at the closed counter; operator closes idle Counter 1 → "No counter is open" warning; reopening and calling calls G001 first (waiting age kept).
3. **Audit trail:** auditor follows the console link, sees the override row with explanation, classes and actor; "Verify integrity" → `verified`, result focused; export link present and the export is redacted; a counter operator gets no link and a clear refusal on the page.
4. **Policy versions (1280 px):** editing enables a class and transfer placement → "Policy v2" and the new wording; saving again keeps v2; history lists v2 then v1; axe clean.

## Manual acceptance (local)

Setup: follow `docs/local-environment.md` (secrets via `pnpm env:generate`, `set -a; source .env;
set +a` in every terminal, `pnpm build`, `pnpm env:check` → `READY`, identity-guarded
`pnpm db:migrate`, checkpoints with `node apps/worker/dist/worker.js --once`).

Prepared on this machine (2026-11-10): `.env` validated by both parsers (API and worker load the
same audit key id and fingerprint); dev database `queuebridge` identified, backed up, migrated to
0006 (`adopted`); one worker pass checkpointed 8 sessions with 0 alerts. A separate organization
**`m4-acceptance`** ("M4 Clinic", service "General Consultation", Counter 1 and Counter 2) was
created through sign-up and invitations, with one account each for `org_admin`, `staff_counter`,
`supervisor` and `auditor` — credentials are in `~/.config/queuebridge/m4-test-accounts.txt`
(mode 600, outside the repository; never shown). Use the org admin for steps 1 and 5, the
supervisor for 2–4, the counter operator for the refusals in 2 and 4, and the auditor for 6.

1. **Policy:** as facility admin, Administration → facility → Services → "Edit policy": enable "priority", choose "Keep their original waiting time", save. Expect "Policy v2" and the new description; save unchanged → still v2; "Policy history" lists v2, v1.
2. **Override:** open today's queue, issue three walk-ins. As a supervisor, "Supervisor actions for G003" → class Priority, reason, explanation → "Change priority" → read the confirmation → confirm. Expect G003 first with a "▲ Priority" badge. Sign in as a counter operator: no "Supervisor actions" buttons.
3. **Call out of order:** as supervisor with a free, open counter selected, open another ticket's supervisor actions → "Call out of order" with reason and explanation. Expect that ticket at your counter.
4. **Counter closure:** with a visitor CALLED at Counter 1, as a counter operator the close button is disabled with the supervisor hint; as a supervisor close it (reason "Break") → the visitor returns to the front, "Call next" is disabled at that counter; close every counter → "No counter is open for this service" warning; reopen.
5. **Counter transfer:** with two open counters, call a visitor, use "Send to another counter".
6. **Audit:** as an auditor, open the queue console → "Audit trail and integrity check". Check the override rows (reason text, classes, actor); "Verify integrity" → "Verified". Download the export and confirm it contains no names or explanation text. With the worker running long enough, the result shows signed checkpoints valid; stop the API, unset its `AUDIT_SIGNING_KEY`, restart, verify again → **"Incomplete — … NOT a successful audit"**.
7. **Tamper (disposable DB only — never on real data):** in `psql`, `ALTER TABLE queue_events DISABLE TRIGGER queue_events_append_only; UPDATE queue_events SET payload = jsonb_set(payload,'{public_code}','"X"') WHERE queue_session_id = '<id>' AND sequence = 2; ALTER TABLE queue_events ENABLE TRIGGER queue_events_append_only;` then "Verify integrity" → "Failed", "Hash chain: broken at event 2".

## Manual test 12 — offline coordinator fencing (procedure; PASSED, see "Manual acceptance result")

Accounts: `m4-supervisor` (browser A), `m4-counter` (browser B, a separate browser profile),
`m4-admin` (browser C). Environment loaded per `docs/local-environment.md`; API and web running.

1. B (counter operator): open today's General Consultation console once ONLINE (registers the
   device). A: walk-in ×2 (G00a, G00b). B: select Counter 1, **Call next** → G00a called ONLINE.
2. A: Staff console → facility → **Connectivity and recovery** → **Make coordinator** for B's
   device. Expect on B: "This device is the offline coordinator…"; on A: Call next is paused
   ("A coordinator device … holds authority").
3. Fencing checks (A and C), each must be REFUSED with "Offline coordinator active" and change
   nothing:
   a. A: **Supervisor actions for G00b → Change priority** → 409 coordinator-active.
   b. A: **Call out of order** for G00b → 409.
   c. A: Counter 1 → **Close Counter 1** (reason Break) → refused: "An offline coordinator holds
   … End its authority before releasing G00a".
   d. C: Administration → Counters → **Deactivate Counter 1** → the same refusal shown under
   Counter 1 (new in this fix; previously this path bypassed fencing).
   e. Deactivating an idle counter (Counter 2) is still allowed.
4. Offline: B DevTools → Network → **Offline**. B: Start serving / Complete G00a, Call next →
   G00b — each shows **Local**; the display board and visitor pages do not change.
5. A: **End authority** (Connectivity) and then call G00b online from Counter 2.
6. B: back **Online**. Expect B's offline Call of G00b → **Needs review** with a reason (stale
   epoch); nothing from B overwrites the online call. A: resolve it in the dashboard (dismiss).
7. Evidence to record: screenshots of 3a–3d and 6; then
   `psql "$DATABASE_URL" -c "SELECT event_type, payload->>'public_code' FROM queue_events WHERE queue_session_id = '<queue id>' ORDER BY sequence"`
   — no release/override/call event between the coordinator assignment and its end, other than
   the coordinator's own synced actions; Audit trail → **Verify integrity** → Verified.

## Manual test 15 — private data redacted from audit exports (procedure; PASSED, see "Manual acceptance result")

1. As `m4-supervisor`, override a waiting ticket's priority with the explanation
   `REDACTION-CHECK wheelchair user` (any distinctive text; it is private by design).
2. Issue a walk-in and keep its status link (QR → "Show status link"); note the token after `#t=`.
3. As `m4-auditor`: Audit trail → the override row shows the explanation and "M4 Supervisor"
   (authenticated view). **Download redacted export** (saves `queue-<id>-audit.json`).
4. Check the file (no secret is printed — these commands print counts / true-false only):
   ```bash
   F=~/Downloads/queue-<id>-audit.json
   grep -c 'REDACTION-CHECK' "$F"                     # expect 0 (free text never exported)
   grep -c 'M4 Supervisor\|M4 Counter\|M4 Org Admin' "$F"  # expect 0 (no names)
   grep -c '@acceptance.local' "$F"                   # expect 0 (no e-mail addresses)
   read -s TOKEN; grep -c "$TOKEN" "$F"; unset TOKEN   # paste the status token: expect 0
   node -e 'const j=require(process.argv[1]);console.log("redacted:",j.redacted)' "$F"   # true
   printf %s 'REDACTION-CHECK wheelchair user' | shasum -a 256   # this hash IS in the export:
   grep -c "$(printf %s 'REDACTION-CHECK wheelchair user' | shasum -a 256 | cut -d' ' -f1)" "$F"  # expect ≥ 1
   ```
5. Also open the public display board and the visitor status page: the explanation and staff
   names never appear there.
6. Limitation: visitors' phone numbers are not collected before M6 (SMS), so phone-number
   redaction cannot be exercised yet.

## Not covered here (by design or milestone)

- Strict priority between classes: lower classes can wait without bound while higher-class tickets keep arriving. Documented policy limitation (ADR-012); no aging or interleaving exists, so there is nothing to test for it.

- Group 8 recovery-credential rate limiting and expired credentials → M5; webhook signature and replay → M6.
- Chromium only (no Firefox/WebKit runs).
- No Codex/human review and no GitHub CI run yet (nothing pushed).
