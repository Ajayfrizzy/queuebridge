# QueueBridge

**Resilient, accessible, accountable queue-coordination platform**

QueueBridge keeps service moving through unreliable connectivity across web, staff-assisted, SMS, and USSD channels. Built for the **Kiroween 2026** hackathon.

---

## What makes QueueBridge different

QueueBridge is not a QR ticket generator. Its key differentiator is the **Continuity Engine** — a system that:

- Keeps designated queue operations running during internet outages
- Ensures offline-captured operations are safely reconciled (never silently overwritten) when connectivity returns
- Surfaces conflicts for supervisor review rather than claiming false consistency
- Provides an inclusive, accessible experience for visitors without smartphones (SMS, USSD, staff-assisted)

## Feature overview

| #   | Feature                                          | Status |
| --- | ------------------------------------------------ | ------ |
| F1  | Offline-first queue operations                   | M3     |
| F2  | Inclusive registration (web, staff, SMS, USSD)   | M2/M6  |
| F3  | Queue fairness and transparency                  | M4     |
| F4  | Ticket recovery and missed-turn handling         | M5     |
| F5  | Adaptive service routing                         | M4     |
| F6  | Explainable wait-time estimates                  | M2     |
| F7  | Accessibility-first visitor experience           | M5     |
| F8  | Tamper-evident operational history               | M4     |
| F9  | Connectivity and recovery dashboard              | M3     |
| F10 | Portable facility setup                          | M1     |
| F11 | Real SMS (sandbox ready; live pending provider)  | M6     |
| F12 | Real USSD (sandbox ready; live pending provider) | M6     |

## Architecture

```
apps/web      → React 19 PWA (visitor, staff, supervisor, public board)
apps/api      → Fastify 5 API (tenant auth, queue service, sync)
apps/worker   → Notification outbox worker

packages/contracts   → Zod schemas, enums, API types
packages/domain      → Ticket state machine, routing, wait-time (zero I/O)
packages/continuity  → Offline commands, reconciliation, epoch checks
packages/channels    → SMS/USSD adapter interface + sandbox implementations
packages/ui          → Accessible React components

infra/migrations/    → Numbered idempotent SQL migrations
infra/seeds/         → Development fixture data
docs/adr/            → Architecture Decision Records (ADR-001 through ADR-010)
```

See [`docs/QueueBridge_Technical_Architecture_v1.0.md`](docs/QueueBridge_Technical_Architecture_v1.0.md) for the full architecture specification.

## Local development setup

### Prerequisites

- **Node.js 24+** (`node --version`)
- **pnpm 9+** (`npm install -g pnpm@9`)
- **PostgreSQL 16+** (local install or Docker)

### Quick start

```bash
# 1. Clone and install
git clone https://github.com/your-org/queuebridge
cd queuebridge
pnpm install

# 2. Configure environment (details: docs/local-environment.md)
cp .env.example .env          # DATABASE_URL / TEST_DATABASE_URL → localhost:55433 (queuebridge-pg)
pnpm env:generate             # fresh random secrets + audit key id; values are never printed

# 3. Build, load the environment (EVERY terminal — nothing reads .env automatically) and check
pnpm build
set -a; source .env; set +a
pnpm env:check                # API + worker parse .env, same audit key, DB identity → READY

# 4. Database (identity-guarded: refuses any non-QueueBridge database, changes nothing)
pnpm db:check                 # read-only status
pnpm db:migrate
pnpm db:seed                  # optional: load dev fixture data

# 5. Start development servers (each in a terminal with the environment loaded)
pnpm dev:api                  # Fastify API on http://localhost:3002
pnpm dev:web                  # Vite/React on http://localhost:5173
pnpm dev:worker               # Audit checkpoint worker (one pass: node apps/worker/dist/worker.js --once)
```

### Running tests

```bash
pnpm test                     # all unit/integration tests (no DB required)
pnpm test:db                  # database-dependent tests (requires TEST_DATABASE_URL)
pnpm typecheck                # TypeScript strict mode check
pnpm lint                     # ESLint (zero errors required)
pnpm format:check             # Prettier formatting check
```

### Database operations

```bash
pnpm db:migrate               # apply pending migrations
pnpm db:seed                  # load development fixtures
pnpm db:reset                 # ⚠️  drop and recreate schema (dev only)
```

## Project structure

```
queuebridge/
├── apps/
│   ├── web/          # React PWA
│   ├── api/          # Fastify API
│   └── worker/       # Notification worker
├── packages/
│   ├── contracts/    # Zod schemas, types, enums
│   ├── domain/       # Pure business logic (no I/O)
│   ├── continuity/   # Offline sync logic
│   ├── channels/     # SMS/USSD adapters
│   └── ui/           # React components
├── infra/
│   ├── migrations/   # SQL migrations (idempotent)
│   └── seeds/        # Dev fixture data
├── docs/
│   ├── adr/          # Architecture Decision Records
│   └── testing/      # Test evidence
├── .kiro/
│   ├── steering/     # Kiro persistent guidance
│   └── specs/        # Spec-driven development artifacts
├── .github/
│   └── workflows/    # GitHub Actions CI
├── AGENTS.md         # AI agent instructions
└── M0-completion.md  # M0 implementation report
```

## Kiro contribution

QueueBridge was developed with substantial Kiro assistance across every phase:

- **Spec creation**: Requirements, design, and task files in `.kiro/specs/queuebridge/` authored with Kiro
- **Steering files**: Always-on product, architecture, security, and testing guidance in `.kiro/steering/`
- **AGENTS.md**: Engineering rules, security standards, and validation requirements
- **Implementation**: Package implementations, database schema, CI workflows, ADRs, and test suite
- **Architecture review**: ADR-001 through ADR-010 reviewed and refined with Kiro guidance

See `M0-completion.md` for a detailed account of Kiro's contributions.

## Milestones

| Milestone | Scope                                          | Status         |
| --------- | ---------------------------------------------- | -------------- |
| M0        | Foundation, contracts, config, CI, migrations  | ✅ In progress |
| M1        | Tenancy, roles, facility/service/counter setup | Planned        |
| M2        | Online queue, visitor flows, staff console     | Planned        |
| M3        | Continuity Engine, offline sync, conflict UI   | Planned        |
| M4        | Fairness, overrides, audit, routing, ETA       | Planned        |
| M5        | Recovery, accessibility, device health         | Planned        |
| M6        | SMS/USSD adapters, sandbox tests               | Planned        |
| M7        | Hardening, demo data, submission               | Planned        |

## License

MIT — see [LICENSE](LICENSE).
