# QueueBridge — Spec Design

**Spec version:** 1.0  
**Source:** `docs/QueueBridge_Technical_Architecture_v1.0.md`  
**Status:** Baseline — architecture and data model established at M0

---

## 1. System architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Client layer (apps/web — React PWA)                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐ ┌───────────────┐ │
│  │ Visitor  │ │  Staff   │ │  Supervisor  │ │ Public Board  │ │
│  │   app    │ │ console  │ │  dashboard   │ │     view      │ │
│  └────┬─────┘ └────┬─────┘ └──────┬───────┘ └───────┬───────┘ │
│       │            │               │                  │         │
│  ┌────▼────────────▼───────────────▼──────────────────▼──────┐ │
│  │          IndexedDB outbox (packages/continuity)            │ │
│  │          Service worker (offline shell + cache)            │ │
│  └──────────────────────────┬─────────────────────────────────┘ │
└─────────────────────────────┼───────────────────────────────────┘
                               │ HTTPS / WSS
┌─────────────────────────────▼───────────────────────────────────┐
│  API layer (apps/api — Fastify)                                  │
│  Auth → RBAC → Tenant scope → Queue service → Event append      │
│  Sync endpoint → Dedup → Epoch check → Atomiccommit             │
└────────┬──────────────────────────────────────┬─────────────────┘
         │                                       │
    ┌────▼────┐                          ┌───────▼────────┐
    │PostgreSQL│                         │ Notification   │
    │  (DB)   │                         │ outbox worker  │
    └─────────┘                         │  (apps/worker) │
                                         └───────┬────────┘
                                                 │
                              ┌──────────────────▼──────────┐
                              │  ChannelAdapter (packages/  │
                              │  channels): SMS / USSD      │
                              └─────────────────────────────┘
```

## 2. Package design

### packages/contracts

- No runtime dependencies except `zod`.
- Exports: all Zod schemas, TypeScript types inferred from schemas, shared enums.
- Key schemas:
  - `CommandEnvelopeSchema` — offline sync command with operation_id, epoch, revision
  - `TicketSchema`, `QueueSessionSchema`, `QueueEventSchema`
  - `SyncBatchRequestSchema`, `SyncBatchResponseSchema`
  - `ApiErrorSchema` (RFC 9457 problem detail)
  - `WaitEstimateSchema`, `AuditCheckpointSchema`
  - `ChannelMessageSchema`, `DeliveryReceiptSchema`, `UssdSessionSchema`

### packages/domain

- Zero I/O, zero database dependency. Pure functions only.
- Exports:
  - `ticketStateMachine` — `transition(state, action, role, policy) → newState | Error`
  - `routeTicket(ticket, counters, policy) → counter | null`
  - `computeWaitEstimate(queue, position, counters, history) → WaitEstimate`
  - `selectNextTicket(queueState, counters, policy) → ticket | null`
  - `applyFairnessPolicy(tickets, policy, overrides) → orderedTickets`
- All functions are deterministic: same inputs → same outputs always.
- Policy is versioned: `PolicySnapshot` includes version hash for replay fidelity.

### packages/continuity

- Depends on: `contracts`, `domain`. No I/O.
- Exports:
  - `createCommandEnvelope(action, payload, context) → CommandEnvelope`
  - `validateCoordinatorEpoch(token, now) → valid | expired | revoked`
  - `reconcileBatch(localOps, serverDispositions) → ReconcileResult`
  - `detectConflicts(localOps, serverEvents) → Conflict[]`
  - `mergeQueueState(local, serverSnapshot) → MergedState`
- IndexedDB schema (browser): `operations` store keyed by `operation_id`, `queue_snapshots` store.

### packages/channels

- Depends on: `contracts` only.
- Exports:
  - `ChannelAdapter` interface (see architecture steering)
  - `SandboxSmsAdapter` — logs `[SANDBOX]`, never real network
  - `SandboxUssdAdapter` — stateful in-memory session for testing
  - Provider adapter registry: `getAdapter(provider: string) → ChannelAdapter`

### packages/ui

- Depends on: `contracts`, React, Tailwind CSS (or chosen CSS framework).
- Exports accessible, themeable components:
  - `TicketCard` — displays ticket code, state badge (local/pending/synced/review), wait estimate
  - `QueueStatusBanner` — sync health indicator with ARIA live region
  - `CounterDisplay` — public board ticket calling with optional audio
  - `PriorityOverrideModal` — supervisor reason entry with validation
  - `DeviceHealthRow` — single device sync status row
  - `SyncStateIndicator` — `local_only | pending_sync | committed | needs_review | rejected`
  - Base: `Button`, `Input`, `Select`, `Modal`, `Alert`, `Badge`, `Spinner`

### apps/api

- Fastify 5 with TypeScript.
- Plugin architecture: `auth`, `tenancy`, `rateLimit`, `sse`, `errorHandler`.
- Route groups: `/api/v1/facilities`, `/api/v1/queues`, `/api/v1/tickets`, `/api/v1/sync`, `/api/v1/audit`, `/api/v1/webhooks`.
- Database: `postgres` npm package with raw SQL. Connection pool via environment config.
- Auth: session cookie (HttpOnly, Secure, SameSite=Strict) with server-side session store in PostgreSQL.
- Every route handler: authenticate → authorize (RBAC + tenant) → validate input (Zod) → business logic → respond.

### apps/web

- Vite + React 19 + TypeScript strict.
- Routes: `/join/:facilitySlug`, `/ticket/:code`, `/staff/`, `/supervisor/`, `/admin/`, `/display/:facilityId`.
- PWA: `vite-plugin-pwa` with service worker, offline shell, manifest.
- State: React Query for server state, Zustand for offline command queue, context for auth.
- i18n: `react-i18next` with English namespace; additional locales added when verified translations exist.

### apps/worker

- Fastify-based process OR a simple `setInterval` loop consuming `notification_outbox`.
- Dependencies: `postgres`, `packages/contracts`, `packages/channels`.
- Jobs:
  - `processNotificationOutbox` — poll outbox, dispatch via adapter, record delivery
  - `verifyAuditCheckpoints` — periodically verify hash chain integrity
  - `expireCoordinatorTokens` — mark expired device authorizations
- Graceful shutdown: drain in-flight jobs, do not lose outbox rows.

## 3. Database design

All tables use `uuid` primary keys (v7, time-ordered). See Architecture steering for full column list.

### Core schema groups

**Tenancy:**
`organizations` → `facilities` → `staff_users` + `role_assignments`

**Service configuration:**
`services` → `counters` → `counter_service_capabilities`

**Queue operations:**
`queue_sessions` (with `revision`, `last_sequence`, `coordinator_epoch`, `coordinator_device_id`)
→ `tickets` (with `state`, `priority_class`, `issued_sequence`, `current_counter_id`, `version`)
→ `ticket_transitions` (linked to `queue_events`)
→ `queue_events` (APPEND-ONLY, with `prev_hash`, `event_hash`)
→ `audit_checkpoints`

**Synchronization:**
`devices` → `client_operations` (dedup by `organization_id, operation_id`)
→ `device_sync_cursors`

**Visitor data (PII-isolated):**
`visitor_contacts` (phone_ciphertext, not in events)
→ `ticket_recovery_credentials` (credential_hash, never plaintext)

**Notifications:**
`notifications` → `notification_outbox` → `notification_deliveries`

**Channels:**
`ussd_sessions` (keyed by provider_session_key_hash)
`priority_overrides` (linked to queue_events with full audit fields)

### Key database constraints

```sql
-- Authoritative sequence invariant
UNIQUE (queue_session_id, sequence) ON queue_events

-- Deduplication invariant
UNIQUE (organization_id, operation_id) ON client_operations

-- Ticket uniqueness per queue
UNIQUE (queue_session_id, public_code) ON tickets

-- Append-only enforcement trigger
CREATE OR REPLACE FUNCTION prevent_queue_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'queue_events is append-only; UPDATE and DELETE are not permitted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER queue_events_append_only
BEFORE UPDATE OR DELETE ON queue_events
FOR EACH ROW EXECUTE FUNCTION prevent_queue_event_mutation();
```

## 4. API design

All routes versioned at `/api/v1`. Error responses follow RFC 9457 (`application/problem+json`).

### Facility management

```
POST   /api/v1/organizations                    # org admin: create org
POST   /api/v1/facilities                       # org admin: create facility
POST   /api/v1/facilities/:id/services          # facility admin: create service
POST   /api/v1/facilities/:id/counters          # facility admin: create counter
PUT    /api/v1/facilities/:id/services/:sid     # facility admin: update service
POST   /api/v1/facilities/:id/staff/invite      # facility admin: invite staff
GET    /api/v1/facilities/:id/operations/health # supervisor: device sync health
```

### Queue operations

```
POST   /api/v1/queues/:id/join                  # visitor/staff: create ticket
GET    /api/v1/queues/:id/status                # public (limited): queue summary
GET    /api/v1/queues/:id/stream                # SSE: real-time queue events
POST   /api/v1/queues/:id/commands              # staff: online state transition
POST   /api/v1/tickets/:id/priority-override    # supervisor: audited override
```

### Ticket access

```
GET    /api/v1/tickets/:publicCode/status       # visitor with credential: own ticket status
POST   /api/v1/tickets/recover                  # visitor: recover ticket credential
```

### Synchronization

```
POST   /api/v1/sync/batches                     # staff device: sync offline commands
GET    /api/v1/sync/queues/:id/snapshot         # staff device: current revision + events since cursor
```

### Audit

```
GET    /api/v1/queues/:id/audit                 # auditor: paginated immutable event sequence
GET    /api/v1/queues/:id/audit/verify          # auditor: hash chain verification result
```

### Webhooks

```
POST   /api/v1/webhooks/sms/:provider           # provider: delivery receipt / inbound
POST   /api/v1/webhooks/ussd/:provider          # provider: USSD dialogue
```

### Health

```
GET    /health                                   # liveness
GET    /health/ready                            # readiness (checks DB connection)
```

## 5. Offline coordination design

### Browser-side (packages/continuity + apps/web)

```
IndexedDB stores:
  operations:       { operation_id, status, envelope, result, created_at }
  queue_snapshots:  { queue_session_id, revision, last_sequence, events[] }
  coordinator_auth: { device_id, epoch, expires_at, allowed_commands, signature }
```

**Outbox flush loop:**

1. On online event: flush all `pending` operations in `client_sequence` order.
2. POST to `/api/v1/sync/batches` with up to N operations.
3. On response: update each operation's `status` in IndexedDB per server disposition.
4. On conflict: mark affected operations `needs_review`, surface to staff UI.

**Coordinator authority checks (client-side):**

- Before any call/advance action: validate `coordinator_auth.expires_at > now`.
- If expired: show "Offline authority expired — ticket capture only" banner; disable call/advance.
- If missing: show "No offline authority — contact supervisor" banner.

### Server-side sync transaction (apps/api)

Per command in batch (in `client_sequence` order):

1. Check `(organization_id, operation_id)` in `client_operations` — return stored result if exists.
2. Begin transaction.
3. `SELECT ... FOR UPDATE` on `queue_sessions` row.
4. Verify `coordinator_epoch` matches current `queue_sessions.coordinator_epoch`.
5. Verify `base_revision` ≤ `queue_sessions.revision` (stale but compatible, or reject if too stale).
6. Apply domain state machine transition.
7. INSERT into `queue_events` with new `sequence = last_sequence + 1`.
8. INSERT into `client_operations` with `status = committed`.
9. INSERT into `notification_outbox` if applicable.
10. UPDATE `queue_sessions.revision` and `last_sequence`.
11. Commit.
12. Return disposition: `committed | duplicate | rejected | needs_review`.

## 6. Audit hash chain design

```typescript
// Canonical event JSON: deterministically sorted keys, no extra whitespace
function canonicalEventJson(event: QueueEventPayload): string {
  return JSON.stringify(event, Object.keys(event).sort());
}

// Hash computation
function computeEventHash(params: {
  domainSeparator: string; // 'queuebridge:v1:event'
  queueSessionId: string;
  sequence: number;
  prevHash: string; // genesis: SHA256('queuebridge:v1:genesis')
  canonicalJson: string;
}): string {
  const input = [
    params.domainSeparator,
    params.queueSessionId,
    String(params.sequence),
    params.prevHash,
    params.canonicalJson,
  ].join('|');
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
```

Checkpoints store `root_hash = SHA256(all event hashes in range concatenated)` and are signed with a server key (key ID stored, not the key itself).

## 7. Wait-time estimate algorithm

```typescript
interface WaitEstimateInput {
  position: number; // eligible tickets ahead (by priority class)
  activeCompatibleCounters: number; // counters currently serving this service
  serviceSamples: number[]; // recent service duration samples (seconds)
  schedule: OperatingSchedule; // counter availability windows
}

interface WaitEstimate {
  lowSeconds: number;
  highSeconds: number;
  confidence: 'high' | 'medium' | 'low' | 'insufficient_data';
  factors: string[]; // human-readable explanation
  calculatedAt: string; // ISO timestamp
  sampleSize: number;
}
```

Algorithm:

1. If `sampleSize < 5` or `activeCompatibleCounters === 0`: return `insufficient_data`.
2. `avgService = median(serviceSamples)`.
3. `estimatedSeconds = (position / activeCompatibleCounters) * avgService`.
4. `low = estimatedSeconds * 0.7`, `high = estimatedSeconds * 1.5`.
5. `factors` = `["${position} tickets ahead", "${activeCompatibleCounters} counters active", "avg ${avgService}s per ticket based on ${sampleSize} samples"]`.
6. Clamp to operating schedule end time if within current session.

## 8. Notification template design

Templates keyed by `template_key`, localized by language. Stored in code (not DB) at M0:

| Template key          | Trigger                   | Channel |
| --------------------- | ------------------------- | ------- |
| `ticket.confirmed`    | Ticket created            | SMS     |
| `ticket.nearing_turn` | N tickets ahead           | SMS     |
| `ticket.called`       | Counter calls ticket      | SMS     |
| `ticket.delayed`      | Significant wait increase | SMS     |
| `ticket.missed`       | No-show window elapsed    | SMS     |
| `ussd.welcome`        | Session start             | USSD    |
| `ussd.join_confirm`   | Joined queue              | USSD    |
| `ussd.status`         | Status check              | USSD    |
| `ussd.recovery`       | Ticket recovery           | USSD    |

## 9. Environment configuration

Required environment variables per app (validated with Zod at startup):

### apps/api

```
NODE_ENV                  # development | test | production
DATABASE_URL              # postgres://...
SESSION_SECRET            # ≥ 32 random bytes, hex-encoded
CONTACT_ENCRYPTION_KEY    # 32-byte hex key for phone number encryption
AUDIT_SIGNING_KEY_ID      # identifies the signing key
AUDIT_SIGNING_KEY         # private key for checkpoint signatures
CORS_ORIGIN               # allowed origins
PORT                      # default 3001
```

### apps/web

```
VITE_API_BASE_URL         # e.g. http://localhost:3001
VITE_APP_ENV              # development | production
```

### apps/worker

```
DATABASE_URL
WORKER_POLL_INTERVAL_MS   # default 5000
SMS_PROVIDER              # sandbox | [provider-name]
SMS_API_KEY               # injected from CI secrets in production
USSD_PROVIDER             # sandbox | [provider-name]
USSD_WEBHOOK_SECRET       # for signature verification
```

## 10. CI/CD design

GitHub Actions workflows:

- `ci.yml` — triggered on push/PR to any branch: lint → typecheck → test → build
- `db-validate.yml` — applies migrations to test PostgreSQL container; verifies constraints

CI matrix: Node 24, PostgreSQL 16.

No deployment workflow at M0 — deployment decisions are deferred per architecture §15.
