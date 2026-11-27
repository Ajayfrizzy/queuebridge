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

## MQ.2 Knowledge-base delivery and offline (2026-11-17)

**Branch:** `feature/mq2-kb-delivery-offline`, from `staging` at `1cb83f0` (PR #10 merged).
**Scope:** MQ.2 only. No Ask Que UI (MQ.3), no AI layer (MQ.4), no article inventory (MQ.5).
No migration, no new external dependency, no provider, no spending. `/auth/me` is unchanged.

### What was built

| Task                                           | Where                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Markdown → versioned per-audience bundles      | `packages/assist/src/kb-compile.ts` (pure), `scripts/build-kb.mjs` (runs in the package build), `knowledge/` |
| `GET /que/kb/public`, `GET /que/kb`            | `apps/api/src/routes/que.ts`, `apps/api/src/que/kb.ts`                                                       |
| Server-issued role fingerprint (D2)            | `apps/api/src/auth/role-digest.ts` (the only digest calculation)                                             |
| Precache and per-user cache                    | `apps/web/src/pwa/swRules.ts`, `vite.config.ts`; `apps/web/src/que/{store,publicKb}.ts`                      |
| Offline expiry, binding and invalidation       | `apps/web/src/que/{offlineHelp,helpClient}.ts`, wired in `apps/web/src/auth.tsx`                             |
| Tenant-sensitive content build check, D4 check | `kb-compile.ts` content checks and `privatePhrases`                                                          |
| Incremental update                             | `known=id:version` on `GET /que/kb`; `knowledge/kb.lock.json` version discipline                             |

**Initial delivery content (not the MQ.5 inventory).** Four articles prove delivery:
`visitor.recovery.how`, `visitor.recovery.staff` (public), `staff.recovery.assist` (reception,
counter, supervisor, facility admin; carries the D4 `privatePhrases`) and `staff.sync.states`
(all staff). `knowledge/README.md` marks them as initial content; MQ.5 reviews them with the
rest of the inventory.

**Compilation.** Front-matter is a strict subset (`key: value`, inline lists, integers). Every
article must pass `KbArticleSchema` (Safe Markdown, registered RouteIds, known capabilities),
sit in a folder that is one of its audiences, and be named after its id. The build fails on
emails, phone numbers, UUIDs, ticket codes, template placeholders and secret-like strings, and
when a public article contains a staff article's `privatePhrases` (D4). `privatePhrases` is
build-time only and never shipped. Every content change needs a higher article version and a
higher `kbVersion`; the normal build checks the committed `kb.lock.json` and fails if it is
stale; `pnpm --filter @queuebridge/assist kb:lock` rewrites it after the same checks.

**API.** `GET /que/kb/public` (public, rate-limited) returns the visitor bundle. `GET /que/kb`
(session required, rate-limited, strict query) computes audiences from the session's
server-loaded grants (`audiencesFor(auth.roles)`, the union over facilities per design §11.2),
returns only restricted articles (public ones ship in the public bundle), and adds `userId`,
`roleDigest`, `issuedAt`, `authorizedUntil = min(session end, now + QUE_OFFLINE_HELP_TTL_SECONDS)`
(default 12 h, max 12 h) and `validForMs`. Bundles are loaded and schema-checked at start-up; if
they cannot be loaded, the two KB endpoints answer 503 and the rest of the API is unaffected.

**Role fingerprint (D2).** SHA-256 over the domain separator `qb.que.role-digest.v1`, organization
ID, user ID, `AUDIENCE_MAPPING_VERSION` and the canonically sorted `(facility_id, role)` grants.
Only `apps/api/src/auth/role-digest.ts` computes it; a static test confirms no Ask Que browser
module hashes anything.

**Browser.**

- Public: the API copy (service-worker stale-while-revalidate) first, then the built-in copy (a
  hashed JSON asset in the install precache). Both are schema-checked.
- Restricted: IndexedDB database `queuebridge-que`, one record per user, replaced in one
  transaction. It is fetched after each confirmed session (sign-in, every successful
  `/auth/me`), incrementally with `known`. Restricted help is hidden while that revalidation is
  outstanding.
- Expiry (design §11.5.2): shown only while `0 <= elapsed < validForMs − 5 min`. A rollback
  beyond 2 minutes against the persisted high-water mark, a wall-clock/monotonic jump within the
  page, or time before receipt marks the record unverifiable until a fresh fetch. Missing or
  corrupt metadata counts as expired.
- Invalidation (design §11.5.3):
  - confirmed sign-out, any 401 (including `/auth/me` at start-up) and a response for another
    user delete all records;
  - a different user signing in deletes every other user's record;
  - a new fingerprint deletes the record before the new one is stored;
  - failed sign-out, an unreachable server and 5xx change nothing.
  - A purge bumps a generation counter, so a refresh in flight cannot write afterwards.
- Honest limit kept: the offline bound is best effort against wrong or reset clocks, not
  against a person in full control of the device; confidentiality rests on the content rule.

**Service-worker correction (readiness report F10).** The M2 rule
`/api/v1/facilities/.+/public` never matched a route. The corrected rule matches exactly
`/api/v1/public/facilities/<org>/<facility>` and never `/board` (live state) or `/stream` (SSE).
New rules cover `/api/v1/que/kb/public` and `/api/v1/que/capabilities`. No authenticated
response is cached by the service worker.

### Security and offline verification

| Area                                | Evidence                                                                                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anonymous vs authenticated          | DB: public endpoint open and identical for staff; `/que/kb` 401 for anonymous, forged, signed-out and deactivated sessions                                                                    |
| Role and audience restrictions      | DB: exact articles per role (auditor never gets `staff.recovery.assist`); org admin gets every staff audience; no public article in restricted responses                                      |
| Cross-organization / cross-facility | DB: fingerprints differ per user and organization; another organization's response holds none of org A's ids; no tenant names, emails, slugs or ids in any response                           |
| Cache separation                    | Browser: one record per user; a second person signing in on the same browser removes the first user's record; no restricted or auth response in Cache Storage                                 |
| Expiry and clock manipulation       | Unit: validity window and margin, device clock ahead/behind by years, rollback (sticky), small corrections, time before receipt, monotonic jump, corrupt metadata                             |
| Logout, revocation, deactivation    | Browser: sign-out deletes the record; role grant and revoke replace it under a new fingerprint (and back to the original one); deactivation (401) deletes it                                  |
| Reconnection after offline          | Browser: offline reload keeps the record untouched; reconnection re-verifies the session and refreshes it (new receipt time, same fingerprint)                                                |
| No sensitive data in cached bundles | Browser and DB: no email, organization/facility name, slug or id in the record or response; build check for data-like content                                                                 |
| Safe compilation and versions       | Unit: front-matter, schema, folder/id rules, data patterns, D4 phrases, stripped build-only keys, version and kbVersion discipline, stale and missing lock                                    |
| Read-only, no queue mutations       | DB: queue events, tickets, client operations, admin events, roles and users of the organization unchanged after repeated Que calls; non-GET methods are 404; browser: Ask Que issues GET only |
| Corrected service-worker rule       | Unit: real path cached, old path, board, stream, query, restricted KB, session, ticket status and recovery never; browser: facility details cached and served offline, board not cached       |
| Public precache                     | Browser: the built-in visitor bundle is in the precache, public-only, without the D4 phrases; the public endpoint is answered offline by the service worker                                   |

### Mutation checks (each made a test fail, then reverted)

| Mutation                                                                | Failing tests   |
| ----------------------------------------------------------------------- | --------------- |
| No clock-rollback check                                                 | 2 (web unit)    |
| No 5-minute safety margin                                               | 2 (web unit)    |
| `unverifiable` not sticky                                               | 2 (web unit)    |
| Monotonic jump ignored                                                  | 2 (web unit)    |
| Cached articles reused across fingerprints                              | 1 (web unit)    |
| High-water mark before receipt accepted                                 | 1 (web unit)    |
| 401 during refresh does not purge                                       | 1 (web unit)    |
| Restricted help shown while revalidation is pending                     | 1 (web unit)    |
| Other users' records kept at sign-in                                    | 1 (web unit)    |
| Old public-facility rule restored                                       | 2 (web unit)    |
| Public-KB rule widened to `/que/kb` (would cache the restricted bundle) | 3 (web unit)    |
| Audiences ignore the session (everyone treated as org admin)            | 6 (API DB)      |
| `authorizedUntil` not capped by the session                             | 1 (API DB)      |
| `known` ignored (no incremental update)                                 | 1 (API DB)      |
| Public articles included in restricted selection                        | 1 (assist unit) |
| Fingerprint ignores the facility of each grant                          | 1 (API unit)    |
| Fingerprint ignores the user                                            | 1 (API unit)    |
| D4 phrase check removed                                                 | 1 (assist unit) |
| Data-pattern checks removed                                             | 7 (assist unit) |
| Content change without version bump accepted                            | 1 (assist unit) |
| `privatePhrases` shipped in the output                                  | 4 (assist unit) |
| Article change without `kbVersion` bump accepted                        | 2 (assist unit) |
| No purge on confirmed sign-out (`auth.tsx`)                             | 1 (Playwright)  |
| No purge on `/auth/me` 401 at start-up (`auth.tsx`)                     | 1 (Playwright)  |

One guard survived: the generation check right after the first fetch in `QueHelpClient.refresh`
is redundant with the checks before every write, which the purge-during-refresh test covers. It
is kept as defence in depth.

### Gate results (local, 2026-11-17)

| Gate                             | Result                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`, `pnpm lint` | pass                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm typecheck`, `pnpm build`   | pass (the assist build compiles the KB in check mode)                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm test`                      | contracts 179, channels 33, ui 6, assist 118, domain 109, continuity 64, api 95, worker 12, web 159                                                                                                                                                                                                                                                                                                                         |
| `pnpm test:db`                   | api 635 (34 files), worker 63                                                                                                                                                                                                                                                                                                                                                                                               |
| Playwright (4 projects)          | 250 passed, 5 skipped (pre-existing conditional skips); the new spec also passed 3× repeated                                                                                                                                                                                                                                                                                                                                |
| `pnpm db:check`                  | 9 applied, none pending (no migration)                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm audit --audit-level high`  | **2 high, pre-existing:** `picomatch` ReDoS (GHSA-fc5q-39xc-vjpf), dev tooling only (`@typescript-eslint` via fast-glob/micromatch; vite/vitest via fdir/tinyglobby); no patched version listed; same result without the MQ.2 changes. Since 2026-11-17 handled by the approved temporary exception (see the security assessment): production audit clean; full audit passes only through the scoped gate; **not resolved** |

Visitor bundle: 183.87 kB → 185.72 kB gzip (+1.85 kB). The built-in public bundle is a separate
0.77 kB gzip asset.

New tests: contracts 3; assist 38 (`kb-compile.test.ts`); api 14 (`que-kb.test.ts`) and 27
(`que-kb.db.test.ts`); web 55 (`que/*.test.ts`, `pwa/swRules.test.ts`); Playwright 8
(`que-offline.spec.ts`). One MQ.1 assertion was updated because its premise changed: the KB
endpoints now exist (public 200, restricted 401 without a session); `/que/ask` still 404.

### Notes and deviations (no architectural change)

- **Network-first for facility details and the capability manifest.** Stale-while-revalidate
  would show stale facility details (for example "no queue open") or a stale "available" on
  the first online load. Network-first keeps online answers fresh and uses the cache only when
  the network fails. The public KB uses stale-while-revalidate as design §11.5 specifies.
- **No build-time capability snapshot.** Design §11.5 mentions a precached manifest snapshot.
  Availability is deployment-specific (D1), so a build-time copy could claim a capability that
  is not set up. The manifest is cached only from the server (network-first); with no copy,
  every capability is treated as unavailable (fail closed).
- **Audiences are the union over facilities** (design §11.2); facility scope applies to links
  (MQ.1). `GET /que/kb` rejects unknown parameters (400), so no client-supplied facility or role
  can influence content.
- **Restricted responses exclude public articles**, which ship in the public bundle.
- **Eager fetch:** the restricted bundle is fetched after each confirmed session, so offline
  help exists before connectivity is lost. Design §11.5 leaves the timing open.
- **`userId` is stored** with the cached bundle, as `CachedRestrictedBundle` in design §11.5.2
  specifies; it is the user's own identifier and is needed for per-user binding.
- **Monotonic check and device sleep:** browsers that pause `performance.now()` during sleep make
  restricted help unverifiable after a long sleep; it returns at the next online fetch.
- **Build script lint:** `scripts/build-kb.mjs` declares the Node globals it uses
  (`/* global process, console */`); the ESLint config has no Node block for package scripts.

### Obligations still open

- MQ.3: the Ask Que UI reads `queHelp.restrictedHelp()`, `loadPublicKb()` and
  `loadCapabilities()`; offline wording for configuration-dependent capabilities (D1).
- MQ.5: the M1–M5 article inventory replaces or extends the four initial articles, with the
  article-existence check (registry defaults and links).
- MQ.4 (optional): AI stays disabled; no adapter, provider or endpoint exists.

## Dependency security assessment: GHSA-fc5q-39xc-vjpf (2026-11-17)

**Status (updated 2026-11-17): NOT RESOLVED — accepted under a temporary, scoped exception.**
The vulnerability is still present in development tooling and no fix exists. The product owner
approved the exception below on 2026-11-17; it is enforced by `infra/scripts/audit-gate.js` and
`infra/security/audit-policy.json` and **expires on 2026-12-15** (see "Approved temporary
exception" at the end of this section). The original assessment and proposal follow unchanged.

### Advisory

| Field             | Value                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| IDs               | GHSA-fc5q-39xc-vjpf, CVE-2026-112366 (CWE-1333, inefficient regular expression complexity)                                                                                                                                                             |
| Package and range | `picomatch` `<= 4.0.7`; **no patched version** (`first_patched_version: null`)                                                                                                                                                                         |
| Severity          | High: CVSS 3.1 7.5 (`AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H`), CVSS 4.0 8.7; EPSS 0.34 %                                                                                                                                                                  |
| Mechanism         | ReDoS when an attacker **supplies the glob pattern**: single-branch repeated extglobs such as `+(*)` or `+(*a)` are not analysed by `analyzeRepeatedExtglob` (`lib/parse.js`), so the compiled regex backtracks exponentially on short crafted strings |
| Timeline          | Published 2026-10-19; GitHub-reviewed 2026-11-17 15:56 UTC. That review is why `pnpm audit` started reporting it today; the last green `staging` CI run (PR #10, 05:26 UTC) predates it                                                                |
| Upstream fix      | None released. npm `latest` is 4.0.7 (no newer version). The referenced PR micromatch/picomatch#194 is open and unmerged                                                                                                                               |

Sources: GitHub advisory API (`/advisories/GHSA-fc5q-39xc-vjpf`), npm registry
(`npm view picomatch versions`), GitHub API (`/repos/micromatch/picomatch/pulls/194`).

### What `pnpm audit` reports

The two "high" findings are **one advisory affecting two installed versions** of the same
package. pnpm counts one finding per vulnerable version.

| Installed version | Paths | Importer → top-level dev dependency → … → parent                                                                                                                                                                                          |
| ----------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `picomatch@2.3.2` | 7     | root → `@typescript-eslint/eslint-plugin@8.18.0` (4), `@typescript-eslint/parser@8.18.0` (1), `eslint-plugin-import@2.31.0` (2) → … → `fast-glob@3.3.3` → `micromatch@4.0.8` → `picomatch`                                                |
| `picomatch@4.0.7` | 215   | every workspace → `vitest@4.1.12` / `@vitest/coverage-v8@4.1.12`; `apps/web` also → `vite@6.4.5`, `@vitejs/plugin-react`, `vite-plugin-pwa`; immediate parents `fdir@6.5.0`, `tinyglobby@0.2.17`, `vite`, `vitest`, `@rollup/pluginutils` |

The same audit also reports, unchanged from earlier milestones and below the gate: 1 low
(`@eslint/plugin-kit`) and 3 moderate (`glob` ×1, `minimatch` ×2 versions). They are not part of
this assessment.

### Exposure

| Question                                         | Finding                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Development-only?                                | **Yes.** All 24 declarations of the top-level packages are `devDependencies`. `pnpm audit --prod --audit-level high`: no known vulnerabilities. `pnpm -r ls picomatch --prod`: not in any production tree                                                                                                                                                  |
| In production bundles?                           | **No.** No file in `apps/web/dist` (assets, `sw.js`, Workbox runtime), `apps/api/dist`, `apps/worker/dist` or any `packages/*/dist` contains picomatch/micromatch code                                                                                                                                                                                     |
| Loaded by deployed services?                     | **No.** Module-resolution trace of the built API (`buildApp`, `/que/kb/public`, `/que/capabilities`, `/health`): 575 modules, none a glob library. Built worker (`--once`): 147 modules, none a glob library. No source file imports a glob library                                                                                                        |
| Runtime containers?                              | None exist in the repository (no Dockerfile or image definition). Services start with `node dist/server.js` / `node dist/worker.js`                                                                                                                                                                                                                        |
| Can untrusted input reach the vulnerable parser? | **Not from users.** The flaw needs an attacker-chosen _pattern_. Patterns come only from committed configuration (ESLint, Vite/Vitest `include`, Workbox `globPatterns`, tsconfig); none uses extglob syntax. Matched _strings_ are repository file paths. The Vite dev and preview servers are local tools; their `server.fs` patterns are fixed defaults |
| Who could trigger it?                            | Someone who can change committed configuration or a dependency. Either needs a reviewed change, and a malicious dependency could already run code at install time. Impact is at most a hung lint, test or build on a developer machine or CI runner                                                                                                        |
| Same on `staging`?                               | **Yes.** `pnpm-lock.yaml` is identical to `staging`; with the MQ.2 changes stashed the audit reports the same 2 high (2.3.2 ×7 paths, 4.0.7 ×215 paths). MQ.2 added no external dependency                                                                                                                                                                 |

### Remediation options

| Option                                                                          | Assessment                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Upgrade to a patched `picomatch`                                                | Not possible: no patched release exists                                                                                                                                  |
| Upgrade the parents (`typescript-eslint`, `eslint-plugin-import`, Vite, Vitest) | Does not help: current releases still depend on `picomatch` ≤ 4.0.7 (directly, or via `tinyglobby`/`fdir`/`micromatch`). It would also be an unrelated toolchain upgrade |
| `pnpm.overrides` to an unreleased commit (for example PR #194)                  | Rejected: unreviewed third-party patch; the PR is open and addresses a related parsing issue, not a released fix                                                         |
| Replace the toolchain                                                           | Rejected: major incompatibility, out of scope                                                                                                                            |
| Narrow, time-bounded exception (below)                                          | Justified **only** because the exposure is development-only and the production audit stays clean                                                                         |

**Recommendation:** approve the scoped exception below, or keep the Security audit job red until
upstream publishes a fix. Do not use `pnpm.auditConfig.ignoreGhsas`: it would ignore the advisory
for every version and every path, including a future production path.

### Proposed scoped exception (as proposed; superseded by the approved exception below)

| Field                 | Proposal                                                                                                                                                                                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Advisory              | GHSA-fc5q-39xc-vjpf / CVE-2026-112366 only                                                                                                                                                                                                                                                                                         |
| Affected versions     | `picomatch` 2.3.2 and 4.0.7 only                                                                                                                                                                                                                                                                                                   |
| Allowed paths         | Only paths whose top-level package is one of the dev dependencies `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `eslint-plugin-import`, `vitest`, `@vitest/coverage-v8`, `vite`, `@vitejs/plugin-react`, `vite-plugin-pwa` (the 222 paths above)                                                                |
| Production exposure   | None (verified above); must stay none                                                                                                                                                                                                                                                                                              |
| Residual risk         | A crafted extglob pattern introduced into committed configuration or a dependency could hang a developer or CI job. No user-facing or deployed service is affected                                                                                                                                                                 |
| Compensating controls | `pnpm audit --prod --audit-level high` stays blocking with no exception; `--frozen-lockfile`; review of every change to configuration and the lockfile; proposed `timeout-minutes` on CI jobs (today GitHub's 6-hour default applies)                                                                                              |
| Review / expiry       | The exception fails CI by itself, and must be reviewed, on the **earliest** of: a patched `picomatch` version being published; the advisory changing (severity, range or a new ID); `picomatch` appearing in any production tree; a new installed version or path outside the allow-list; or **2026-12-15** (before M7 submission) |
| Other advisories      | Every other high or critical advisory, and any other ID affecting `picomatch`, keeps failing CI                                                                                                                                                                                                                                    |

**Proposed mechanism** (to implement only after approval; the current CI step stays as is until
then):

1. Keep a production gate with no exception: `pnpm audit --prod --audit-level high`.
2. Replace the full-tree step with a small script (for example `infra/scripts/audit-gate.js`)
   that reads `pnpm audit --json` and fails unless **every** high or critical advisory matches
   all of the following:

   - its GHSA is `GHSA-fc5q-39xc-vjpf` and its module is `picomatch`;
   - each finding's version is 2.3.2 or 4.0.7;
   - each path's top-level package is in the allow-list;
   - the advisory has no patched version;
   - the current date is before the expiry.

   The script prints every exempted path. Its own tests would check that an unrelated high
   advisory, a production path, a new version, a patched-version flag and the expiry all fail.

3. Record the approval (who, date, expiry) next to the exception in this file.

### Approved temporary exception (active; NOT a resolution)

> **Update 2026-11-20:** GitHub withdrew GHSA-fc5q-39xc-vjpf on 2026-11-18 as not a security issue, and the exception was removed from `infra/security/audit-policy.json` (no exception is active). The installed picomatch versions did not change. Proof and the gate tests: `docs/testing/M6-evidence.md`, "Audit exception GHSA-fc5q-39xc-vjpf". The text below is the record as approved.

**Approval.** Product owner, 2026-11-17: a narrowly scoped, temporary risk exception for
GHSA-fc5q-39xc-vjpf (CVE-2026-112366), limited to the demonstrated development-tool exposure. It
does not authorize disabling the security audit or ignoring any other vulnerability.

| Field                          | Value                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Advisory                       | GHSA-fc5q-39xc-vjpf / CVE-2026-112366, `picomatch` `<=4.0.7`, high (CVSS 3.1 7.5), patched versions `<0.0.0` (none)                                                                                                                                                                                                          |
| Approved versions              | `picomatch` 2.3.2 and 4.0.7 only                                                                                                                                                                                                                                                                                             |
| Approved paths                 | Exactly the 222 paths recorded in `infra/security/audit-policy.json` (7 for 2.3.2, 215 for 4.0.7), each rooted in one of 8 development packages: `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `eslint-plugin-import`, `vitest`, `@vitest/coverage-v8`, `vite`, `@vitejs/plugin-react`, `vite-plugin-pwa` |
| Development-only evidence      | All root packages are `devDependencies` of their importer (checked by the gate on every run); `pnpm audit --prod` clean; `pnpm -r ls picomatch --prod`: absent (checked on every run); no picomatch code in any build output; built API (575 modules) and worker (147) load no glob library; no container images             |
| Residual risk                  | Availability only: a crafted extglob pattern in committed configuration or a malicious dependency could hang a developer or CI job. No deployed service, user data or user input is affected                                                                                                                                 |
| Compensating controls          | Exception-free production audit (separate blocking step); path-exact policy; `--frozen-lockfile`; review of configuration and lockfile changes; `timeout-minutes` on every CI job (15, Postgres/browser job 40)                                                                                                              |
| Expiry                         | `2026-12-15T00:00:00Z`: from that instant the gate fails until the exception is renewed through review or removed. Renewal is capped at 45 days from `approvedOn` (`maxValidityDays`)                                                                                                                                        |
| Upstream remediation condition | The gate fails, asking for remediation instead of renewal, when the advisory lists a patched version, when npm publishes a `picomatch` release above 4.0.7, or when that metadata is unavailable or ambiguous                                                                                                                |
| Status                         | **Open vulnerability, accepted temporarily.** Remove the exception and upgrade when a fixed release exists                                                                                                                                                                                                                   |

**Enforcement.**

- `infra/security/audit-policy.json` is the checked-in, reviewable policy: advisory, module,
  severity, ranges, approval, expiry, development roots and exact paths.
- `infra/scripts/audit-gate.js` runs the complete `pnpm audit --json`, then
  `pnpm -r ls picomatch --prod --json` and `pnpm view picomatch dist-tags --json`. Every pnpm
  command is checked for start failure, signal and exit status, and every output for JSON
  validity and structure. `pnpm audit` exits 1 both when it finds advisories and when it fails,
  so an `{"error": …}` body is rejected explicitly.
- The gate rejects:
  - any high or critical advisory without an exception (including another ID on `picomatch`, or
    no GHSA id);
  - changed severity, module or vulnerable range;
  - a patched version or a newer release;
  - an unapproved version or path, or a path not ending at the approved version;
  - a root outside the approved development packages, or one that is not a devDependency-only
    package of its importer;
  - `picomatch` in any production tree;
  - expired, future-dated or over-long approval;
  - an invalid policy;
  - malformed, incomplete or muted audit output, including metadata counts that do not match
    the findings.
- Low and moderate findings keep the same non-blocking threshold as before. The gate never
  edits pnpm configuration; there is no `ignoreGhsas` or `auditConfig` (a test checks
  `package.json` and `.npmrc`).
- CI (`security-audit` job): step 1 `pnpm audit --prod --audit-level high` (no exceptions); step 2
  `node infra/scripts/audit-gate.js` (full tree through the policy). Neither step uses
  `continue-on-error` or `|| true` (checked by a test).

**Validation (2026-11-17).**

| Check                                                             | Result                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy unit tests (`apps/api/src/audit-gate.test.ts`, no network) | 42 passed: exact acceptance; other advisory; new version; new path; production exposure; malformed or incomplete data; expiry; unrecognized metadata; command failures; upstream fix or ambiguous metadata; policy and CI wiring                                                                                             |
| Mutation checks on the gate                                       | 21 of 21 killed (expiry, path, version, production tree, devDependency classification, unknown advisory, patched version, newer release, registry failure, severity, range, error body, metadata counts, muting, exit status, signal, maximum validity, root allow-list, path terminus, ambiguous latest, critical severity) |
| `node infra/scripts/audit-gate.js` on the real tree               | PASS: accepted GHSA-fc5q-39xc-vjpf, picomatch 2.3.2 (7 paths) and 4.0.7 (215 paths); production trees clean; latest upstream 4.0.7                                                                                                                                                                                           |
| Same with an unreachable registry                                 | BLOCKED (`pnpm reported an error (ECONNREFUSED)`), exit 1                                                                                                                                                                                                                                                                    |
| `pnpm audit --prod --audit-level high`                            | No known vulnerabilities found                                                                                                                                                                                                                                                                                               |
| Regression (`pnpm test`, format, lint, typecheck, build)          | pass (api 137 including the gate tests; all other packages unchanged)                                                                                                                                                                                                                                                        |

## MQ.3 Accessible Ask Que interface (2026-11-18)

**Branch:** `feature/mq3-accessible-que-interface`, from `staging` at `c59cadc` (PR #11 merged;
`staging` CI and Database Validation green on that commit).
**Scope:** MQ.3 only. No AI layer (MQ.4), no new articles (MQ.5), no API, contract, role-model,
offline-security or queue-state change. No migration, no dependency, no provider, no spending.

### What was built

| Part                | Where                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Entry point         | `apps/web/src/que/AskQue.tsx`: "Ask Que" button in the shared header (`Layout`), on every screen for every role           |
| Panel and sheet     | `apps/web/src/que/QuePanel.tsx`: native `<dialog>`; non-modal panel on desktop, full-height modal sheet at ≤ 40rem        |
| Screen context      | `apps/web/src/que/routeContext.ts` (registry patterns via `matchPath`); `screenHint.ts` (facility of the queue console)   |
| Data                | `apps/web/src/que/useQueKnowledge.ts`: reads the MQ.2 public bundle, capability manifest and restricted cache             |
| Article rendering   | `apps/web/src/que/SafeArticle.tsx`: Safe Markdown → React elements; links only where permitted                            |
| Change notification | `QueHelpClient.subscribe` (additive): an open panel updates when revalidation finishes or a purge happens                 |
| Offline readiness   | One-off idle warm-up (2 s after load, online only) of `GET /que/capabilities` and `GET /que/kb/public` into the SW caches |
| Styles              | `apps/web/src/styles.css` (`.que-*`), high-contrast variant, no animation                                                 |

**Behaviour.**

- **Opening.** The panel opens from the header button, which has `aria-haspopup="dialog"` and
  `aria-expanded`. Focus moves to the labelled search field.
- **Desktop.** The panel is non-modal and anchored bottom-right, clear of the header. The page
  stays usable, and the button toggles the panel closed.
- **Mobile.** A modal sheet keeps Tab inside it.
- **Closing.** Escape or Close closes it and focus returns to the button.
- **Results.**
  - With no question, "On this screen" shows the screen's default articles the user may read.
  - A question shows "Results" (the MQ.1 deterministic ranking).
  - Opening an article focuses its heading; "Back to results" returns to the search.
  - "Go to" lists permitted screens. When a screen needs another role, the required role is
    named and no link is shown.
- **Status shown as text.**
  - "Built-in help", or "Built-in help (saved with this app)" when the server copy is
    unavailable.
  - "Offline", with a note that setup-dependent features are described as last checked (D1).
  - "Help version N".
  - For staff: "Includes staff help for your roles." / "Checking your staff help…" / "Staff help
    … could not be confirmed".
- **States.** Loading; failure with "Try again"; empty results ("No help article matched …
  ask a member of staff"); and a plain message if the panel code itself cannot load.
- **Announcements.** One polite live region in the panel announces result counts once typing
  pauses (500 ms).
- **Read-only.** The only controls are Close, search, article titles, Back to results and Try
  again. Enter in the search sends nothing, and every Ask Que request is a GET.

**Architecture and security.**

- **Authorization.** All screen and link decisions use the MQ.1 functions (`answer`, `buildPath`)
  with the session's server-derived role grants. There is no new permission logic.
- **Restricted help.** Shown only when `queHelp.restrictedHelp` reports `valid`, so MQ.2's
  fingerprint, expiry and invalidation rules apply unchanged.
- **Facility hint.** The queue console reports its facility only for its own path. It affects
  which links are offered, never what the API allows.
- **Placeholder route.** `/supervisor/*` resolves to no screen and is never linked.
- **No AI.** There is no AI badge, because no AI layer exists (MQ.4).

### Verification

| Area                                  | Evidence                                                                                                                                                                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop and mobile presentation       | Playwright `@responsive` on all 4 projects: panel at 1280/1440 px, sheet at 320/375 px; axe WCAG 2.x A/AA clean with the panel open; no horizontal overflow                                                                                                             |
| Entry-point discoverability           | Button visible on `/`, `/recover`, the join page and `/login`; site-header layout test passes with the new button (no overlap or clipping, 44 px targets, focus order)                                                                                                  |
| Route-context synchronization         | Unit: every registry path maps to its RouteId, parameters extracted, longest-prefix fallback, `/supervisor` → none. Browser: navigating from the panel updates "On this screen"                                                                                         |
| Deterministic retrieval and rendering | Browser: defaults on `/recover`, search results, article view with focused heading and permitted body link. Unit: headings, lists, emphasis; HTML and scripts stay inert text                                                                                           |
| Authorized vs unauthorized navigation | Counter: console linked, connectivity not linked and the required roles named; supervisor: connectivity linked and navigates; auditor: no staff-assisted procedure; visitor: public only, never the verification questions (D4)                                         |
| Offline and reconnect                 | Staff: offline reload keeps public and cached staff help with an "Offline" badge, and the badge clears after reconnecting. Visitor who never opened Que: help offline thanks to the warm-up. No manifest ever fetched: capability-dependent help withheld (fail closed) |
| Sign-out, 401, role change            | Sign-out → public help only; deactivation (401) → public help only; role grant → staff procedure appears after the next confirmed session; an open panel updates from "Checking…" to staff help without reopening                                                       |
| Keyboard and screen reader            | Enter opens, focus to search, Escape closes and focus returns; sheet keeps Tab and Shift+Tab inside; live-region text for results and no results                                                                                                                        |
| Loading, empty, failure               | Failure with both copies blocked → "could not be loaded" and "Try again" recovers; built-in copy used when the server copy fails; empty results message                                                                                                                 |
| Capability messaging (D1)             | A switched-off capability: its article is withheld, "Staff-assisted ticket recovery: not set up here."; manifest unavailable (503): capability-dependent help withheld, "not available here"                                                                            |
| Read-only                             | Allow-list of panel controls; no submit, select or textarea; Ask Que network requests are GET only                                                                                                                                                                      |

**Mutation checks** (each change made a test fail, then was reverted):

- links rendered without the permission check (2 unit);
- `/` allowed as a prefix match (1 unit);
- no Escape on the desktop panel (1 Playwright);
- no warm-up (1 Playwright);
- focus not moved to search on open (1 Playwright);
- sheet mode never used on phones (2 Playwright, mobile-320);
- no subscription to help-cache changes. This first **survived**, which showed a coverage gap;
  the new "open panel follows revalidation" test now kills it.

One redundant guard survived: removing the manual focus return on close. Native `<dialog>`
already restores focus to the previously focused element, and the explicit call is kept for the
error-boundary path.

### Gate results (local, 2026-11-18)

| Gate                                                             | Result                                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build` | pass                                                                                                                                                                                                                                  |
| `pnpm test`                                                      | contracts 179, assist 118, api 137, web 168, domain 109, continuity 64, channels 33, worker 12, ui 6                                                                                                                                  |
| `pnpm test:db`                                                   | api 635, worker 63                                                                                                                                                                                                                    |
| Playwright (4 projects)                                          | 273 passed, 7 skipped at first; **276 passed, 7 skipped after the checkpoint review** (5 pre-existing conditional skips; 2 intended: the phone-only sheet test on the two desktop projects); `que-ui.spec.ts` also passed 3× repeated |
| Security gates                                                   | `pnpm audit --prod --audit-level high` clean; `node infra/scripts/audit-gate.js` PASS (only the approved GHSA-fc5q-39xc-vjpf exception; unchanged, still unresolved); policy tests 42 passed                                          |

New tests: web unit 9 (`routeContext.test.ts`, `SafeArticle.test.tsx`, help-client
notification); Playwright 19 test definitions in `que-ui.spec.ts` at first (25 runs across the 4 projects: 23 passed, 2 intended skips), 22 after the checkpoint review (see below).

**Bundle:** main chunk 185.72 → 187.17 kB gzip (+1.45 kB, including the checkpoint fix). The panel is a separate lazy chunk
(7.69 kB gzip), precached by the service worker so it opens offline.

### Deviations and notes (for review; no architectural change)

- **Existing header test updated.** `ui-layout.spec.ts` lists the exact header controls; its
  expected count and keyboard order now include "Ask Que", as they did for "Display and alerts"
  in M5.2. Every layout assertion (no overlap, no clipping, 44 px targets, rows, no horizontal
  scroll) applies to the new button and passes. Nothing was weakened.
- **Offline warm-up.** Design §11.5 expects the manifest snapshot to be available offline; MQ.2
  dropped the build-time snapshot because availability is deployment-specific (D1). The panel
  therefore fetches the two public Que GETs once per load while online. Without it, a visitor who
  never opened Que would get no capability-dependent help offline (fail closed).
- **Desktop panel position.** Anchored bottom-right below the header (an early top-right version
  covered the header controls; found and fixed through the non-modal test).
- **Notices.** Capability and role notices come from the MQ.1 answer text and are shown as a
  list; the `QueAnswer` schema is unchanged.
- **AI badge.** Not shown: the deterministic build has no AI answers to label. MQ.4 adds the
  "AI-generated" label only if an approved provider is ever enabled.
- **Queue-scoped links.** Links from the queue console use the facility the console loaded. The
  audit screen URL has no facility, so links to facility screens are not offered there (fail
  closed).
- **Help-client change notification** is a small additive API on the MQ.2 client; its rules are
  unchanged.

### Checkpoint review (2026-11-18): focus verification and a defect fix

| Requirement                                       | Evidence                                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Focus enters the search field on open             | `@responsive` presentation test (all 4 projects); keyboard-only test                                                                 |
| Focus returns to the button after Close or Escape | Escape: presentation test (all projects) and keyboard-only test; Close: mobile sheet test; desktop toggle: non-modal test            |
| Focus after a failed panel load, and recovery     | **New test** "a failed panel load returns focus to the button, and the next open recovers"                                           |
| Mobile focus containment still allows dismissal   | Sheet test: Tab/Shift+Tab stay inside; Close and Escape dismiss and return focus                                                     |
| Desktop panel does not block page controls        | **New test**: with the panel open, Sign out is visible, not covered (element at its centre is the button), focusable and works       |
| Trigger discoverable at supported widths          | Presentation test on `/`, `/recover`, the join page and `/login` at 320, 375, 1280 and 1440 px; header layout test                   |
| Keyboard-only operation                           | **New test**: Enter opens, type, Tab to a result, Enter opens the article (heading focused), Tab to "Back to results", Enter, Escape |

**Defect found and fixed.** After one failed load of the lazy panel chunk (for example offline
before the chunk is cached), the panel could never open again in that page. `React.lazy` keeps
the rejected import, so every later open showed the error again. The fix creates a fresh lazy
component after a failure (`AskQue.tsx`: `makePanel`), so the next open retries the import. The
new recovery test fails without the fix and passes with it (3× repeated).

### Deferred obligations (recorded at the MQ.3 checkpoint)

- **MQ.5:** the full M1–M5 help-article inventory (design §11.10, §11.10a) and the
  article-existence checks (every registry default, related route and body link resolves).
  Until then most screens show "No help is listed for this screen yet".
- **MQ.4:** optional; the AI layer stays disabled; no provider is selected or integrated; no
  AI endpoint, badge or answer exists.
- **M7:** the existing visitor-bundle optimization (route splitting; 187.17 kB gzip today
  against the 100 kB target) remains M7 work. MQ.3 kept the panel in its own lazy chunk.
- **Final acceptance (Set 2, after M7):** manual screen-reader passes (VoiceOver on iOS,
  TalkBack or NVDA) and real-device checks of Ask Que, with the other deferred M5 manual checks.
- **Security:** the temporary picomatch exception (GHSA-fc5q-39xc-vjpf) remains **unresolved**
  and expires on 2026-12-15; the audit gate fails from then on, or earlier if a fix is published.

### Remaining limitations

- Content is still the four MQ.2 delivery articles; MQ.5 supplies the inventory, after which
  most screens get "On this screen" help.
- A visitor whose first-ever visit is offline has no manifest and therefore no
  capability-dependent help until the next online load (fail closed by design).
- Manual screen-reader passes (VoiceOver, TalkBack/NVDA) are not run here; they belong to the
  deferred Set 2 final acceptance.

## MQ.4 Optional AI explanation layer (2026-11-18)

**Provider decision status: No provider selected — AI disabled by default.**

**Branch:** `feature/mq4-optional-ai-explanations`, from `staging` at `29ace1f` (PR #12 merged;
`staging` CI green on that commit).

**Implemented infrastructure, not activated capability.** MQ.4 builds the optional AI layer end
to end: adapters, endpoint, guard, opt-in and disclosure. It does not activate AI anywhere:

- the only runnable adapter is the TEST-ONLY sandbox, which is refused in production;
- every deployment default leaves AI off;
- the capability manifest reports `ask_que_ai` as `live` / `unavailable` / `switched_off`.

No account was created, no payment detail entered, no provider integrated, no inference credit
used.

### What was built

| Task                       | Where                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A. Adapters                | `apps/api/src/que/inference.ts`: `InferenceAdapter`, `DisabledInferenceAdapter` (default), `SandboxInferenceAdapter` (TEST-ONLY), `aiDeploymentAvailable` zero-cost guard |
| B. Ask endpoint            | `apps/api/src/routes/que.ts` (`POST /api/v1/que/ask`), `apps/api/src/que/ask.ts` (orchestration, daily cap, per-user limiter)                                             |
| C. Output guard, redaction | `packages/assist/src/ai-guard.ts` (pure): `redactQuestion`, `guardAiExplanation`                                                                                          |
| D. Facility opt-in         | `GET                                                                                                                                                                      | PUT /api/v1/facilities/:id/que-ai`; migration `0010_que_ai.sql`; `apps/web/src/que/QueAiSettingsSection.tsx` on the facility page |
| E. UI disclosure           | `apps/web/src/que/QuePanel.tsx`: "Explain with AI", "AI-generated" label, sources, "Check with staff…", fallback reasons, status notes                                    |
| F. Provider research       | Below                                                                                                                                                                     |
| Contracts                  | `packages/contracts/src/que.ts`: `QueAskRequestSchema`, `QueAiSettings*`, `QUE_AI_CONSENT_VERSION` / `QUE_AI_CONSENT_TEXT`                                                |
| Configuration              | `apps/api/src/env.ts`, `.env.example`, `docs/local-environment.md` ("Ask Que AI explanations"); `apps/web/playwright.config.ts` (sandbox for browser tests)               |

**Request flow of `POST /que/ask`.**

1. **Session and scope.** A staff session is required: anonymous and forged sessions get 401, and
   a missing CSRF header gets 403. The body is strict Zod (≤ 500 characters, registered RouteIds
   only). The facility must be one where the user holds a role (`FACILITY_READ`); otherwise 404,
   including any facility of another organization.
2. **Rate limits.** Per user: `QUE_AI_RATE_LIMIT_MAX` per minute, then 429 with a plain message.
   Per IP: five times that, because colleagues often share an address.
3. **Deterministic answer.** Always computed first, from public plus restricted articles for the
   session's audiences. It is the fallback.
4. **Zero-cost guard and opt-in.** If the guard or the facility opt-in fails, the answer is
   built-in help with `ai_disabled`.
5. **Grounding.** The adapter gets at most 3 of the deterministic citations. When none exist the
   result is `validation_failed`, without calling the adapter.
6. **Daily cap.** One atomic slot per UTC day, shared by every instance. When the cap is reached
   the result is `quota`, without calling the adapter.
7. **Adapter call.** It receives only the redacted question, the authorized articles and a
   capability summary. Timeout or a client disconnect aborts it (`timeout`); a classified quota
   gives `quota`; any other failure gives `provider_error`.
8. **Output guard.** Any rejection gives `validation_failed`. On success the answer is
   `mode: 'ai'`, links are computed by the server from the cited articles' related routes, and
   the response is strict-schema checked.
9. **Logs.** Adapter id, mode, fallback reason, latency and redaction count only; never question
   or answer text. Sandbox runs are logged with `[SANDBOX]`.

**Output guard.** The model's output is accepted only when it is plain text of 1–1200
characters, cites at least one article, and every citation is one of the supplied (authorized)
articles. It is rejected for any of:

- HTML, scripts, Markdown links or images, URLs, `www.`, `javascript:`/`data:`/`mailto:`,
  `route:` or backticks;
- data-like content: emails, phone numbers, UUIDs, ticket codes, secret-like strings;
- claims that something was done ("I have cancelled…", "has been moved") or will happen ("you
  will be called"), and injection artefacts ("ignore previous instructions", "system prompt");
- any mention of a capability that is not usable (for example SMS, USSD, or push when not set up);
- any number not present in the cited articles;
- text where fewer than 60 % of the content words come from the cited articles.

The model never supplies links.

**Facility opt-in.** It is off by default (no row), and only `FACILITY_CONFIGURE` (facility admin
or org admin) can change it; other roles get 403 and other organizations get 404. Turning it on
requires `consent_version = que-ai-consent-v1` and `consent_acknowledged: true`. The database
CHECK refuses "on" without a recorded consent. Each real change writes an `admin_events` row
(`que_ai.enabled` / `que_ai.disabled`, details: consent version and deployment availability; no
names). Opting in has no effect while the deployment has no enabled zero-cost adapter, and the
admin page says so.

**UI.**

- **Built-in help** is unchanged and always shown.
- **"Explain with AI"** appears only for signed-in staff, online, on a facility whose setting
  reports `available`, after a question with built-in matches.
- **An AI answer** is in its own region with the text label "AI-generated", the plain-text
  explanation (rendered as text, never HTML), a "Sources" list that opens the cited built-in
  articles, and "Check with staff before acting on queue decisions." The live region announces
  "AI explanation ready."
- **A failure** shows "AI explanation unavailable — showing built-in help." plus a plain reason.
- **Notes:** offline, "AI explanations need a connection. Built-in help works offline."; where
  not set up, "AI explanations are not set up here. This is built-in help."
- **Visitors** see no AI control or text.

### Provider research (design §11.8; research only, 2026-11-18)

No account was created and no payment detail entered. Eligibility (all required): no personal
spending; no payment card or billing details; no automatic paid overage. Project preference: no
training use of inputs.

| Provider                         | Finding (verified 2026-11-18 unless noted)                                                                                                                                                                                               | Eligible?   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Cloudflare Workers AI            | 10,000 Neurons/day free; free plan operations fail with an error past the limit (hard stop); zero retention and no training on customer content. Card at signup, Nigeria availability and usage terms **not verified**                   | **Unclear** |
| Groq (GroqCloud)                 | Free tier exists; upgrading needs a card or bank account; inputs/outputs not retained by default (up to 30-day logs for reliability/abuse). Free-tier limits, Nigeria availability, production terms and training terms **not verified** | **Unclear** |
| Google Gemini API (AI Studio)    | Free tier needs no billing; Nigeria listed; but free-tier content is used to improve products and may be read by human reviewers                                                                                                         | No          |
| OpenRouter (free models)         | 50 requests/day without credits (1,000/day only after buying credits); its own docs say free models are usually not suitable for production                                                                                              | No          |
| Hugging Face Inference Providers | No free credits for free users (credits must be bought)                                                                                                                                                                                  | No          |
| Cohere (trial key)               | Trial keys are for testing and proofs of concept; production keys are paid                                                                                                                                                               | No          |
| OpenAI                           | No free API tier found (only moderation is free)                                                                                                                                                                                         | No          |
| Anthropic                        | No free tier found (page not verified)                                                                                                                                                                                                   | No          |
| Mistral, GitHub Models           | Pages could not be loaded; nothing verified                                                                                                                                                                                              | Unclear     |

Sources (read 2026-11-18):

- Cloudflare:
  - developers.cloudflare.com/workers-ai/platform/pricing/ (page dated 2026-11-12)
  - developers.cloudflare.com/workers-ai/platform/data-usage/ (page dated 2026-10-16)
- Groq: console.groq.com/docs/rate-limits, /docs/billing-faqs and /docs/your-data
- Google AI Studio: aistudio.google.com/docs/pricing, /docs/terms, /docs/billing and
  /docs/available-regions
- OpenRouter: openrouter.ai/docs/faq and openrouter.ai/docs/api-reference/limits
- Hugging Face: huggingface.co/docs/inference-providers/pricing
- Cohere: docs.cohere.com/docs/rate-limits and /docs/how-does-cohere-pricing-work
- OpenAI: developers.openai.com/api/docs/pricing

**Conclusion.** No provider satisfies every requirement with verified evidence. Cloudflare Workers
AI is the strongest candidate: it hard-stops at the free allowance and does not train on or
retain inputs. Its card-at-signup, Nigeria availability and usage terms are unverified. Free
allowances can change without notice. MQ.4 therefore remains **operationally disabled**:

**No provider selected — AI disabled by default.**

Selecting or integrating any provider needs a separate, explicit project decision (REQ-F13.4.8).

### Verification

| Area                                      | Evidence                                                                                                                                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default-disabled                          | DB: default deployment answers `ai_disabled` even after opt-in; manifest `live` / `unavailable` / `switched_off`; settings `deployment_available: false`; each zero-cost switch alone keeps AI off; sandbox refused in production                                                                       |
| Authentication and facility authorization | DB: 401 anonymous and forged; 403 without CSRF; 400 for extra fields, empty, over 500 characters, unknown route, malformed or missing facility; 404 for an unassigned facility and another organization's                                                                                               |
| Tenant isolation                          | DB: another organization cannot read or change the opt-in (404); the adapter receives no facility or organization id                                                                                                                                                                                    |
| Administrator-only settings and audit     | DB: reception, counter, supervisor, auditor get 403; facility admin and org admin succeed; consent required (4 invalid bodies, no audit row); one audit row per real change; no names; DB CHECK. Browser: off by default, button disabled until consent ticked, on and off; supervisor sees no controls |
| PII redaction                             | Unit: emails, phones, ticket codes, UUIDs, grouped keys, long tokens, URLs; DB: the adapter received only the redacted question (3 redactions) and authorized generic articles                                                                                                                          |
| Rate limits and daily cap                 | DB: per user third request 429 while a colleague on the same IP succeeds; per-IP limit still applies; cap 2 → `ai, ai, quota` and the counter stops at 2; 8 concurrent requests on a cap of 3 → exactly 3 AI answers                                                                                    |
| Timeout and adapter failure               | DB: `timeout` (500 ms, answered well under 5 s), `provider_error`, `quota`; Browser: fallback messages for timeout and error                                                                                                                                                                            |
| Prompt injection and malicious output     | Unit: 42 guard and redaction tests. DB: injected instructions and claimed actions, uncited, foreign citation, SMS claim, HTML link and invented number all fall back to `validation_failed`, and none of their text reaches the response                                                                |
| Unauthorized citations and links          | Unit: foreign and mixed citations rejected; DB: an auditor's AI answer never cites the staff-assisted procedure; links come only from the server and respect roles (counter: no connectivity)                                                                                                           |
| Misleading capability claims              | Unit: SMS, USSD and push (not set up) rejected; a usable capability may be mentioned; manifest never `live` + `available`                                                                                                                                                                               |
| Deterministic fallback                    | Every failure path returns the built-in answer with citations and a `fallbackReason`; nothing to ground → `validation_failed` without an adapter call (counter unchanged)                                                                                                                               |
| No queue mutations                        | DB: queue events, tickets, client operations, roles and staff of the organization unchanged after asks; the only write is the aggregate daily counter                                                                                                                                                   |
| Offline and UI disclosure                 | Browser: AI answer labelled "AI-generated" with sources and the staff advice, no links in AI text, axe clean; live announcement; fallback reasons; offline note and no control; "not set up here" when the deployment has no provider; visitors see no AI                                               |
| MQ.1–MQ.3 regression                      | All earlier unit, DB and browser tests pass. Two MQ.1 premises were updated because MQ.4 changed them: `ask_que_ai` is now `live` / `unavailable` / `switched_off` (was `planned`), and `POST /que/ask` now exists and answers 401 to anonymous callers (was 404)                                       |

**Mutation checks** (each change made a test fail, then was reverted). 31 mutations were applied
and 30 were killed:

- **Guard:** citations, markup, sensitive data, action/injection, capability words, numbers and
  grounding checks, each removed.
- **Redaction:** the email and phone redactions, each removed.
- **Zero-cost guard:** without `QUE_AI_ENABLED`, and without the cost-mode check.
- **Opt-in:** the check removed, and the PUT permission weakened to `FACILITY_READ`.
- **Audit:** recording on change removed.
- **Consent:** the schema rule removed.
- **Facility scope:** removed.
- **Daily cap:** the reservation removed, and the cap condition in SQL removed.
- **Pipeline:** the guard result ignored, the unredacted question sent, and the timeout not
  aborting.
- **Production:** the sandbox no longer refused.
- **Manifest:** reporting AI as available.
- **UI:** the AI control offered without the facility setting.
- **Per-user limiter, initially survived.** The per-IP limit was equal to it, so the test could
  not tell them apart. This was also a design weakness: staff behind one NAT share an IP. The
  per-IP limit is now 5× the per-user limit, and the test checks a colleague on the same IP; the
  mutation is now killed.
- **Unrestricted article pool, survived (redundant guard).** Giving the server's article pool
  every staff audience does not change answers, because `answer()` already filters by the
  session's audiences. The restriction stays as defence in depth.

### Gate results (local, 2026-11-18)

| Gate                                                             | Result                                                                                                                                                                            |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build` | pass                                                                                                                                                                              |
| `pnpm test`                                                      | contracts 179, assist 162, api 143, web 168, domain 109, continuity 64, channels 33, worker 12, ui 6                                                                              |
| `pnpm test:db`                                                   | api 676 (35 files), worker 63                                                                                                                                                     |
| Playwright (4 projects)                                          | 283 passed, 7 skipped (5 pre-existing conditional skips; 2 intended phone-only skips)                                                                                             |
| `pnpm db:check`                                                  | 10 applied, none pending                                                                                                                                                          |
| Security gates                                                   | `pnpm audit --prod --audit-level high` clean; `node infra/scripts/audit-gate.js` PASS (only the approved, still unresolved GHSA-fc5q-39xc-vjpf exception); policy tests 42 passed |

New tests: assist 42 (`ai-guard.test.ts`); API DB 41 (`que-ask.db.test.ts`, including the tenant FK added at the checkpoint); API unit 6 (`que-inference.test.ts`, added at the checkpoint); Playwright 7
(`que-ai.spec.ts`).

**Bundle:** main chunk 187.17 → 188.14 kB gzip (+0.97 kB: the admin opt-in section and API
calls). The lazy Ask Que panel chunk is 7.69 → 8.46 kB gzip.

### Database migration

`0010_que_ai.sql` is additive: two new tables, no change to existing ones. It applies on a fresh
database and re-runs as a no-op. It is registered in the schema identity guard
(`infra/scripts/db-identity.js` sentinels).

- `facility_que_ai_settings`: one row per facility; organization-scoped; consent CHECK.
- `que_ai_daily_usage`: one aggregate counter per UTC day; non-negative CHECK. No user,
  facility, ticket or question data.

**Checkpoint review (2026-11-18).**

| Check            | Finding                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation | Every query filters by `facility_id` AND `organization_id` from the session. **Fixed at review:** the table had separate FKs to `facilities` and `organizations`, so the database would have accepted a mismatched pair. Added `facility_que_ai_settings_facility_org_fk` `(facility_id, organization_id) → facilities (id, organization_id)`, the rule used by 0003–0009, with a DB test that a mismatched row is refused |
| Foreign keys     | `facility_id`, `organization_id`, `consented_by`, `updated_by`: all `ON DELETE RESTRICT` (no cascade can erase the opt-in record)                                                                                                                                                                                                                                                                                          |
| Constraints      | `facility_que_ai_consent_chk` (no "on" without consent version, actor and time); `que_ai_daily_usage_nonneg_chk`; primary keys `facility_id` and `usage_date`                                                                                                                                                                                                                                                              |
| Indexes          | `facility_que_ai_settings_org_idx` on `organization_id`; lookups use the primary keys                                                                                                                                                                                                                                                                                                                                      |
| Safe deployment  | Additive (two new tables, nothing altered or dropped); `IF NOT EXISTS` guards on tables, index and constraints; applied to a fresh database and re-run as a no-op; re-applied to the local dev and test databases after the FK change (no mismatched rows existed)                                                                                                                                                         |

### Notes, deviations and remaining risks

- **`ask_que_ai` status.** Now `live` (built) with `unavailable` / `switched_off` by default, as
  design §11.10a anticipated. Only the sandbox adapter makes it `sandbox` / `available`; nothing
  can make it `live` / `available` without a new adapter.
- **Per-IP limit = 5× per-user** (staff share addresses); both limits are in-process, as with the
  other per-IP limits (M5 limitation). The daily cap is database-backed and shared.
- **"Explain with AI" is a POST** for an explanation, not an operation; the read-only allow-list
  in the browser tests includes it only where AI is available.
- **Guard heuristics are conservative.** False positives only fall back to built-in help. They do
  not prove a real model's output is correct, which is why every AI answer is labelled and cites
  built-in articles.
- **Content.** Still the four MQ.2 delivery articles; MQ.5 owns the inventory.
- **Security.** The temporary picomatch exception remains unresolved and expires on 2026-12-15.
- **Deferred.** Manual screen-reader and real-device checks remain in the final acceptance
  (Set 2).

### Checkpoint security verification (2026-11-18)

| Invariant                                                          | Evidence                                                                                                                                                                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production defaults to `DisabledInferenceAdapter`                  | Unit (`que-inference.test.ts`): a production configuration with no AI settings parses to `disabled`, the factory returns the disabled adapter and the zero-cost guard is off                                                            |
| The sandbox cannot run in production                               | Two independent layers: the environment schema refuses `QUE_AI_ADAPTER=sandbox` with `NODE_ENV=production` at start-up, and the factory returns the disabled adapter for production even if that check were bypassed (both unit-tested) |
| No real provider, credential or external request                   | Only the disabled and sandbox adapters exist; the adapter schema accepts no other value (unit); a source check finds no network API in the adapter code; no provider credential variable exists                                         |
| Opt-in alone cannot activate inference                             | DB: the default deployment answers `ai_disabled` after an opt-in; each zero-cost switch alone keeps AI off                                                                                                                              |
| Anonymous users cannot invoke AI                                   | DB: 401 anonymous and forged sessions; visitors see no AI control (browser)                                                                                                                                                             |
| Cross-facility access is denied                                    | DB: 404 for an unassigned facility and another organization's facility; the opt-in of another organization cannot be read or changed (404); composite tenant FK                                                                         |
| Admin settings need authorization and are audited                  | DB: only `FACILITY_CONFIGURE` roles succeed; consent required; one audit event per real change                                                                                                                                          |
| AI requests cannot mutate queue state                              | DB: queue events, tickets, client operations, roles and staff unchanged; the only write is the aggregate daily counter                                                                                                                  |
| Output guard blocks links, citations, markup and capability claims | Unit 42 guard tests; DB end-to-end rejections fall back to `validation_failed`                                                                                                                                                          |
| Every failure falls back deterministically                         | DB: `ai_disabled`, `timeout`, `provider_error`, `quota`, `validation_failed`, each with the built-in answer and citations                                                                                                               |
| Caps and limits are enforced                                       | DB: per-user 429, per-IP limit, shared daily cap under concurrency                                                                                                                                                                      |

### Obligations carried forward (recorded at the MQ.4 checkpoint)

- **No provider selected — AI disabled by default.** Integrating any real inference provider
  requires a separate, explicit product-owner approval (REQ-F13.4.8), verified free-tier or
  sponsored terms and no personal spending. MQ.4 adds no provider adapter or credential.
- **MQ.5** must complete the knowledge-base inventory (currently the four MQ.2 articles).
- **MQ.6** must implement the ongoing knowledge-base consistency checks (Group 13.5: article
  capabilities in the manifest, no non-live capability presented as available, metadata
  validation) as CI checks.
- **Rate limits.** The per-user and per-IP limits are in-process per API instance (the M5
  limitation); only the daily cap is shared through the database. Guard heuristics are
  conservative and do not prove a real model's output correct.
- **M7** owns the visitor-bundle optimization (main chunk 188.14 kB gzip after MQ.4).
- **M5 Set 2** acceptance (manual screen-reader and real-device checks) stays deferred to the
  final acceptance after M7.
- **picomatch (GHSA-fc5q-39xc-vjpf)** remains an approved, unresolved, dev-only exception that
  expires on 2026-12-15T00:00:00Z.

## MQ.5 Knowledge-base content (2026-11-18)

**Branch:** `feature/mq5-knowledge-base-content` from `staging` at `2acf25a` (CI green).
**Scope:** MQ.5 only (tasks.md). No MQ.6 maintenance rule, no M6, no AI activation or provider
selection, no queue-state or role changes.

### What was built

- **Inventory:** 44 articles in `packages/assist/knowledge` (knowledge-base version 2): 18 public
  (visitor bundle, precached for offline use) and 26 restricted. All 20 article ids proposed in
  design §11.10a exist. The four MQ.2 articles kept their ids and paths: `visitor.recovery.how`,
  `staff.recovery.assist` and `staff.sync.states` were corrected to match the screens (version 2);
  `visitor.recovery.staff` was re-reviewed without content change (version 2, new review date).
  Full inventory with audiences, capabilities, routes and versions: `knowledge/README.md`.
- **Audience coverage (bundle sizes):** visitor 18, reception 16, counter 20, supervisor 27,
  facility admin 31, auditor 20; an organization administrator receives every staff audience.
  Public bundle 18.98 kB (5.69 kB gzip).
- **Screen defaults:** every registered screen now has default articles (registry
  `defaultArticles`), ordered so the first five shown are the most relevant for the roles that
  open the screen.
- **Capability-gated articles:** `visitor.alerts.sms` (`sms_turn_alerts`) and `visitor.ussd`
  (`ussd`) are hidden while those capabilities are `planned`; a question about them gets
  "not available yet" and the reliable fallback. `visitor.alerts.push` and `staff.alerts.status`
  require `turn_alert_web_push` and are withheld when VAPID is absent. The capability manifest
  itself is unchanged: the MQ.1 entries already matched §11.10a.
- **Content review:** checklist and review record in `knowledge/README.md`.

### How the content was verified against the implementation

The articles were written from the code, not the specifications. Three read-only reviews of the
current implementation (administration and onboarding; visitor flows; staff, connectivity and
audit) produced the facts used, with file references, and the role, default and limit facts
that change article wording were rechecked directly:

| Fact used in an article                                                                          | Source                                                                                       |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Every role transition named in a "Who can do this" line                                          | `packages/domain/src/state-machine.ts` (checked by test)                                     |
| Screen and procedure permissions                                                                 | `packages/contracts/src/permissions.ts` (checked by test)                                    |
| Vibration on by default where supported; sound off                                               | `apps/web/src/lib/a11yPrefs.ts` `DEFAULT_PREFS`                                              |
| Grace window counted from the missed time                                                        | `apps/api/src/queue/commands.ts` (`missed_at` + `grace_window_seconds`)                      |
| Staff-assisted recovery on by default                                                            | `packages/contracts/src/admin.ts` (`staff_recovery` default `true`)                          |
| At most 3 devices; a 4th signs out the earliest                                                  | `apps/api/src/recovery/credentials.ts` (`MAX_ACTIVE_STATUS_TOKENS`, ordered by `created_at`) |
| Session ends after 12 hours                                                                      | `apps/api/src/auth/session.ts` (`SESSION_TTL_MS`)                                            |
| Counter open/close: counter, supervisor, facility admin (API); console shows it to counter roles | `apps/api/src/queue/counters.ts`, `StaffConsole.tsx`                                         |
| Invitations are links you share yourself, 7 days, single use                                     | `FacilityStaff.tsx`, `apps/api/src/routes/staff.ts`                                          |
| No password reset, no facility rename or removal in the UI                                       | absent from `apps/web` and `apps/api` routes                                                 |

**Differences between the specification and the implementation (the articles follow the code):**

- `staff.missed.rejoin`: design §11.10a says counter, supervisor, facility admin; the state
  machine lets reception, counter and supervisor return a missed ticket, not the facility
  admin. The article names those roles.
- `staff.alerts.status`: the per-ticket "Visitor alert" panel is shown only to counter
  operators and supervisors (inside the calling controls); facility admins and auditors see
  only the connectivity counts. The article says so.
- `staff.coordinator.limits`: a facility admin's device can be designated, but calling and
  serving still need the counter or supervisor role. The articles say who can call.
- `visitor.alerts`: vibration is on by default where supported (the design row does not say);
  the article states it.
- `visitor.recovery.key`: "Sign out other devices" also issues a new recovery key, and the page
  does not keep the key after a reload; both are stated.
- `admin.policy.recovery`: the service form also edits priority classes, override reasons and
  transfer placement; those are in `admin.services`. Policy editing is open to facility and
  organization administrators.
- M1 workflows (sign-up, sign-in, invitations, readiness and the join link) had no §11.10a
  row; they are covered by `org.signup`, `org.signin`, `staff.invite.accept`,
  `admin.staff.invite`, `admin.facility.create` and `admin.readiness.join_link`.

### Coverage matrix

Each row is a test in `packages/assist/src/kb-content.test.ts` (`COVERAGE`): the article must be
readable by the role, tied to the screen (related route or screen default), and returned in the
top 3 for the plain-language question with AI off. Visitor rows also pass from the public bundle
alone (the offline copy). Every article except the two planned-capability ones appears in the
matrix.

| Workflow                                | Role tested    | Screen                 | Question                                    | Article                     |
| --------------------------------------- | -------------- | ---------------------- | ------------------------------------------- | --------------------------- |
| Join by QR or link                      | Visitor        | `visitor.join`         | “how do I get a ticket”                     | `visitor.join.status`       |
| Ticket status                           | Visitor        | `visitor.ticket`       | “what does on hold mean”                    | `visitor.ticket.states`     |
| Wait estimate and uncertainty           | Visitor        | `visitor.ticket`       | “how long will I wait”                      | `visitor.wait.estimate`     |
| Public display board                    | Visitor        | `public.display`       | “spoken announcements on the board”         | `visitor.display.board`     |
| Save the recovery key                   | Visitor        | `visitor.ticket`       | “save my recovery key”                      | `visitor.recovery.key`      |
| Sign out other devices                  | Visitor        | `visitor.ticket`       | “someone else has my key”                   | `visitor.recovery.key`      |
| Recover on another device               | Visitor        | `visitor.recover`      | “I lost my phone, get my ticket back”       | `visitor.recovery.how`      |
| Recovery without the key (visitor side) | Visitor        | `visitor.recover`      | “I lost my key, ask staff”                  | `visitor.recovery.staff`    |
| Missed turn and grace window            | Visitor        | `visitor.ticket`       | “I missed my turn”                          | `visitor.missed.grace`      |
| Automatic missed turn rule              | Visitor        | `visitor.ticket`       | “how long do I have to respond when called” | `visitor.auto_miss`         |
| Offline ticket page                     | Visitor        | `visitor.ticket`       | “no internet connection”                    | `visitor.offline`           |
| In-app alert, sound and vibration       | Visitor        | `visitor.ticket`       | “turn on sound alert”                       | `visitor.alerts`            |
| Web Push opt-in                         | Visitor        | `visitor.ticket`       | “push notification”                         | `visitor.alerts.push`       |
| Accessibility settings                  | Visitor        | any (header)           | “larger text and high contrast”             | `visitor.accessibility`     |
| Organization sign-up                    | Visitor        | `public.signup`        | “create an organization”                    | `org.signup`                |
| Sign in and out                         | Visitor        | `public.login`         | “forgot password”                           | `org.signin`                |
| Accept a staff invitation               | Visitor        | `public.accept_invite` | “accept invitation”                         | `staff.invite.accept`       |
| Create a facility                       | Org admin      | `admin.home`           | “create a facility”                         | `admin.facility.create`     |
| Services and ordering policy            | Facility admin | `admin.facility`       | “add a service”                             | `admin.services`            |
| Counters and their services             | Facility admin | `admin.facility`       | “add a counter”                             | `admin.counters`            |
| Missed-turn and recovery policy         | Facility admin | `admin.facility`       | “change the grace window”                   | `admin.policy.recovery`     |
| Readiness, join link and QR             | Facility admin | `admin.facility`       | “qr code not live yet”                      | `admin.readiness.join_link` |
| Invite staff and manage roles           | Facility admin | `admin.facility.staff` | “invite staff”                              | `admin.staff.invite`        |
| AI explanations opt-in                  | Facility admin | `admin.facility`       | “turn on AI explanations”                   | `admin.que_ai`              |
| Roles and access                        | Reception      | `staff.home`           | “what can my role do”                       | `staff.roles.workflows`     |
| Open, pause and close the queue         | Supervisor     | `staff.facility`       | “open today's queue”                        | `staff.queue.open`          |
| Walk-in registration                    | Reception      | `staff.console`        | “visitor without a phone”                   | `staff.walkin`              |
| Call, serve and complete                | Counter        | `staff.console`        | “call next visitor”                         | `staff.counter.calling`     |
| Priority changes and reasons            | Supervisor     | `staff.console`        | “change priority reason”                    | `staff.fairness.priority`   |
| Transfers                               | Counter        | `staff.console`        | “transfer to another service”               | `staff.transfers`           |
| Audit view, verification and export     | Auditor        | `staff.audit`          | “verify integrity”                          | `staff.audit.trail`         |
| Return a missed visitor                 | Reception      | `staff.console`        | “missed visitor came back late”             | `staff.missed.rejoin`       |
| Automatic no-show (staff)               | Auditor        | `staff.audit`          | “missed automatically by the system”        | `staff.auto_miss`           |
| Sync states                             | Counter        | `staff.console`        | “what does pending sync mean”               | `staff.sync.states`         |
| Coordinator limits during an outage     | Counter        | `staff.console`        | “internet is down, can I still call”        | `staff.coordinator.limits`  |
| Designate, renew, fail over             | Supervisor     | `staff.connectivity`   | “fail over the coordinator”                 | `staff.coordinator.manage`  |
| Conflict review                         | Supervisor     | `staff.connectivity`   | “resolve a conflict”                        | `staff.conflicts.review`    |
| Device health and alerts                | Auditor        | `staff.connectivity`   | “device alerts”                             | `staff.device.health`       |
| Lost or stolen device                   | Counter        | `staff.console`        | “my tablet was stolen”                      | `staff.device.lost`         |
| Staff-assisted recovery                 | Reception      | `staff.console`        | “visitor has no recovery key”               | `staff.recovery.assist`     |
| Approve a recovery request              | Supervisor     | `staff.console`        | “approve recovery request”                  | `staff.recovery.approve`    |
| Recovery activity view                  | Auditor        | `staff.audit`          | “recovery activity”                         | `staff.recovery.activity`   |
| Push alert status                       | Counter        | `staff.console`        | “push sent not confirmed”                   | `staff.alerts.status`       |

Browser checks (`apps/web/e2e/que-ui.spec.ts`, "MQ.5 knowledge-base inventory"): with the network
off, a visitor's six representative questions and a counter operator's four are answered from
the cached help; SMS gets the planned notice; a counter operator never sees the audit articles.

### Security, privacy and capability checks

| Check                                                                         | Evidence                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compilation of every article (schema, Safe Markdown, data patterns, D4, lock) | `kb-compile.test.ts` (committed KB) and `kb-content.test.ts`; `node scripts/build-kb.mjs` in every build                                                                                                                                                                                                              |
| Article existence (deferred from MQ.1)                                        | every registry default exists and is readable on its screen; every body link is a related route                                                                                                                                                                                                                       |
| Screen defaults                                                               | every screen gives at least one default article to every role that can open it                                                                                                                                                                                                                                        |
| Public vs restricted                                                          | public bundle = exactly the visitor-audience articles; no `admin.*` id in it; DB: anonymous endpoint carries no staff ids                                                                                                                                                                                             |
| Role and facility filtering                                                   | DB (`que-kb.db.test.ts`): each role receives exactly the articles its audience metadata allows, with the security-relevant ones named (auditor: no recovery procedure; reception and counter: no audit or approval articles); role grant and revoke change the set; cross-organization users get none of org A's data |
| Role claims                                                                   | `apps/api/src/que-kb-content.test.ts`: 13 step lines and 8 permission lines equal the state machine and permission map; any unchecked role section fails                                                                                                                                                              |
| D4                                                                            | no public article contains the staff verification questions or answers (compiler and tests)                                                                                                                                                                                                                           |
| No tenant or secret data                                                      | compiler data patterns; DB: restricted bundles contain no names, emails, slugs or ids                                                                                                                                                                                                                                 |
| No unsafe Markdown or external links                                          | schema plus an explicit lint over every body                                                                                                                                                                                                                                                                          |
| Capability truth                                                              | SMS/USSD only behind planned capabilities (manifest the server builds); push withheld without VAPID; no manifest withholds every capability-dependent article; no article is dated before its capability                                                                                                              |
| Truthfulness lint                                                             | no "conflict-free"/"globally final", no tamper-proof claims, no guaranteed delivery, no clock times, no background vibration, recovery never moves a visitor, a failed alert never causes a miss, policy described conditionally                                                                                      |
| AI grounding                                                                  | DB: the adapter receives only articles a counter operator may read                                                                                                                                                                                                                                                    |

**Mutation checks** (each change made a test fail, then was reverted; 8 applied, 8 killed): SMS
named in the in-app alert article; a facility admin claimed for Call next; a registry default
pointing to a missing article; the audit article given to counter staff; a clock time promised;
recovery claimed to move a visitor; the push article no longer gated on Web Push; a staff
verification answer added to a public article (refused by the compiler's D4 check).

### Gate results (local, 2026-11-18)

| Gate                                                             | Result                                                                                                                                                    |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build` | pass                                                                                                                                                      |
| `pnpm test`                                                      | contracts 179, assist 235 (+73), api 172 (+29), web 168, domain 109, continuity 64, channels 33, worker 12, ui 6                                          |
| `pnpm test:db`                                                   | api 677 (+1), worker 63                                                                                                                                   |
| Playwright (4 projects)                                          | 285 passed (+2), 7 skipped (the same pre-existing conditional and phone-only skips)                                                                       |
| Security gates                                                   | `pnpm audit --prod --audit-level high` clean; `node infra/scripts/audit-gate.js` PASS (only the approved, still unresolved GHSA-fc5q-39xc-vjpf exception) |
| Bundle                                                           | main chunk 188.14 kB gzip (unchanged); Ask Que panel chunk 8.46 → 8.65 kB gzip; public KB asset 5.69 kB gzip                                              |

**Existing assertions updated because the content they pinned grew** (intent kept, sets still
exact): the KB delivery DB tests, the restricted-cache Playwright tests and the AI grounding test
previously listed the four MQ.2 articles by name. They now derive the exact expected set from
each article's audience metadata (`expectedFor`, `e2e/kb-expected.ts`) and also name the
security-relevant inclusions and exclusions. The visitor D4 browser test now checks that no
staff-only title appears, instead of a two-title allow-list. The stale-version test marks one
article as outdated in the full index.

### Defects found

- **Fixed (Ask Que, MQ.3):** when a question matched nothing, the visible lead said "No help
  article matched your question. Here is help for this screen." but the screen-reader
  announcement counted the screen defaults ("4 help articles found."). Before MQ.5 the home
  screen had no defaults, so the two never disagreed. `answer.ts` now exports the `NO_MATCH`
  lead and `QuePanel.tsx` announces a no-match whenever the answer starts with it. The existing
  Playwright test that caught it passes unchanged.
- **Tooling:** Prettier rewrote long front-matter lists over several lines, which the KB
  compiler does not read. `.prettierrc.json` now sets `embeddedLanguageFormatting: off` for
  `packages/assist/knowledge/**/*.md` only; bodies are still formatted and checked.
- **Five UI inconsistencies: OPEN, deferred to M7 (not resolved).** Each was checked for a
  server-side authorization bypass or an integrity defect; none was found, so the UI correction
  is deferred to M7 under the approved rule. They are tracked as unchecked items in `tasks.md`
  (M7.1, "MQ.5 UI findings U1–U5"). The articles describe the API and state-machine behaviour.

| ID  | Current API / state-machine behaviour (authoritative)                                                                                                                                           | Current UI behaviour                                                                                 | Correct future UI behaviour (M7 acceptance)                                                                                                            | Authorization or integrity impact                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| U1  | The grace window is counted from the moment the ticket was marked missed (`missed_at` + `grace_window_seconds`, `apps/api/src/queue/commands.ts`)                                               | The service form hint says "How long a called visitor may take to arrive before being marked missed" | The hint states that the window starts when the ticket is marked missed and limits how long it can still return to the queue                           | None: help text only; the server computes the window                                |
| U2  | `call_specific` is allowed only to supervisors (plus organization admins); a facility admin gets 403, the denial is logged and no event is written (new DB test in `fairness.db.test.ts`, MQ.5) | Facility admins see the "Call out of order" form under "Supervisor actions"                          | The form is shown only to roles the transition allows (supervisor, organization admin); facility admins keep "Change priority"                         | None: the API refuses and records the attempt; no queue state changes               |
| U3  | A transfer keeps `joined_at`; the queue place follows the destination's transfer placement policy (keep waiting time, or join the end)                                                          | The ticket page always says "Your original join time is kept."                                       | The note states the actual placement: original waiting time kept, or joined the end of the queue                                                       | None: display text; the server sets the place                                       |
| U4  | The automatic no-show records `ticket.miss` with actor `system` and reason `call_window_elapsed` in the hash-chained event (M5 tests 8.R9 and 8.R12)                                            | The audit trail shows "Missed" by "Visitor / system", with no reason label                           | The audit trail shows the actor as the system and a plain label for the reason (for example "Call window elapsed")                                     | None: the event and its reason are recorded and verified; only the label is missing |
| U5  | The state machine allows `waiting → paused` for counter operators and supervisors                                                                                                               | The console offers "Put on hold" only for a ticket being served                                      | Either offer "Put on hold" for waiting tickets to the allowed roles, or record a product decision that waiting tickets are not paused from the console | None: a missing control, not an extra permission                                    |

- **Related content note (not a UI defect):** the pages never state the three-device limit or
  the 24-hour status-link lifetime; the recovery-key article now states the device limit.

### Checkpoint verification (2026-11-18)

- **No-results announcement fix:** a matching search still announces "N help articles found"
  and a failed search announces no match even when screen defaults are shown (Playwright
  "screen context…" and "empty results…"); the visible lead and the announcement agree. The fix
  depends on `answer()` starting the text with `NO_MATCH` exactly when nothing matched; a new
  unit test in `answer.test.ts` pins that (miss, hit and empty question).
- **Prettier override scope:** the same sample was formatted under four paths: front matter is
  kept on one line only under `packages/assist/knowledge/`; under `docs/` and elsewhere in
  `packages/assist` it is still reformatted. Article bodies are still formatted (blank lines
  around blocks) and `pnpm format:check` covers them; every article compiles.
- **Ids and versions:** the four staging articles keep their ids and paths (all at version 2);
  44 lock entries; every compiled article's version equals its lock version; every bundle is
  `kbVersion` 2; all 20 ids of design §11.10a exist.
- **U2 authorization:** new DB test in `fairness.db.test.ts`: a facility admin's out-of-order
  call is refused (403), the denial is logged, no queue event is written and the ticket stays
  waiting.

### Remaining content gaps

- No review by real visitors or staff and no second human reviewer.
- English only; no second language.
- The SMS and USSD article bodies are minimal placeholders; M6 must rewrite them in the same PR
  that changes those capabilities (MQ.6 rule).
- Not covered in depth: closing a queue session during an outage, the `Needs review` ticket
  state as seen by a visitor, "Clear local data on this device", and a "how to use Ask Que"
  article.
- Search is deterministic keyword ranking: questions using words outside an article's title,
  keywords and headings may miss it. The matrix tests 43 questions, not every phrasing.

### Obligations carried forward

- **MQ.6** implements the ongoing KB consistency rule and CI check (Group 13.5) for later
  milestones; MQ.5 added only the checks its own acceptance needs.
- **M6** updates the SMS and USSD articles and capability entries together.
- **M7** reviews every article against the final UI and the capability manifest.
- No provider selected — AI disabled by default; any real provider needs separate product-owner
  approval. M5 Set 2 manual acceptance stays deferred. The picomatch exception remains
  unresolved and expires on 2026-12-15T00:00:00Z.

## MQ.6 Knowledge-base maintenance and CI consistency (2026-11-19)

**Branch:** `feature/mq6-kb-consistency` from `staging` at `5149c54` (PR #16 merged; CI green).
**Scope:** MQ.6 only (tasks.md). No M6 or M7 work, no AI activation or provider selection, no
change to the Ask Que architecture, roles or queue behaviour.

### The maintenance rule

Every PR that changes user-visible behaviour, a capability, a route or a screen label updates the
affected articles, the capability coverage contract and the registry screen defaults in the same
PR. Recorded in `AGENTS.md` §4.7, `packages/assist/knowledge/README.md` (rule table and the M6
and M7 procedures) and `.github/pull_request_template.md`. CI enforces it; the template is a
reminder only.

### What was built

- **Capability coverage contract** `packages/assist/knowledge/capabilities.json`: for each of
  the 16 manifest capabilities, the status and default availability its articles were reviewed
  for, and the articles that document it. Shipped with the build as `dist/kb/capabilities.json`.
- **Consistency checker** `packages/assist/src/kb-consistency.ts` (pure, imports `contracts`
  only; covered by the package boundary test). Rules:

| Rule | Fails when                                                                                                                                      | Runs in             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| C0   | the contract is malformed                                                                                                                       | build, assist tests |
| C1   | a manifest capability has no contract entry, or the contract names an unknown one                                                               | build, assist tests |
| C2   | a capability lists no article, or a missing one                                                                                                 | build, assist tests |
| C3   | an article requires a capability without being listed under it                                                                                  | build, assist tests |
| C4   | the server manifest status differs from the reviewed status                                                                                     | API test            |
| C5   | the server default availability differs from the reviewed one                                                                                   | API test            |
| A1   | a shown article says its feature is "not offered" or "not available yet"                                                                        | API test            |
| A2   | an article for a `sandbox` or `preview` capability does not label it                                                                            | API test            |
| A3   | an article dated after the newest shown milestone is not gated on a non-live capability                                                         | API test            |
| R1   | an article relates a route none of its audiences can open                                                                                       | build, assist tests |
| R2   | a body link is not a related route                                                                                                              | build, assist tests |
| R3   | a screen default article does not exist                                                                                                         | build, assist tests |
| V1   | a review date is in the future                                                                                                                  | API test            |
| V2   | against the base branch's lock: content changed without a version bump, a version went backwards, or the set changed without a `kbVersion` bump | CI step             |
| L1   | an article quotes a screen label (bold) that no longer exists in `apps/web`, `packages/ui` or `packages/domain`                                 | web test            |

- **Where CI runs them:** every `pnpm build` (the build job and every test job) runs
  `scripts/build-kb.mjs`, which now also applies C0–C3 and R1–R3; `pnpm test` (job "Tests
  (without DB)") runs `kb-consistency.test.ts`, `apps/api/src/que-kb-consistency.test.ts` and
  `apps/web/src/que/kbUiLabels.test.ts`; the same job runs the new step "Knowledge-base version
  discipline against the base branch" (`scripts/kb-base-check.mjs`, base = the PR's target
  branch, `staging` for pushes; the job checks out full history). The base branch name reaches
  the shell through an environment variable, and the script calls git without a shell.
- **Server manifest:** `que-kb-consistency.test.ts` builds the manifest from the real
  environment schema with production defaults (no optional settings), so C4/C5 compare with what
  a production deployment reports; the content rules are also checked with Web Push configured,
  online joining switched off and the TEST-ONLY sandbox AI.
- **Group 13.5 VAPID fixture (design §11.2, D1):** with VAPID absent the manifest reports Web
  Push `live` / `unavailable` / `not_configured`, and no answer for visitor, counter or
  supervisor questions offers push as usable.

**Content corrections found by the new rules** (knowledge-base version 3):
`org.signup` (version 2) no longer relates and links the administration screen, which an
anonymous visitor cannot open (R1); `admin.services` (version 2) quotes the real form legend
"Reasons a supervisor may give for an override" (L1). Both were checked against staging's lock
(V2).

### Applicability to M6 and M7 (no future redesign needed)

- **M6 SMS turn alerts and USSD:** changing `sms_turn_alerts` or `ussd` in the server manifest
  fails C4/C5 (contract), A1 (the planned articles say "not offered here") and A2 (sandbox not
  labelled) until the articles are rewritten and the contract updated. A unit test shows both the
  failure and the compliant end state (`kb-consistency.test.ts`, "path to compliance"). A new
  channel capability fails C1 until it has a contract entry and C2 until it is documented.
- **M7 redesign and onboarding:** a renamed or removed control fails L1; a new screen fails D3
  check 2 (router ⇔ registry) and the MQ.5 screen-default check; onboarding content dated M7
  must stay gated until live (A3); every new article must join the MQ.5 coverage matrix.

### CI-enforcement evidence (mutations)

Each mutation simulates a later-milestone change made without the KB update and runs the same
command CI runs; every touched file was restored afterwards (verified byte-identical).
11 applied, 11 rejected:

| #   | Mutation                                                                     | Rejected by                                                               |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | M6: `sms_turn_alerts` becomes `sandbox` in the server manifest, KB untouched | API test (C4, C5, A1, A2)                                                 |
| 2   | Web Push becomes available by default, articles not reviewed                 | API test (C5)                                                             |
| 3   | M7: "Issue walk-in ticket" renamed in the console                            | web test (L1)                                                             |
| 4   | M7: a new `/get-started` route without a registry entry                      | web D3 check 2                                                            |
| 5   | `ussd` removed from `capabilities.json`                                      | build (C1)                                                                |
| 6   | an article newly gated on `device_health` without a contract entry           | `kb:lock` / build (C3)                                                    |
| 7   | a public article relates the staff audit screen                              | `kb:lock` / build (R1)                                                    |
| 8   | a live article says "not available yet"                                      | API test (A1)                                                             |
| 9   | a review date in the future                                                  | API test (V1)                                                             |
| 10  | content changed without a version bump and the lock regenerated from scratch | the normal build passes (expected); the CI base-lock step rejects it (V2) |
| 11  | question text added to the AI log line                                       | DB test (13.9, below)                                                     |

### MQ exit criteria

| Criterion                      | Evidence                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13.1 Role restrictions         | `que-kb.db.test.ts` (each role receives exactly its articles; auditors never get the recovery procedure; reception and counter never get audit or approval articles); `que-ask.db.test.ts` (401 anonymous); `kb-content.test.ts`; `que-ui.spec.ts` (staff help, auditor)                                                   |
| 13.2 Tenant isolation          | `que-consistency.test.ts` (D3 check 5); `que-kb.db.test.ts` (other organization); `que-ask.db.test.ts` (cross-organization 404 for ask and opt-in)                                                                                                                                                                         |
| 13.3 Offline fallback          | `que-offline.spec.ts`; `que-ui.spec.ts` (MQ.3 offline, MQ.5 inventory offline)                                                                                                                                                                                                                                             |
| 13.4 Navigation accuracy       | `que-consistency.test.ts` (registry ⇔ router), `registry.test.ts`, `links.test.ts`, `kb-content.test.ts` (existence, screen defaults, coverage matrix), `que-kb-content.test.ts` (role claims)                                                                                                                             |
| 13.5 KB consistency            | MQ.6 rules above; MQ.5 checks; VAPID-absent fixture                                                                                                                                                                                                                                                                        |
| 13.6 Accessibility             | `que-ui.spec.ts` (axe at desktop and the mobile sheet, keyboard open/search/read/close, focus return, announcements, no-match announcement); `que-ai.spec.ts` (axe, AI label as text)                                                                                                                                      |
| 13.7 Inference failures        | `que-ask.db.test.ts` (disabled, timeout, quota, provider error, malformed, foreign or empty citations → deterministic answer with the right reason); `que-ai.spec.ts`                                                                                                                                                      |
| 13.8 Zero-cost guard           | `que-inference.test.ts`, `que-ask.db.test.ts` (each switch alone keeps AI off; daily cap)                                                                                                                                                                                                                                  |
| 13.9 Privacy                   | `ai-guard.test.ts` (redaction); `que-ask.db.test.ts` (the adapter receives only the redacted question and authorized articles); **new at MQ.6:** a real `/que/ask` round trip captures every API log line and finds no question or answer text, with `[SANDBOX]` marked (the design stated it; no test asserted it before) |
| 13.10 Read-only                | `que-ask.db.test.ts` (queue events, tickets, client operations, roles and staff unchanged); `que-ui.spec.ts` (help controls only, GET requests only)                                                                                                                                                                       |
| 13.11 Prompt injection         | `ai-guard.test.ts` (42 tests); `que-ask.db.test.ts` (injected instructions, claimed actions, links, markup, capability claims)                                                                                                                                                                                             |
| 13.12 Offline authorization    | `offlineHelp.test.ts`, `helpClient.test.ts`, `que-kb.db.test.ts` (`authorizedUntil`, `validForMs`, short TTL), `que-offline.spec.ts`                                                                                                                                                                                       |
| 13.13 AI independence          | AI is off by default in every unit and DB suite (the sandbox runs only where a suite enables it); the deterministic paths of the browser suites never call AI (the facility opt-in is off by default); the coverage matrix is answered with no AI and from the public bundle alone                                         |
| No Que write path              | as 13.10; the only writes are the aggregate AI counter and the admin-only, audited opt-in on the facility settings screen                                                                                                                                                                                                  |
| AI disclosed, cited, validated | `ai-guard.test.ts`, `que-ask.db.test.ts`, `que-ai.spec.ts`; no provider selected — AI disabled by default                                                                                                                                                                                                                  |

### Gate results (local, 2026-11-19)

| Gate                                                             | Result                                                                                                                                              |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build` | pass                                                                                                                                                |
| `build-kb.mjs --base-lock` (staging's lock)                      | version discipline verified (kbVersion 2 → 3)                                                                                                       |
| `pnpm test`                                                      | contracts 179, assist 260 (+25: 23 consistency, 2 boundary), api 182 (+10), web 171 (+3), domain 109, continuity 64, channels 33, worker 12, ui 6   |
| `pnpm test:db`                                                   | api 678 (+1), worker 63                                                                                                                             |
| Playwright (4 projects)                                          | 285 passed, 7 skipped (the same pre-existing conditional and phone-only skips)                                                                      |
| Security gates                                                   | `pnpm audit --prod --audit-level high` clean; `node infra/scripts/audit-gate.js` PASS (only the approved, unresolved GHSA-fc5q-39xc-vjpf exception) |

**Local environment note:** the first full Playwright run had 119 failures because Docker
Desktop stopped during the run and took the local PostgreSQL container with it (sign-up
returned 500 from then on). After restarting Docker and `queuebridge-pg` (as
`docs/local-environment.md` describes) the full suite passed. No code was involved.

### Checkpoint review (2026-11-19)

**Corrected at the checkpoint: the base-branch version step.** As first written it compared
with the base branch's tip from a depth-1 checkout. That was wrong in three ways: a push run on
a branch that is behind `staging` would fail when `staging` had changed articles since the
branch left it; a merge base could not be computed in a shallow clone; and the eventual
`staging` → `main` release PR would fail with a confusing `git show` error, because `main` has no
knowledge base yet. It is now `packages/assist/scripts/kb-base-check.mjs`, run with the job's
full history (`fetch-depth: 0`) after an explicit fetch of the base branch:

- it compares with the lock at the **merge base** of `HEAD` and the base branch (for
  `pull_request` runs, `HEAD` is GitHub's merge commit, so the merge base is the base tip; for
  pushes it is where the branch left `staging`);
- it **fails** when the ref does not resolve, there is no merge base (shallow or unrelated
  history), the base lock is not valid JSON or is malformed, or version discipline breaks;
- a base with no knowledge-base lock is **reported explicitly** and has nothing to compare.

Verified locally:

| Case                                                                         | Result                                                                           |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `origin/staging` (valid)                                                     | pass, merge base `5149c54`, kbVersion 2 → 3                                      |
| `origin/does-not-exist`                                                      | FAIL: does not resolve to a commit                                               |
| an unrelated commit (no shared history)                                      | FAIL: no merge base                                                              |
| a commit whose lock is not valid JSON (temporary detached worktree, removed) | FAIL: not valid JSON                                                             |
| an option-looking ref (`--help`)                                             | FAIL: usage                                                                      |
| `origin/main` (no knowledge base yet)                                        | reported: nothing to compare (exit 0)                                            |
| content changed, no version bump, lock regenerated from scratch              | normal build passes; this check FAILS ("content changed without a version bump") |
| the same change with the article and `kbVersion` bumped                      | pass                                                                             |

**Capability semantics (6 more unit tests):** lifecycle status (C4) and deployment
availability with its server-computed reason (C5) are compared separately, and the wording rules
(A1, A2) use the status only. Tests now show:

- SMS or USSD made `live` and `available` fails C4 and C5 while the contract is unreviewed, and
  A1 while the article is unreviewed;
- a different unavailable reason fails C5 only;
- an unavailable entry without a reason fails closed;
- a status change with the same availability fails C4 only;
- push configured, joining switched off and the sandbox AI raise no content violation.

C4 and C5 compare only with the production-default manifest, which is what the articles are
written for, so a deployment's legitimate configuration never fails the contract.

### Remaining findings

- **Branch protection (read 2026-11-19, not changed):** `staging` and `main` are not protected
  (`GET /branches/<b>/protection` 404 "Branch not protected", `protected: false`), and the
  repository has no rulesets (`/rulesets` and `/rules/branches/<b>` empty). The checks therefore
  fail a non-compliant PR's CI, but nothing technically prevents merging it: merge blocking is
  procedural only (`AGENTS.md` §6, "never merge without a passing CI run"). Making the checks
  required is a repository-owner decision; for a private repository it may depend on the GitHub
  plan, which was not checked.
- **L1 is a text match:** a quoted label must appear somewhere in the screen source. It catches
  renamed and removed labels, not labels that move to another screen.
- **A1/A2 are wording rules** with fixed phrases ("not offered", "not available yet",
  "sandbox", "test only", "preview"). New phrasings need the rules extended.
- **V2 compares with the merge base only:** it cannot detect history rewritten on the base
  branch itself. A base without a knowledge base (today `main`) is reported and has nothing to
  compare; the normal lock check still runs in every build.
- The MQ.5 UI findings U1–U5, M5 Set 2 acceptance, the picomatch exception (expires
  2026-12-15) and "No provider selected — AI disabled by default" remain as recorded.
- The remote branch `fix/m5-device-health-stale-fixture-race` (PR #16, merged) still exists on
  GitHub; it was not part of the earlier cleanup and was left alone.
