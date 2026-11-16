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
| ADR-011 | Ask Que: deterministic-first, read-only assistant (Accepted 2026-11-16)      | Yes — applies from MQ        |
| ADR-012 | Versioned fairness policy, waiting-age order, pull routing, HMAC checkpoints | Yes                          |
| ADR-013 | Smart Turn Alerts: in-app first, best-effort Web Push, never blocking        | Yes — applies from M5        |
| ADR-014 | Final UI/UX: design tokens, original branding, code-split landing page       | Yes — applies from M7        |
| ADR-015 | Ticket recovery credentials, abuse controls, staff procedure, auto no-show   | Yes — applies from M5        |

Full ADRs live in `docs/adr/`.

## Milestone order (reconciled 2026-11-12; status updated 2026-11-16)

M0–M5 merged into `staging` (M5: PR #8, `cebbe06`, 2026-11-16). Done: **M5** (recovery, accessibility, device health, Smart Turn Alerts;
stabilization M5.0 first). Next: **MQ** (Ask Que) → **M6** (SMS turn alerts + USSD) → **M7** (final UI/UX,
animated landing page, hardening, demo, submission). No renumbering. M5 manual acceptance Set 2
(checks 15–41) runs after M7, before submission; Set 1 (checks 1–14) is closed (2026-11-16).

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

## M5 detail constraints (recovery, accessibility, device health; design §15–§17)

- **Recovery is identity-plane only (ADR-015):** credential tables, no session lock, no `queue_events`, no change to ticket state, position or waiting age; works while a coordinator holds the queue. The public ticket code is never a credential; the recovery key is ≥128-bit (160-bit design), HMAC-stored, and throttle keys never include the guess; there is no lifetime lockout. Staff-assisted recovery is a restricted, audited procedure issuing single-use grants.
- `rejoin_policy` (`staff_resume` default | `self_resume`) and `auto_miss` (default off) are versioned service-policy fields (ADR-012). The only grace setting is the existing `grace_window_seconds`. `self_resume` and automatic no-show are queue transitions: standard command path, session lock, coordinator fence; auto-miss runs as an API sweep, never in the worker, through the standard command executor with a `system` role for `called → missed` only: session then ticket lock, database time, current policy version, deterministic operation id (idempotent across instances), refused while a coordinator is assigned, clock restarted after coordinator authority ends and after a detected outage, stateless restart, and no dependency on notification state.
- **Accessibility preferences** are device-local (`qb.a11y.v1`), applied as `data-*` attributes before first render, precached, offline-capable, never sent to the server. The PWA manifest must not lock orientation.
- **Device health is observational:** the worker's `evaluateDeviceHealth` writes only `health_alerts`; it never touches coordinator fields, sessions, tickets or events and never triggers failover. Single-coordinator authority (ADR-006) is unchanged.
- Migrations for M5 are additive and numbered at implementation (indicatively M5.1 `0007`, M5.3 `0008`, M5.4 `0009`).

## Smart Turn Alerts (F14) — planned architecture constraints (from M5; ADR-013)

- Alerts are produced from **server-committed** events only (online or via sync). Offline-applied actions create none until committed.
- `enqueueTurnAlerts` runs inside the queue transaction under a **SAVEPOINT** with no network I/O; any error rolls back to the savepoint, is logged and counted, and the queue command commits. Alert code must never be able to fail a queue command.
- The worker sends; the API only enqueues and serves subscription endpoints. The worker never writes to `tickets`, `queue_sessions` or `queue_events`.
- Web Push uses a separate narrow `PushTransport` in `packages/channels` (TEST-ONLY sandbox double + `WebPushTransport`: RFC 8291 encryption with `http_ece` (MIT), RFC 8292 VAPID with `node:crypto`; the `web-push` npm package is not used because it is MPL-2.0). `ChannelAdapter` stays SMS/USSD-shaped. No new package; no boundary change.
- In-app alert derives from server-confirmed ticket state; no outbox row, no delivery claim.
- One `notifications` + outbox entry **per subscribed device**; idempotency key `web_push:ticket.called:<ticket_id>:<event_sequence>:<subscription_id>` (`notification_outbox.dedup_key` is globally unique, so the subscription must be in the key); stale alerts are suppressed at send time; TTL bounds retries; at-least-once with collapse.
- Notification identity is the non-secret `subscription_id` (tag, `Topic`, click destination `/ticket/<code>?ref=<ref>` resolved through the saved ticket's `pushRef`), never the public ticket code alone; the service worker and payloads hold no bearer credential; an unmatched reference opens a neutral screen with no status request.
- States: `sent` (push service accepted) ≠ `delivered` (first-party ack or provider receipt only) · `failed` · `suppressed` · `unknown`.
- No alert outcome may change ticket state or cause a `missed` transition.
- The M5.4 migration is additive (new table, new column, widened CHECK constraints); nothing dropped.

## Ask Que (F13) — planned architecture constraints (from MQ; ADR-011 Accepted 2026-11-16)

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
