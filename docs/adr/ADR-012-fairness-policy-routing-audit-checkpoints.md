# ADR-012: Versioned Fairness Policy, Waiting-Age Ordering, Pull Routing and HMAC Audit Checkpoints

**Date:** 2026-11-08  
**Status:** Accepted (M4, `feature/m4-fairness-routing-audit`)  
**Builds on:** ADR-004 (server-authoritative sequence), ADR-006 (single coordinator), ADR-010 (audit hash chain)

## Context

M4 adds priority classes, supervisor overrides, adaptive routing and audit verification (F3, F5,
F8). The M2 code had three gaps that made past decisions unexplainable or unverifiable:

1. The policy `version` label was chosen by the client and overwritten in place, so a call could
   not be replayed against the rules in force when it happened.
2. Waiting order used `issued_sequence` only, so a transferred visitor always lost their waiting
   age, and there was no recorded reason why a ticket was chosen.
3. The hash chain (ADR-010) existed, but nothing verified it, checkpoints were never written, and
   `TRUNCATE` bypassed the row-level append-only trigger.

## Decisions

### 1. Policy versions are assigned and kept by the server

- Every change to `services.policy` appends an immutable row to `service_policy_versions`
  (`v1`, `v2`, … per service, unique). Any `version` sent by a client is ignored. Re-sending the
  same rules creates no version.
- A change also appends an audit-only `policy.changed` event to the service's open session(s) for
  the day, so the session's own chain shows when the rules changed.
- Rejected: client-chosen labels (M2 behaviour) — not replayable, collisions possible.

### 2. One published, total ordering key

`ORDERING_RULE = priority_class > wait_since > issued_sequence > id`

- `priority_class` ranks by the service's `priority_order`; a class the policy does not enable
  ranks last, so a stale class can never jump the queue.
- New column `tickets.wait_since`: issue time for native tickets (`clock_timestamp()` taken under
  the session lock, so it is monotonic with `issued_sequence`); for service transfers it is the
  original waiting time (`transfer_placement = by_original_join_time`, default for new services)
  or the transfer time (`end_of_queue`; existing services were migrated explicitly to this, the
  M2 behaviour). The original join time is recorded either way.
- Backfill uses a running `MAX(created_at)` in issue order, preserving the M2 relative order.
- Rejected: ordering by `joined_at` (transaction-start `NOW()` can invert relative to issue order
  under concurrency).

### 3. Priority classes change only through a supervisor override

- Joins and walk-ins are always `normal`. A supervisor or facility admin (org admin implied) may
  change a WAITING ticket's class to an enabled class, citing a reason code from
  `policy.override_reasons` and a free-text explanation (≥ 5 characters).
- An override changes the class, never an arbitrary position: the published rule still decides.
- The explanation is stored only in `priority_overrides.reason_text` (access-controlled); the event
  payload carries its SHA-256, so the chain seals the text without exposing it.
- Denied attempts return 403 and append an admin event `<action>.denied`.
- Routing override (`ticket.call_specific`, "call out of order") is supervisor-only with the same
  reason requirements and records `would_have_called`.

### 4. Routing stays pull-based (counters call next)

- Counter `availability` (`open | closed`) is separate from the administrative `active` flag,
  but BOTH ways of taking a counter out of service (closing it, or deactivating it in
  Administration) run the same locked procedure and keep the same invariant: no inactive or
  closed counter holds a called or serving ticket, and service can only start at an active,
  open counter (amended 2026-11-10 after manual acceptance; see M4 evidence).
  Only active, open, capable, free counters can take a call.
- Closing a counter while a visitor is CALLED emits `ticket.release` (called → waiting, waiting
  age kept, so they return to the head of the line) and requires a supervisor; closing while
  SERVING is refused (409). An idle counter may be closed by its operator.
- `ticket.counter_transfer` moves a called/serving ticket to another active, open, capable, free
  counter of the same service.
- Every call event records `payload.routing` (rule, policy version, priority order, candidate
  count, selected keys, counter) so `verifyRoutingDecisions` can replay it against the cited
  policy snapshot.
- Rejected: push assignment of waiting tickets to counters — it adds a second source of truth for
  "who is next" and conflicts with the M3 coordinator model.
- All new ticket actions pass through the existing M3 coordinator fence; while a coordinator holds
  the queue they are refused with `coordinator-active`.
- Lock order everywhere: queue sessions (id order) → counter → tickets. The session row is locked
  before the policy is read (a policy committed while waiting is seen), and the counter row is
  locked before busy/capable is computed.

### 5. Audit primitives live in `packages/domain`; the worker may import `domain`

- `canonicalJson`, `computeEventHash`, `verifyChain`, `checkpointRoot`, `checkpointMessage` and
  `verifyCheckpoints` moved to `packages/domain/src/audit.ts` with an injected SHA-256 function
  (domain stays free of Node I/O). `apps/api/src/queue/hash.ts` is a thin wrapper.
- **Package boundary change (additive):** `apps/worker` may now import `@queuebridge/domain`
  (pure functions only). AGENTS.md §2 and the architecture steering are updated accordingly.
- Rejected: duplicating hash code in the worker (two implementations drift), or putting it in
  `contracts` (contracts holds schemas, not algorithms).

### 6. Checkpoints are HMAC-SHA256 and never sign a broken chain

- `root_hash = SHA256(concatenated event_hash values in the range)` — recomputable in SQL without
  application code. The signed message is
  `queuebridge:v1:checkpoint|session|from|to|root|head`.
- The worker verifies the full chain and every existing checkpoint before signing; on failure it
  appends an `audit_integrity_alerts` row (deduplicated) and skips the session.
- No `AUDIT_SIGNING_KEY` → the job is disabled; it never writes unsigned checkpoints.
- Both apps compute the HMAC with Node `crypto`; a fixed test vector asserted in both test suites
  proves they agree.
- Rejected for now: Ed25519 (public verification) — needs key distribution and rotation design;
  recorded as future work.

### 7. Verification has three outcomes and never a false success

`GET /queues/:id/audit/verify` → `verified | failed | incomplete`:

- `failed` if the chain breaks, a checkpoint is invalid, a stored override explanation does not
  match its sealed hash, a routing decision does not replay, a worker alert exists, or the event
  count does not match `last_sequence`.
- `incomplete` if nothing failed but at least one check could not run (e.g. a checkpoint signed
  with a key this server does not hold). The UI states explicitly that this is not a successful
  audit.
- `verified` only if nothing failed and every check that can be made was made. Two things are
  not failures and are reported as counts, never hidden: events newer than the last signed
  checkpoint (`uncheckpointed_events` — a session with no checkpoint yet is verified by its hash
  chain, replay and record checks alone) and calls recorded before M4 without a routing
  explanation (`decisions_not_replayable`). A checkpoint whose signature cannot be checked here
  makes the result `incomplete`.
- Access: auditor, supervisor, facility admin (org admin implied); tenant-scoped (404 across
  tenants). The export is redacted (no names, no free text, hashes only).

### 8. TRUNCATE is blocked too

Statement-level `BEFORE TRUNCATE` triggers on `queue_events`, `admin_events` and every new M4 audit
table (`service_policy_versions`, `priority_overrides`, `audit_checkpoints`,
`audit_integrity_alerts`). Row triggers alone did not stop `TRUNCATE`.

## Consequences

**Positive:** every call, override, release and transfer is explainable from the chain and the
policy snapshot it cites; tampering with events, override text or checkpoints is detected and
shown; the published order is enforced server-side and mirrored by the offline projection.

**Negative / limits:**

- HMAC verification needs the signing key — an external party cannot verify signatures alone
  (hash chain and root hashes remain independently recomputable).
- **Strict priority — possible starvation (accepted policy limitation).** Classes are served in
  strict rank order: a lower-class visitor is called only when no higher-class ticket is waiting,
  so a steady supply of higher-class tickets can delay a `normal` visitor without limit. This
  matches REQ-F3.1 / REQ-F5.2, and no specification requires aging, interleaving or a maximum
  wait. Mitigations today: every ticket starts `normal`; only a supervisor can raise a class, with
  a configured reason and explanation; every override is audited and summarized in the audit
  view; within a class, order is strictly first come, first served. Aging, interleaving (e.g. one
  `normal` call per k higher-class calls) or override caps would change the published ordering
  rule and therefore need a new policy field, a new `ORDERING_RULE` label (so earlier decisions
  still replay), visitor-facing wording and an ADR — deliberately NOT introduced in M4.
- Call events committed before M4 carry no routing explanation and are reported as
  `not_replayable`.
- An administrator who controls the database AND the signing key can still rewrite history
  consistently (ADR-010 threat model unchanged). QueueBridge claims tamper-evident, not
  tamper-proof.
