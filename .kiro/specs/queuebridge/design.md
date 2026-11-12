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

M4 adds (auditor, supervisor, facility admin; tenant-scoped, read-only):

```
GET    /api/v1/queues/:id/audit?after_sequence&limit   # page ≤ 200, with override explanations
GET    /api/v1/queues/:id/audit/export                 # redacted (no names / free text)
GET    /api/v1/queues/:id/audit/verify                 # verified | failed | incomplete
POST   /api/v1/tickets/:id/priority-override           # supervisor/facility_admin, reason required
POST   /api/v1/tickets/:id/call-out-of-order           # supervisor/facility_admin, reason required
POST   /api/v1/tickets/:id/counter-transfer            # counter operator/supervisor
POST   /api/v1/counters/:id/availability               # open | closed (reason to close)
GET    /api/v1/facilities/:id/services/:sid/policy-versions   # immutable policy history
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

### M2 implementation notes (2026-11-08)

Additive to the route list above; these are the routes M2 actually ships.

```
GET    /api/v1/facilities/:id/queues                # QUEUE_VIEW: today's queue per service
POST   /api/v1/facilities/:id/queues                # supervisor/facility_admin: open today's session
GET    /api/v1/queues/:id                           # QUEUE_VIEW: staff console projection
POST   /api/v1/queues/:id/commands                  # staff: idempotent online command (role per state machine)
POST   /api/v1/queues/:id/walk-ins                  # reception/counter/supervisor/admin: staff-assisted ticket
GET    /api/v1/queues/:id/stream                    # staff SSE (change signals only)
POST   /api/v1/queues/:id/join                      # anonymous visitor join (operation_id + join_proof)
GET    /api/v1/tickets/:code/status                 # visitor; X-QB-Ticket-Token header required
GET    /api/v1/tickets/:code/stream                 # visitor SSE; same header
GET    /api/v1/public/facilities/:org/:facility     # public join catalog (no PII)
GET    /api/v1/public/facilities/:org/:facility/board   # display board: codes + counter names only
GET    /api/v1/public/facilities/:org/:facility/stream  # public SSE (change signals only)
```

- Walk-ins use a separate staff endpoint rather than sharing `/join`, so anonymous and staff
  authority never mix in one handler.
- Ticket status is addressed by public code and authorized by a per-ticket status token in a
  header (never a URL parameter, so it is never logged). Tokens are stored as SHA-256 only.
- SSE streams carry `{"revision": n}` change signals and no queue data; clients refetch through
  the authorized endpoint. Fan-out uses PostgreSQL `LISTEN/NOTIFY` (delivered on commit, works
  across API instances). Streams end after 15 min so reconnects re-run authorization.
- Every state-changing `/api/*` request now requires the `X-QB-CSRF` header and an allowed
  Origin, including anonymous visitor joins. Provider webhooks (M6) will need an explicit,
  signature-verified exemption.
- Transfer reasons are fixed codes, never free text, so `queue_events.payload` cannot carry PII.

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

### M3 implementation notes (2026-11-08)

Additive to §4 and §5; these are the routes and rules M3 actually ships.

```
POST   /api/v1/devices                              # staff (WALK_IN roles): register this browser for a facility
POST   /api/v1/devices/:id/heartbeat                # owner: self-reported pending count / failure (display only)
POST   /api/v1/devices/:id/revoke                   # supervisor/facility_admin: revoke; strips coordinator authority
POST   /api/v1/sync/batches                         # owner of the devices in the batch: offline commands
GET    /api/v1/sync/queues/:id/snapshot             # QUEUE_VIEW: state + events after cursor + signed authority
POST   /api/v1/queues/:id/coordinator               # QUEUE_MANAGE: assign (epoch+1)
POST   /api/v1/queues/:id/coordinator/failover      # QUEUE_MANAGE: replace (epoch+1, reason required)
POST   /api/v1/queues/:id/coordinator/renew         # QUEUE_MANAGE: extend expiry (same epoch)
POST   /api/v1/queues/:id/coordinator/revoke        # QUEUE_MANAGE: end authority (epoch+1)
GET    /api/v1/facilities/:id/operations/health     # supervisor/facility_admin/auditor
GET    /api/v1/facilities/:id/sync/conflicts        # supervisor/facility_admin/auditor
POST   /api/v1/sync/conflicts/:operationId/resolve  # QUEUE_MANAGE: apply (re-validated) | dismiss, reason required
```

- **Devices** carry no secret: every request is authenticated by the owner's session; the server checks
  owner, tenant, facility and revocation on every batch. A revoked device gets `403 device-revoked`.
- **Authority token:** `v1.<base64url(CoordinatorAuth)>.<HMAC-SHA256>` signed server-side
  (`COORDINATOR_SIGNING_KEY`, else derived from `SESSION_SECRET`). Delivered only to the active coordinator
  device via the snapshot, with a signed `delivered_at` (server clock at hand-over). The browser cannot
  verify it; it uses the claims only to gate UI.
- **Offline vocabulary:** capture `ticket.create` (any registered device of a WALK_IN role) and advancement
  `ticket.call_next | serve | complete | miss` (coordinator only). Everything else is online-only.
- **Per-command evaluation** (one transaction each, session row locked, in `client_sequence` order):
  envelope identity must match the session (else rejected) → dedupe `(organization_id, operation_id)` →
  for advancement: signed token for (queue, device, epoch) present (else `authority_token_missing`) →
  `epoch < current` ⇒ **needs_review `stale_epoch`**; `epoch > current` ⇒ rejected; device ≠ coordinator ⇒
  rejected; action outside grant ⇒ rejected; **timing** (below) not established ⇒ needs_review;
  `base_revision > revision` ⇒
  needs_review; any advancement event after `base_revision` not attributed to this epoch ⇒ needs_review
  `concurrent_advancement` → shared M2 `applyCommand` (same state machine and roles) inside a savepoint;
  business-rule failures ⇒ needs_review with the M2 reason. Capture into a closed/paused queue ⇒
  needs_review (`queue_closed` / `queue_paused`), never silently placed elsewhere.
- **Offline authority timing (device clocks are untrusted).** `created_at_client` is diagnostic only and
  never authorizes anything. Every offline advancement carries `authority_timing`
  `{delivered_at, elapsed_ms, floor_ms, source, rollback_detected}` measured on the device since it
  RECEIVED that token: `performance.now()` within the page session; a persisted elapsed floor (advanced
  every 5 s) across reloads/restarts; `elapsed = max(floor, wall delta)` (sleep counts); wall clock behind
  the floor by > 2 s ⇒ rollback (sticky for that token; UI drops to capture-only). The server
  (`apps/api/src/queue/timing.ts`) places the action at `delivered_at (signed) + elapsed` and holds as
  needs_review: no evidence or evidence for an unpresented token (`authority_timing_unverifiable`);
  rollback (`clock_rollback`); floor > elapsed or action later than server now + 5 s (unverifiable);
  floor or estimate ≥ min(signed `expires_at`, stored session expiry) (`authority_expired`);
  `source = restarted` and the server receives it at/after expiry (unverifiable — the closed-app gap is
  wall-clock evidence only); elapsed decreasing vs the device's previous command under the same token
  (unverifiable). A restarted device that syncs before expiry commits: server receipt proves the action
  preceded expiry. Supervisors may still apply held actions explicitly.
- **Limitation (not a guarantee):** a modified client can fabricate any evidence; an honest app whose
  device clock is moved while the app is CLOSED, by an amount the persisted floor cannot reveal, is only
  bounded by rule "restarted ⇒ must reach the server before expiry". Within one page session, the
  monotonic clock bounds the device. Fencing (epoch), short TTLs and supervisor review are the controls.
- **Authorities per batch:** each batch presents exactly the tokens its commands were timed against
  (looked up at send time), and a batch is cut so it never needs more than 20 distinct tokens
  (server limit) — prefix-only, so `client_sequence` order holds. Tokens no unsent command needs and
  that are not a queue's current authority are pruned after each flush. Device-id caches in the
  browser are keyed by user AND facility; a newly established session clears the previous session's
  sync block (e.g. "sign-in ended") without touching unsent actions.
- **Offline capture status link:** the server returns a one-time `status_token` for a committed capture
  (stored only as SHA-256). Replaying the same operation (same user AND same device) re-issues — rotating —
  the credential, so at most one link is valid. The web app keeps it in memory only, shows the confirmed
  code + QR + link once to the capturing user (`StatusHandoverPanel`), and never persists, logs or
  broadcasts it; "New status link" replays the operation to rotate it.
- `revision` and `last_sequence` advance together (one event per committed change), so `base_revision`
  is compared against event sequences.
- **Coordinator fence (online):** while a coordinator is designated (even if expired), online
  advancement via `/queues/:id/commands` returns `409 coordinator-active`; joins, walk-ins and session
  controls still work. Ends on revoke/failover.
- **Audit:** `coordinator.assign|failover|renew|revoke`, `sync.conflict_detected`,
  `sync.conflict_resolved` are hash-chained queue events (audit-only in replay). Synced events carry
  `origin`, `device_id`, `coordinator_epoch` (and `temporary_ref` for captures). Device register/revoke
  are `admin_events`.
- **Resolution** never edits `queue_events`: apply re-runs the command against current state (supervisor
  stands in for the offline authority) and appends new events; dismiss records `rejected`.
- **Browser storage:** IndexedDB `operations` + `kv`. Cached snapshots/facility data and a minimal identity
  (no email) are owned by the signed-in user and bounded by the server-reported session expiry. 401 erases
  caches but keeps unsent operations (same user can sync after signing in again); confirmed sign-out
  erases caches and — only after explicit confirmation — that user's unsent operations. Another user's
  unsent operations are never sent under the current session and never deleted implicitly.

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

### M4 implementation notes (2026-11-08) — see ADR-012

- **Where the code lives.** Hash primitives are in `packages/domain/src/audit.ts` (sha256
  injected; no Node I/O): `canonicalJson`, `computeEventHash` (the construction above, unchanged),
  `genesisHash`, `verifyChain`, `checkpointRoot`, `checkpointMessage`, `verifyCheckpoints`.
  `apps/api/src/queue/hash.ts` wraps them with Node `crypto`; `apps/worker` imports them directly.
- **Checkpoint job** (`apps/worker/src/checkpoints.ts`): per session with ≥
  `AUDIT_CHECKPOINT_MIN_EVENTS` unanchored events, or older than `AUDIT_CHECKPOINT_MAX_AGE_MS`, or
  closed: lock the session row, verify the WHOLE chain and every existing checkpoint, then insert
  `[last_to + 1, last_sequence]` with `signature = HMAC-SHA256(key, checkpointMessage)` where the
  message is `queuebridge:v1:checkpoint|session|from|to|root|head`. Ranges are contiguous and
  unique (`UNIQUE (queue_session_id, from_sequence, to_sequence)`), so concurrent workers write one
  row. A failed verification inserts a deduplicated `audit_integrity_alerts` row and skips the
  session. No key → job disabled.
- **SQL-only root check** (no application code):
  `SELECT encode(sha256(convert_to(string_agg(event_hash, '' ORDER BY sequence), 'UTF8')), 'hex')
FROM queue_events WHERE queue_session_id = $1 AND sequence BETWEEN $from AND $to`.
- **Verification endpoint** (`apps/api/src/queue/audit.ts → verifyAudit`): chain → checkpoints
  (invalid / unverifiable) → override text hashes vs sealed hashes → routing-decision replay
  against `service_policy_versions` snapshots → worker alerts → event count vs `last_sequence`.
  Result `verified | failed | incomplete`; `incomplete` is never shown as success.
- **Append-only:** row triggers (UPDATE/DELETE) plus statement `BEFORE TRUNCATE` triggers on
  `queue_events`, `admin_events`, `service_policy_versions`, `priority_overrides`,
  `audit_checkpoints`, `audit_integrity_alerts` (migration `0006`).

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

> **M2 amendment (2026-11-08):** step 4 is implemented as
> `low = (position / counters) * avgService * 0.7` and
> `high = ((position + 1) / counters) * avgService * 1.5`, so the interval also allows for the
> service in progress and is never zero-width (the original formula produced `0–0` for the next
> person, which would imply an exact time, contrary to REQ-F6.6). Step 6 is not applied in M2
> because operating hours are not configurable yet; the estimate states this as a factor.

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
PORT                      # default 3002 (3001 is left free for other local projects)
```

### apps/web

```
VITE_API_BASE_URL         # e.g. http://localhost:3002
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

---

## 11. Ask Que Anything (F13) — design (planned, milestone MQ)

> Added 2026-11-07. Specification only — nothing in this section is implemented yet. Governing
> decision: ADR-011. Requirements: REQ-F13. This section is additive and does not modify §1–§10.

### 11.1 Principles

1. **Deterministic first, AI optional.** All behaviour works with the AI layer disabled.
2. **Read-only.** No mutation endpoints, no tool calls, no writes to tenant tables.
3. **Authorize content, not just screens.** Restricted articles are filtered server-side.
4. **Truthful.** Content is gated by a capability manifest; non-live features are labelled.
5. **Offline and low-bandwidth.** Text-only articles, small bundles, cached in the PWA.

### 11.2 Knowledge base model (`packages/assist`)

Source articles live as Markdown with front-matter in `packages/assist/knowledge/<audience>/`,
compiled at build time into versioned JSON bundles per audience.

```typescript
interface KbArticle {
  id: string; // stable, e.g. 'visitor.join.qr'
  title: string;
  audiences: Audience[]; // 'visitor' | 'reception' | 'counter' | 'supervisor' | 'facility_admin' | 'org_admin' | 'auditor'
  topics: KbTopic[]; // 'registration' | 'ticket_status' | 'recovery' | 'staff_operations' | 'facility_configuration' | 'connectivity'
  requiresCapabilities: CapabilityId[]; // every listed capability must be at least 'preview' to show
  relatedRoutes: RouteId[];
  availableSince: MilestoneId; // 'M1' | 'M2' | ... | 'MQ'
  version: number; // per-article, increments on content change
  lastReviewed: string; // ISO date
  keywords: string[]; // search synonyms
  body: SafeMarkdown; // restricted subset: headings, lists, emphasis, links to RouteIds only
}

type CapabilityStatus = 'live' | 'preview' | 'sandbox' | 'planned';
interface CapabilityManifest {
  version: number;
  capabilities: Record<
    CapabilityId,
    { status: CapabilityStatus; since?: MilestoneId; note?: string }
  >;
}
```

- Audience → role mapping: `visitor` = `visitor_anonymous`; `reception` = `staff_reception`;
  `counter` = `staff_counter`; others map 1:1. `org_admin` inherits facility-admin articles.
- The capability manifest is generated from authoritative server flags (e.g. M1's
  `VISITOR_JOIN_OPERATIONAL`, channel `mode: sandbox|live`) and served at
  `GET /api/v1/que/capabilities` (public subset) so content cannot drift from reality.
- Articles whose capabilities are `planned` are never shown as instructions; Que instead states
  "not available yet" using the manifest note.

### 11.3 Route / screen registry

`packages/assist/routes.ts` maps each `RouteId` → path pattern, required permission (from the same
`Permission` map as `apps/api/src/auth/rbac.ts`, to be moved to `packages/contracts` when MQ
starts), and default articles for that screen.

- Navigation suggestions are filtered by the user's roles at the current facility.
- Contract test: every registered route exists in `apps/web` router; every permission name exists
  in the API permission map; every article's `relatedRoutes` are registered.

### 11.4 Deterministic answering and search

Deterministic help is the complete product: every essential navigation step and explanation must
be answerable from KB articles and the route registry with AI disabled and no network access. The
AI layer may only rephrase what deterministic help already provides; it never adds steps that are
unavailable otherwise, and no QueueBridge workflow requires it.

- In-browser tokenized keyword index (title, keywords, headings) with simple TF-IDF-style ranking;
  no external search service, no network.
- Inputs: query text + context (`RouteId`, audience set, capability manifest).
- Output: `QueAnswer` with `mode: 'deterministic'`, ranked articles, context-relevant next steps
  and permitted links. Empty results return the screen's default articles plus "ask staff".

```typescript
interface QueAnswer {
  mode: 'deterministic' | 'ai';
  text: string; // plain text or SafeMarkdown
  citations: string[]; // KbArticle ids, all authorized for the user
  links: RouteId[]; // all permitted for the user
  fallbackReason?:
    | 'ai_disabled'
    | 'offline'
    | 'timeout'
    | 'quota'
    | 'provider_error'
    | 'validation_failed';
  kbVersion: number;
}
```

### 11.5 Offline delivery

- Public (`visitor`) bundle + capability manifest snapshot: precached by the service worker
  (`vite-plugin-pwa`), stale-while-revalidate on `GET /api/v1/que/kb/public`.
- Restricted bundles: `GET /api/v1/que/kb` (authenticated) returns only articles for the session's
  audiences; stored in a per-user IndexedDB store keyed by user ID.
- No phone numbers, ticket recovery secrets or other PII are ever stored in KB caches.

#### 11.5.1 What may be cached for offline staff help

- **Allowed:** generic, role-level procedural articles from `packages/assist/knowledge/` (identical
  for every organization), the public capability manifest, and the route registry.
- **Never cached:** anything tenant-sensitive — organization, facility, service or counter names or
  configuration; staff names or emails; invitation data; visitors; tickets; ticket codes; recovery
  secrets; queue state; audit data; internal IDs; or any API response other than the KB bundle and
  manifest. Facility-specific explanations are shown online only, from endpoints the user can
  already read, and are never written to the Que cache.
- A KB build check rejects articles containing tenant placeholders or data-like patterns (emails,
  phone numbers, UUIDs).

#### 11.5.2 Offline authorization expiry

```typescript
interface CachedRestrictedBundle {
  userId: string;
  roleDigest: string; // SHA-256 of sorted role grants (role + facility_id) at issue time
  audiences: Audience[];
  kbVersion: number;
  issuedAt: string; // server time (diagnostic; never compared with the device clock)
  authorizedUntil: string; // server-set: min(session expires_at, issuedAt + QUE_OFFLINE_HELP_TTL)
  validForMs: number; // server-computed: authorizedUntil - issuedAt (a duration, not a timestamp)
  articles: KbArticle[];
}

interface OfflineHelpClock {
  receivedAtLocalMs: number; // device Date.now() when the bundle was received
  highWaterLocalMs: number; // largest Date.now() ever observed for this bundle (persisted)
}
```

Expiry is evaluated as **elapsed time since receipt**, never by comparing the device clock with a
server timestamp, so a device clock that is simply wrong (ahead or behind) has no effect:

- The server sends `validForMs` (default TTL equals the session lifetime, 12 h; never longer). The
  client stores `receivedAtLocalMs` and `highWaterLocalMs` with the bundle.
- Before every display: `elapsed = Date.now() - receivedAtLocalMs`. Restricted articles are shown
  only if `0 <= elapsed < validForMs - SAFETY_MARGIN_MS` (margin covers network latency and
  rounding; default 5 min).
- **Clock rollback:** if `Date.now() < highWaterLocalMs - ROLLBACK_TOLERANCE_MS` (default 2 min), the
  device clock has moved backwards. The bundle is marked _unverifiable_: restricted articles are
  hidden until a fresh authorized fetch succeeds. Otherwise `highWaterLocalMs` is advanced and
  persisted.
- **Within one page session:** the client also tracks `performance.now()` (monotonic, unaffected by
  wall-clock changes) from load; if wall-clock elapsed and monotonic elapsed disagree by more than
  the tolerance, the bundle is treated as unverifiable.
- **Restart / reload while offline:** the persisted `receivedAtLocalMs` and `highWaterLocalMs`
  continue to apply; monotonic tracking restarts. A restart combined with a clock moved backwards
  _before_ the restart is still caught by the high-water mark.
- **Missing or corrupt clock metadata:** treated as expired.

**Qualified guarantee (honest limit).** These checks enforce expiry against wrong, drifting or
accidentally reset clocks. They cannot defeat a person who fully controls the device (for example,
freezing or carefully manipulating the clock, or reading IndexedDB directly) — cached data on a
device is ultimately readable by that device's owner. The offline expiry is therefore a
best-effort bound on **display**, not a confidentiality control. Confidentiality comes from
§11.5.1: restricted bundles contain only generic, non-tenant-sensitive procedures, so extended
access reveals nothing an unauthorized person could not learn from public documentation of the
product. Server-side authorization (every online request) remains authoritative, and revocation
always takes effect at the first online contact.

#### 11.5.3 Role-change handling and cache invalidation

| Trigger                                                              | Action                                                                                                    |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Confirmed sign-out                                                   | Delete all restricted Que caches for the user                                                             |
| Sign-out failed (server not confirmed)                               | Keep cache; the user is still signed in (M1 behaviour)                                                    |
| Any 401 on an authenticated request                                  | Delete restricted caches; show public help                                                                |
| `/auth/me` or Que response with a different `userId` or `roleDigest` | Delete, then refetch for current roles                                                                    |
| A different user signs in on the device                              | Delete every other user's restricted cache                                                                |
| `authorizedUntil` passed                                             | Hide restricted articles; delete at next online check                                                     |
| KB bundle version changed                                            | Replace bundle atomically                                                                                 |
| Role revoked or account deactivated while device offline             | Takes effect at first online contact (401 or digest mismatch) or at `authorizedUntil`, whichever is first |

Server-side authorization remains authoritative: the restricted endpoint re-evaluates roles on
every request, like the rest of the API.

- Bundle `version` lets clients refresh incrementally; unchanged articles are not re-downloaded.

### 11.6 Authorization and tenant isolation

- `GET /api/v1/que/kb` and `POST /api/v1/que/ask` run the standard pipeline: authenticate →
  authorize (role/audience) → validate (Zod, strict) → respond. Visitors use only public endpoints.
- Que holds no tenant data of its own. Facility-specific context (e.g. "this service is single
  queue FIFO") is read in the browser from endpoints the user already has access to, never sent to
  an inference provider, and never fetched for another tenant.
- Cross-tenant and cross-facility probes against Que endpoints must return the same 404 / filtered
  results as the rest of the API.

### 11.7 Optional AI explanation layer (`apps/api`)

```typescript
interface InferenceAdapter {
  readonly id: string; // 'disabled' | 'sandbox' | provider id
  readonly costMode: 'free_tier' | 'sponsored' | 'none';
  explain(params: {
    question: string; // already redacted
    articles: { id: string; title: string; body: string }[]; // authorized subset only
    capabilitySummary: string; // live/preview/sandbox/planned list
    locale: 'en';
  }): Promise<{ text: string; citations: string[] }>;
}
```

- Default adapter: `DisabledInferenceAdapter`. Test double: `SandboxInferenceAdapter`
  (deterministic, scripted, labelled `[SANDBOX]`, never networked).
- Anonymous visitors never reach the AI layer: `POST /api/v1/que/ask` requires an authenticated
  staff session; the visitor UI shows deterministic help only and no AI affordance.
- Request flow for `POST /api/v1/que/ask`:
  1. Authenticate (staff session required); resolve audiences; check facility opt-in and
     `QUE_AI_ENABLED`.
  2. Validate input (length ≤ 500 chars, strict schema); per-user and per-IP rate limit.
  3. Redact PII patterns; run deterministic retrieval to select ≤ N authorized articles.
  4. Check daily cap; call adapter with timeout (e.g. 8 s).
  5. **Output guard:** citations ⊆ supplied articles; links ⊆ permitted routes; length limit;
     strip unsafe markup; reject mentions of non-live capabilities as available, instructions to
     perform actions Que cannot verify, or text that does not cite any article.
  6. Return `mode: 'ai'` on success, otherwise the deterministic answer with `fallbackReason`.
- Prompt-injection posture: user text and KB text are passed as delimited data, never as
  instructions; the system prompt contains no secrets or tenant data; there are no tools to abuse;
  the output guard is the final authority. Success is measured by tests, not by prompt wording.
- Logging: no question or answer text by default; log `trace_id`, mode, fallback reason, latency,
  adapter id. Aggregate counters only.

### 11.8 Provider research (no provider selected)

No inference provider is selected or integrated. During MQ, candidates are **researched only**;
selecting or integrating one requires a separate, explicit project decision. Eligibility (all
required): no personal spending; no payment card or billing details required; no automatic paid
overage (hard stop at the free/sponsored allowance). Also record: quota and rate limits,
data-retention and training-use terms, region, terms permitting this use, latency from target
regions, and an exit path. Research must not involve creating accounts that require payment
details. If none qualifies, the AI layer stays disabled and MQ is still complete.

### 11.9 UI (`apps/web` + `packages/ui`)

- Entry: a persistent, labelled "Ask Que" button in the page shell (all roles, including visitors),
  opening a non-modal panel on desktop and a full-height sheet on mobile; Escape closes and returns
  focus to the trigger.
- Panel: search field (labelled), context section "On this screen", results list, article view
  with numbered steps and permitted links, connectivity/source badge ("Built-in help — offline",
  "AI explanation"), and a live region announcing result counts and fallbacks.
- AI answers show an "AI-generated" label (text, not colour only), the cited articles, and
  "Check with staff before acting on queue decisions."
- No answer UI ever contains buttons that perform operations.

### 11.10 Knowledge-base content inventory and incremental updates

| Milestone | KB content added or updated (when that milestone's capability becomes live)                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 (done) | Org signup, sign-in, facility creation, services and ordering policy, counters and assignments, readiness, staff invitations, roles, deactivation, join link "not live yet" |
| M2        | Joining via QR/link, staff-assisted walk-in, ticket status, wait estimates, public board, counter call/serve/complete                                                       |
| M3        | Sync states (`local_only` … `rejected`), coordinator role, outage procedures, conflict review                                                                               |
| M4        | Priority overrides and reasons, transfers/routing, audit view                                                                                                               |
| M5        | Ticket recovery, missed-turn/grace rules, accessibility options, device health                                                                                              |
| M6        | SMS consent/opt-out, USSD menus — labelled `sandbox` until live                                                                                                             |
| M7        | Final review of every article against the capability manifest                                                                                                               |

Because the KB package is built in MQ, articles for M1–M5 are authored in MQ.5 against the
behaviour that is live at that point. From MQ onward, every milestone that changes user-visible
behaviour (M6, M7 and later) also updates the affected articles and capability entries in the same
change; the KB consistency test (Group 13.5) enforces it.
