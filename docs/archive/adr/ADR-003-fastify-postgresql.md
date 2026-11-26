# ADR-003: Fastify API + PostgreSQL

**Date:** 2026-10-30  
**Status:** Accepted

## Context

The API layer needs:

- Transactional queue state changes (no partial updates to queue_events)
- RBAC with tenant scope enforcement on every request
- High-performance JSON handling for sync batch processing
- Durable append-only event log with hash chain integrity

## Decision

**Fastify 5** as the HTTP framework. **PostgreSQL 16+** as the database. **`postgres` npm package** for raw SQL queries.

- Fastify chosen for its performance, TypeScript-first design, and plugin ecosystem
- PostgreSQL chosen for ACID transactions, row-level locking (`SELECT ... FOR UPDATE`), and `UNIQUE` constraints that enforce the sequence invariant
- Raw SQL (via `postgres` package) instead of an ORM — preserves full control over query behavior and avoids ORM abstraction hiding important details like locking semantics
- Outbox pattern: `notification_outbox` rows inserted in the same DB transaction as queue events

## Consequences

**Positive:**

- PostgreSQL transactions guarantee atomicity for the queue session lock + event insert + outbox insert
- `UNIQUE (queue_session_id, sequence)` enforced at DB level, not just application level
- Fastify's schema validation integrates with Zod via custom serializers
- No ORM magic — every query is explicit and auditable

**Negative:**

- Raw SQL requires more discipline than an ORM (no automatic migrations from model changes)
- `postgres` package uses tagged templates — learning curve for developers used to ORMs
- PostgreSQL must be provisioned for local development (Docker recommended)

## Alternatives considered

- Prisma ORM: rejected — ORM hides locking semantics; migrations from model definitions can be fragile
- Hono or Express: rejected — Fastify has better TypeScript support and plugin ecosystem
- SQLite: rejected — no row-level locking sufficient for concurrent queue advancement
