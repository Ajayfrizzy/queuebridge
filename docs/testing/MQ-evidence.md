# MQ — Ask Que Anything (F13): Implementation and Test Evidence

## MQ.1 Contracts and deterministic core (2026-11-17)

**Branch:** `feature/mq1-contracts-deterministic-core`, from `staging` at `2401735` (PR #9 merged).
**Scope:** MQ.1 only (tasks.md). No KB content (MQ.5), no KB delivery or offline cache (MQ.2), no
UI (MQ.3), no AI layer (MQ.4). No new dependency beyond the new workspace package; no migration;
no provider, account or spending.

### What was built

| Task                                                      | Where                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/assist` and boundary tables                     | `packages/assist/` (imports `@queuebridge/contracts` only); `AGENTS.md` §2; architecture steering |
| `KbArticle`, `CapabilityManifest`, `RouteId`, `QueAnswer` | `packages/contracts/src/que.ts`                                                                   |
| Shared permission map                                     | `packages/contracts/src/permissions.ts`; `apps/api/src/auth/rbac.ts` re-exports it                |
| Route/screen registry                                     | `packages/assist/src/registry.ts`                                                                 |
| Deterministic search and answer builder                   | `packages/assist/src/{search,answer,links,capabilities,audiences,operations}.ts`                  |
| Capability manifest and endpoint                          | `apps/api/src/que/capabilities.ts`, `apps/api/src/routes/que.ts` (`GET /api/v1/que/capabilities`) |

**Contracts.** All Que schemas are strict. `SafeMarkdown` allows headings, lists and emphasis,
and links only of the form `[text](route:<RouteId>)` to a registered RouteId; it rejects raw
HTML, images, code blocks, URLs (`http(s)`, `javascript:`, `data:`, `mailto:` …), relative paths
and reference links. `RouteId` lists the 16 screens of design §11.3.1; `/supervisor/*` is absent.

**D1 capability availability.** Four statuses unchanged; separate `availability`
(`available`/`unavailable`) with `unavailableReason` (`not_implemented`, `not_configured`,
`switched_off`), enforced by the schema (reason required when unavailable, forbidden when
available; `planned` is always `unavailable`/`not_implemented`). The manifest is exhaustive over
the 16 capability ids of design §11.10a. `isCapabilityUsable` is true only for `live` +
`available` and fails closed on any missing, unknown or malformed value.

**Server manifest.** Built from booleans only (`VISITOR_JOIN_OPERATIONAL`, `webPushAvailable`).
`webPushAvailable` was extracted unchanged from `routes/push.ts` and is now the single check behind
both `GET /push/capability` and the manifest's `turn_alert_web_push` entry. SMS, USSD and AI
explanations are `planned`. The endpoint is public, rate-limited with the public-read limit, reads
no database table, returns the same body regardless of cookies, headers or query, and contains no
environment value. Caching follows the API-wide `no-store` header; offline copies are MQ.2.

**D3 permission synchronization.** `Permission` moved to contracts byte-for-byte; `rbac.ts`
re-exports the same object and `requireFacilityPermission` is unchanged. Que's helpers
(`holdsPermission`, `queueActorRolesAt`) mirror the API and are verified against it exhaustively.
Ticket operations are identified by their transition (`action`, `from`); their roles are resolved
from the domain table passed in (`operationRoles(op, TRANSITION_RULES)`), because `assist` may not
import `domain`. The web hint lists are checked, not rewired.

**D2 / D4.** D2 (server-issued role fingerprint) belongs to restricted KB delivery (MQ.2) and is
not implemented in MQ.1. D4 is exercised with fixtures: anonymous answers never cite the staff
verification article or its content.

### Consistency checks (decision D3)

| Check                           | Test                                                                                                                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 API permissions               | `contracts/permissions.test.ts` (matrix snapshot); `api/que-consistency.test.ts` (same object; every permission literal in `routes/*.ts` is a known name and every name is used)                                                                                        |
| 2 Que route access              | `assist/registry.test.ts` (per-role matrix of §11.3.1); `web/lib/queConsistency.test.ts` (every registered path exists in `App.tsx`; every router path is registered or explicitly unregistered)                                                                        |
| 3 Frontend role assumptions     | `web/lib/queConsistency.test.ts`: `QUEUE_MANAGER_ROLES` = `QUEUE_MANAGE`, `WALK_IN_ROLES` = `WALK_IN`, `COUNTER_ROLES` = call-next transition roles, console `AUDIT_ROLES` = `AUDIT_VIEW`, staff-home connectivity link = `OPERATIONS_VIEW`                             |
| 4 State-machine operation roles | `api/que-consistency.test.ts`: every console operation exists in `TRANSITION_RULES`; the named roles equal what `transition()` allows for every role; `canPerformOperation` ⇔ API `queueActorRoles` + `transition()` for every role set                                 |
| 5 Cross-facility authorization  | `assist/registry.test.ts` (roles at A get no facility screen of B); `api/que-consistency.test.ts` (`holdsPermission` ⇔ `requireFacilityPermission` for 96 role sets × 8 permissions; a facility outside the organization is 404 for the API and never permitted to Que) |

### Other behaviour verified

- **Deterministic ranking:** identical results across repeated calls and reversed input order;
  title outranks keyword; screen boost reorders an exact tie (`approver` on console vs audit);
  long queries truncated.
- **Fallback:** no match → the screen's default articles the user may read, plus "ask staff";
  empty query → help for this screen; unknown screen and no match → "ask staff" only.
- **Role-aware filtering:** visitors never receive staff articles; recovery activity only for
  supervisor, facility admin, auditor (and org admin); auditors never get staff-assisted steps;
  org admin gets every staff audience; a forbidden related screen is named with its required
  roles and never linked (REQ-F13.1.3).
- **Capability gating:** Web Push not configured → push article never cited, "not set up here"
  plus the reliable fallback; planned SMS/USSD → "not available yet"; sandbox → labelled test
  only; malformed manifest → only capability-free articles remain.
- **Exhaustive authority check:** 9 role sets × 3 facility contexts × 2 manifests × 17 screen
  contexts × 7 queries (6,426 answers): every answer is strict-schema valid, deterministic mode,
  every link permitted, every citation readable and not capability-blocked.
- **Safe links:** paths built only from validated context ids/slugs, URI-encoded, never with a
  query, fragment or `..`; the ticket and invitation pages are never linked.
- **Read-only:** `POST`/`PUT`/`PATCH`/`DELETE /que/capabilities` are not routed (404 with valid
  CSRF headers); `/que/kb`, `/que/kb/public` and `/que/ask` do not exist yet; the manifest works
  with an unreachable database; answering does not mutate its inputs; `assist` sources contain no
  network, storage, process, randomness or clock access (static boundary test).

### Mutation checks (each made a test fail, then reverted)

| Mutation                                                           | Failing tests |
| ------------------------------------------------------------------ | ------------- |
| `holdsPermission` ignores the facility                             | 5 (assist)    |
| Capability gate never blocks                                       | 3 (assist)    |
| Audience filter removed                                            | 5 (assist)    |
| Route permission replaced by "signed in"                           | 16 (assist)   |
| `org_admin` audiences reduced to facility admin                    | 1 (assist)    |
| Screen boost removed                                               | 1 (assist)    |
| Links not filtered by permission                                   | 2 (assist)    |
| `holdsPermission` without the org-admin rule                       | 1 (api D3)    |
| `operationRoles` without org admin                                 | 1 (api D3)    |
| `queueActorRolesAt` without facility-admin authority for org admin | 1 (api D3)    |
| Manifest reports Web Push available regardless of configuration    | 3 (api)       |
| Manifest reports AI explanations available                         | 1 (api)       |

Two guards were found redundant by mutation: `linkable` on credential screens (already never
permitted) is kept as defence in depth; a duplicate system-actor filter in `operationRoles` was
removed (the final role filter already drops system actors).

### Gate results (local, 2026-11-17)

| Gate                                  | Result                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                   | pass                                                                                                     |
| `pnpm lint`                           | pass (0 errors, 0 warnings)                                                                              |
| `pnpm typecheck`                      | pass                                                                                                     |
| `pnpm build`                          | pass                                                                                                     |
| `pnpm test`                           | pass: contracts 176, channels 33, ui 6, assist 80, domain 109, continuity 64, api 82, worker 12, web 104 |
| `pnpm test:db` (PostgreSQL)           | pass: api 608 (33 files), worker 63 (4 files)                                                            |
| Playwright (all 4 projects, Chromium) | 242 passed, 5 skipped (pre-existing conditional skips: visual capture ×4, Firefox print not installed)   |
| `pnpm db:check`                       | 9 applied, none pending (MQ.1 adds no migration)                                                         |
| `pnpm audit --audit-level high`       | no high or critical (1 low, 3 moderate, unchanged)                                                       |

New tests: contracts `que.test.ts` (55), `permissions.test.ts` (3); assist 80 across 5 files;
api `que-capabilities.test.ts` (17), `que-consistency.test.ts` (9); web `queConsistency.test.ts`
(7). No existing assertion was changed.

### Deferred integration obligations (carried by later MQ tasks)

| Obligation                                                                                                                                                                                                                                                                                                                                                                | Owner           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Author the default KB articles referenced by the registry (ids from design §11.10a) and enable the article-existence check (every registry default and every `relatedRoutes`/body link resolves) in the KB consistency test (Group 13.5)                                                                                                                                  | MQ.5, MQ.6      |
| Implement restricted KB delivery (`GET /api/v1/que/kb`, role-filtered) with the server-issued role fingerprint of design §11.5.4 (D2): one server-side calculation, issued with the restricted bundle; no new `/auth/me` field                                                                                                                                            | MQ.2            |
| Implement the offline caching rules (design §11.5–§11.5.3: public bundle and manifest precache, per-user restricted cache, elapsed-time expiry, invalidation triggers) with regression tests, including correcting the existing service-worker runtime rule that targets `/api/v1/facilities/.+/public` instead of `/api/v1/public/facilities/...` (readiness report F10) | MQ.2            |
| AI explanations stay disabled: `ask_que_ai` is `planned` / `unavailable` in the manifest; no inference adapter, provider, endpoint or credential exists                                                                                                                                                                                                                   | MQ.4 (optional) |

Unchanged by MQ.1 and to stay that way: `packages/assist` performs no external I/O (static
boundary test); every queue operation, transition rule and API permission is as before (the
permission matrix snapshot, the exhaustive API-equivalence tests and the full DB and browser
suites pass unchanged).

### Deviations and notes (no architectural change)

- **File name:** the registry is `packages/assist/src/registry.ts` (exported as
  `ROUTE_REGISTRY`, used consistently across the package and tests). Design §11.3 names
  `routes.ts` illustratively; the content is as specified and no architecture changes.
- **Default articles** reference the approved ids of design §11.10a, which are authored in MQ.5.
  The answer builder skips ids that are not in the bundle; the check that every default exists
  in the KB belongs with the KB consistency test (Group 13.5, MQ.5/MQ.6). Tests use clearly marked
  fixtures (`fixtures.testkit.ts`), not KB content.
- **Notices in `text`:** capability and role-requirement notices are plain sentences in
  `QueAnswer.text`; the schema of design §11.4 is unchanged.
- **Helpers in contracts:** `isCapabilityUsable` / `isCapabilityShowable` are pure functions in
  `contracts` so every consumer applies the same fail-closed rule (contracts already hosts pure
  helpers such as `recoveryPolicyOf`).
- **Advisory only:** Que's permission helpers cannot know whether a facility belongs to the
  session's organization; only the API can. They are never used for authorization.
