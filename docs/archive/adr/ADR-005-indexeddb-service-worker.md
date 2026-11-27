# ADR-005: IndexedDB Outbox + Service Worker

**Date:** 2026-10-30  
**Status:** Accepted

## Context

F1 requires that local staff operations (ticket calls, completions) are durably persisted before any success is shown to the user. If the browser crashes or the network is lost after the user confirms an action but before it syncs, the operation must survive the restart.

## Decision

**IndexedDB** for the client-side operation outbox. **Service worker** for offline app shell caching.

- Every staff operation is written to IndexedDB with status `local_only` before any UI feedback
- On network availability, the outbox is flushed to `/api/v1/sync/batches` in `client_sequence` order
- Service worker caches the app shell and static assets (Workbox via `vite-plugin-pwa`)
- Service worker does NOT proxy API calls — all API interactions are managed by the application layer

## Consequences

**Positive:**

- Operations survive browser crash, device restart, and connectivity loss
- Service worker enables fast app load on poor connections
- IndexedDB supports structured data and transactions

**Negative:**

- IndexedDB API is complex — abstracted behind `packages/continuity` to keep app code clean
- Browser storage can be cleared by the user or system — must warn when this would lose un-synced operations
- Service worker lifecycle (install, activate, claim) requires careful management to avoid stale caches

## Security constraints (from steering/security.md)

- IndexedDB must NOT store raw phone numbers or sensitive PII
- Provide a supervisor-accessible "clear local data" function
- When storage is cleared without syncing, display a warning: "Some unsynced actions may be lost"

## Scope boundary

The service worker handles asset caching only. It does NOT perform background sync API calls — the application manages the sync lifecycle explicitly via the outbox flush loop.
