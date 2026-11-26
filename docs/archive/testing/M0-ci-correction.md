# M0 CI Correction Report

**Date:** 2026-11-01  
**Branch:** feature/m0-foundation  
**Base commit:** c847a8723a345dafa2a6d57c45031014d8006f4f  
**Workflow runs analysed:** CI `41234446036`, Database Validation `41234445991`

---

## Summary

Four failures were confirmed in GitHub Actions on `feature/m0-foundation`. All four root causes have been
fixed. Local validation of all M0 exit criteria now passes, including actual PostgreSQL migration and
constraint verification. The lockfile has been regenerated. No scope was reduced.

---

## Failure 1 — `postgres` package not resolvable from infra scripts

### Root cause

`infra/scripts/migrate.js`, `seed.js`, and `reset.js` each begin with:

```js
import postgres from 'postgres';
```

These scripts are invoked from the workspace root (`pnpm db:migrate`, etc.), but `infra/` is not a pnpm
workspace package (not listed in `pnpm-workspace.yaml`). Node resolves bare imports relative to the calling
script's directory, walking up through `node_modules` directories. The `postgres` package existed only in
`apps/api/node_modules` and `apps/worker/node_modules` — not in root `node_modules` — because the root
`package.json` declared no `postgres` dependency.

Both the `test-db` CI job in `ci.yml` and the `migrate-and-validate` job in `db-validate.yml` run
`node infra/scripts/migrate.js` after `pnpm install --frozen-lockfile`, producing
`ERR_MODULE_NOT_FOUND: Cannot find package 'postgres'`.

The original M0 report misdiagnosed this as "PostgreSQL not available locally" — the real bug was a missing
root dependency regardless of database availability.

### Fix

Added `"postgres": "3.4.5"` to root `package.json` `devDependencies`. After `pnpm install`, the package is
available in root `node_modules` and all three scripts resolve it correctly.

### Verification

```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/queuebridge_test \
  node infra/scripts/migrate.js
# Output: APPLY 0001_initial_schema.sql / APPLY 0002_append_only_trigger.sql / Applied 2 migration(s).

# Second run:
# Output: SKIP 0001_initial_schema.sql (already applied) / SKIP 0002_append_only_trigger.sql (already applied) / No new migrations to apply.
```

---

## Failure 2 — Prettier formatting violations

### Root cause

`docs/testing/M0-evidence.md` and `M0-completion.md` were committed with formatting differences from Prettier's
Markdown rules: trailing spaces on front-matter lines and misaligned table pipes. Prettier's `--check` mode
flags any byte-level difference.

### Fix

Ran `pnpm prettier --write docs/testing/M0-evidence.md M0-completion.md`. `pnpm format:check` now exits 0.

---

## Failure 3 — 68 security advisories (4 critical, 19 high)

### Root cause

Direct dependencies were pinned to versions that have since received CVE disclosures:

| Package                            | Pinned version | CVE range                                              |
| ---------------------------------- | -------------- | ------------------------------------------------------ |
| `vitest`                           | `2.1.8`        | `>=2.0.0 <2.1.9` (critical) and `<3.2.6` (critical)    |
| `tinypool` (transitive via vitest) | `1.1.1`        | `<=2.1.0` and `<2.1.2` (critical)                      |
| `fastify`                          | `5.2.1`        | `>=5.0.0 <=5.3.1` and `<5.12.2` (high)                 |
| `vite`                             | `6.0.5`        | `>=6.0.0 <=6.4.1` and `<=6.4.3` (high)                 |
| `react-router-dom`                 | `7.1.1`        | `>=7.0.0` multiple CVEs through `<7.18.0` (high)       |
| `zod`                              | `3.24.1`       | `<4.6.6` (high) — CVE-2023-54404, array exhaustion DoS |

The `tinypool` criticals were transitive through `vitest@2.x` — upgrading to `vitest@4.x` resolves them
because v4 removed `tinypool` from its dependency tree entirely.

### Dependency upgrades applied

| Package                                           | Old      | New      | Notes                                                            |
| ------------------------------------------------- | -------- | -------- | ---------------------------------------------------------------- |
| `vitest` + `@vitest/coverage-v8` (all 8 packages) | `2.1.8`  | `4.1.12` | Resolves 4 criticals (vitest + tinypool CVEs); v4 drops tinypool |
| `fastify` (apps/api)                              | `5.2.1`  | `5.12.7` | Resolves 5 high fastify CVEs                                     |
| `vite` (apps/web)                                 | `6.0.5`  | `6.4.5`  | Resolves 2 high vite CVEs                                        |
| `react-router-dom` (apps/web)                     | `7.1.1`  | `7.18.5` | Resolves 7 high react-router CVEs                                |
| `zod` (contracts, api, web, worker)               | `3.24.1` | `4.6.7`  | Resolves 1 high CVE-2023-54404                                   |
| `@vitejs/plugin-react` (apps/web)                 | `4.3.4`  | `5.2.0`  | Required: v6+ needs vite 8; v5 supports vite 6                   |

### Code changes required by zod 3→4 migration

Zod 4 tightened TypeScript signatures and removed deprecated aliases:

1. **`z.record()` requires explicit key type** (`packages/contracts/src/schemas.ts`, 5 locations):

   - `z.record(z.unknown())` → `z.record(z.string(), z.unknown())`
   - `z.record(z.string())` → `z.record(z.string(), z.string())`

2. **`ZodError.errors` removed** (`apps/api/src/env.ts`, `apps/worker/src/env.ts`):

   - `result.error.errors.map(...)` → `result.error.issues.map(...)`

3. **`packages/ui/src/TicketCard.tsx`** — zod 4 inference required explicit `.map((factor: string, i: number)`

4. **`packages/continuity/src/reconcile.ts`** — switch statement missing `default` branch exposed by stricter
   TS flow analysis; added default that handles unreachable cases safely.

5. **`apps/api/src/app.ts`** — Fastify 5.12 changed `setErrorHandler`'s generic `TError` default from
   `Error` to `unknown`; imported and applied `FastifyError` type.

### Remaining advisories (7 low/moderate — do not block CI)

| Package                                                           | Severity | Notes                                                                                                                                      |
| ----------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `deepmerge@4.3.1` (transitive in vite-plugin-pwa → workbox-build) | Low      | `patched: <0.0.0` — no patched version exists; advisory is a prototype pollution variant with limited exploitability in build-time context |
| `esbuild` (transitive in vite)                                    | Moderate | Build-time only; not deployed                                                                                                              |
| `glob` / `minimatch` (transitive)                                 | Moderate | Build-time only                                                                                                                            |

`pnpm audit --audit-level high` exits 0 with these remaining.

### Result

```
7 vulnerabilities found
Severity: 2 low | 5 moderate
# exit 0
```

---

## Failure 4 — `UNIQUE (organization_id, operation_id)` constraint not verified

### Root cause

The final step in `.github/workflows/db-validate.yml` was a stub:

```yaml
- name: Verify UNIQUE (organization_id, operation_id) on client_operations
  run: |
    echo "Constraint validation complete — all invariants verified."
```

This step always passes regardless of whether the constraint exists or not.

Additionally, the stub in the original PR contained incorrect column names (`facility_id`,
`coordinator_epoch`, `base_revision`, `payload`, `created_at_client`, `schema_version`) that do not exist
in the actual `client_operations` table schema — it would have failed even if run.

### Fix

Replaced the stub with a real SQL test that:

1. Inserts prerequisite records (staff_user → device, required by FK constraints on client_operations)
2. Inserts a valid `client_operations` row
3. Attempts to insert a second row with the same `(organization_id, operation_id)`
4. Asserts the second insert is rejected (exits 1 if it succeeds)

### Verification (local, PostgreSQL 16 via Docker)

```
PASS: Duplicate (organization_id, operation_id) correctly rejected by UNIQUE constraint
```

---

## Complete local validation results (2026-11-01)

All commands run against a clean `pnpm install --frozen-lockfile`:

```
$ pnpm install --frozen-lockfile
Lockfile is up to date, resolution step is skipped
Already up to date

$ pnpm format:check
All matched files use Prettier code style!

$ pnpm lint
(zero output — 0 errors, 0 warnings)

$ pnpm typecheck
(all 8 packages/apps: Done, 0 errors)

$ pnpm build
(all 8 packages/apps build cleanly; vite v6.4.5, PWA built)

$ pnpm test
 ✓ packages/contracts  — 32 tests
 ✓ packages/domain     — 40 tests (29 state machine + 11 wait-estimate)
 ✓ packages/channels   — 18 tests
 ✓ packages/ui         — 6 tests
 ✓ packages/continuity — 11 tests
 ✓ apps/api            — 8 tests
 ✓ apps/worker         — 6 tests
 — apps/web            — passWithNoTests (M5 scope)
Total: 121 tests, 0 failures

$ pnpm audit --audit-level high
7 vulnerabilities found
Severity: 2 low | 5 moderate
# exit 0 ✅

$ DATABASE_URL=postgres://postgres:postgres@localhost:5432/queuebridge_test \
    node infra/scripts/migrate.js
  APPLY 0001_initial_schema.sql
  APPLY 0002_append_only_trigger.sql
Applied 2 migration(s).

$ DATABASE_URL=... node infra/scripts/migrate.js  (second run)
  SKIP  0001_initial_schema.sql (already applied)
  SKIP  0002_append_only_trigger.sql (already applied)
No new migrations to apply.

UPDATE on queue_events:  PASS — rejected by append-only trigger
DELETE on queue_events:  PASS — rejected by append-only trigger
UNIQUE (queue_session_id, sequence): PASS — duplicate rejected
UNIQUE (organization_id, operation_id): PASS — duplicate rejected
```

---

## Files changed

| File                                   | Change                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json`                         | Added `"postgres": "3.4.5"` to devDependencies                                                                                                                     |
| `packages/contracts/package.json`      | `zod` 3.24.1 → 4.6.7; `vitest`/`@vitest/coverage-v8` 2.1.8 → 4.1.12                                                                                                |
| `packages/domain/package.json`         | `vitest`/`@vitest/coverage-v8` 2.1.8 → 4.1.12                                                                                                                      |
| `packages/continuity/package.json`     | `vitest`/`@vitest/coverage-v8` 2.1.8 → 4.1.12                                                                                                                      |
| `packages/channels/package.json`       | `vitest`/`@vitest/coverage-v8` 2.1.8 → 4.1.12                                                                                                                      |
| `packages/ui/package.json`             | `vitest`/`@vitest/coverage-v8` 2.1.8 → 4.1.12                                                                                                                      |
| `apps/api/package.json`                | `fastify` 5.2.1 → 5.12.7; `zod` 3.24.1 → 4.6.7; `vitest`/`@vitest/coverage-v8` 2.1.8 → 4.1.12                                                                      |
| `apps/web/package.json`                | `vite` 6.0.5 → 6.4.5; `react-router-dom` 7.1.1 → 7.18.5; `zod` 3.24.1 → 4.6.7; `@vitejs/plugin-react` 4.3.4 → 5.2.0; `vitest`/`@vitest/coverage-v8` 2.1.8 → 4.1.12 |
| `apps/worker/package.json`             | `zod` 3.24.1 → 4.6.7; `vitest`/`@vitest/coverage-v8` 2.1.8 → 4.1.12                                                                                                |
| `pnpm-lock.yaml`                       | Regenerated for all above changes                                                                                                                                  |
| `packages/contracts/src/schemas.ts`    | `z.record()` calls updated for zod 4 (5 locations)                                                                                                                 |
| `apps/api/src/env.ts`                  | `result.error.errors` → `result.error.issues`                                                                                                                      |
| `apps/worker/src/env.ts`               | `result.error.errors` → `result.error.issues`                                                                                                                      |
| `apps/api/src/app.ts`                  | Added `FastifyError` import; typed error handler parameter                                                                                                         |
| `packages/ui/src/TicketCard.tsx`       | Added explicit types on `.map()` callback                                                                                                                          |
| `packages/continuity/src/reconcile.ts` | Added `default` branch to switch statement                                                                                                                         |
| `.github/workflows/db-validate.yml`    | Replaced stub with real `UNIQUE (organization_id, operation_id)` SQL test                                                                                          |
| `M0-completion.md`                     | Updated Phase 4 table, blockers table, exit criteria, added §9                                                                                                     |
| `docs/testing/M0-evidence.md`          | Prettier formatting fixed                                                                                                                                          |
| `docs/testing/M0-ci-correction.md`     | This report                                                                                                                                                        |

---

## Remaining risks

1. **PostgreSQL `test-db` CI job** depends on the `build` step completing first (migrations reference compiled
   packages). The job already calls `pnpm build` before running migrations — correct.

2. **`eslint@9.17.0` deprecation warning** appears in `pnpm install` output. Not a security issue; ESLint 9.17
   is the latest 9.x release. Will be addressed when ESLint 10 stabilises.

3. **`apps/web` has no tests** — `passWithNoTests: true` suppresses CI failure. Visitor flow tests deferred to M5.

4. **7 low/moderate advisories** — all transitive build-time deps. `deepmerge` has no upstream fix. These are
   acceptable at `--audit-level high` threshold.
