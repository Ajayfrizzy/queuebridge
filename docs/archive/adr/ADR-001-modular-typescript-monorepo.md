# ADR-001: Modular TypeScript Monorepo

**Date:** 2026-10-30  
**Status:** Accepted  
**Deciders:** QueueBridge team (Kiro-assisted)

## Context

QueueBridge has multiple runtime components (web app, API, worker) and significant shared logic (ticket state machine, sync protocol, channel adapters). We need a project structure that enables:

- Shared TypeScript types across frontend and backend without duplication
- Clear enforcement of package boundaries (e.g., domain logic must not depend on the database)
- Independent deployability of each application
- Shared tooling (ESLint, Prettier, Vitest) without per-package duplication

## Decision

Use a **pnpm workspaces monorepo** with TypeScript project references.

Structure:

- `apps/web`, `apps/api`, `apps/worker` — deployable applications
- `packages/contracts`, `packages/domain`, `packages/continuity`, `packages/channels`, `packages/ui` — shared libraries
- `infra/` — database migrations, seeds, and scripts
- TypeScript project references enforce compile-time dependency direction

## Consequences

**Positive:**

- Single `pnpm install` bootstraps the entire project
- TypeScript project references catch import boundary violations at compile time
- Shared schemas (Zod) ensure API DTOs match frontend expectations
- `pnpm -r` commands run scripts across all packages consistently

**Negative:**

- Build order must be managed (contracts → domain → continuity → apps)
- More complex initial setup vs a simple single-package project
- CI must build in dependency order

## Alternatives considered

- Separate repositories per service: rejected — too much overhead for a hackathon; harder to share types
- Nx or Turborepo: considered but adds complexity; pnpm workspaces + project references sufficient for M0
