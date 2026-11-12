# M4 Completion Report — Fairness, Overrides, Audit and Adaptive Routing (F3, F5, F8)

**Date:** 2026-11-08  
**Branch:** `feature/m4-fairness-routing-audit` (from `staging` @ `f880abb`, which contains M0–M3 via PRs #1–#5)  
**Status:** IMPLEMENTED — all local gates pass (exact results in `docs/testing/M4-evidence.md`).
**Committed and pushed; PR #6 → `staging` open, all CI green, Codex: no major issues. Not merged** (merge needs human authorization).

## Completed scope

### M4.1 Fairness and priority (F3)

- **Server-managed policy versions.** New append-only `service_policy_versions`; the server assigns
  `v1`, `v2`, … (client labels ignored; no-op edits create nothing). A change appends an audit-only
  `policy.changed` event to the service's sessions for the day. History endpoint
  `GET /facilities/:id/services/:sid/policy-versions`; editor and history in Administration → Services.
- **Configurable per service:** enabled classes (`priority_order`), the reason codes a supervisor
  may cite (`override_reasons`), and `transfer_placement` (`by_original_join_time` | `end_of_queue`).
- **Deterministic ordering**, enforced server-side: `priority_class > wait_since > issued_sequence > id`
  (new `tickets.wait_since`, taken under the session lock). Classes the policy does not enable rank
  last. The same comparator drives the API, decision replay and the offline projection.
- **Supervisor priority override** `POST /tickets/:id/priority-override`: supervisor / facility admin
  (org admin implied) only; target class must be enabled; reason code must be configured;
  explanation ≥ 5 characters. Recorded: actor, ticket, original and resulting class, reason code,
  explanation (access-controlled table; SHA-256 sealed in the event), policy version, timestamp,
  operation id. DB check constraints refuse incomplete rows. Ordinary staff → 403 **and** an
  append-only `*.denied` admin event.

### M4.2 Adaptive routing (F5)

- **Eligibility:** only active, **open**, capable, free counters can take a call (new
  `counters.availability`, separate from the admin `active` flag); `POST /counters/:id/availability`.
- **Counter becomes unavailable:** a CALLED visitor is released to the head of the line
  (`ticket.release`, waiting age kept) — supervisor only; closing while SERVING is refused; an idle
  counter may be closed by its operator; services left with no open counter are reported and the
  console shows a warning.
- **Transfers without losing waiting history:** service transfers keep the original join time and,
  per policy, the waiting age; new counter-to-counter transfer `ticket.counter_transfer`.
- **Routing override** ("call out of order", `POST /tickets/:id/call-out-of-order`): supervisor
  only, reason + explanation, records what the published rule would have called.
- **Explainable:** every call records `payload.routing` (rule, policy version, class order,
  candidates, selected keys, counter); `verifyRoutingDecisions` replays it against the cited snapshot.
- **No duplicate calls / unauthorized transfers:** lock order sessions → counter → tickets; role
  checks per transition; concurrency tests. **M3 fencing** applies to every new action.

### M4.3 Audit integrity (F8)

- Hash-chain primitives moved to `packages/domain/src/audit.ts` (shared by API and worker).
- **Worker checkpoint job:** HMAC-SHA256 over `session|from|to|root|head`; verifies the full chain and
  earlier checkpoints first; never signs a broken chain; raises append-only `audit_integrity_alerts`;
  disabled without a key (never unsigned).
- **Authorized, tenant-scoped, read-only** audit view, redacted export and verification
  (`GET /queues/:id/audit`, `/audit/export`, `/audit/verify`) for auditor, supervisor, facility admin.
- **Verification is `verified | failed | incomplete`**; failures and checks that could not run are
  stated plainly in the UI and never shown as success.
- **TRUNCATE** is now blocked on `queue_events`, `admin_events` and every M4 audit table.
- No secrets in audit events: override text only as a hash; no tokens, e-mails or phone numbers.

### UI (apps/web)

Priority badges (text + symbol), supervisor actions panel (change priority with confirmation step;
call out of order), counter open/close, counter-to-counter transfer, "no open counter" warning,
policy editor and history, audit trail page `/staff/queues/:queueId/audit` with integrity check and
export. Existing components and styles reused (two small CSS rules added; no redesign).

## Architectural decisions

Recorded in **ADR-012** (`docs/adr/ADR-012-fairness-policy-routing-audit-checkpoints.md`):

1. Policy versions are server-assigned and immutable (rejected: client labels — not replayable).
2. One total ordering key with `wait_since` (rejected: `joined_at` — can invert under concurrency).
3. Classes change only via supervisor override; overrides never set arbitrary positions.
4. Routing stays pull-based (rejected: push assignment — second source of truth, conflicts with M3).
5. Audit primitives in `domain`; **`apps/worker` may now import `domain`** — an additive package
   boundary change, reflected in `AGENTS.md` and `.kiro/steering/architecture.md`.
6. HMAC checkpoints (rejected for now: Ed25519 — key distribution and rotation not designed yet).
7. Three-valued verification; `incomplete` is never success.

Concurrency hardening while doing this: (a) a real defect — `lockCounter` computed busy/capable
from a snapshot taken before acquiring the lock (caught by the existing M2 concurrency test);
(b) `lockSessions` now locks the session row first and reads the policy in a separate statement,
so a policy committed while a command waited for the lock is the one applied and cited.

## Test results (exact; details in the evidence document)

- `pnpm test` (no DB): **385** passed (M3: 299).
- `pnpm test:db`: api **465** (25 files; M3: 395 / 21) + worker **13**; 2 consecutive runs on the final tree.
- Playwright: **127 passed**, 4 pre-existing opt-in capture tests skipped; `fairness.spec.ts` 13 and `counter-closure.spec.ts` 6 at 1280/1440/375/320 px with axe and overflow checks.
- format, lint (0 warnings), typecheck, build, DB-validation workflow emulation (incl. new TRUNCATE step), migrate ×2, seed ×2: all pass.
- `pnpm audit --audit-level high`: exit 0 (no high/critical; 2 low + 3 moderate pre-existing dev-tooling).

## Manual acceptance

Step-by-step instructions (policy edit, override, call out of order, counter closure, counter
transfer, audit view/verify/export, tamper on a disposable DB) are in
`docs/testing/M4-evidence.md` → "Manual acceptance".

## Changes to earlier artifacts

- `tasks.md`: status reflects merged M0–M3 (PRs #1–#5); M0 boxes checked (evidenced by
  `M0-completion.md` / PR #1); M1–M3 merge notes; M4 boxes checked with the test that evidences each,
  plus explicit M4 deferrals. M4 is marked implemented-not-merged.
- `design.md`: M4 audit implementation notes and the M4 route list.
- `AGENTS.md` / architecture steering: worker → domain boundary; ADR-012 row.
- `.env.example`: audit key commented out with instructions (the old placeholder could be used as a
  real key by copying the file); worker checkpoint thresholds.
- `db-validate.yml`: new step asserting TRUNCATE is refused on six append-only tables.
- API `AUDIT_SIGNING_KEY` now requires ≥ 32 characters (same as the worker).
- Dev seed: complete M4 policy fields and `v1` policy snapshots for seeded services;
  `recordPolicyChange` also snapshots the prior rules of any service that has no history.
- Test global setup takes an advisory lock before migrating (API and worker suites run in parallel).

## Remaining limitations and risks

- **HMAC checkpoints** need the key to verify signatures; an external party can recompute the chain
  and root hashes but not check signatures. An administrator holding both the database and the key
  can still rewrite history consistently — tamper-evident, not tamper-proof (ADR-010/012).
- **Key operations:** API and worker must share the same key id + key; rotation keeps old checkpoints
  `incomplete` on servers without the old key (by design, never "verified"). No rotation tooling yet.
- **Strict priority — possible starvation (accepted policy limitation, ADR-012).** Classes are served in
  strict rank order: a lower-class visitor is called only when no higher-class ticket is waiting,
  so a steady supply of higher-class tickets can delay a `normal` visitor without limit. This
  matches REQ-F3.1 / REQ-F5.2, and no specification requires aging, interleaving or a maximum
  wait. Mitigations today: every ticket starts `normal`; only a supervisor can raise a class, with
  a configured reason and explanation; every override is audited and summarized in the audit
  view; within a class, order is strictly first come, first served. Aging, interleaving (e.g. one
  `normal` call per k higher-class calls) or override caps would change the published ordering
  rule and therefore need a new policy field, a new `ORDERING_RULE` label (so earlier decisions
  still replay), visitor-facing wording and an ADR — deliberately NOT introduced in M4.
- **Pre-M4 call events** carry no routing explanation: counted as `not_replayable`, not verified.
- **Release on close requires a supervisor**; there is no automatic reassignment push (pull routing).
- **Offline:** the projection mirrors the new order and refuses closed counters, but a coordinator
  working from an older snapshot can still produce `needs_review` if the order changed online (by
  design — surfaced, never merged).
- **Local `.env`:** if it still holds the old `.env.example` placeholder for `AUDIT_SIGNING_KEY`
  (it meets the length rule), replace it with a random value before relying on checkpoints.
- **Not yet covered:** Group 8 recovery-credential rate limits (M5) and webhook signature/replay (M6);
  Chromium only; no GitHub CI or code review has run on this branch.

## Pre-acceptance hardening (audit signing key and worker safety)

- Shared `AuditSigningKeySchema` (contracts) used by both the API and the worker: ≥ 32 characters,
  known placeholders and low-variety values refused, id and key required together, key required
  when `NODE_ENV=production`. Invalid configuration stops the process at startup; messages name the
  variable, never the value (tested).
- Both processes log `audit_key_id` and a 64-bit HMAC fingerprint of the key at startup (fixed test
  vector asserted in both suites) so an operator can confirm they hold the same key without seeing it.
- The worker refuses (exit 1, writes nothing) any database that is not a migrated QueueBridge
  database with migration 0006 (tested against a foreign schema and a pre-0006 schema); `--once`
  runs a single pass for manual acceptance.
- Verified on a throwaway clone of the local `queuebridge` dev database (dropped afterwards; the dev
  database itself was not migrated or modified): guard refused the pre-0006 clone; after migrating
  the clone, 8 sessions were checkpointed, 0 integrity alerts, a second run wrote nothing, and the
  API verification with the same key reported all 8 `verified` (`incomplete` without the key).

## Manual-acceptance preparation (migration safety and local environment)

- **Migration identity guard** (`infra/scripts/db-identity.js`, used by `migrate.js`, `seed.js`,
  `reset.js` and the test setup): the target is inspected before any change; only an empty
  database or an identified QueueBridge database (marker `_queuebridge_identity`, or a pre-marker
  history that is a consistent prefix of this checkout with all sentinel tables/columns present)
  is changed. Foreign, unidentified or inconsistent databases are refused unchanged and never
  repaired; identity does not depend on host, port or name. Each migration commits atomically
  with its history row under an advisory lock. `pnpm db:check` reports status read-only.
  Tests: `apps/api/src/migrate-guard.db.test.ts` (14: empty init + idempotence + seed, legacy
  0005 → 0006 adoption, 5 foreign shapes refused by migrate/seed/reset with an unchanged schema
  snapshot, 5 inconsistent histories refused, concurrent runners).
- **Local environment:** `pnpm env:generate` / `pnpm env:check` (`infra/scripts/local-env.js`) —
  values never printed; check validates with the real API and worker parsers and compares the
  audit key fingerprints computed by each app. Guide: `docs/local-environment.md`. `AGENTS.md`
  dotenv statement corrected; `.env.example`, README and the Playwright fallback use port 55433.
- **State on this machine:** `.env` READY (existing valid `SESSION_SECRET` / `CONTACT_ENCRYPTION_KEY`
  kept; the audit key pair was only present commented out, so a fresh key + id were generated;
  `DATABASE_URL` port corrected to 55433). Dev database backed up to `~/queuebridge-backups/`
  (mode 600), identified, migrated to 0006 (`adopted`), 8 sessions checkpointed, 0 alerts.
  Acceptance organization `m4-acceptance` created via sign-up and invitations with one
  org admin, counter operator, supervisor and auditor (credentials in
  `~/.config/queuebridge/m4-test-accounts.txt`, mode 600, outside the repository).

## Manual-acceptance defects (2026-11-10)

Manual acceptance found two blocking defects; both are fixed server-side with regression tests
(details, timeline and evidence: `docs/testing/M4-evidence.md` → "Manual-acceptance defects").

1. **A serving counter could be taken out of service** and 2. **a called visitor was not
   requeued and could still be served at the deactivated counter.** Root cause: the admin
   Activate/Deactivate switch (`PATCH /facilities/:id/counters/:id`, from M1) was a second,
   unguarded out-of-service path — it locked only the counter, ignored the counter's tickets and
   produced no queue event — and starting service never re-checked the ticket's counter. The M4
   close control was correct. Fix: both paths share one locked procedure (sessions → counter →
   tickets): serving → 409, called → atomic, audited `ticket.release`; `ticket.serve` requires an
   active, open counter; consoles are signalled; the admin page shows refusals in place.

- Regression: `counter-closure.db.test.ts` 16 tests — **8 failed on the unfixed code**, all 16
  pass after; `counter-closure.spec.ts` 5 Playwright runs (written after the fix).
- Manual test 1: the org admin's policy change had in fact succeeded (v2, 21:25:10); the
  permission matrix is now tested (org/facility admin allowed; supervisor, counter, reception,
  auditor refused). Procedures for tests 12 (coordinator fencing) and 15 (export redaction) are
  in the evidence document.

## Manual acceptance — final result (reported by the human tester, 2026-11-12)

All **17** M4 manual acceptance scenarios passed, including the retests of both counter
defects and test 12 (offline coordinator fencing, all 8 checks: coordinator device listed,
designation, conflicting online Call next refused, out-of-order call refused, counter close
refused, administrative deactivation refused, authority ended by the supervisor, normal online
operations resumed) and test 15 (audit-export redaction). No manual failure remains.

Remaining risks from this round:

- The out-of-service invariant is enforced by application code under locks, not by a database
  constraint (it spans two tables); a direct SQL edit can still strand a ticket — such a ticket
  cannot be served there, and recall returns it to the queue.
- The close-vs-serve race test observed only "serve wins" for the operational close path in local
  runs (both orders are covered deterministically by sequential tests); the deactivation race
  observed both orders.
- The already-running local API (`pnpm dev:api`, started before the new `.env`) must be restarted
  with the environment loaded to get these fixes and the configured audit key.

## Final pre-commit review (2026-11-12)

Full diff reviewed against `staging` (`f880abb`), plus an independent behavioural review
(semantic reviewer: no blockers). Hygiene: no `.env`, backups, credential files, test results or
build output in the change set; no `.env` secret value appears in any committable file (302
files scanned); no debug code. The diff changes no M5, MQ, M6 or M7 section of the specs or docs.
Counter service state is written in exactly two places, both through the shared locked
procedure (`lockCounterScope` → `vacateCounter`): `POST /counters/:id/availability` and
`PATCH /facilities/:id/counters/:id`.

Review findings fixed (each with a regression test shown to FAIL without its fix):

| Finding                                                                                                                                                                    | Fix                                                                                       | Test                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A partial policy `PATCH` reset omitted fields to schema defaults (e.g. a service pinned to `end_of_queue` silently became `by_original_join_time`)                         | The sent fields are merged onto the CURRENT policy and the result is validated as a whole | `fairness.db.test.ts` "a partial policy update keeps every field it does not mention" |
| Verification compared only the override explanation's hash with the chain; a tampered reason code, actor, class, ticket, counter or policy version still showed `verified` | Every field of the override record is compared with the sealed event                      | `audit.db.test.ts` "every other field of an override record is cross-checked too"     |
| One session failing in the checkpoint job aborted the run and starved later sessions                                                                                       | Per-session isolation; failures are reported and logged, nothing is signed for them       | `checkpoints.db.test.ts` "one session failing … never starves the sessions after it"  |
| `local-env generate --rotate` also rotated `CONTACT_ENCRYPTION_KEY` (would orphan encrypted contacts)                                                                      | Needs its own `--rotate-contact-key` flag                                                 | `local-env.test.ts`                                                                   |

Also: `reset.js` holds the migration lock between the identity check and `DROP SCHEMA`; the CI
TRUNCATE check now requires the append-only error (not just any failure); the audit view and
export are rate-limited; the documented meaning of `verified` now matches the code (no check
failed and every possible check was made; events after the last checkpoint and pre-M4 calls are
reported as counts).

Remaining risks and accepted limitations:

- Override explanations (`priority_overrides.reason_text`) are append-only and visible to every
  audit-view role, with no retention or erasure path yet. Staff should not type personal or
  medical details there. A redaction mechanism that preserves the chain belongs to the
  retention work before production onboarding (security steering).
- The redacted export carries the SHA-256 of each explanation. A short, guessable explanation can
  be confirmed by a dictionary attack (salting would need a chain change → future ADR).
- Removing a counter's service capability while that counter is calling or serving a visitor of
  that service is not refused (outside the out-of-service invariant; follow-up).
- The migration guard treats a database with pre-installed extensions as foreign (fail-closed).
  A managed PostgreSQL that pre-installs extensions would need an explicit allow-list.
- `audit_checkpoints.organization_id` is nullable in 0006 (always written by the worker). Make it
  NOT NULL in a later migration, since applied migrations are not edited.
- Strict priority can starve lower classes (ADR-012). HMAC checkpoints need the key to verify
  signatures. The out-of-service invariant is enforced in code under locks, not by a database
  constraint.

## GitHub — PR #6 and CI

PR: https://github.com/Ajayfrizzy/queuebridge/pull/6 (`feature/m4-fairness-routing-audit` → `staging`).

First CI round on `3c46343`: every job passed in the push-triggered run, including real
PostgreSQL and Playwright. In the pull-request run, the "Tests with PostgreSQL" job failed two
Playwright tests from earlier milestones; neither touches M4 code.

1. `e2e/offline.spec.ts` "on a shared device, one person's unsent actions are never sent under
   another person's sign-in" (M3). **Test defect, now fixed.** It recorded every sync request
   from the moment of reconnect. In that window the still-loaded page of person A can flush A's
   own action with no session at all (A's cookie was cleared), and the request is cut off by the
   reload. Diagnosis over 15 local runs: the failing runs showed A's operation only in requests
   without a session cookie and without a response; it never appeared under B's session. The
   test now asserts the actual property, and asserts more: B's flush happened under B's session;
   A's action never left under any session; the server never accepted a request carrying it.
   Mutation check: removing the owner filter in `flushOutbox` makes the test fail. Stress: 25/25
   under 6 workers (previously 4 failures in 15).
2. `e2e/security-isolation.spec.ts` "sign out ends the server session; the back button does not
   resurrect data" (M1). **Not reproduced.** After Sign out and Back, the URL stayed `/admin`
   for 10 s. It passed in the push run on the same commit, 15/15 under local stress and in two
   full local runs. The code paths involved (`auth.tsx`, `Layout.tsx`, `RequireAuth.tsx`) are
   unchanged by M4. Recorded as an intermittent CI failure to investigate if it recurs; no code
   was changed for it and the test was not weakened.

### Codex review of `3c46343` (2 findings, both P2, both valid, both fixed)

| Finding                                                                                                                                                                                               | Fix                                                                                                                                                                                                                                                                                                      | Regression evidence                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verifyAudit` read the session head, events, checkpoints and alerts in separate snapshots, so a command or checkpoint committing in between made a healthy queue report `failed` (a false failure)    | All verification reads run in ONE `REPEATABLE READ READ ONLY` transaction                                                                                                                                                                                                                                | `audit.db.test.ts` "verifying while commands and checkpoints commit never reports a healthy queue as failed": **reproduced on the unfixed code** (false `failed`, "records 8 events but 9 are present", 2 of 3 runs); passes 5/5 after |
| M4 forms renewed their `operation_id` only on success, so after a definitive refusal (e.g. `counter_busy`) a retry or changed command resubmitted the refused id and only replayed the stored refusal | `OperationIdTracker` (`apps/web/src/lib/operationIds.ts`): the same id only to retry the SAME command after an unknown outcome (no response, 429, 5xx); a new id after a commit, a definitive refusal, or a changed command. Used by the priority-override, call-out-of-order and counter-transfer forms | Unit `operationIds.test.ts` (5); Playwright `counter-closure.spec.ts` "a counter transfer refused because the target became busy succeeds when retried after it is free": **fails with the old renewal rule**, passes after            |

### Codex re-review of `14de6d1` (1 new finding, P2, valid, fixed)

| Finding                                                                                                                        | Fix                                                                                                                                                                                                                                                                               | Regression evidence                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The audit export loaded at most 50,000 events and returned an apparently complete file for larger sessions (silent truncation) | All or nothing: a session above `AUDIT_EXPORT_MAX_EVENTS` (default 50,000) is refused with `413 audit-export-too-large`, pointing to the paginated audit view; every export carries `last_sequence`, `event_count` and `head_hash` (one snapshot), so completeness can be checked | `audit.db.test.ts` "a session larger than the export limit is refused (413), never returned truncated" (fails on the truncating behaviour: 200) and "an export within the limit is complete and says so" |

Local observation (not seen in CI): `e2e/offline.spec.ts` "a browser that cannot store offline
data says so and refuses to pretend" (M3) failed once in seven full local runs. It then passed
20/20 under stress and in the next full run. Most likely a test race: it clicks immediately after
going offline, before the app registers the loss of connectivity. Not changed; recorded as a
follow-up.

## Final routing invariant: capability removal (2026-11-12, commit `5bd18d5`)

**Defect.** An administrator could remove a service capability from a counter (Administration →
Counters, `DELETE /counter_service_capabilities/:counterId/:serviceId`) while that counter was
calling or serving a visitor of that service. The route deleted the row with no locks and no check,
so a counter could hold a called/serving ticket of a service it no longer served, and the console
and routing rules disagreed about it.

**Fix.** `removeCounterCapability` (`apps/api/src/queue/counters.ts`) runs inside the route's
transaction under the same procedure as closing or deactivating a counter: `lockCounterScope`
(queue sessions in id order, THEN the counter `FOR UPDATE`). After the locks, a fresh statement
looks for a called/serving ticket at the counter whose session belongs to the removed service.
If one exists the route answers **409** and nothing changes; otherwise the row is deleted, the
admin event is recorded and today's consoles are signalled. Call Next, Start Serving and every
other queue command already lock the session, then the counter, then read the capability, so they
serialize with the removal: either the call/serve commits first (removal refused) or the removal
commits first (the call is rejected `counter_not_capable`).

- Only the affected service blocks: tickets of other services at the same counter do not.
- A missing capability is still 404; permission checks (403) still come first.
- UI: the refusal is shown in the counter's own alert (it was only announced before) and the
  checkbox returns to the server state.
- Not changed: coordinator fencing, routing, fairness, the audit chain, migrations, other modules.

**Evidence.**

- `apps/api/src/capability-removal.db.test.ts`: 13 tests on real PostgreSQL. Run against the
  unfixed route: **7 failed**, 6 passed; with the fix: 13 pass. It covers called and serving
  refusals with exact before/after state (capability, counter flags, ticket row incl. version,
  queue revision, event log, admin events), other-service tickets, 403-before-409, 404, races
  against Call Next, Start Serving and Complete (12 rounds each, invariant and event-log checked),
  two racing removals, and a coordinator-held queue (epoch and device unchanged).
- `apps/web/e2e/counter-closure.spec.ts`: new `@responsive` journey (called then serving refusal
  with visible alert, unchanged server state, success after completion), run at 1280, 1440, 375 and
  320 px with axe and overflow checks.
- Full local gates on the fix: format check, ESLint `--max-warnings 0`, typecheck, build clean;
  `pnpm test` 385 passed; `pnpm test:db` api 26 files / **478** tests + worker 13; Playwright
  **130 passed**, 4 opt-in skips, 1 failure (below).
- Pre-existing, unrelated Playwright failure seen locally: `review-fixes.spec.ts` "the notice can
  be dismissed without signing out" (M1). The aborted logout request also raises the "You are
  offline" toast, so `getByRole('button', { name: 'Dismiss' })` matches two buttons (strict mode).
  It fails the same way with this change stashed and passed in CI. Not changed here (unrelated
  module); recorded as a follow-up (use `exact: true`).

- **CI on `5bd18d5`**, push and pull-request runs, 11/11 jobs passed (including Tests with PostgreSQL with Playwright and the migration validation).

**Remaining risk.** While an offline coordinator holds the queue, an action the coordinator took
offline is invisible to the server until it syncs. Removal checks only server-known tickets, like
deactivation. A coordinator call made offline for a service removed meanwhile is rejected at sync
(`counter_not_capable`) and held for review, never applied.

## Final state (2026-11-12)

- **PR:** https://github.com/Ajayfrizzy/queuebridge/pull/6 — `feature/m4-fairness-routing-audit` → `staging`; **not merged**.
- **Commits:** `3c46343` (M4), `14de6d1` (review and CI fixes), `014389d` (audit export all or nothing), then `5bd18d5` (capability removal invariant), then the report update.
- **CI on `014389d`**, push and pull-request runs, 11/11 jobs passed: Lint and typecheck (format check, ESLint `--max-warnings 0`, typecheck); Tests without DB (contracts 102, domain 98, channels 18, continuity 64, ui 6, worker 10, api 53, web 34); Build; **Tests with PostgreSQL** (api 465 in 25 files, worker 13; Playwright 127 passed, 4 opt-in capture skips); **Apply migrations and validate constraints** (fresh migrate, idempotent re-run, UPDATE/DELETE/TRUNCATE on 6 append-only tables refused by the guard, both unique constraints: 10 OK checks); **Security audit** (`--audit-level high` passes; 2 low and 3 moderate, pre-existing dev tooling).
- **Codex:** 2 × P2 on `3c46343` and 1 × P2 on `14de6d1`, all valid and all fixed with regression tests that fail without the fix. Review of `014389d`: "Didn't find any major issues."
- **Manual acceptance:** 17/17 scenarios passed (human tester).
