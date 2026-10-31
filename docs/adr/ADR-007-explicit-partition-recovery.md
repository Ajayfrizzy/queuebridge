# ADR-007: Explicit Recovery After Partitions (No Silent Overwrite)

**Date:** 2026-10-30  
**Status:** Accepted — **core invariant, do not deviate**

## Context

Network partitions will occur. When connectivity returns, offline-captured operations must be reconciled with the server's authoritative state. The temptation is to "just apply everything" — but this would silently corrupt the queue if, for example, the server had already advanced past the coordinator's base revision or a supervisor had reassigned authority.

## Decision

**Explicit reconciliation with mandatory conflict surfacing.**

On reconnect:

1. Submit offline operations to `/api/v1/sync/batches` in `client_sequence` order
2. Server returns per-command dispositions: `committed | duplicate | rejected | needs_review`
3. Committed operations: update IndexedDB status, update local queue state
4. Duplicate operations: update status (idempotency confirmed), no state change
5. Rejected operations: mark as rejected with reason, surface to staff
6. `needs_review` operations: block automatic application, surface conflict review UI
7. The visitor-facing view NEVER advances to show a globally-confirmed state before receiving `committed`

**Non-negotiable UI states:** `local_only` | `pending_sync` | `committed` | `duplicate` | `needs_review` | `rejected`

## Consequences

**Positive:**

- No silent corruption of queue order
- Staff can see exactly what happened during the outage and what requires attention
- Idempotency guaranteed: retrying after lost ACK returns `duplicate`, not a second commit
- Clear audit trail: every reconciliation result is recorded in `client_operations`

**Negative:**

- Reconnection requires active staff attention to resolve conflicts
- `needs_review` items cannot auto-resolve — supervisor must act
- This may create brief operational pauses at reconnection time

## Conflict examples and required handling

| Scenario                                     | Required behavior                                               |
| -------------------------------------------- | --------------------------------------------------------------- |
| Stale epoch reconnect                        | Reject all commands with stale epoch; surface conflict review   |
| Two call-next attempts                       | Only one commits; other is rejected or needs_review             |
| Queue session closed during outage           | Tickets not silently migrated; explicit review required         |
| Supervisor changed priority rules mid-outage | Revalidate against new policy; reject or needs_review           |
| Clock skew                                   | Server controls ordering; client timestamps are diagnostic only |

## This decision explicitly does NOT claim

- Conflict-free distributed consistency
- Eventual consistency with automatic merging
- Exact-once globally-final offline behavior before M3 acceptance tests pass
