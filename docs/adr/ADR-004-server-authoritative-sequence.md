# ADR-004: Server-Authoritative Final Sequence

**Date:** 2026-10-30  
**Status:** Accepted — **core invariant, do not deviate**

## Context

QueueBridge operates across multiple client devices (visitor phones, staff consoles, supervisor dashboards). During normal operation all devices communicate with the server. During outages, designated offline coordinators may perform permitted operations locally. The fundamental question is: **who decides the final order of queue events?**

## Decision

**The server is the sole authority for globally final queue event sequences.**

Specifically:

- Every `queue_event` receives its `sequence` number from the server in a serialized transaction
- The sequence is assigned under a `SELECT ... FOR UPDATE` lock on the `queue_sessions` row
- No client may claim its local event is "globally final" — local events are `offline_applied` until the server returns `committed`
- An offline coordinator's operations are provisional to global state
- Two disconnected devices cannot both produce conflicting authoritative final sequences

## Consequences

**Positive:**

- Eliminates distributed consensus complexity (no Raft, no CRDTs needed)
- `UNIQUE (queue_session_id, sequence)` enforced at DB level provides ironclad deduplication
- Audit hash chain integrity is checkable against the server's authoritative sequence
- Visitors never see a globally-confirmed state that hasn't been confirmed by the server

**Negative:**

- Queue advancement is blocked during server outage unless a designated coordinator is authorized
- Coordinator authority is limited to provisional local operations — not a substitute for full server connectivity
- Client UI must clearly distinguish `local_only` from `committed` states

## Explicit guarantee boundary

QueueBridge does NOT guarantee conflict-free eventually-consistent distributed ordering. It guarantees:

1. Server-committed events have a unique, monotonically increasing sequence per queue session
2. Offline-applied events are provisional and subject to server validation on reconnect
3. Conflicts are surfaced for supervisor review, never silently resolved

This is deliberately conservative. See ADR-006 and ADR-007 for coordinator authority and partition recovery.
