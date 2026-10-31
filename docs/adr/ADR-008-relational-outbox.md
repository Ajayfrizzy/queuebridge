# ADR-008: Relational Outbox for Channel Dispatch

**Date:** 2026-10-30  
**Status:** Accepted

## Context

QueueBridge needs to send SMS and USSD notifications when queue events occur (ticket confirmed, called, missed, etc.). A naive approach would be to call the SMS provider directly inside the API request handler — but this risks:

- Request timeout if the provider is slow
- Lost notifications if the API process crashes after committing the DB transaction but before the HTTP call completes
- Duplicate notifications if the request is retried

## Decision

**Transactional outbox pattern**: `notification_outbox` rows are inserted atomically in the same PostgreSQL transaction as the `queue_event` that triggers them. A separate worker process polls the outbox and dispatches via `ChannelAdapter`.

```
1. API transaction:
   INSERT INTO queue_events (...) → commits
   INSERT INTO notification_outbox (...) → commits atomically

2. Worker (apps/worker):
   SELECT * FROM notification_outbox WHERE next_attempt_at <= NOW()
   → dispatch via ChannelAdapter
   → on success: UPDATE notification status
   → on failure: increment attempt_count, set next_attempt_at (backoff)
```

Idempotency key on every outbox row prevents duplicate sends even if the worker processes the same row twice.

## Consequences

**Positive:**

- Provider failure does NOT roll back a committed queue action
- Notifications are durable: survive API process restarts
- Retry with backoff handles transient provider failures
- Idempotency key prevents duplicate sends

**Negative:**

- Slight latency between event and notification (worker polling interval)
- Worker must be kept running; missed notifications if worker is down for extended period
- Must monitor outbox depth as a health metric

## Failure modes

- Provider permanently fails: notification stays in outbox until max attempts, then marked `failed`
- Worker crashes mid-dispatch: on restart, same row will be retried (idempotency key prevents duplicate)
- Notification not in outbox: this means the transaction failed — queue event also rolled back (safe)

## Never claim delivery without provider confirmation

The `delivery` status is only set to `delivered` when the provider returns a confirmed delivery receipt webhook. `sent` means we received a 2xx from the provider; `delivered` means the provider confirmed end-device delivery.
