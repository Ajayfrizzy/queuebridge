# QueueBridge — Spec Design

**Spec version:** 1.2 (2026-11-12)  
**Source:** `docs/QueueBridge_Technical_Architecture_v1.0.md`  
**Status:** Baseline — architecture and data model established at M0; M0–M4 implemented and merged into `staging`. §12 (Smart Turn Alerts, M5), §15 (M5.1 ticket recovery), §16 (M5.2 accessibility), §17 (M5.3 device health), §13 (SMS turn alerts, M6) and §14 (final UI/UX and landing page, M7) are planned and additive; §1–§11 are unchanged except where a note below says so.

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
  - _(M5.4, ADR-013)_ `PushTransport` interface with `SandboxPushTransport` (test-only label, no network) and `WebPushTransport` (RFC 8291 encryption with `http_ece` (MIT), RFC 8292 VAPID with `node:crypto`; not the MPL-2.0 `web-push` package). Separate from `ChannelAdapter`, which is SMS/USSD-shaped (it carries `handleUssdSession`). See §12.5.

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
  - `processNotificationOutbox` — poll outbox, dispatch via adapter, record delivery (M5: `web_push` rows via `PushTransport`, with stale suppression and bounded retries, §12.5; M6: SMS via `ChannelAdapter`, §13)
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
GET    /api/v1/queues/:id/audit/export                 # redacted (no names / free text); whole session or 413
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

| Template key          | Trigger                   | Channel                                                                 |
| --------------------- | ------------------------- | ----------------------------------------------------------------------- |
| `ticket.confirmed`    | Ticket created            | SMS                                                                     |
| `ticket.nearing_turn` | N tickets ahead           | SMS                                                                     |
| `ticket.called`       | Counter calls ticket      | SMS (M6), Web Push (M5), in-app (M5, derived from state, no outbox row) |
| `ticket.delayed`      | Significant wait increase | SMS                                                                     |
| `ticket.missed`       | No-show window elapsed    | SMS                                                                     |
| `ussd.welcome`        | Session start             | USSD                                                                    |
| `ussd.join_confirm`   | Joined queue              | USSD                                                                    |
| `ussd.status`         | Status check              | USSD                                                                    |
| `ussd.recovery`       | Ticket recovery           | USSD                                                                    |

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

### Planned additions (M5/M6, not yet in `.env.example`)

```
# apps/api (public key, capability reporting) and apps/worker (sending)
VAPID_PUBLIC_KEY          # Web Push application server key (public); absent => web_push capability "disabled"
VAPID_PRIVATE_KEY         # secret; worker only; never reaches the browser
VAPID_SUBJECT             # mailto: or https: contact required by the Web Push protocol
TURN_ALERT_TTL_SECONDS    # push TTL and retry horizon; default 120 (confirmed)
PUSH_MAX_SUBSCRIPTIONS_PER_TICKET  # default 3 (confirmed)
# M6
SMS_DAILY_CAP             # hard per-day message cap across the deployment; sends beyond it fail with a cap reason
# M5.1 / M5.3 (accepted initial defaults, all configurable)
RECOVERY_RATE_LIMIT_MAX=10         # recovery attempts per source per minute (all attempts counted)
AUTO_MISS_SWEEP_SECONDS=15         # automatic no-show sweep interval (feature itself is off by default per service)
DEVICE_STALE_AFTER_SECONDS=900
COORDINATOR_EXPIRY_WARN_SECONDS=300
CONFLICT_REVIEW_WARN_SECONDS=900
```

Subscription encryption reuses `CONTACT_ENCRYPTION_KEY` with a purpose-specific derived key (HKDF
info string `push-subscription`), so no additional secret is introduced. `pnpm env:generate` is
extended in M5.4 to generate a VAPID key pair for local development; `.env.example` lists every new
variable with a safe placeholder.

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

| Milestone | KB content added or updated (when that milestone's capability becomes live)                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1 (done) | Org signup, sign-in, facility creation, services and ordering policy, counters and assignments, readiness, staff invitations, roles, deactivation, join link "not live yet"          |
| M2        | Joining via QR/link, staff-assisted walk-in, ticket status, wait estimates, public board, counter call/serve/complete                                                                |
| M3        | Sync states (`local_only` … `rejected`), coordinator role, outage procedures, conflict review                                                                                        |
| M4        | Priority overrides and reasons, transfers/routing, audit view                                                                                                                        |
| M5        | Ticket recovery, missed-turn/grace rules, accessibility options, device health, **turn alerts** (in-app, sound, vibration, push: best effort, never promised, how to enable/disable) |
| M6        | SMS turn alerts (consent, opt-out, caps) and USSD menus — labelled `sandbox` until live                                                                                              |
| M7        | Landing page and onboarding guide; final review of every article against the capability manifest                                                                                     |

Because the KB package is built in MQ, articles for M1–M5 are authored in MQ.5 against the
behaviour that is live at that point. From MQ onward, every milestone that changes user-visible
behaviour (M6, M7 and later) also updates the affected articles and capability entries in the same
change; the KB consistency test (Group 13.5) enforces it.

---

## 12. Smart Turn Alerts (F14) — design (planned, milestone M5)

> Added 2026-11-12. Implemented in M5.4 (uncommitted at the time of writing); the differences from
> the text below (transport library and licence, registered enqueue hook, extra public click
> parameters `seq`/`rp`, endpoint allow-list, push controls on the ticket page) are recorded in
> ADR-013 "Implementation notes and deviations". Governing decision: ADR-013.
> Requirements: REQ-F14. Additive to §1–§11. The M5 recovery (F4), accessibility (F7) and device
> health (F9) requirements and tasks are unchanged; alerts are task group M5.4 and must also satisfy
> the M5.2 accessibility work.

### 12.1 Principles

1. **In-app first.** The always-available layer needs no permission, provider or cost.
2. **Best effort beyond that, never promised.** Sound, vibration and push widen reach where the
   platform allows; QueueBridge never claims they will arrive.
3. **Never on the critical path.** Alert work is isolated from queue commits; its failure changes
   nothing about the queue or any ticket.
4. **Committed truth only.** Alerts follow server-committed events, never local-only state.
5. **Honest states.** Only what is known is shown: `sent` is not `delivered`.

### 12.2 What already exists (M2/M3) and what M5 changes

Existing: `TicketPage.tsx` announces the visitor's turn through an assertive live region and calls
`navigator.vibrate` in the foreground; `DisplayBoard.tsx` has opt-in spoken announcements; the
schema has `notifications` (channel already allows `in_app`), `notification_outbox` (unique
`dedup_key`, `next_attempt_at`) and `notification_deliveries`; the worker has an outbox stub only.
M5 replaces the ad-hoc vibration with the settings-driven alert component, adds the push pipeline,
and implements the outbox consumer for `web_push`. M6 adds SMS to the same consumer.

### 12.3 In-app alert (client, `apps/web` + `packages/ui`)

**12.3.1 Alert.** A `TurnAlert` component driven by the ticket's server-confirmed state and `called`
event sequence. Content: "It's your turn. Please go to {counter}." with ticket code, an icon and a
text label ("Called"). Rendered in a persistent banner (not a toast that auto-dismisses), plus a
one-time assertive live-region announcement. Document title is prefixed ("Your turn: A-012") so a
backgrounded tab is identifiable. No focus theft; the banner has a Dismiss button, and dismissal
returns focus to the page heading. The alert clears when the ticket leaves `called`.

**12.3.2 Sound.** Off by default. An "Enable sound" control plays a short bundled tone on the click
(user gesture), then stores `sound=on` in `localStorage`. On a later call event the tone plays once;
play failures (autoplay policy, muted device) are swallowed and the visual alert stands. "Test alert"
plays the tone and shows a sample banner marked "Test". No looping, modest fixed volume; no
dependency on `speechSynthesis`. The staff-side public board keeps its separate optional speech.

**12.3.3 Vibration.** `navigator.vibrate([200, 100, 200])` only when `document.visibilityState` is
`visible`, the API exists, and `vibration=on` (default on where supported, matching M2 behaviour).
The settings panel states: "Vibration works only while this page is open, and not on every device."

**12.3.4 Once per call event.** `lastAlertedSequence` for the ticket is kept in `sessionStorage`
(and the sequence is part of the status payload). Sound and vibration run only when a new call
sequence is observed, so refreshes, reconnects and SSE replays do not repeat them; the visual
banner always reflects the current state.

**12.3.5 Reduced motion and contrast.** No animation is required for meaning. With
`prefers-reduced-motion` the banner appears without transition. Colours meet contrast in normal,
high-contrast and large-text modes; the banner never flashes (WCAG 2.3.1).

**12.3.6 Offline.** When the connectivity layer reports the server unreachable, a note says alerts
may be delayed and to watch the public board or ask staff. Local-only coordinator actions never
reach visitors (M3 rule); the alert appears when the server commits the call and the client syncs.

### 12.4 Triggering and the outbox (server, `apps/api`)

**12.4.1 One helper, all call paths.** `enqueueTurnAlerts(tx, session, event)` is called from the
shared command code that commits `ticket.call_next`, out-of-order call and `ticket.counter_transfer`
(for a ticket left `called`), including when those commands arrive through `POST /sync/batches`
(`applyCommand`). Because the sync path commits through the same code, an offline-coordinated call
alerts the visitor only after the server commits it.

**12.4.2 Savepoint isolation and one outbox entry per subscribed device.** Inside the open
transaction:

```
SAVEPOINT turn_alert;
  -- active = SELECT id FROM push_subscriptions
  --           WHERE ticket_id = $ticket AND revoked_at IS NULL AND expires_at > NOW() ORDER BY id
  -- for EACH subscription S in active (one device = one subscription = one outbound notification):
  --   one statement (CTE) creating the pair together or not at all:
  --     notifications     (channel 'web_push', template 'ticket.called', ticket_id, push_subscription_id = S.id)
  --     notification_outbox (notification_id, payload = { subscription_id, event_sequence },
  --        dedup_key = 'web_push:ticket.called:<ticket_id>:<event_sequence>:<subscription_id>')
  --     ON CONFLICT (dedup_key) DO NOTHING   -- a duplicate key skips that one row, never raises
RELEASE SAVEPOINT turn_alert;
-- on ANY error: ROLLBACK TO SAVEPOINT turn_alert; log + count; the queue command continues
```

`notification_outbox.dedup_key` is globally unique (`notification_outbox_dedup_idx`, migration `0001`),
so a key that does not identify the **device** would make the second subscription's insert collide
with the first. Including the subscription id in the key gives every device its own entry, keeps the
key unique per outbound notification (AGENTS §4.6), and makes the conflict clause a pure replay guard:
it can only fire for a replay of the same (ticket, call event, subscription), and when it does it
skips that one row without disturbing the other devices' entries or the savepoint. The helper does no
network I/O. A defect or constraint failure in alert code cannot fail a queue command, and a replayed
command (idempotent `duplicate` disposition) produces no second alert. A subscription added after the
call event is not retro-alerted (it has no row for that sequence).

**12.4.3 Suppression on state change.** A release/recall (`called → waiting`), a completed or missed
ticket, or a transfer to another counter makes the outbox consumer drop the pending alert at send
time (§12.5.4). The in-app banner clears on the next state update.

**12.4.4 Subscription identity (`subscription_id`).** The primary key of `push_subscriptions`
(random UUID, `gen_random_uuid()`). It is unique per (ticket, push endpoint): a device that
re-subscribes the same ticket gets the same id (idempotent on `endpoint_hash`); the same device
subscribing two tickets gets two ids; two devices on one ticket get two ids. It is **not derived from
the endpoint, not a credential, and grants nothing**: every endpoint that accepts it also requires the
ticket's status token. It is returned to the owning client as `subscription_ref`, and it is the one
identifier used for the outbox deduplication key, the push `Topic`, the notification `tag`, the click
destination (§12.5.7) and the aggregate counters. The endpoint URL, the endpoint hash, the keys and
every bearer credential never appear in a payload, URL, tag, `dedup_key`, log line or audit record.

### 12.5 Web Push

**12.5.1 Client subscribe flow.** Ticket page → "Get a push alert (optional)" button → feature check
→ `Notification.requestPermission()` (only inside this click) → `registration.pushManager.subscribe`
with the server's VAPID public key → `POST /api/v1/tickets/:publicCode/push-subscription`, which returns the non-secret `subscription_ref` that the page saves as `pushRef` on that saved ticket (§12.5.7).
"Turn off" calls `DELETE` and unsubscribes locally. Unsupported, denied, and iOS-not-installed states
each have specific plain-language text and no nagging. Nothing is requested on page load.

**12.5.2 Server endpoints** (status-credential authenticated like the ticket status endpoint; CSRF
header; rate limited; Zod strict):

```
GET    /api/v1/push/capability                          -> { web_push: 'live' | 'disabled', public_key? }
POST   /api/v1/tickets/:publicCode/push-subscription   -> 201 | 200 { subscription_ref }  (idempotent on endpoint hash: same ref)
DELETE /api/v1/tickets/:publicCode/push-subscription    -> 204
POST   /api/v1/tickets/:publicCode/alerts/ack           -> 204   { subscription_ref, event_sequence }  (page-sent "seen on device")
GET    /api/v1/queues/:id/alerts                        -> staff: per-called-ticket alert state (plain codes)
```

A fourth active subscription for a ticket is refused with 409 and the message "Push is already on for 3 devices. Turn it off on one first." (unlike status tokens, push subscriptions are never evicted silently). No endpoint ever returns endpoint URLs or keys. The public code in these paths is only a consistency check (as for ticket status): the status token header decides which ticket is meant, and a `subscription_ref` that does not belong to that ticket is 404. Cross-tenant and wrong-credential requests are 404.

**12.5.3 Storage.** The M5.4 migration (additive; constraint replacement only; numbered after the M5.1 and M5.3 migrations, so indicatively `0009`):

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  facility_id     UUID NOT NULL REFERENCES facilities (id)     ON DELETE RESTRICT,
  ticket_id       UUID NOT NULL REFERENCES tickets (id)        ON DELETE CASCADE,
  endpoint_hash   TEXT NOT NULL,           -- SHA-256, for idempotency; unique with ticket_id
  endpoint_ct     BYTEA,                   -- encrypted endpoint URL (capability URL: secret); NULL once revoked
  keys_ct         BYTEA,                   -- encrypted p256dh + auth; NULL once revoked
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,         -- created_at + 24 h or earlier (see 12.13)
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,                      -- visitor | ticket_ended | gone | session_closed | credentials_revoked | expired
  CHECK ((revoked_at IS NULL) = (endpoint_ct IS NOT NULL)),  -- ciphertext exists only while active
  failure_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (ticket_id, endpoint_hash)
);
-- notification_deliveries: add detail_code TEXT (e.g. 'accepted', 'gone', 'ttl_elapsed', 'client_ack', 'cap')
-- notifications: widen CHECKs: channel adds 'web_push'; status adds 'suppressed';
--   add push_subscription_id UUID REFERENCES push_subscriptions (id) ON DELETE SET NULL (per-device state)
```

Revocation, tombstones and hard deletion follow §12.13. No existing column or table is dropped.

**12.5.4 Worker consumer (`apps/worker`).** Each outbox row is one device. A worker claims due
`web_push` rows with `FOR UPDATE SKIP LOCKED` in a short transaction that also increments
`attempt_count` and moves `next_attempt_at` forward by a lease (so concurrent workers never take the
same row and a crashed worker's row becomes due again), then works outside the transaction:
re-reads the ticket: if it is not `called` at the same counter and call sequence, records `suppressed`
and stops; if `now > created_at + TTL`, records `failed`/`ttl_elapsed`; otherwise decrypts that one
subscription and calls `PushTransport.send` with `Topic = subscription_id` (32 hex characters,
non-secret) so the push service collapses a retried or duplicated message for that device. Outcomes:
2xx → `sent` (`accepted`); 404/410 → revoke that subscription only, `failed`/`gone`; 429/5xx/network →
exponential backoff to at most 3 attempts inside the TTL, then `failed`; any unexpected error →
`unknown`. One device failing never affects another device's row. Delivery is **at-least-once with
collapse** (a crash between sending and recording can re-send after the lease expires; the identical
`Topic` and notification `tag` replace rather than stack), and exactly-once delivery is never
claimed. Nothing the worker does updates `tickets`, `queue_sessions` or `queue_events`.

**12.5.5 Payload and service worker.**

```json
{
  "v": 2,
  "type": "ticket.called",
  "ref": "6f1c0a52-7d0e-4b0d-9a77-2d0c5f6f4b11",
  "code": "A012",
  "counter": "Counter 2",
  "seq": 41,
  "rp": "/recover/acme/city-clinic/A012",
  "ts": "2026-11-12T10:00:00Z"
}
```

`ref` is the `subscription_id` (§12.4.4); `seq` is the committed call event sequence; `rp` is the
public recovery path (public identifiers only, no key). The payload is encrypted end to end to the
device by the Web Push protocol and contains **no status token, recovery key, grant, endpoint, key
material or personal data**. TTL = `TURN_ALERT_TTL_SECONDS`, `Urgency: high`, `Topic = subscription_id`.
The service worker handler is added through the existing `generateSW` configuration
(`workbox.importScripts: ['push-handler.js']`), leaving the M3 offline shell and caching rules
untouched. The service worker has no `localStorage` and holds no bearer credential; it needs only the
payload. On `push`: if a focused QueueBridge window exists, `postMessage` the payload to it and show no
system notification (REQ-F14.5.7); the page shows the in-app alert only if `ref` resolves to the
ticket it is displaying (§12.5.7). Otherwise `showNotification` with `tag = qb-call-<ref>`,
`renotify: true`, best-effort `vibrate`, and `data = { ref, code, rp }`. **Neither the tag nor the
destination is built from the public code alone.** On `notificationclick`: focus an existing window
and navigate it, or open, `/ticket/<code>?ref=<ref>` (§12.5.7). The first-party acknowledgement is sent
by the **page** (which holds the status token) when it receives the hand-off or is opened from the
notification, as `POST …/alerts/ack { subscription_ref, event_sequence }`; a notification that was
shown but never opened therefore stays `sent`, which is the honest state.

**12.5.6 Platform notes (stated in the UI and KB).** Android Chrome: works with the browser
closed, subject to battery settings. Desktop Chrome/Edge/Firefox: needs the browser running. iOS
Safari: requires the app to be added to the Home Screen (iOS 16.4+) and permission granted from that
installed app. Vibration from a system notification is device- and OS-dependent and is not relied on.

**12.5.7 Ticket identity, notification mapping and opening a notification safely.**

_Why the public code is not enough._ Public codes repeat across queue sessions and facilities (each
numbers from `001`; two facilities can both issue `A012`). The existing web architecture already
handles this: a saved ticket has a device-local `id` (`StoredTicket.id`, UUID v7, never sent to the
server), `ticketPath` builds `/ticket/:code?k=<id>`, and `TicketPage.resolveSaved` returns
`ambiguous` for a bare `/ticket/:code` that matches several saved tickets. Push reuses that
architecture instead of adding a parallel one.

_Mapping._ The device-local `id` stays device-local. The server's `subscription_ref` is the shared,
non-secret key between a notification and the saved ticket:

1. When the visitor enables push on a saved ticket, the server returns `subscription_ref`; the page
   stores it on that `StoredTicket` as a new non-secret field `pushRef` (same `localStorage` record as
   the token, no new store; the service worker needs no copy).
2. A notification carries `ref` (§12.5.5). Its tag `qb-call-<ref>` and `Topic` are unique per
   ticket-and-device, so two tickets with the same public code never collapse into one notification.
3. The click destination is `/ticket/<code>?ref=<ref>`. A new `resolveByPushRef(ref)` in the saved-ticket
   helpers returns the saved ticket whose `pushRef === ref`, and `resolveSaved` is extended: **`ref` (or
   the existing `k`) wins; a bare code is never used to guess when a `ref` is present.** If both `k` and
   `ref` are present they must refer to the same saved ticket, otherwise the result is "not found".
4. The page then reads the token from `localStorage` as it does today and calls the ordinary
   token-protected status endpoint. The `ref` in the URL is only a lookup key; it is not accepted by the
   server on its own.

_A device without the corresponding saved credential._ A push subscription belongs to the browser
profile that created it, so a notification normally arrives where the ticket was saved. It can still be
opened where the saved ticket is gone: the visitor chose "forget ticket", cleared site data, or
storage failed when `pushRef` was saved. In every such case (`ref` resolves to no saved ticket):

- The page shows a neutral screen: "This alert is for ticket A012. That ticket is not saved on this
  device." It makes **no status request** and shows nothing about the ticket.
- It offers recovery paths that need a credential the visitor holds: the saved link or QR, `rp`
  (`/recover/<org>/<facility>/<code>`, where the recovery key is entered), or "Ask staff" (design §15.5a).
- It does **not** open another saved ticket that merely has the same public code. A separate "My saved
  tickets" link lists saved tickets (the existing chooser) clearly marked as not necessarily the one
  from the alert.
- It never receives or displays a bearer credential from the notification, because none is in it.

_Focused window._ The hand-off message carries `ref`; the page raises the in-app alert only when that
`ref` equals the `pushRef` of the ticket it is showing, otherwise it shows a non-blocking notice with a
link to `/ticket/<code>?ref=<ref>`.

_Recovery on another device._ Push subscriptions belong to the browser profile that created them and do not move with recovery. A ticket recovered on a new device has no subscription there; the visitor opts in again on that device, which yields a new `subscription_ref` and `pushRef` for that device.

_Transfers._ A service transfer creates a new destination ticket row. The transfer transaction (inside
the same alert-isolation savepoint) re-binds the transferred ticket's active subscriptions to the
destination ticket, keeping the same `subscription_id`. Saved-ticket `pushRef` therefore stays valid,
and the token chain already followed by the status endpoint continues to resolve. A counter transfer
within one ticket changes nothing.

### 12.6 Delivery state model

| Layer    | Recorded as                     | Meaning                                                                                |
| -------- | ------------------------------- | -------------------------------------------------------------------------------------- |
| In-app   | nothing server-side             | Derived from state; no delivery claim                                                  |
| Web Push | `sent` / `accepted`             | The push service accepted it; the device may never show it                             |
| Web Push | `delivered` / `client_ack`      | The visitor's page confirmed display or open (first-party, sent with the status token) |
| Web Push | `failed` / `gone` `ttl_elapsed` | Definitive failure or window elapsed                                                   |
| Web Push | `suppressed`                    | No longer relevant when sending (state changed)                                        |
| Web Push | `unknown`                       | Unexpected error; outcome not known                                                    |

Staff see: `No push` · `Push sent, not confirmed` · `Seen on device` · `Push failed` · `Alert not
sent (ticket changed)`, per device where a ticket has several, always with "The public board and calling aloud remain the reliable fallback."

### 12.7 Failure behaviour (required)

| Situation                                  | Behaviour                                                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Alert enqueue throws                       | Savepoint rolled back, error logged and counted; the call commits normally                                                   |
| Push service down / 5xx / timeout          | Bounded retries within TTL, then `failed`; ticket stays `called`; no queue effect                                            |
| Subscription expired (404/410)             | Subscription revoked; in-app alert still works                                                                               |
| Permission denied / unsupported / iOS web  | UI explains; in-app alert unaffected                                                                                         |
| Page closed, no push                       | No alert possible; public board / staff call are the fallback; no state change                                               |
| Audio blocked, vibration unsupported       | Silent fallback to the visual alert                                                                                          |
| Server unreachable from the visitor        | "Alerts may be delayed" note; no local-only claims                                                                           |
| Any of the above and the grace time passes | Only the F4 policy decides what happens; alert outcomes are never an input; never auto-marked missed because an alert failed |

### 12.8 Security and privacy

Subscription endpoint and keys are encrypted (AES-256-GCM, derived key), never logged, never
returned. Payloads contain the type, `subscription_id` (`ref`), ticket code, counter label, call sequence, public recovery path and timestamp, and never a status token, recovery key, grant or endpoint. `subscription_id` is a non-secret internal id and may appear in logs and metrics; the endpoint, `endpoint_hash`, keys and credentials never appear in logs, audit records, URLs, tags or deduplication keys. Subscription routes require the
ticket status credential, are rate limited (per IP and per ticket), cap active subscriptions
(`PUSH_MAX_SUBSCRIPTIONS_PER_TICKET`), and are tenant scoped. VAPID private key lives only in the
worker environment. Logs record counts, outcome codes and `subscription_id`, never endpoints, keys or payload bodies.
Retention: subscriptions expire with the ticket or at `expires_at`, whichever is earlier.

### 12.9 Observability and dashboard

Aggregate counters (attempted, sent, delivered, failed, suppressed, enqueue-errors) are exposed to
supervisors as a small panel on the connectivity dashboard (REQ-F9 area) with last-hour totals and
no personal data.

### 12.10 Interplay with M5.1 recovery, M5.2 accessibility, M5.3 device health

- **Recovery (F4):** the grace window starts from the committed `called_at`, not from alert success.
  Automatic miss is opt-in per service, time-based, reason `call_window_elapsed`. Recovery copy tells
  visitors alerts are best effort and how to check the board.
- **Accessibility (F7):** the alert controls and banner are in scope of the keyboard-only visitor
  journey, axe checks at 320/375 px, high-contrast and large-text modes, and reduced motion.
- **Device health (F9):** unchanged; the alert panel in §12.9 is additive and separate from device
  sync health.

### 12.11 Verification plan (Group 14, items 14.1–14.14)

Savepoint isolation test: a deliberately failing alert helper (forced constraint error) while a
real `call_next` runs — the call still commits with the expected event and sequence. State-neutrality
test: for every failure path in §12.7, ticket state, queue revision and event chain are unchanged and
no `ticket.miss` exists. Committed-only: an offline-applied call produces no alert until sync
commits it. Idempotency: replayed command and retried outbox row yield one send per subscription; a ticket with three subscriptions gets three outbox entries with distinct deduplication keys, and a replay adds none. Identity: two saved tickets sharing a public code (different facilities) get distinct tags and each notification opens its own ticket; an unmatched `ref` opens the neutral screen and makes no status call. Stale suppression:
release before send yields `suppressed`. State honesty: `sent` never becomes `delivered` without an
ack. Minimal payload and encrypted storage verified by DB inspection. Tenant isolation and
credential tests. Playwright: keyboard-only enable/disable flows, banner, live region, reduced
motion, 320/375 px, axe; a sandbox push transport proves the client handler without a real push
service. Real-device matrix recorded in `docs/testing/M5-evidence.md`.

### 12.12 Confirmed defaults (2026-11-12)

These defaults are confirmed for the specification; each is configurable where stated.

1. **Web Push TTL:** 120 seconds (`TURN_ALERT_TTL_SECONDS`, configurable); retries stop at the TTL, at most 3 attempts.
2. **Subscriptions:** at most 3 active push subscriptions per ticket (`PUSH_MAX_SUBSCRIPTIONS_PER_TICKET`, configurable downwards or upwards by deployment).
3. **Automatic no-show:** disabled by default per service. When an administrator enables it, the call-response time is entered explicitly (no default value is supplied), it executes only through the authoritative command path (design §15.8), is time-based only, and its reason is `call_window_elapsed`.
4. **All notification channels are best effort.** No channel is documented, labelled or tested as guaranteed.
5. **Explicit opt-in:** the visitor opts in to push (permission is requested only from the button) and to sound; vibration is on where supported (existing M2 behaviour) and can be switched off.
6. **Push delivery failure never changes queue state** (REQ-F14.7; Group 14.7).
7. **Grace window:** the existing per-service `grace_window_seconds` (default 300, range 0–3600, M2/M4) is the only grace setting. M5 does not introduce another default or change this one (design §15.7).
8. **Push subscription retention and deletion:** specified in §12.13.

Still open (does not block the specification): the real-device test matrix, that is, which Android and iOS
versions are available at no cost for the manual checks in Group 14.10.

### 12.13 Push subscription retention and deletion (specified before implementation)

| Moment                                                                                                                                                                                         | What happens                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subscribe                                                                                                                                                                                      | `expires_at = created_at + 24 hours` (the status-token lifetime) or earlier terminal event, whichever is first                                                              |
| Visitor turns push off                                                                                                                                                                         | Revoked immediately: `endpoint_ct` and `keys_ct` are set to NULL (columns are nullable for this), `revoked_at` and `revoke_reason = 'visitor'` recorded                     |
| Ticket reaches a terminal state (`completed`, `cancelled`), or `missed` and the grace window elapsed (a service transfer re-binds the subscription to the destination ticket instead, §12.5.7) | Revoked within one worker cycle (same nulling), reason `ticket_ended`                                                                                                       |
| Push service answers 404/410                                                                                                                                                                   | Revoked at once, reason `gone`                                                                                                                                              |
| Queue session closes                                                                                                                                                                           | All subscriptions of that session revoked, reason `session_closed`                                                                                                          |
| Staff "sign out visitor devices" or recovery revocation (design §15.6)                                                                                                                         | Subscriptions of that ticket revoked, reason `credentials_revoked`                                                                                                          |
| Revoked or expired row                                                                                                                                                                         | Ciphertext already gone; a tombstone (ids, `endpoint_hash`, reason, timestamps) is kept 24 hours for idempotency and abuse counting, then hard-deleted by the retention job |
| `notification_deliveries` / `notifications` for push                                                                                                                                           | No endpoint or key material is ever stored; rows kept 30 days for aggregate counts, then deleted                                                                            |
| Ticket row deleted (cascade)                                                                                                                                                                   | Subscriptions deleted with it                                                                                                                                               |

The retention job (`purgeAlertData`) runs in the worker at least every 15 minutes, is idempotent, and
logs only counts. No code path decrypts a subscription except the send step. Backups follow the
deployment's backup retention; because ciphertext is nulled on revoke, expired subscriptions are not
recoverable from the live database.

---

## 13. SMS Turn Alerts (F11) — design (planned, milestone M6)

> Added 2026-11-12. Specification only. Requirements: REQ-F11.8–REQ-F11.13. Decisions: ADR-009
> (adapters), ADR-013 (alert pipeline). USSD (F12) remains in M6 and is not reduced.

### 13.1 Architecture

SMS rides the outbox and worker built in M5. A committed `called` event enqueues an `sms` outbox
row (same savepoint helper) only when the ticket has a contact with recorded consent and SMS is
enabled for the facility. The worker sends through `ChannelAdapter.sendMessage` with
`idempotencyKey = sms:ticket.called:<ticket_id>:<event_sequence>` (a ticket has at most one consented
contact, so this identifies one recipient; any future multi-recipient channel must put the recipient in
the key, as push does with `subscription_id`). Provider receipts arrive on
`POST /webhooks/sms/:provider` (signature verified, replay defended) and update
`notification_deliveries` idempotently. `delivered` is recorded only from a provider receipt.

### 13.2 Consent, opt-out and data

Phone number is optional at joining, with a separate unticked consent checkbox stating purpose
("SMS when you are called"). The number is stored only as `visitor_contacts.phone_ciphertext` with
`consent_at` and `retention_until`; never in `queue_events`, logs or the IndexedDB outbox. Opt-out:
a control on the ticket page, a staff action, and an inbound reply keyword where the provider
supports it. Opt-out takes effect before the next send.

### 13.3 Spending controls and live/sandbox modes

`SMS_DAILY_CAP` is checked in the worker before every send; beyond the cap the row is `failed`
(`cap`), never queued for later overage. Sandbox is the default mode, with `[SANDBOX]` in logs and a
visible "Test mode — no real messages are sent" label in facility channel settings. Live mode is
selectable only when a provider adapter and credentials are configured, and is expected only for a
provider usable on sponsored or free credits (PRD §13). Provider research (tariffs, sender-ID,
sandbox, webhooks, receipts, spending controls) is recorded in the M6 evidence document. Real
provider support is preserved: adapters implement send, signed webhook verification and receipt
parsing, so switching providers is configuration plus one adapter.

### 13.4 Channel independence and optional cost control

In-app, push and SMS are independent senders of the same committed event; failure of one never
suppresses or blocks another or the queue. An optional facility setting ("send SMS only if the
visitor has not seen the in-app alert within N seconds") may reduce credit use; default is send
immediately, because delaying a turn alert has a fairness cost.

### 13.5 Verification

Group 10 sandbox contract tests (send, idempotency, receipt, signature, replay), consent and opt-out
tests, cap enforcement, "no delivered without receipt", and channel-independence tests mirroring
Group 14 (failure changes nothing, no auto-miss).

---

## 14. Final UI/UX, Branding and Public Landing (F15) — design (planned, milestone M7)

> Added 2026-11-12. Specification only. Requirements: REQ-F15. Decision: ADR-014.

### 14.1 Information architecture

`/` becomes the public landing page (today `Home.tsx`). Existing routes (`/join/:slug`,
`/ticket/:code`, `/staff/*`, `/admin/*`, `/display/*`, `/login`, `/signup`) keep their paths so links,
QR codes and tests remain valid. The landing page links to sign up, sign in, and "How joining a
queue works".

### 14.2 Design system

Tokens in `packages/ui` (CSS custom properties generated from a typed token file): colour roles
(surface, text, brand, success, warning, danger, focus) with light and high-contrast sets, a type
scale with a large-text multiplier, 4-px spacing scale, radii, elevation, and motion durations with
a reduced-motion override. Components (Button, Field, Alert, Badge, Card, Dialog, Table,
StatusPill, SyncStateIndicator, TurnAlert, etc.) consume tokens only. Status is always text plus
icon, never colour alone. Brand assets (wordmark, logo, favicon, PWA icons) are original SVG/PNG
created for the project; fonts are the system stack or self-hosted open-licence files.

### 14.3 Redesign scope and safety net

All roles' screens move to the shared tokens and components: visitor (join, ticket, recovery),
reception, counter console, supervisor (fairness, audit, connectivity), administration, public
board, and Ask Que (once built). Behaviour is unchanged. The existing Playwright suites, axe checks,
responsive and overflow checks are the regression net and may not be weakened; selectors and
accessible names are kept stable or updated in the same change with equivalent assertions.

### 14.4 Landing page content and structure

1. **Hero:** one-sentence promise ("Queues that keep moving when the connection doesn't"), a short
   supporting line, primary CTA "Set up your facility", secondary "Sign in", tertiary "How visitors
   join".
2. **Animated story (CSS/SVG):** join → wait → connection drops → staff keep calling safely →
   reconnect and review → "It's your turn". Each frame has a text caption; reduced motion shows the
   frames statically.
3. **Who it is for:** visitors, reception and counter staff, supervisors, administrators, auditors,
   one short block each.
4. **What it does:** account-free joining, staff-assisted tickets, offline-safe operation with
   visible review (no conflict-free claim), fair ordering and audit, accessibility, turn alerts
   (best effort, stated as such), wait estimates as ranges.
5. **Channels, honestly:** web and QR live; SMS and USSD status read from the capability manifest
   (`sandbox`/`planned` until live), never presented as live otherwise.
6. **Get started checklist:** the F10 sequence (organization → facility → service → counter → invite
   staff → share QR/join link → serve the first visitor), each step linking to the real screen after
   sign-in, reusing the facility readiness states.
7. **Footer:** privacy statement (what is collected, no trackers), accessibility statement (target
   WCAG 2.2 AA, how to report issues), licence and repository link.

No invented numbers, customers or testimonials.

### 14.5 Motion policy

Transforms and opacity only; no layout-thrashing properties. Reduced motion yields static content
with identical meaning. Any loop longer than five seconds has a visible Pause control (WCAG 2.2.2).
No scroll-jacking, parallax or auto-playing audio.

### 14.6 Performance

Lazy route chunk for the landing page; visitor/staff routes never import it. CI measures bundle
sizes per route and fails on regression against the recorded baseline; Lighthouse (free, CLI) runs
against the built preview for landing and visitor flows, and budgets are set from the first measured
baseline, not guessed.

### 14.7 Security and privacy

Production CSP forbids third-party origins (`default-src 'self'`; fonts, images, scripts from the
same origin), with HSTS, frame-ancestors, referrer and permissions policies. A Playwright test fails
if the landing page issues any request to another origin. `pnpm audit` gate unchanged.

### 14.8 Cross-browser matrix

Playwright projects add `firefox` and `webkit` for smoke journeys (landing, sign-up entry, visitor
join and ticket page, staff call) at a mobile and a desktop size, alongside the existing Chromium
projects. A manual real-device checklist covers Android Chrome and iOS Safari (including installed
app push), recorded with versions and results in the M7 evidence document along with known gaps.

### 14.9 Verification plan (Group 15)

Landing truthfulness against the manifest; reduced-motion and pause; axe, keyboard and recorded
manual screen-reader pass; no horizontal overflow at 320/375/768/1280/1440; bundle budgets; no
third-party requests; security headers; cross-browser smoke; full regression of Groups 1–14.

---

## 15. M5.1 Ticket Recovery (F4) — design (planned)

> Added 2026-11-12, revised 2026-11-12 after review. Specification only. Requirements: REQ-F4.1–F4.6
> (unchanged) and REQ-F4.7–F4.15 (additive). Decision record: ADR-015. Architecture: Addendum B.7.
> Tests: Group 8, items 8.R1–8.R12 (testing steering). Recovery never creates a queue event and never
> changes a ticket's state, position or waiting age.

### 15.1 Baseline (what exists today) and what changes

- A visitor ticket is read with a **status token**: 256-bit random (`generateToken`), sent in the
  `X-QB-Ticket-Token` header (never a URL parameter), stored only as a SHA-256 hash in
  `ticket_recovery_credentials`, valid 24 hours (`STATUS_TOKEN_TTL_HOURS`), held by the browser in
  `localStorage` (`qb.tickets.v1`). One row per ticket (unique `ticket_id`); a replayed join by the
  original requester (same join proof) replaces it.
- The public ticket code (for example `A012`) is shown on the public board and spoken aloud. It is an
  **identifier, never a credential**.
- `services.policy.grace_window_seconds` (default 300, range 0–3600) already governs `missed → waiting`
  (`grace_window_active`). `ticket.resume` is a staff action today.
- Missing today: any way to get a ticket back after the browser state is lost; abuse limits for such
  a path; rejoin configuration; the unused `attempts` column.
- A status token **cannot** cancel, transfer or reorder a ticket and exposes no personal data: the public routes offer only status read, the live stream and the join; M5 adds only management of the ticket's own credentials and alert subscriptions, and (with `self_resume`) rejoin of a missed ticket. This bounds the harm of a wrongly granted token and is used in the staff procedure (§15.5a).

### 15.2 Principles

1. **No recovery from a public ticket code alone.** The code is read from boards, spoken aloud and
   seen over shoulders. Recovery needs a private high-entropy credential, or the restricted staff
   procedure of §15.5a.
2. **Brute-force defences key on public identifiers and the source, never on the guess.** Changing
   the submitted credential cannot change any throttle key, so guesses cannot be used to dodge limits.
3. **No irreversible lockout.** Every throttle state expires on its own (at most 15 minutes), and a
   legitimate holder of the credential on a clean source always succeeds, even during an attack on
   their ticket. An attacker can only block their own sources.
4. **Recovery restores access to the visitor's own ticket and reveals nothing else** (REQ-F4.5).
5. **Uniform, oracle-free failure:** unknown, wrong, expired and terminal cases are indistinguishable
   in status, body and processing time.
6. **Recovery is on the identity plane:** it touches credential tables only, takes no queue-session
   lock, appends no `queue_events`, and cannot interfere with the authoritative sequence or the
   coordinator (§15.11).
7. **Staff never see or speak a credential.** They can only start a single-use grant that the
   visitor's own device redeems, after the verification procedure (§15.5a).
8. **Every change of who can see a ticket is audited** in `admin_events` (no secrets, no PII), and the
   rightful holder's existing devices are told when access is granted elsewhere.

### 15.3 Credentials

| Artifact             | Form                                                                    | Role                                                                           | Stored as                                                |
| -------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Public ticket code   | `A012`                                                                  | Identifies the ticket on screens and in conversation. **Never a credential**   | Plain (`tickets.public_code`)                            |
| Status token         | 256-bit CSPRNG, 43-char base64url                                       | Bearer credential held by a device; reads status, manages alerts, rejoins      | SHA-256 hash; at most 3 active per ticket; 24 h          |
| **Recovery key**     | **160-bit CSPRNG** (`randomBytes(20)`), Crockford base32, 32 characters | Gets a new status token for that ticket on another device. Grants nothing else | **HMAC-SHA-256** (HKDF-derived pepper), never reversible |
| Staff hand-off grant | 160-bit CSPRNG, single use, 10-minute expiry                            | Lets the visitor's device redeem a new status token after staff verification   | HMAC-SHA-256; consumed on use                            |

**Entropy.** The recovery key has 160 bits, above the 128-bit minimum required for recovery
credentials (REQ-F4.4, security steering). Online guessing is infeasible at any request rate; the
throttles of §15.10 are defence in depth and resource protection, not the primary control. The key is
generated with the platform CSPRNG, shown once, and never derived from the ticket code, time or any
guessable value.

**Visitor-friendly presentation without weakening it.**

- **QR and link (primary).** `https://<app>/recover/<org>/<facility>/<ticketCode>#k=<recoveryKey>`.
  The key sits in the URL **fragment**, which browsers do not send to servers, proxies, access logs or
  `Referer`. The recovery page reads the fragment, immediately removes it from the address bar with
  `history.replaceState`, and sends the key only in a POST body over TLS. The QR encodes this link
  (error correction M). Opening the link on the new phone recovers in one tap.
- **Readable text (fallback).** Eight groups of four characters, `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`,
  in a monospace face, high contrast, with a spoken-friendly alphabet that excludes `I L O U`.
  Input is case-insensitive, ignores spaces and hyphens, and folds `I/L→1` and `O→0`, so a typed or
  dictated key works. The form uses `autocapitalize="characters"`, `spellcheck="false"` and
  `autocomplete="off"`.
- **Actions:** Copy key, Copy link, Share (Web Share API where supported), Save as text, Print, and a
  screenshot hint. Each has an accessible name and keyboard operation (§16).
- **Warning copy:** "Anyone with this link or key can open your ticket on another device. Keep it
  private." The key is never stored in `localStorage` or the offline outbox and never logged.

The pepper is derived with HKDF from `CONTACT_ENCRYPTION_KEY` (info `recovery-key`), so no new secret
is introduced. HMAC storage means a database leak without the pepper yields nothing verifiable;
rotating the pepper invalidates all recovery keys, which visitors can regenerate.

### 15.4 Data model (M5.1 migration, additive; indicatively `0007`)

```sql
-- Status tokens: several active tokens per ticket (<= 3, enforced under a row lock)
ALTER TABLE ticket_recovery_credentials
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'join'
    CHECK (source IN ('join', 'recovery', 'staff')),
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_reason TEXT,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
DROP INDEX IF EXISTS ticket_recovery_creds_ticket_idx;          -- unique(ticket_id) -> plain partial index
CREATE INDEX IF NOT EXISTS ticket_recovery_creds_active_idx ON ticket_recovery_credentials (ticket_id, created_at)
  WHERE revoked_at IS NULL;   -- as implemented; revoked rows are KEPT and purged by retention (15.14), not deleted
-- `attempts` (M0, unused) stays, documented as legacy. Only a superseded index is dropped.

CREATE TABLE IF NOT EXISTS ticket_recovery_proofs (          -- one recovery key per ticket
  ticket_id       UUID PRIMARY KEY REFERENCES tickets (id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  facility_id     UUID NOT NULL REFERENCES facilities (id)     ON DELETE RESTRICT,
  key_hmac        TEXT,                    -- NULL after the post-visit purge (15.14)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at      TIMESTAMPTZ
);                                          -- no failure counters, no lock columns: nothing here can lock a visitor out

CREATE TABLE IF NOT EXISTS ticket_recovery_grants (          -- staff hand-off, single use
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       UUID NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  grant_hmac      TEXT NOT NULL UNIQUE,
  assurance       TEXT NOT NULL CHECK (assurance IN ('basic', 'strong')),
  created_by      UUID NOT NULL REFERENCES staff_users (id),
  approved_by     UUID REFERENCES staff_users (id),          -- required to REDEEM when assurance = 'basic' (see the CHECKs below)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,                      -- created_at + 10 minutes
  redeemed_at     TIMESTAMPTZ,
  -- As implemented (0007). The original single CHECK would reject a PENDING request (created, not yet
  -- approved), so the rule is split: a different approver is always required once approved, and a
  -- 'basic' grant can never be redeemed without that approval. Also added: reason_code, approved_at,
  -- revoked_at, facility_id.
  CONSTRAINT ticket_recovery_grants_second_person_chk CHECK (approved_by IS NULL OR approved_by <> created_by),
  CONSTRAINT ticket_recovery_grants_approval_pair_chk CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CONSTRAINT ticket_recovery_grants_redeem_requires_approval_chk
    CHECK (redeemed_at IS NULL OR assurance <> 'basic' OR approved_by IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS recovery_throttle (               -- self-expiring counters; keys never contain the guess
  scope             TEXT NOT NULL CHECK (scope IN ('source', 'target_source', 'target', 'facility', 'facility_source')),   -- 'facility_source' added at implementation: lets L4 refuse only sources that already failed in this facility
  key_hash          TEXT NOT NULL,          -- HMAC(pepper, scope | public identifiers | source); no PII, no secret
  window_started_at TIMESTAMPTZ NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  failures          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key_hash)
);
```

```sql
CREATE TABLE IF NOT EXISTS auto_miss_sweeps (                -- outage detection for automatic no-show (15.8)
  id           BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),  -- single row
  last_pass_at TIMESTAMPTZ NOT NULL,                         -- database time of the last completed pass
  outage_end_at TIMESTAMPTZ                                  -- set when a pass found a gap > 3 intervals
);
```

The _source_ is the client IP (IPv4 /32, IPv6 /64) stored only as an HMAC, never in clear. It is
operational abuse-control data, not device-health data, and is purged within 24 hours (§15.14).

`services.policy` gains two additive, defaulted fields (versioned like all policy changes, ADR-012;
snapshots written earlier read as the defaults, so replay is unaffected): `rejoin_policy:
'staff_resume' | 'self_resume'` (default `staff_resume`, today's behaviour) and
`auto_miss: { enabled: boolean; after_seconds?: number }` (default `{ enabled: false }`; §15.8). A third boolean, `staff_recovery` (default `true`), lets a facility turn off staff-assisted recovery entirely (restricted assistance only; §15.5a).

### 15.5 Workflows

**A. Joining (all web joins and staff walk-ins).** The response returns, once, the status token and the
recovery key (as QR/link and readable text). The ticket page presents it with Copy/Share/Save/Print.
A replayed join by the original requester (lost response) re-issues both, as the token is re-issued
today. Walk-ins created at the desk show the recovery key to the person present at creation, on the
staff screen, for them to scan or photograph.

**B. Lost device or cleared browser, visitor has the link, QR or key (self-service).** Scanning the QR
or opening the link on the new device recovers in one step; otherwise `/recover` takes facility,
ticket code and the typed key. The server resolves the ticket by (facility, code) among tickets in
recoverable states in today's sessions, verifies the HMAC in constant time and issues a new status
token (`source = 'recovery'`). The page then offers "Sign out other devices".

**C. Token present, key lost.** On the ticket page: "Get a new recovery key" (status token required)
replaces the key; the old one stops working at once.

**D. Lost both (no token, no key): staff-assisted recovery.** Governed by §15.5a. It is a restricted
procedure, not a convenience.

**E. Under attack.** A flood of wrong guesses against a ticket never locks the rightful holder out
(§15.10). Staff-assisted recovery remains available, and supervisors receive a `recovery_abuse` alert.

**F. Provisional (offline) tickets.** A ticket created offline has only a temporary reference and no
credentials; recovery is unavailable until the server confirms it (M3 mapping), and the UI says so.
After sync the confirmed ticket gets its token and recovery key like any join.

**G. Missed turn.** See §15.7.

### 15.5a Staff-assisted recovery: verification and restricted assistance procedure

**Why a procedure is needed.** Physical presence and knowledge of the public ticket code do **not**
prove identity. The code is on the public board and is called aloud, so anyone in the waiting area can
quote it. Staff must therefore never grant private access to a ticket on presence plus the code alone.

**What is at stake.** A status token lets its holder read the ticket's status, receive its turn
alerts, manage its own credentials and (with `self_resume`) rejoin a missed ticket. It exposes no
personal data and cannot cancel, transfer or reorder a ticket. A wrongful grant therefore causes
privacy-of-position and nuisance harm (and could displace the rightful holder from the alert), not
loss of the place. The procedure keeps that residual risk small and detectable.

**Factors.**

| Factor                        | Definition                                                                                                                                                                 | Strength | Availability                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Server-checked contact match  | Staff type the phone number the visitor states; the server compares it with the consented contact recorded at join and answers match / no match without ever displaying it | Strong   | **Not available in M5**: no contact data is collected before M6 (SMS consent). Becomes available when M6 records consented contacts |
| Account of the visit          | The visitor states the service and the approximate join time (within ±10 minutes), which staff confirm against the console                                                 | Basic    | Always                                                                                                                              |
| Public ticket code / presence | Quoting the code, being at the desk                                                                                                                                        | **None** | Never counts as a factor                                                                                                            |

**Decision rules.**

1. **No factor satisfied → restricted assistance only.** No credential is issued. Staff may: say what
   the public board already shows; ask the person to stay and present themselves at the counter when
   the code is called (the counter operator sees the person, as in every queue today); or offer a new
   ticket. Staff do not disclose any private status.
2. **Basic factor only → low assurance.** Allowed only with a second person: a user holding
   `QUEUE_MANAGE` (supervisor or facility admin, or organization admin) different from the requester
   confirms in their own session before the grant is created. The audit record is flagged
   `assurance: basic`.
3. **Strong factor (from M6) → any `WALK_IN` role** (reception, counter, supervisor, facility admin)
   may create the grant alone; the account of the visit must also match.
4. **Every grant:** mandatory reason code (`lost_device`, `cleared_browser`, `no_smartphone`, `other`);
   checklist confirmations recorded as booleans; **single-use, expires in 10 minutes**; shown as a QR
   on the staff screen that the visitor's own device scans (staff never see, read out or copy a
   credential); redeemed at `POST /tickets/recover` with the grant. Limits: 3 grants per ticket per
   hour and 5 per staff user per 10 minutes. Auditors cannot use it.
5. **Detection:** whenever a new token is issued by recovery or a grant, the ticket's other devices
   display "Access to this ticket was granted on another device at HH:MM. If this was not you, sign
   out other devices." and the event is audited, so a wrongful grant is visible to the rightful holder.
6. **Secrecy:** staff can mint a grant or revoke access; they cannot read tokens, keys or hashes.
   Audit records hold ticket id, actor, approver, reason code, assurance level and factor booleans,
   never values.

**Documented limits.** In M5 every staff-assisted grant is low assurance (basic factor + second
person), because no server-checked factor exists yet. This is stricter than convenience would suggest
and is deliberate. Facilities that prefer to avoid even this can disable staff-assisted recovery in
the service policy, leaving restricted assistance only. A skilled impersonator who learns the service
and join time can still pass the basic factor; the second person, the 10-minute single-use grant, the
notification on the rightful holder's devices and the audit trail are the compensating controls.

### 15.6 Rotation and invalidation

| Event                                                      | Status tokens                                                           | Recovery key                  |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------- |
| Join (first)                                               | 1 issued (`join`)                                                       | Issued                        |
| Join replayed by the original requester                    | The prior `join` token revoked, new issued                              | Regenerated                   |
| Successful recovery (key or grant)                         | New token added; if 3 are active the oldest is revoked; others notified | Unchanged (grant consumed)    |
| "Sign out other devices" (visitor, current token required) | All other tokens and push subscriptions revoked                         | Regenerated                   |
| Staff "revoke all visitor access" (lost/stolen phone)      | All tokens and push subscriptions revoked                               | Regenerated                   |
| "Get a new recovery key"                                   | Unchanged                                                               | Replaced; old invalid at once |
| Ticket reaches a terminal state                            | Remain valid read-only until their 24 h expiry                          | Hash removed after 24 h       |
| Token expiry (24 h)                                        | Rejected; rows deleted by the retention job                             | n/a                           |

Rotation is atomic under a row lock on the ticket's `ticket_recovery_proofs` row.

### 15.7 Grace period and rejoin policy

- **Grace window:** the existing `grace_window_seconds` (default 300, 0–3600). No new grace setting or
  default is introduced. It starts at `missed_at`, exactly as `ticket.resume` already evaluates it.
- **Rejoin policy** (`rejoin_policy`, per service, versioned): `staff_resume` (default, current
  behaviour) leaves resuming to staff; `self_resume` additionally lets the visitor press "I'm here" on
  their ticket page **while the grace window is active**. Beyond the window, or with grace `0`, the
  ticket stays `missed` and the page says "Your turn passed. Join the queue again" with the join link;
  a new join makes a new ticket (no silent reinstatement).
- **Self-resume mechanics:** `POST /tickets/:code/rejoin` (status token, CSRF, `operation_id`) runs the
  existing `ticket.resume` through the standard command path under the session lock, with actor kind
  `visitor`, allowed only for `missed → waiting` with `grace_window_active`. Placement and waiting-age
  rules are exactly those of staff resume (unchanged). It is idempotent by `operation_id` and refused
  with the usual `coordinator-active` result while an offline coordinator holds the queue (§15.11).
  The domain transition table gains a `visitor_self` role for that single transition only.
- The visitor-facing wording states the remaining grace time only as a bounded statement and never
  promises the position they will get.

### 15.8 Automatic no-show (opt-in; default off)

**Setting.** `auto_miss: { enabled, after_seconds }` per service; **disabled by default**. When
enabled the administrator must enter `after_seconds` (validated 60–3600); no default is supplied. The
policy is shown to visitors on the ticket page ("If you are not at the counter within N minutes of
being called, your ticket may be marked as missed") so the rule is transparent. The time is a floor,
not a promise: execution may be later (see below).

**Execution only through the authoritative queue-transition and audit mechanisms.** The sweep never
updates tickets directly. For each candidate it calls the same command executor used by every queue
command (`applyCommand` path), with the `system` role added to the transition table for the single
transition `called → missed`. That path already provides: session lock, ticket row lock, state and
policy preconditions, the `ticket.miss` event with the hash-chained append, `ticket_transitions`, the
routing/revision updates, the policy version in the payload, the change signal, and the
`client_operations` record. The event carries actor `system` (null staff id), `reason_code =
call_window_elapsed`, the policy version and the call event sequence it acted on.

**Transactional locking and idempotency.** Per candidate, one transaction:

1. Lock the queue session, then the ticket (`FOR UPDATE`), in the global lock order used by all commands.
2. Re-check, under the locks and with database `NOW()` (never an instance clock): ticket still
   `called` (not `serving`), still the same call event sequence, auto-miss still enabled in the
   **current** policy version, queue `open`, **no coordinator assigned**, and the effective start
   plus `after_seconds` has passed (below).
3. Apply the command with a **deterministic `operation_id`**: a UUID with the version-7 layout whose
   timestamp field is the deadline and whose random bits are an HMAC of (ticket id, call event
   sequence). Every instance computes the same id, so `UNIQUE (organization_id, operation_id)` in
   `client_operations` makes a concurrent or repeated execution return `duplicate`, never a second
   miss. A ticket that was re-called since has a different call sequence, so a stale attempt is rejected.

**Offline coordinator fencing (M3) is not bypassed.**

- Auto-miss is a queue advancement. It is refused whenever a coordinator is assigned to the session
  (`coordinator_device_id` not null, even if its authorization has expired), exactly like any online
  advancement. It never changes the coordinator epoch.
- After the coordinator is revoked or replaced, the clock restarts: effective start is
  `GREATEST(called_at, time of the latest coordinator event in the session)`. This leaves time for
  the previous coordinator's unsynced actions to reach the server and be reviewed, so a visitor the
  coordinator served offline is not wrongly missed. A stale-epoch reconnect still goes to
  `needs_review` as today.

**Multiple API instances.** No leader is needed for correctness. Each instance runs the sweep; the
locks, the re-check and the deterministic `operation_id` make duplicate work harmless. An optional
`pg_try_advisory_lock` per sweep only reduces wasted work. Candidates are processed in session-id
order, one per transaction, with a per-sweep batch cap so one instance cannot monopolise the database.

**Restart recovery and delayed timers.** The sweep is stateless: every pass recomputes from the
database; there are no in-memory timers to lose. It runs at startup and then every
`AUTO_MISS_SWEEP_SECONDS` (initial default 15). Lateness is therefore bounded by the interval plus
any downtime, and the rule is "not before". To stop an outage from mass-missing visitors who could
not be served while the system was down, the sweep records a heartbeat (`auto_miss_sweeps`: last
successful pass); if a pass finds the previous one older than 3 intervals it treats the gap as an
outage and uses the pass time as the effective start for every called ticket
(`GREATEST(called_at, outage_end, last coordinator event)`).

**Never notification-driven.** The sweep reads no notification, push, SMS, outbox or delivery data and
has no import path to them. Nothing about whether, when or how an alert was delivered or failed is
evidence for marking a visitor missed (REQ-F14.7.3). A test makes alert failure and success
indistinguishable to the sweep.

After an automatic miss the normal grace window and rejoin policy apply (§15.7).

### 15.9 API surface (additive; all Zod-strict, CSRF-protected, tenant-scoped, RFC 9457 errors)

| Method and route                                         | Caller          | Result                                                                                                                      |
| -------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `POST /tickets/recover`                                  | Visitor         | `{ org_slug, facility_slug, ticket_code, recovery_key }` or `{ grant }` → new token, or uniform failure                     |
| `POST /tickets/:code/recovery-key`                       | Status token    | New recovery key (shown once)                                                                                               |
| `POST /tickets/:code/sessions/revoke-others`             | Status token    | Revokes all other tokens and subscriptions; returns a new recovery key                                                      |
| `POST /tickets/:code/rejoin`                             | Status token    | `self_resume` only; `missed → waiting` in grace                                                                             |
| `POST /queues/:id/tickets/:ticketId/recovery/assist`     | `WALK_IN` staff | Records the verification outcome; creates a single-use grant (basic assurance needs an approver); returns the grant QR once |
| `POST /queues/:id/tickets/:ticketId/recovery/approve`    | `QUEUE_MANAGE`  | Second-person approval for a basic-assurance grant                                                                          |
| `POST /queues/:id/tickets/:ticketId/recovery/revoke-all` | `WALK_IN` staff | Revoke all visitor access; regenerate the key                                                                               |
| `GET /queues/:id/recovery/requests`                      | `QUEUE_MANAGE`  | Approval list: requests for tickets of this queue only (scoped to the queue, as approval is; manual check 9, 2026-11-15)    |
| `GET /queues/:id/recovery/audit?after&limit`             | `AUDIT_VIEW`    | Read-only Recovery activity for this queue's tickets (§15.9a; approved extension, 2026-11-16)                               |

There is no unlock endpoint because there is no lock (§15.10).

#### 15.9a Recovery activity audit view (approved extension, 2026-11-16; ADR-015 amendment 1)

Recovery audit records are `admin_events` (rule 8 above); recovery never writes queue events
(8.R6). The M4 queue Audit trail shows only the queue's hash-chained events, so before this
extension no screen showed who requested or approved a staff-assisted recovery (manual check 12).

- **Endpoint:** `GET /api/v1/queues/:id/recovery/audit?after=<cursor>&limit=<1–100, default 50>`.
  Same authorization as the queue audit view (`AUDIT_VIEW`: auditor, supervisor, facility admin;
  organization admins through their facility permission); read-only; tenant, facility and queue
  scoped on the server; another tenant's or facility's queue is 404.
- **Rows:** the existing `ticket_recovery.*` `admin_events` whose target is a ticket of this queue
  session, oldest first, ordered by `(created_at, id)`; keyset pagination (`next_after` is the
  last row's event id). Nothing is written, rewritten or backfilled.
- **Fields:** time, public ticket code, event kind, who performed it, reason code, assurance,
  method, outcome and revoked-device count where the event recorded them. Details are copied
  through an allow-list; nothing else from `details` is returned.
- **Attribution:** staff events (`assist`, `approved`, `restricted_assistance`, `revoke_all`) are
  attributed to the event's immutable `actor_id`. The name shown is the account's current
  `display_name`, resolved at read time within the same organization: a display label, not a
  historical snapshot; a renamed account shows its new name, and a deactivated or suspended one
  is still named and marked as such (staff are never deleted). Visitor actions (`recovered`,
  `key_regenerated`, `sessions_revoked`) are shown as the visitor's device, never as a staff
  member; `abuse_detected` as the system. An event without a recorded actor is shown as "not
  recorded", never guessed. Requests, approvals and redemptions are related only by their ticket
  and time: the events carry no request id, so no further link is claimed.
- **Never returned:** recovery keys, grants, status tokens, hashes, links, staff emails or ids.
- **Limit:** events of a ticket transferred from another queue stay on its original (root)
  ticket's queue.

### 15.10 Rate limiting and abuse prevention

Keys are built only from **public identifiers and the source**: `source` = HMAC of the client IP;
`target` = facility + the submitted public ticket code; the submitted recovery key, grant or any part
of a guess is never part of a key. Every attempt, including malformed requests, is counted before
verification.

| Layer | Key                  | Limit (configurable; the per-IP default is accepted)                                | On exceed                                                                                                                   |
| ----- | -------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| L1    | source               | **10 attempts per minute** (`RECOVERY_RATE_LIMIT_MAX`, all attempts)                | 429 for the rest of the minute                                                                                              |
| L2    | target + source      | **5 failed attempts per 15 minutes** (REQ-F4.4, applied per ticket code per client) | 429 to that source for that ticket until the window ends                                                                    |
| L3    | target (all sources) | 50 failures per 15 minutes                                                          | `recovery_abuse` alert; sources that already failed for this ticket get 429; **sources with no failure still get verified** |
| L4    | facility             | 100 failures per 15 minutes                                                         | Sources with a recent failure get 429 for 5 minutes; clean sources unaffected                                               |
| L5    | process              | Cap on concurrent verifications                                                     | 503 with retry hint                                                                                                         |

Properties (each has a test):

- **The guess cannot dodge the limits.** No key contains it. 1,000 different wrong keys count as
  1,000 failures against the same L1/L2/L3/L4 keys.
- **No irreversible lockout and no denial of the rightful holder.** All counters expire within 15
  minutes (and are purged within 24 hours). A request from a source with no failures for that ticket
  is always verified, even while the ticket is under attack from other sources, so an attacker can
  block only the sources they control. There is no lifetime counter, no `locked` state and no
  unlock action.
- **Oracle-free:** unknown tickets are counted and throttled with the same keys (the submitted public
  code is the target key whether or not it exists), and every failure does the same work (a dummy
  HMAC when no ticket matches) and returns the same body.
- **Shared networks:** visitors behind one facility Wi-Fi address share L1 (10 per minute across them)
  but not L2 (per ticket and source). A burst at one address delays others on that address for at most
  a minute; it never affects other addresses.
- **Cost of an attack:** with 160-bit keys, even unlimited attempts do not make guessing feasible;
  the limits stop resource exhaustion and make probing visible.
- Failures are counted with single atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING` statements.
- Staff-assisted actions are limited per staff user and per ticket (§15.5a). No CAPTCHA is used
  (accessibility; cost).

### 15.11 Interaction with M3 offline synchronization

- Recovery, rotation and staff hand-off touch credential tables only: no session lock, no
  `queue_events`, no `client_operations`. They work while a coordinator holds the queue and cannot
  fence, advance or confuse coordinator authority.
- Status shown after recovery is the **server-committed** state with its freshness note. A recovered
  ticket whose call was made offline shows nothing until the server commits it (REQ-F1.8).
- `self_resume` and auto-miss are queue transitions and therefore obey the existing fence: refused or
  suspended while a coordinator is assigned, with a plain message ("Please speak to a member of staff").
- Offline staff devices never mint credentials. Hand-off and revocation require a server round trip
  and are disabled with an explanation while the staff device is offline.
- The IndexedDB outbox stores no tokens or recovery keys (REQ-SEC offline rule).

### 15.12 Interfaces

**Visitor:** ticket page ("Keep your recovery key": QR, link, readable groups, Copy/Share/Save/Print,
"Get a new recovery key", "Sign out other devices", rejoin button with grace text; a banner when access
is granted on another device); `/recover` and `/recover/:org/:facility/:ticketCode#k=…` (reads and
strips the fragment; without a fragment, as when opened from a push notification's `rp`, it
prefills facility and ticket code from the public path and asks for the key, single column, error summary, inline errors, no CAPTCHA, offline message, works at
320 px, announces the outcome); "Lost your ticket and your key? Ask staff" explaining what staff will
ask and why. **Staff console:** ticket row action "Help visitor get their ticket back" that walks
through §15.5a (factor questions, assurance outcome, restricted-assistance script when no factor
holds, request approval, grant QR shown once). **Supervisor:** approval queue for basic-assurance
requests and recovery counters on the connectivity dashboard. **Admin:** service policy fields
`rejoin_policy`, auto-miss (toggle with required seconds) and "allow staff-assisted recovery".

### 15.13 Failure, replay and concurrency

| Case                                                      | Behaviour                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Recovery response lost, visitor retries with the same key | Succeeds again, adds another token (cap 3, oldest revoked); harmless                               |
| Grant redeemed twice                                      | Second redemption fails uniformly; the grant is consumed under a row lock                          |
| Two simultaneous correct recoveries                       | Serialized by the proof row lock; both succeed within the cap                                      |
| Recovery racing "new recovery key"                        | Whichever commits first wins; the loser's old key fails uniformly                                  |
| Recovery racing "sign out other devices" or revoke-all    | Serialized; revoked tokens never reappear                                                          |
| Same wrong key replayed or varied repeatedly              | Counted identically; L1/L2 429 after the limits; keys never include the guess                      |
| Ticket completes/cancels between lookup and issue         | Re-checked inside the transaction; uniform failure                                                 |
| Approver equals requester, or approval missing            | Refused by the API and by the table CHECK                                                          |
| Pepper missing                                            | Recovery capability `disabled`; join still works (no key shown; page says recovery is unavailable) |
| Database error during rotation                            | Transaction rolls back; old credentials stay valid; no partial state                               |
| Clock skew                                                | Server time only                                                                                   |

### 15.14 Security, privacy, retention

Logs carry outcome codes and hashed keys only, never keys, grants, tokens or their hashes. Audit events
(`ticket_recovery.assist`, `.approve`, `.revoke_all`, `.key_regenerated`, `.abuse_detected`) hold
ticket id, actor, approver, reason code, assurance level and factor booleans, never values.
Retention: status-token rows deleted 24 hours after expiry; `key_hmac` removed 24 hours after the
ticket reaches a terminal state; grants deleted 24 hours after expiry or redemption; `recovery_throttle`
rows deleted 24 hours after their window; all by the same idempotent retention job as §12.13.

### 15.15 Verification (Group 8, items 8.R1–8.R12)

Public code alone never recovers; keys are 160-bit CSPRNG, HMAC-stored and never logged; the
fragment never reaches the server; typed input normalization; wrong/unknown/expired/terminal cases
are identical and constant-work; throttle keys exclude the guess (varying guesses cannot evade);
no irreversible lock and a clean-source holder succeeds during an attack; per-IP 10 per minute and
5 failures per 15 minutes per ticket per source; cross-tenant 404; token cap and the rotation matrix;
staff procedure (no factor → no credential; basic → second-person approval; auditor refused; grant
single-use and 10-minute; notification to other devices; audit fields without values); no queue event
or state/position/age change from any recovery action; self-resume rules; automatic no-show rules
including multi-instance, restart, delay and coordinator fencing; concurrency races on real
PostgreSQL; keyboard and axe on the recovery pages.

---

## 16. M5.2 Accessibility (F7) — design (planned)

> Added 2026-11-12. Specification only. Requirements: REQ-F7.1–F7.9 (unchanged) and REQ-F7.10–F7.17
> (additive). Architecture: Addendum B.8. Tests: Group 11, items 11.A1–11.A11. Target WCAG 2.2 AA for core visitor
> flows, **subject to verification**; this design does not claim conformance.

### 16.1 Baseline and gaps

Exists: skip link; `:focus-visible` styles; `prefers-contrast: more`, `forced-colors` and
`prefers-reduced-motion` CSS; `rem`-based text that follows browser text size; an `Announcer`
(polite live region); form error summaries; `lang="en"`; assertive turn announcement and foreground
vibration on the ticket page; axe and 320/375 px overflow checks in Playwright. Gaps this design
closes: no in-app high-contrast or text-size control (only OS settings), no single preferences
surface, no documented announcement policy, no route-change focus rule, no offline-accessibility
checklist, and the PWA manifest locks `orientation: 'portrait'`, which conflicts with WCAG 1.3.4 and
must become unrestricted.

### 16.2 Display and alert preferences (device-local)

`qb.a11y.v1` in `localStorage` (no server copy, no PII, never in the outbox):

```ts
{ contrast: 'system' | 'high',          // default system
  textSize: 'normal' | 'large' | 'xlarge', // 100 / 125 / 150 % root size, default normal
  motion: 'system' | 'reduce',          // default system
  quiet: boolean,                       // visual-only alerts (disables sound and vibration)
  sound: boolean, vibration: boolean }  // sound default false; vibration default true where supported
```

A small module in `main.tsx` applies `data-contrast`, `data-text-size`, `data-motion` to `<html>`
before React renders, so there is no flash. Precedence: an explicit app choice overrides the system
setting; `system` follows `prefers-contrast`, `prefers-reduced-motion` and OS text size. High contrast
and text size are expressed through CSS custom properties and the root font size, so every component
inherits them (the M7 token system extends the same mechanism). Entry points: a "Display and alerts"
button in the shared header (all roles) and a link on the ticket page. The panel is a labelled form,
every control has a visible label and hint, changes apply immediately, and "Reset to defaults" exists.

### 16.3 Keyboard-only navigation

- Every visitor flow (facility page, join, ticket, recover, display and alert settings, rejoin) is
  completable with Tab, Shift+Tab, Enter, Space and Escape; no pointer-only, hover-only or drag-only
  interaction; no keyboard trap (WCAG 2.1.2).
- Logical order follows the visual order; landmarks (`banner`, `nav`, `main`, `contentinfo`) and one
  `h1` per route; the skip link targets `main`.
- **Route change rule:** on navigation, the document title updates and focus moves to the route's
  `h1` (tabindex -1). _As implemented:_ the focused heading is what a screen reader reads, so no second
  live announcement is made (it would be heard twice); the manual pass verifies it is heard once. The browser Back button restores
  position sensibly.
- **Dialogs and panels** (settings, confirmations, staff hand-off): focus moves in on open, is
  contained, Escape closes, and focus returns to the opener. Toasts never take focus.
- Focus is always visible (indicator contrast at least 3:1) and not hidden under sticky bars
  (WCAG 2.4.11): fixed headers/footers use `scroll-padding` and are not taller than needed at 320 px.
- Targets are at least 24 × 24 CSS px (WCAG 2.5.8); primary mobile actions are at least 44 px.

### 16.4 Screen-reader announcements (policy)

| Event                                               | Mechanism                                                            | Rule                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| You are called (`called`)                           | Assertive (`role="alert"`)                                           | Once per call event; text names code and counter                              |
| Position or estimate changes                        | Polite live region                                                   | At most one announcement per 15 s; only when the value changes meaningfully   |
| Status changes (waiting, paused, missed, completed) | Polite                                                               | Each change once, with a plain reason                                         |
| Connection lost / restored; sync state changes      | Polite                                                               | Text plus the state label (`Local`, `Pending sync`, `Synced`, `Needs review`) |
| Form errors                                         | Error summary receives focus; inline messages via `aria-describedby` | Not duplicated by a live region                                               |
| Success of an action (copied, saved, rejoined)      | Polite                                                               | Short sentence                                                                |
| Route change                                        | Title announcement                                                   | Once                                                                          |

Messages come from the i18n catalog, so they are translatable; duplicates inside 2 s are dropped;
live regions exist at page load (never injected together with their content).

### 16.5 High-contrast and large-text modes

Text meets 4.5:1 (3:1 for large text and UI components) in normal mode and 7:1 in high-contrast mode.
Layouts are `rem`-based and reflow: at 200 % browser zoom or `xlarge` text there is no loss of content
or function and no horizontal scrolling at 320 CSS px (WCAG 1.4.4, 1.4.10). Status never relies on
colour (text plus icon). Forced-colours mode keeps borders and focus indicators.

### 16.6 Reduced motion

`prefers-reduced-motion: reduce`, or `motion: 'reduce'`, removes transitions and animations on toasts,
banners, spinners, skeletons and the alert banner; progress is shown with text. No information is
conveyed by motion alone; nothing flashes more than three times per second; no auto-playing,
auto-scrolling or parallax effects exist. Live updates change content in place without animation.

### 16.7 Accessible turn alerts

Alerts follow §12.3 and add: the `TurnAlert` banner is a labelled region reachable by keyboard with a
Dismiss button; it never steals focus; its meaning is in text and an icon; sound and vibration are
extras with visual and screen-reader equivalents; the preferences in §16.2 (including `quiet`) decide
which cues run; push permission text is plain-language and re-readable. Deaf, hard-of-hearing,
blind, low-vision and vestibular users therefore all receive the call through at least one reliable,
non-optional channel (the in-app banner and live region) and the public board.

### 16.8 Vibration and audio preferences on supported devices

- Vibration control is enabled only when `'vibrate' in navigator`; otherwise it is shown disabled with
  "This device or browser does not support vibration" (iOS Safari is the common case).
- Vibration runs only in the foreground, pattern under one second, never repeated for the same call.
- Sound is off by default; enabling it plays the test tone on the click (user gesture); the tone is
  short, plays once per call, never loops, and has an obvious off switch. "Test alert" exercises the
  enabled cues and shows a banner marked "Test".
- "Quiet mode" turns every non-visual cue off at once. All preferences are device-local.

### 16.9 Offline accessibility

The offline shell, preferences panel, ticket page (from the stored token), `/recover` (showing "You
need a connection to recover a ticket") and outbox panel are keyboard- and screen-reader-usable with
no network. Preferences and catalogs are precached; connectivity changes are announced; sync states
carry text labels; messages never imply a local-only action is confirmed. Staff offline workflows keep
their existing labels; error and blocked states ("Waiting for connection") are text, not colour.

### 16.10 Mobile responsiveness at 320 and 375 px

Single-column reflow, no horizontal scroll, readable line lengths, safe-area insets respected,
primary actions reachable with one hand, the preferences panel and all dialogs usable at 320 px,
orientation not locked (remove `orientation: 'portrait'` from the manifest), and the visitor-flow
initial JavaScript budget (REQ-F7.7) not exceeded by the new preferences code.

### 16.11 Localization

All new strings (announcements, alert text, recovery help, error messages) are catalog keys; English
is the baseline. No second language is presented as verified without validated translations (REQ-F7.8).

### 16.12 Verification (Group 11, items 11.A1–11.A11)

Automated: axe WCAG 2.1 A/AA (and 2.2 rules available in the installed axe) on every visitor route and
the preferences panel at 320, 375 and desktop; keyboard-only Playwright journeys (join → ticket →
alert controls → recover → rejoin); focus-order, focus-return and route-change assertions; live-region
assertions for the §16.4 table including rate limits; high-contrast and large-text screenshots with
overflow checks at 320 px and 200 % zoom; reduced-motion emulation; offline emulation for §16.9;
manifest orientation check. Manual (recorded, limits stated): screen-reader pass (VoiceOver and
TalkBack/NVDA as available) and real-device checks. No claim of full conformance without expert review.

---

## 17. M5.3 Device Health (F9) — design (planned)

> Added 2026-11-12. Specification only. Requirements: REQ-F9.1–F9.5 (unchanged) and REQ-F9.6–F9.14
> (additive). Architecture: Addendum B.9. Tests: Group 8, items 8.D1–8.D6, with Group 6 as the
> regression for coordinator authority and Group 11 item 11.A10 for accessibility. **The single-coordinator authority model of M3 is
> unchanged: device health observes and alerts; it never assigns, fails over or revokes anything by
> itself.**

### 17.1 Baseline

Exists: `devices` (label, `last_seen_at`, `last_sync_at`, `reported_pending_count`,
`last_failure_code`, `revoked_at`); self-reported `POST /devices/:id/heartbeat`; `operationsHealth()`
with states `healthy | pending | offline | needs_review | revoked` (offline after
`OFFLINE_AFTER_SECONDS` = 120); coordinator status with epoch and expiry evaluated on read; failover,
renew, revoke and device-revoke commands (audited); the connectivity dashboard. Carried-over deferral
from M3: **automatic alerting**. Not built: stale-device tiers, alert records, recipients, lost-device
guidance.

### 17.2 Signals (what is monitored, and honestly what is not known)

| Signal                            | Source                                            | Caveat shown in the UI                  |
| --------------------------------- | ------------------------------------------------- | --------------------------------------- |
| Last contact                      | Server time of the last heartbeat or sync         | Server-side fact                        |
| Pending actions                   | Device-reported count                             | "Approximate: reported by the device"   |
| Sync health / failure code        | Last sync result and `last_failure_code`          | From the server's view                  |
| Coordinator status, epoch, expiry | `queue_sessions` coordinator fields               | Server-authoritative                    |
| Open conflicts                    | `client_operations` with `needs_review`           | Server-authoritative                    |
| Server API health                 | `/health/ready` (kept separate from device state) | Not mixed into device status (REQ-F9.3) |

A device that is silent might be offline, asleep, closed or lost; the system cannot tell which and
says so.

### 17.3 Health states and stale detection

States extend the current set: `healthy · pending · offline · stale · needs_review · revoked`.
`offline` keeps the existing meaning (no contact for `OFFLINE_AFTER_SECONDS`, 120 s). `stale` means no
contact for `DEVICE_STALE_AFTER_SECONDS` (**initial default 900, accepted 2026-11-12**, configurable). Each state has a
text label and icon. For the coordinator device two further conditions are tracked:
`coordinator_expiring` (expiry within `COORDINATOR_EXPIRY_WARN_SECONDS`, **initial default 300, accepted**, configurable) and
`coordinator_expired`. Evaluation is by server time only; device clocks never matter.

### 17.4 Automatic health alerts and recipients

| Alert kind               | Raised when                                                                                                           | Severity |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------- |
| `coordinator_offline`    | The assigned coordinator is `offline` or `stale` while its queue has waiting or called tickets                        | High     |
| `coordinator_expiring`   | Coordinator authorization expires within the warning window                                                           | Medium   |
| `coordinator_expired`    | Authorization expired and the device is the assigned coordinator                                                      | High     |
| `device_stale_pending`   | A device is `stale` with reported pending actions greater than 0                                                      | Medium   |
| `sync_failing`           | The same `last_failure_code` persists across 3 consecutive heartbeats/syncs                                           | Medium   |
| `conflicts_unreviewed`   | `needs_review` operations older than `CONFLICT_REVIEW_WARN_SECONDS` (**initial default 900, accepted**, configurable) | Medium   |
| `recovery_abuse`         | Recovery aggregate limit L3 or L4 exceeded (§15.10)                                                                   | Medium   |
| `alert_pipeline_failing` | Turn-alert failures above a threshold in the last hour (§12.9)                                                        | Low      |

**Recipients:** users holding `OPERATIONS_VIEW` at the facility see all alerts (supervisor, facility
admin, org admin; auditors read but cannot acknowledge). Only roles with `QUEUE_MANAGE` (supervisor,
facility admin) can acknowledge. A staff member sees a warning about **their own** device (for example
"This device is offline" or "Your coordinator authorization is about to expire") on their console.
Delivery is in-product only: the dashboard panel, a persistent alert banner on supervisor/admin screens
while alerts are open, and a console warning on the affected device. No SMS or email is sent to staff
(cost, privacy and no configured email channel); an external staff channel would need its own decision.
Alerts are announced through the accessible live-region policy of §16.4.

**Alert records** (`health_alerts`, additive migration indicatively `0008`): id, organization,
facility, kind, subject (device or queue id), severity, `opened_at`, `last_seen_at`, `acknowledged_by`
and `acknowledged_at`, `resolved_at`, `resolved_reason`. One open alert per (facility, kind, subject)
(unique partial index), so the same condition does not re-alert. Alerts resolve automatically when
the condition clears. Acknowledging and clearing are audited admin events; nothing about the
authoritative queue changes.

### 17.5 Evaluation

A worker job `evaluateDeviceHealth` runs every 30 seconds: reads devices, queues and conflicts for
facilities with active sessions (read-only on queue tables), upserts or resolves `health_alerts`, and
emits a facility-level change signal (`pg_notify`) so open dashboards refresh. It uses only server
time, never writes to `queue_sessions`, `queue_events`, `tickets` or `devices`, and logs counts only. If the worker is down the dashboard still computes states on read; only the
stored alert records and banners lag, and the dashboard says "Automatic alerts are paused" when the
last evaluation is older than 3 intervals.

### 17.6 Coordinator health and failover (single authority preserved)

- Exactly one coordinator per queue session, unchanged. Health never designates, replaces or revokes
  a coordinator. A `coordinator_offline` alert only **recommends** the supervisor's existing explicit
  failover, with the standing warning that the old coordinator may still be operating on site and that
  failover fences it (epoch advance) so its unsynced actions go to review.
- Failover remains an authenticated supervisor action (assign, failover, renew, revoke) that advances
  the epoch, is audited, and is re-validated server-side. No timer triggers it.
- Renewal reminders come from `coordinator_expiring`; renewing remains explicit and requires an
  online supervisor, as in M3.
- When the coordinator reconnects after a failover, M3 fencing applies (stale epoch → review).

### 17.7 Privacy-preserving device information

Stored per device: user-chosen label, owner (the staff user already identified in the facility),
created time, last contact and sync times, reported pending count, last failure code, revoked time.
**Never stored:** IP address, user agent or hardware fingerprint, location, contacts, or any visitor
data. The heartbeat payload stays minimal (`pending_count`, online flag, app version string). The
label field warns "Use a name for the device (for example "Front desk tablet"), not a person's name."
The dashboard is visible only to `OPERATIONS_VIEW` roles at that facility; cross-tenant is 404.

### 17.8 Recovery from lost, revoked or disconnected devices

| Situation                              | What staff see and do                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Disconnected non-coordinator device    | `offline`/`stale` badge; its provisional captures remain on that device until it reconnects; nothing is lost on the server; no action required                                                                                                                                                                     |
| Disconnected coordinator               | `coordinator_offline` alert; supervisor may wait or use explicit failover (warned); on reconnect the old device is fenced and its actions go to review                                                                                                                                                             |
| Lost or stolen device                  | Supervisor revokes the device ("Mark as lost" reason). The dashboard shows "Up to N actions were pending on this device and may be lost" (last reported count) with the last-contact time; revoked-device syncs are rejected (M3). The owner's sessions can be ended by deactivating or signing out the staff user |
| Revoked device found again             | It stays revoked. The staff member re-registers it as a new device (new id). Unsent local actions are shown on that device as read-only with "This device was revoked; these actions cannot be sent"; a supervisor reviews them by hand; they are never auto-applied                                               |
| Browser storage cleared or damaged     | Existing M3 warning: unsynced actions cannot be recovered from that device                                                                                                                                                                                                                                         |
| Device permanently gone as coordinator | Revoke, then failover to another device (explicit, audited)                                                                                                                                                                                                                                                        |

The server never sees the contents of a lost device's outbox, so numbers are approximate and the UI says so.

### 17.9 Interfaces

Connectivity dashboard additions: state filter and sort by severity; `stale` and coordinator-condition
badges (text plus icon); an "Alerts" panel (open, acknowledged, resolved today) with acknowledge
buttons for `QUEUE_MANAGE` roles; a "last evaluated" line; recovery and turn-alert counters (§15,
§12.9); the lost-device flow (§17.8). Console: a dismissible, non-blocking warning for the user's own
device. All controls follow §16 (keyboard, announcements, 320 px).

### 17.10 Retention

Resolved `health_alerts` are deleted after 30 days; open alerts persist until they resolve.
Heartbeat values overwrite the device row; no heartbeat history is kept. Revoked device rows are kept
(they are referenced by audit and operation history); their labels are retained.

### 17.11 Failure handling

Evaluation errors are logged and the previous alert state stays (no spurious resolve). A flapping
condition is damped: an alert resolves only after the condition has been clear for two evaluations.
An alert-system failure never blocks any queue action or any device operation.

### 17.11a As implemented (M5.3; deviations recorded)

- Migration `0008_device_health.sql`: `health_alerts` as specified plus `clear_count` (damping) and
  `subject_type`; `health_evaluations` (single row, last completed evaluation); `devices.failure_streak`
  (consecutive identical failure reports, written by the device's own heartbeat and reset by a
  successful sync; the evaluator never writes it). Partial indexes for the evaluator's scans.
- A subject that is gone (device revoked, queue closed) resolves at once with `subject_gone`; all
  other alerts follow the two-evaluation damping.
- The evaluator runs in one transaction under a try-lock (other instances skip); `--once` waits for
  the lock instead, so a manual or scheduled single run always evaluates. Every pass is bounded
  (`lock_timeout` 30 s, `statement_timeout` 60 s): a stuck pass rolls back and the next one retries. Deduplication does not depend
  on the lock: the unique partial index enforces it.
- Own-device warnings: `coordinator_expiring`, `coordinator_expired`, `sync_failing`. A
  "stale with pending" warning to the device itself is not shown: a device that can read it is, by
  definition, not silent.
- Change signal: `pg_notify('qb_health_events', {"f": facility})`. The dashboard still refreshes by
  polling every 5 s (no SSE consumer was added); the banner polls every 30 s.

### 17.12 Verification (Group 8, items 8.D1–8.D6; Group 6 regression; Group 11, item 11.A10)

Real-PostgreSQL tests: state transitions by server time (offline, stale, expiring, expired);
one open alert per (facility, kind, subject) under concurrent evaluation; auto-resolve with damping;
recipients (supervisor/admin see, auditor read-only, counter/reception see only their own device,
cross-tenant 404); acknowledge permission and audit event; **the evaluator and every alert action leave
queue sessions, coordinator epoch/device, tickets and the event chain unchanged**; failover is never
triggered automatically; lost-device flow (revoke, rejected sync, pending-count wording); privacy
(no IP/user agent columns or log fields). Browser: keyboard and axe on the alert panel at 320/375 px,
live-region announcement of a new high-severity alert, offline behaviour of the console warning.
