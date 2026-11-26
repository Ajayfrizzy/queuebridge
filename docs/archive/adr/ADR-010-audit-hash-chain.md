# ADR-010: Audit Hash Chain with External Checkpoint Option

**Date:** 2026-10-30  
**Status:** Accepted

## Context

F8 requires tamper-evident operational history. The goal is to detect if a previously-committed event has been modified or deleted — not to make tampering impossible for an administrator with full database access (which is impossible without external anchoring).

## Decision

**SHA-256 hash chain on `queue_events`**, with periodic `audit_checkpoints`.

Hash computation:

```
event_hash = SHA256(
  'queuebridge:v1:event' ||  -- domain separator (prevents cross-context attacks)
  queue_session_id ||
  sequence ||
  prev_hash ||               -- genesis: SHA256('queuebridge:v1:genesis')
  canonical_event_json       -- deterministically sorted keys, no extra whitespace
)
```

Checkpoints (periodically, via `apps/worker`):

```
root_hash = SHA256(concatenation of all event_hash values in [from_sequence, to_sequence])
signature = sign(root_hash) with AUDIT_SIGNING_KEY
```

Checkpoint signatures allow verification without access to the application — an auditor can independently recompute hashes.

## Threat model (explicit)

**Detects:**

- A database administrator modifying a row in `queue_events` directly
- An application bug accidentally updating an event
- A deployment script modifying historical data

**Does NOT prevent:**

- An administrator who controls both the database AND all signing keys from rewriting history
- Attacks that modify the checkpoint table AND all event hashes consistently

**Mitigation for the above:** Periodically export checkpoint signatures to an external ledger or trusted third party. This is marked as an optional future enhancement — not in scope for M0.

## Append-only enforcement (defense in depth)

A PostgreSQL trigger (`0002_append_only_trigger.sql`) raises an exception on any `UPDATE` or `DELETE` on `queue_events`. This catches application bugs and accidental direct modifications, separate from the hash chain verification.

## Consequences

**Positive:**

- Integrity verification is independent of application code (pure hash comparison)
- Append-only trigger provides additional defense at the DB layer
- Audit log is verifiable by an external party given the event data and signing key

**Negative:**

- SHA-256 hash chain does not prevent modification by a fully-privileged adversary
- Checkpoint signing requires secure key management
- Verification performance scales with event count (requires indexed queries)

## What QueueBridge will NOT claim

"Tamper-proof" — this is impossible without hardware attestation or external anchoring. The correct claim is **"tamper-evident"**: modifications within the trust model are detectable.
