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
