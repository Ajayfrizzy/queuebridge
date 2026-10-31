# M0 Test Evidence

**Date:** 2026-10-31  
**Branch:** feature/m0-foundation  
**Node:** v24.22.1  
**pnpm:** 9.15.9

## Validation commands and results

### format:check — PASS

```
$ pnpm format:check
All matched files use Prettier code style!
```

### lint — PASS (zero errors, zero warnings)

```
$ pnpm lint
(no output — zero problems)
```

### typecheck — PASS

```
$ pnpm typecheck
packages/contracts  Done
packages/domain     Done
packages/channels   Done
packages/ui         Done
packages/continuity Done
apps/api            Done
apps/worker         Done
apps/web            Done
```

### test — PASS (121 tests across 9 suites)

```
$ pnpm test

packages/contracts   ✓ src/schemas.test.ts          (32 tests)
packages/domain      ✓ src/state-machine.test.ts    (29 tests)
packages/domain      ✓ src/wait-estimate.test.ts    (11 tests)
packages/channels    ✓ src/sandbox.test.ts           (18 tests)
packages/continuity  ✓ src/authority.test.ts         (11 tests)
packages/ui          ✓ src/SyncStateIndicator.test.ts (6 tests)
apps/api             ✓ src/health.test.ts             (8 tests)
apps/worker          ✓ src/env.test.ts                (6 tests)
apps/web             (passWithNoTests — M5 test suite planned)

Total: 121 tests passed, 0 failed
```

### build — PASS

```
$ pnpm build
packages/contracts  Done
packages/domain     Done
packages/channels   Done
packages/ui         Done
packages/continuity Done
apps/worker         Done
apps/api            Done
apps/web            ✓ 40 modules transformed, built in ~515ms
```

### db:migrate — NOT RUN (PostgreSQL not available in this environment)

Migrations verified by inspection:
- `0001_initial_schema.sql` — 29 tables with correct constraints
- `0002_append_only_trigger.sql` — append-only trigger for queue_events
- Both use `IF NOT EXISTS` — idempotent
- GitHub Actions `db-validate.yml` will run these on CI with a PostgreSQL service container

### CI

GitHub Actions workflows defined:
- `.github/workflows/ci.yml` — lint, typecheck, test, build, security audit
- `.github/workflows/db-validate.yml` — migrations, constraint tests

## Test coverage by M0 acceptance requirement

| Requirement | Covered by | Result |
|-------------|-----------|--------|
| Contracts: valid Zod schemas parse | schemas.test.ts | PASS |
| Contracts: invalid inputs rejected | schemas.test.ts | PASS |
| Contracts: CommandEnvelope UUID v7 required | schemas.test.ts | PASS |
| Domain: all valid ticket transitions | state-machine.test.ts | PASS |
| Domain: all invalid transitions rejected | state-machine.test.ts | PASS |
| Domain: unauthorized role rejected | state-machine.test.ts | PASS |
| Domain: policy preconditions enforced | state-machine.test.ts | PASS |
| Domain: priority override validation | state-machine.test.ts | PASS |
| Domain: priority class ordering | state-machine.test.ts | PASS |
| Domain: wait estimate with data | wait-estimate.test.ts | PASS |
| Domain: insufficient_data when no counters | wait-estimate.test.ts | PASS |
| Domain: insufficient_data with < 5 samples | wait-estimate.test.ts | PASS |
| Domain: high/medium/low confidence tiers | wait-estimate.test.ts | PASS |
| Domain: more counters → lower estimate | wait-estimate.test.ts | PASS |
| Continuity: valid epoch accepted | authority.test.ts | PASS |
| Continuity: expired epoch rejected | authority.test.ts | PASS |
| Continuity: wrong action rejected | authority.test.ts | PASS |
| Continuity: null auth rejected | authority.test.ts | PASS |
| Continuity: canAdvanceOffline correct | authority.test.ts | PASS |
| Channels: sandbox never real network | sandbox.test.ts | PASS |
| Channels: [SANDBOX] prefix present | sandbox.test.ts | PASS |
| Channels: message recording for tests | sandbox.test.ts | PASS |
| Channels: USSD menu navigation | sandbox.test.ts | PASS |
| Channels: invalid USSD input handled | sandbox.test.ts | PASS |
| Channels: USSD 182-char limit | sandbox.test.ts | PASS |
| Channels: webhook verify returns true (sandbox) | sandbox.test.ts | PASS |
| UI: SyncStatus config covers all states | SyncStateIndicator.test.ts | PASS |
| UI: committed state labeled distinctly | SyncStateIndicator.test.ts | PASS |
| API: /health returns 200 | health.test.ts | PASS |
| API: /health/ready returns 200 | health.test.ts | PASS |
| API: 404 returns problem+json | health.test.ts | PASS |
| API: env validation rejects missing vars | health.test.ts | PASS |
| Worker: env validation rejects missing DB | env.test.ts | PASS |
| Worker: defaults to sandbox providers | env.test.ts | PASS |

## Notes

- Database-dependent tests (Group 4: concurrent PostgreSQL transactions) are marked `*.db.test.ts` and excluded from `pnpm test` — they run in CI via `test-db` job with a PostgreSQL service container.
- M0 scope is foundational: state machine, contracts, sandbox adapters, API skeleton, and migration definitions. Application features begin at M1.
- All 10 core features remain in scope — M0 establishes the architecture that will carry them.
