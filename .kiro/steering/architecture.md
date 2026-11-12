---
inclusion: always
---

# QueueBridge — Architecture Steering

> Always-on architectural constraints and invariants for Kiro. Never violate these without an ADR.

## Architecture decisions (ADR summary)

| ID      | Decision                                                                     | Must not deviate without ADR |
| ------- | ---------------------------------------------------------------------------- | ---------------------------- |
| ADR-001 | Modular TypeScript monorepo (pnpm workspaces)                                | Yes                          |
| ADR-002 | React + TypeScript mobile-first PWA                                          | Yes                          |
| ADR-003 | Fastify API + PostgreSQL                                                     | Yes                          |
| ADR-004 | Server-authoritative final sequence                                          | Yes — core invariant         |
| ADR-005 | IndexedDB outbox + service worker                                            | Yes                          |
| ADR-006 | One designated coordinator per queue during outage                           | Yes — core invariant         |
| ADR-007 | Explicit recovery after partitions (no silent overwrite)                     | Yes — core invariant         |
| ADR-008 | Relational outbox for channel dispatch                                       | Yes                          |
| ADR-009 | Provider-neutral SMS and USSD adapters                                       | Yes                          |
| ADR-010 | Audit hash chain with external checkpoint option                             | Yes                          |
| ADR-011 | Ask Que: deterministic-first, read-only assistant (Proposed)                 | Yes — applies from MQ        |
| ADR-012 | Versioned fairness policy, waiting-age order, pull routing, HMAC checkpoints | Yes                          |

Full ADRs live in `docs/adr/`.

## Runtime components

```
apps/web      ← React PWA: visitor, staff, supervisor, public-board routes
apps/api      ← Fastify: tenant-aware auth, queue service, policies, sync endpoints
apps/worker   ← Notification delivery, retries, provider receipts, audit checkpoint jobs
packages/
  contracts   ← Zod schemas, enums, API DTOs, event schemas (no runtime deps)
  domain      ← Ticket state machine, fairness, routing, wait-time (NO DB / I/O)
  continuity  ← Offline command schema, reconciliation logic, authority/fencing checks
  channels    ← ChannelAdapter interface, SMS/USSD provider adapters, test doubles
  ui          ← Reusable accessible React components
infra/
  migrations/ ← Numbered SQL migrations (idempotent, append-only for queue_events)
  seeds/      ← Development fixtures
```

## Package boundary rules (enforced, not advisory)

```
contracts   → imports nothing internal
domain      → imports contracts only; zero I/O, zero DB
continuity  → imports contracts + domain; no API calls, no direct DB
channels    → imports contracts only; no domain/continuity internals
ui          → imports contracts + React deps; no server-side packages
apps/api    → imports all packages; does NOT import ui
apps/web    → imports contracts, domain, continuity, ui; does NOT import channels internals
apps/worker → imports contracts, domain (pure audit/ordering functions, ADR-012), channels, DB client; does NOT import ui or continuity IndexedDB
```

Violating package boundaries invalidates the architectural isolation guarantee.

## Authoritative sequence — core invariant

Every queue session has:

- `revision` (integer, increments on each committed command)
- `last_sequence` (integer, increments on each committed event)
- A row-level lock (`SELECT ... FOR UPDATE`) that serializes state-changing transactions

Every committed command creates a `queue_event` with a unique `(queue_session_id, sequence)`.
**This pair is UNIQUE and the `queue_events` table is append-only.**
No UPDATE or DELETE on `queue_events` — ever.

## Offline coordinator authority — core invariant

- The online supervisor designates a specific staff device as coordinator for specified queue session(s).
- Coordinator designation is a short-lived signed authorization: `{ device_id, queue_id, epoch, allowed_commands }`.
- The coordinator may locally enact provisional calls/completions while offline; these are `offline_applied`, not globally final.
- The coordinator cannot verify the server hasn't replaced it during a partition — so all offline actions remain provisional.
- Server finalizes a batch only when coordinator epoch and base revision are still compatible.
- An incompatible epoch/revision is rejected or held for supervisor review.
- Expired coordinator credential: stop offline advancement, allow provisional ticket capture only.
- Lost coordinator: suspend offline advancement until authorized supervisor performs explicit failover.

## Synchronization protocol

### Command envelope fields (required on every client command)

- `operation_id` (UUID v7)
- `organization_id`, `facility_id`, `queue_session_id`, `device_id`, `actor_id`
- `coordinator_epoch`, `base_revision`, `client_sequence`
- `action`, `payload`, `created_at_client` (diagnostic only — never used for ordering), `schema_version`

### Server transaction steps

1. Authenticate device, actor, org, facility; enforce permissions and policy.
2. Deduplicate by `(organization_id, operation_id)` — return stored disposition for exact replay.
3. Lock queue session row; verify epoch, base revision, state preconditions.
4. Validate operation-specific constraints.
5. Atomically apply state, append event, record command result, insert notification outbox entries.
6. Return `committed | duplicate | rejected | needs_review` with updated sequence/revision.

### Non-negotiable client UI states

`local_only` | `pending_sync` | `committed` | `duplicate` | `needs_review` | `rejected`

The visitor-facing view NEVER shows offline local-only progress as globally confirmed state.

## Tenant hierarchy

`organization → facility → service → queue_session`

- Counters may serve multiple compatible services.
- Every query and mutation scoped by `organization_id` AND `facility_id`.
- Cross-tenant data access is a security violation, not a bug.

## Ticket state machine

```
create → waiting
waiting → called | paused | cancelled | transferred
called → serving | missed | waiting (authorized recall)
serving → completed | paused | transferred
paused → waiting | cancelled
missed → waiting (grace rule) | cancelled
transferred → waiting in destination queue (linked parent event)
needs_review → supervisor-approved resolution only
```

Every transition has: role precondition, state precondition, policy precondition.
`needs_review` state: never direct client-side overwrite — supervisor resolution only.
Provisional offline tickets use `temporary_ticket_ref` until server assigns confirmed public code.

## Audit hash chain

```
event_hash = SHA256(
  domain_separator ||
  queue_session_id ||
  sequence ||
  prev_hash ||
  canonical_event_json
)
```

Periodic `audit_checkpoints` sign a root hash over a range of sequences.
Verification must be possible independently of application code.
Threat model: detects ordinary modification; an admin controlling all keys and storage could still rewrite. Do not claim tamper-proof.

## Notification outbox pattern

- `notification_outbox` row inserted atomically in the same DB transaction as the `queue_event`.
- Worker consumes outbox; delivery attempts deduplicated by idempotency key.
- Provider receipts update status idempotently.
- Provider failure does not roll back a committed queue action.
- Never claim delivery without confirmed provider receipt.

## Channel adapter interface (`ChannelAdapter`)

Every SMS/USSD provider must implement:

```typescript
interface ChannelAdapter {
  sendMessage(params: SendMessageParams): Promise<SendResult>;
  verifyWebhook(headers: Record<string, string>, body: unknown): boolean;
  parseDeliveryReceipt(payload: unknown): DeliveryReceipt;
  parseInboundMessage(payload: unknown): InboundMessage | null;
  handleUssdSession(params: UssdSessionParams): Promise<UssdResponse>;
}
```

Sandbox traffic must be labeled `[SANDBOX]` in all logs and UI.

## Failure behaviors (required handling)

| Scenario                                 | Required behavior                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| Coordinator browser restart              | Replay persisted IndexedDB operations; preserve local labels                         |
| Coordinator missing/lost                 | Suspend offline advancement; require explicit supervisor failover                    |
| Server available but coordinator offline | Conservative default: block incompatible online advancement until authority resolved |
| Expired coordinator credential           | Stop offline advancement; provisional ticket capture only                            |
| Browser storage cleared                  | Warn user; do not imply durable backup without another replica                       |
| Stale epoch reconnects                   | Fence stale epoch; surface conflict review to supervisor                             |
| Two independent call-next attempts       | Only one server sequence can commit; other rejected/reviewed                         |
| Queue session closed during outage       | Do not silently migrate tickets; review and explicit migration required              |

## Database schema key constraints

- `UNIQUE (queue_session_id, sequence)` on `queue_events`
- `UNIQUE (organization_id, operation_id)` on `client_operations`
- `UNIQUE (queue_session_id, public_code)` on `tickets`
- All tenant resources: `organization_id` NOT NULL with FK
- Indexes: queue state/counter, outbox scheduling (`next_attempt_at`), `device_sync_cursors`
- Phone numbers: stored as `phone_ciphertext` in `visitor_contacts`, never in events

## Performance and observability

- Structured JSON logs with `trace_id`, `facility_id`, `queue_session_id` on every log line.
- Health check endpoints: `/health` (liveness) and `/health/ready` (readiness with DB check).
- Metrics: response time p95, sync backlog size, notification delivery rate, event sequencing rate.
- SSE streams for real-time updates; polling fallback for degraded connections.

## Architectural acceptance gate (M3 blocker)

Before implementing offline queue advancement, code AND tests must answer:

1. Who may advance the queue when the internet disappears?
2. Which progress is local only vs globally confirmed?
3. What happens when two devices or a server disagree?
4. Can duplicate requests change queue state twice?
5. What happens if a coordinator loses its device or storage?
6. How can staff recognize and resolve a conflicted operation?

**Until these are answered, QueueBridge must not describe offline behavior as conflict-free or globally final.**

## Ask Que (F13) — planned architecture constraints (from MQ; ADR-011 Proposed)

- New package `packages/assist` (planned): KB schema, search, route registry, capability gating,
  answer guard. Imports `contracts` only; zero I/O. `apps/web` and `apps/api` may import it.
- Inference only in `apps/api` behind a provider-neutral `InferenceAdapter`
  (`disabled` default, `sandbox` test double, approved free-tier/sponsored provider). No paid mode.
- Que has no mutation path and is outside the authoritative sequence; no tool calling.
- Restricted KB content is filtered server-side by session roles; caches are per user and purged
  on sign-out or role change.
- Capability manifest (`live | preview | sandbox | planned`) is generated from server flags and gates
  every description of platform capability.
- Every inference failure or validation failure falls back to deterministic help.
