# QueueBridge — Permanent Agent and Engineering Instructions

> This file is the authoritative guidance document for every AI agent (Kiro or otherwise) and every human contributor
> working on the QueueBridge codebase. Instructions here govern all milestone work from M0 through M7.
> Do **not** reduce scope, skip validation, or take shortcuts not explicitly approved here.

---

## 1. Project context

QueueBridge is a resilient, accessible, accountable queue-coordination platform for the **Kiroween 2026** hackathon.
It keeps service moving through unreliable connectivity across web, staff-assisted, SMS, and USSD channels.

**Source of truth:**

- Product requirements: `docs/QueueBridge_PRD_v1.0.md`
- Architecture: `docs/QueueBridge_Technical_Architecture_v1.0.md`
- `.kiro/steering/` — persistent per-topic guidance
- `.kiro/specs/queuebridge/` — spec-driven requirements, design, and tasks

All ten core feature groups (F1–F10) plus SMS (F11) and USSD (F12) are **in scope**. Non-goals are listed in the PRD §2.

**Planned addition:** F13 — Ask Que Anything (read-only, deterministic-first navigation assistant
with an optional zero-cost AI layer), milestone MQ between M5 and M6. See PRD Addendum A, REQ-F13
and ADR-011. Do not implement before MQ.

**Planned additions (approved 2026-11-12, PRD Addendum B):**

- **F14 — Smart Turn Alerts (M5):** in-app notification when a visitor is called, optional sound,
  supported foreground vibration, opt-in Web Push, accessible visual fallbacks. Background vibration
  and push delivery are **never** assumed or promised; a failed notification never blocks queue
  progression and never marks a visitor missed. REQ-F14, design §12, ADR-013.
- **SMS Turn Alerts (M6, extends F11):** through the existing channel-adapter architecture; real
  provider support preserved, subject to the zero-personal-spending rule. REQ-F11.8–F11.13, design §13.
- **F15 — Final UI/UX, branding and animated public landing page (M7):** responsive redesign,
  organizational onboarding path, accessibility/performance/security/cross-browser verification.
  REQ-F15, design §14, ADR-014.

**Milestone status (2026-11-12):** M0–M4 are implemented and merged into `staging` (PRs #1–#6).
Order from here: **M5 → MQ → M6 → M7**. Do not implement a later milestone's scope early.

---

## 2. Repository structure

```
queuebridge/
├── apps/
│   ├── web/          # React mobile-first PWA (visitor, staff, supervisor, public board)
│   ├── api/          # Fastify API server
│   └── worker/       # Notification/outbox worker
├── packages/
│   ├── contracts/    # Zod schemas, enums, API DTOs, event schemas
│   ├── domain/       # Ticket state machine, fairness, routing, wait-time — NO DB deps
│   ├── continuity/   # Offline command schema, reconciliation logic, authority checks
│   ├── channels/     # SMS/USSD adapter interfaces and provider implementations
│   └── ui/           # Reusable accessible React components
├── infra/
│   ├── migrations/   # Numbered SQL migrations (repeatable, idempotent where possible)
│   └── seeds/        # Development fixture data
├── docs/
│   ├── adr/          # Architecture Decision Records (numbered, dated)
│   └── testing/      # Test evidence and acceptance reports
├── .kiro/
│   ├── steering/     # Persistent Kiro steering files
│   └── specs/        # Spec-driven development artifacts
├── .github/
│   └── workflows/    # GitHub Actions CI
├── AGENTS.md         # ← this file
├── README.md
└── M0-completion.md  # Generated at M0
```

### Package boundaries (enforced)

| Package                | May import                                                    | Must NOT import                                     |
| ---------------------- | ------------------------------------------------------------- | --------------------------------------------------- |
| `contracts`            | nothing internal                                              | any app or package                                  |
| `domain`               | `contracts`                                                   | `db`, `api`, any Node I/O                           |
| `continuity`           | `contracts`, `domain`                                         | `api`, direct DB calls                              |
| `channels`             | `contracts`                                                   | `domain`, `continuity`, direct DB                   |
| `ui`                   | `contracts`, `ui` deps                                        | `domain`, `continuity`, `channels`, any server code |
| `assist` (planned, MQ) | `contracts`                                                   | any app, DB, network or Node I/O                    |
| `apps/api`             | all packages                                                  | `ui` (server-only)                                  |
| `apps/web`             | `contracts`, `domain`, `continuity`, `ui`                     | `channels` server internals                         |
| `apps/worker`          | `contracts`, `domain` (pure), `channels`, DB client (ADR-012) | `ui`, `continuity` IndexedDB                        |

---

## 3. Technology stack (mandatory — do not substitute without ADR)

| Layer              | Choice                                           | Notes                                                 |
| ------------------ | ------------------------------------------------ | ----------------------------------------------------- |
| Runtime            | Node.js 24                                       | LTS stream                                            |
| Package manager    | pnpm workspaces                                  | `pnpm-workspace.yaml` at root                         |
| Language           | TypeScript 5.x strict mode                       | `strict: true`, no `any` without comment              |
| Frontend framework | React 19                                         | Mobile-first, PWA                                     |
| Build (web)        | Vite                                             | Fast HMR, static output                               |
| API framework      | Fastify 5                                        | Type-safe routes, plugin ecosystem                    |
| Database           | PostgreSQL 16+                                   | Transactional event sequencing                        |
| DB client          | `postgres` (pg) or `@vercel/postgres`-compatible | Raw SQL preferred over heavy ORM                      |
| Schema validation  | Zod 3                                            | Shared across frontend and backend                    |
| Testing            | Vitest                                           | All packages                                          |
| Linting            | ESLint 9 flat-config                             | With TypeScript plugin                                |
| Formatting         | Prettier                                         | 2-space indent, single quotes                         |
| CI                 | GitHub Actions                                   | Free tier                                             |
| Env validation     | `zod` (no dotenv: env comes from the shell)      | `docs/local-environment.md`                           |
| Web Push (from M5) | `web-push` (MIT), VAPID, exact-pinned            | Free open standard; ADR-013; `packages/channels` only |

**Paid services:** explicitly prohibited. Do not add any dependency with a paid tier requirement for local or CI use.

---

## 4. Engineering rules

### 4.1 TypeScript

- `strict: true` everywhere. No `// @ts-ignore` without an explanatory comment and linked issue.
- No `any` without `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reason`.
- Every exported function and class must have explicit return types.
- Prefer `unknown` over `any` for external/untrusted data.
- Use Zod for all external data validation (API inputs, env vars, webhook payloads).

### 4.2 Database

- All schema changes via numbered migrations in `infra/migrations/`. Format: `NNNN_<description>.sql`.
- Migrations must be **idempotent** using `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, etc.
- No migration may drop a column or table without an ADR and explicit human approval.
- **Authoritative sequence invariant:** `(queue_session_id, sequence)` is UNIQUE and append-only. Never update or delete `queue_events` rows.
- Every mutable tenant resource carries `organization_id` and `facility_id` — always filter by both.

### 4.3 API and auth

- Every protected endpoint must validate the session token server-side before accessing any data.
- Tenant isolation: every query involving facility/queue/ticket data must include an organization scope check.
- No sensitive PII (phone numbers, names) in `queue_events.payload` — store in separate encrypted tables.
- CSRF mitigation required for cookie-based auth endpoints.
- Rate limiting on all public-facing endpoints (visitor join, ticket recovery, webhook ingress).

### 4.4 Offline and synchronization

- Offline operations are **never globally final** until the server returns `committed`.
- UI must display one of: `local_only`, `pending_sync`, `committed`, `duplicate`, `needs_review`, `rejected`.
- Operation IDs must be UUID v7 (time-ordered). Deduplication key is `(organization_id, operation_id)`.
- A fenced/expired coordinator epoch must not produce new committed events.
- Do not claim conflict-free distributed consistency — fail visibly and surface review UI.

### 4.5 Audit and integrity

- `queue_events` is append-only. Never issue UPDATE or DELETE on this table.
- Hash chain: `event_hash = SHA256(domain_separator || queue_session_id || sequence || prev_hash || canonical_event_json)`.
- Audit checkpoints must be verifiable independently of application code.
- Priority overrides must record: actor, policy version, reason code, free-text reason, timestamp.

### 4.6 Notifications

- Never claim delivery without a confirmed provider receipt.
- Outbox pattern: insert `notification_outbox` row atomically with the DB transaction that creates the event.
- Idempotency key on every outbound notification — same key must not re-trigger a send.
- SMS/USSD adapters must expose a `ChannelAdapter` interface and a sandbox/test double.
- Mark sandbox traffic unmistakably as test-only in all UI and logs.
- Turn alerts (from M5, ADR-013): enqueue inside a savepoint with no network I/O so alert code cannot
  fail a queue command; alert only for server-committed events; the worker never writes ticket or
  queue tables; no alert outcome may change ticket state or mark a visitor missed; `sent` is not
  `delivered`; never promise background vibration or push delivery in code, UI or docs.
- Push subscriptions are secrets: encrypted at rest, never logged or returned. VAPID private key is
  worker-only environment configuration.

---

## 5. Security standards

### 5.1 Secrets and credentials

- No secrets in source code, ever. Use `.env` files (gitignored) locally and CI secrets in production.
- All `.env.example` files must list every required variable with safe placeholder values.
- Provider credentials (SMS, USSD) must be injectable via environment variables, never hardcoded.

### 5.2 Authentication and authorization

- Passwords must be hashed with bcrypt (cost ≥ 12) or argon2id.
- Session tokens must be cryptographically random, HttpOnly, Secure, SameSite=Strict.
- Recovery credentials: high-entropy random secret, SHA-256 hash stored, original never logged.
- Rate limit recovery attempts: max 5 per 15 minutes per ticket code.
- M5 clarification (ADR-015): recovery keys have at least 128 bits (160-bit design), are stored as HMAC-SHA-256 and shown once; the public ticket code is never a credential; throttle keys never include the submitted secret; there is no irreversible lockout; staff-assisted recovery is a restricted, audited procedure; automatic no-show executes only through the authoritative command path.

### 5.3 Input validation

- Validate and sanitize all inputs with Zod schemas at API boundary.
- Parameterized queries only — never string-concatenated SQL.
- Validate webhook signatures before processing any payload.
- Reject replayed webhooks using provider-supplied nonce or timestamp + idempotency key.

### 5.4 Data minimization

- Never store phone numbers in plaintext in `queue_events` — use `visitor_contacts.phone_ciphertext`.
- Public display endpoints return ticket codes only — no names, phone numbers, or internal IDs.
- Offline IndexedDB storage must exclude raw contact data.

### 5.5 Transport

- HTTPS only in staging/production. Enforce HSTS.
- All external provider calls over TLS with certificate validation.

---

## 6. Git workflow

### Branch model

```
main          ← protected; only accepts PRs from staging
staging       ← integration; accepts PRs from feature branches
feature/*     ← implementation work (one branch per milestone, e.g. feature/m5-recovery-accessibility-alerts)
fix/*         ← bug fixes
chore/*       ← tooling, docs, CI changes
```

### Commit conventions

Follow Conventional Commits:

```
feat(scope): short description
fix(scope): short description
chore(scope): short description
docs(scope): short description
test(scope): short description
refactor(scope): short description
```

Scope examples: `api`, `web`, `worker`, `domain`, `contracts`, `continuity`, `channels`, `ui`, `infra`, `ci`.

### Rules

- **Never push directly to `main` or `staging`** without explicit human authorization.
- **Never force-push** any branch.
- **Never merge without a passing CI run** (lint + typecheck + tests + build).
- Keep commits atomic — one logical change per commit.
- Reference the relevant feature ID (F1–F15) or milestone (M0–M7, MQ) in PR descriptions.

---

## 7. Mandatory validation requirements

Before marking any milestone complete, ALL of the following must pass:

### M0 gate (baseline; met at M0 and re-run for every milestone)

- [ ] `pnpm typecheck` — zero TypeScript errors across all packages and apps
- [ ] `pnpm lint` — zero ESLint errors (warnings allowed, zero errors)
- [ ] `pnpm format:check` — Prettier reports no formatting violations
- [ ] `pnpm test` — all Vitest tests pass
- [ ] `pnpm build` — all packages and apps build without errors
- [ ] `pnpm db:migrate` — migrations apply to a fresh PostgreSQL database without errors
- [ ] CI workflow passes on push to `feature/m0-foundation`

### M1–M7 gates (M1–M4 met and merged; M5–M7 and MQ pending)

Each milestone adds its own domain-specific acceptance criteria defined in `.kiro/specs/queuebridge/tasks.md`.

Core invariants that tests must cover by M3:

- No two final events share a queue sequence.
- Identical operation ID cannot apply twice.
- Fenced coordinator cannot finalize obsolete commands.
- Unauthorized actors cannot commit staff transitions.

---

## 8. Kiro usage requirements (Kiroween 2026)

- Use Kiro substantially for spec-driven planning, implementation, review, and verification.
- Every spec in `.kiro/specs/` must reflect real usage — do not fabricate Kiro artifacts.
- Document concrete Kiro contributions in `M0-completion.md` and the final submission materials.
- Steering files in `.kiro/steering/` are always-on instructions — keep them current as the project evolves.
- Before implementing offline advancement (M3), answer all six questions in Architecture §16 in code **and** tests.

---

## 9. What agents must NOT do

- Do not silently reduce scope. If a requirement cannot be implemented, document the blocker explicitly.
- Do not add paid services or paid API dependencies.
- Do not modify `main` or `staging` without explicit human instruction.
- Do not push, open PRs, merge, or deploy without explicit authorization.
- Do not claim delivery, consistency, or correctness that is not evidenced by passing tests.
- Do not use `// @ts-ignore` or `eslint-disable` to silence real errors — fix the root cause.
- Do not embed real PII or real credentials anywhere in the codebase.
- Do not describe QueueBridge's offline behavior as "conflict-free" or "globally final" until M3 acceptance tests pass.
