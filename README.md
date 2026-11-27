# QueueBridge

**Resilient, accessible, accountable queue-coordination platform**

QueueBridge helps service desks keep track of who is next, even when connectivity drops. Visitors join online or through reception. Staff can record permitted work during an outage, reconcile it on reconnect and explain priority decisions afterward.

## Live application and demo videos

**[Launch the live QueueBridge application](https://queuebridge.rumptycloud.app)** · **[Watch the 2:45 product film on YouTube](https://youtu.be/YRyKmyMb2Ms)**

[![QueueBridge — Service Doesn't Have to Stop (video thumbnail)](https://img.youtube.com/vi/YRyKmyMb2Ms/maxresdefault.jpg)](https://youtu.be/YRyKmyMb2Ms)

*Primary product film: click the thumbnail to watch.*

### Continuity in Action — supplementary technical demonstration

**[Watch the real outage and recovery demonstration (under 3 minutes)](https://youtu.be/pXa5h-StyYM)**

[![QueueBridge — Continuity in Action (video thumbnail)](https://img.youtube.com/vi/pXa5h-StyYM/maxresdefault.jpg)](https://youtu.be/pXa5h-StyYM)

Recorded in the deployed application with fictional demonstration records, this documentary shows a staff workstation losing connectivity, three provisional walk-in registrations saved locally, actual reconnection and reconciliation, confirmed tickets I013–I015, mobile visitor recovery, service completion and audit integrity verification. Offline queue advancement requires a designated coordinator; this recording demonstrates offline registration and subsequent online service. The earlier audit snapshot verifies 54 events, two signed checkpoints and 12 routing decisions, with 19 recent events awaiting checkpoint coverage. [Video evidence and chapters](docs/judging/demo-video.md#supplementary-technical-demonstration)

QueueBridge is a **mobile-first web application** for visitors and a desktop-friendly workspace for reception, counters, supervisors and auditors. The primary product film includes footage from the working Android and desktop web experiences, alongside clearly identified illustrations of offline reconciliation and other workflows.

**For evaluators:** [Visitor entry — Willow Crossing Service Centre](https://queuebridge.rumptycloud.app/join/judge-demo/session-1) · [Staff sign-in](https://queuebridge.rumptycloud.app/login) · [Judge walkthrough and role guide](docs/judging/walkthrough.md). The demonstration uses fictional data; staff passwords are provided separately through the approved private judge channel.

## Why QueueBridge

- **Continue through outages:** One authorized coordinator can record permitted provisional operations offline; the server reconciles and verifies them after reconnecting, including duplicates and conflicts.
- **Make queue order explainable:** Configurable priority policies, service-capable desks, supervisor explanations and clear ticket progress.
- **Include visitors with different needs:** QR/web joining, assisted walk-in registration, accessible display controls, private ticket recovery and best-effort turn alerts.
- **Make operations accountable:** Role-based access, operational history, integrity verification and signed audit checkpoints.
- **Serve multiple facilities:** Organization and facility administration, service/counter setup and isolated staff permissions.

**Channel scope:** SMS and USSD adapters currently run in internal simulation, not live telecom delivery. Optional generative AI is disabled; Ask Que provides curated, role-aware assistance.

## Evaluate QueueBridge

1. [Product overview and real-world impact](docs/judging/overview.md)
2. [Judge Demo access and walkthrough](docs/judging/walkthrough.md)
3. [How the deployed system works](docs/judging/architecture.md)
4. [How the team used Kiro](docs/judging/kiro.md)
5. [Published videos, evidence and original recording plan](docs/judging/demo-video.md)

[Submission evidence matrix](docs/judging/submission-review.md) · [Historical inventory](docs/archive/inventory.md) · [Deployment runbook](docs/deployment/RUMPTYCLOUD-DEPLOYMENT.md)

## Architecture

```
apps/web      → React 19 PWA (visitor, staff, supervisor, public board)
apps/api      → Fastify 5 API (tenant auth, queue service, sync)
apps/worker   → Notification outbox worker

packages/contracts   → Zod schemas, enums, API types
packages/domain      → Ticket state machine, routing, wait-time (zero I/O)
packages/continuity  → Offline commands, reconciliation, epoch checks
packages/channels    → SMS/USSD adapter interface, Web Push transport, sandbox implementations
packages/ui          → Accessible React components

infra/migrations/    → Numbered idempotent SQL migrations
infra/seeds/         → Development fixture data
docs/archive/adr/            → Architecture Decision Records (ADR-001 through ADR-015)
```

See [`docs/judging/architecture.md`](docs/judging/architecture.md) for the as-built overview.

## Local development setup

### Prerequisites

- **Node.js 24** (`node --version`)
- **pnpm 9.15.9** (`npm install -g pnpm@9.15.9`)
- **PostgreSQL 16+** (local install or Docker)

### Quick start

```bash
# 1. Clone and install
git clone https://github.com/Ajayfrizzy/queuebridge
cd queuebridge
pnpm install --frozen-lockfile

# 2. Configure environment (details: docs/development/local-environment.md)
cp -n .env.example .env          # DATABASE_URL / TEST_DATABASE_URL → localhost:55433 (queuebridge-pg)
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
pnpm dev:worker               # Notification outbox and audit checkpoint worker (one pass: node apps/worker/dist/worker.js --once)
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
│   ├── archive/      # Historical decisions, reports and evidence
│   ├── development/  # Local setup
│   ├── deployment/   # Operator guides
│   └── judging/      # Judge walkthrough and submission materials
├── .kiro/
│   ├── steering/     # Kiro persistent guidance
│   └── specs/        # Spec-driven development artifacts
├── .github/
│   └── workflows/    # GitHub Actions CI
└── AGENTS.md         # AI agent instructions
```

## Kiro contribution

QueueBridge was developed using **Kiro CLI and Kiro IDE**. The CLI established the project foundation and early implementation; the project owner then moved to the IDE for continued development, using its approval settings to reduce repetitive terminal interruptions.

Kiro's contribution extends beyond scaffolding:

- **Spec-driven development:** Requirements, design and milestone tasks in [`.kiro/specs/queuebridge/`](.kiro/specs/queuebridge) connect product needs to implementation and acceptance criteria.
- **Persistent steering:** [`.kiro/steering/`](.kiro/steering) contains product, architecture, security and testing guidance.
- **Working foundation:** The [M0 completion report](docs/archive/milestones/M0-completion.md) records shared package implementations, database schema, application foundations, architecture decisions and 121 passing initial tests.
- **Implementation traceability:** The [Continuity Engine milestone](docs/archive/milestones/M3-completion.md) connects the offline coordinator decision to authority checks, reconciliation and regression evidence.

Codex also participated in implementation reviews and later hardening and release work. The [documented handover](docs/archive/handover/QUEUEBRIDGE-CODEX-HANDOVER.md) records the transition at M7.3. The Kiro specifications and engineering constraints remained the reference for continued development.

One example is the outage workflow: requirements identify the risk of competing disconnected workstations; the design assigns offline advancement authority to one coordinator; and the tasks specify replay, fencing and conflict-review checks. The [supplementary documentary](https://youtu.be/pXa5h-StyYM) shows actual offline registration and reconciliation in the deployed application.

**[Read the complete Kiro contribution guide](docs/judging/kiro.md)** for the CLI-to-IDE workflow, milestone evidence, architecture traceability and tool attribution.


## Evaluation evidence

The owner reported **89 of 89 manual checks passed** in Owner QA. Judge Demo was provisioned separately with fictional records. Hosted provisioning verification covered six role logins, facility access, the public join endpoint, the seeded queue states and a denied cross-tenant read. Two checkpoints were observed on the new queues. These observations describe the provisioning session. Today's queues and ticket counts can change as people use the demo.

## Milestones

| Milestone | Scope                                                                                                              | Status                           |
| --------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| M0        | Foundation, contracts, config, CI, migrations                                                                      | ✅ Merged into `staging` (PR #1) |
| M1        | Tenancy, roles, facility/service/counter setup                                                                     | ✅ Merged (PR #2)                |
| M2        | Online queue, visitor flows, staff console                                                                         | ✅ Merged (PR #4)                |
| M3        | Continuity Engine, offline sync, conflict UI                                                                       | ✅ Merged (PR #5)                |
| M4        | Fairness, overrides, audit, routing, ETA                                                                           | ✅ Merged (PR #6)                |
| M5        | Recovery, accessibility, device health, Smart Turn Alerts (in-app, sound, vibration, opt-in Web Push; best effort) | ✅ Merged (PR #8)                |
| MQ        | Ask Que Anything (after M5, before M6)                                                                             | Implemented                      |
| M6        | SMS turn alerts and USSD adapters, sandbox tests                                                                   | Implemented                      |
| M7        | Final UI/UX, branding, animated landing page, hardening, demo data, submission                                     | Implemented                      |

## License

MIT — see [LICENSE](LICENSE).
