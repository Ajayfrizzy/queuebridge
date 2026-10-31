---
inclusion: always
---

# QueueBridge — Testing Steering

> Always-on testing requirements. Tests are not optional. A milestone is not complete until its tests pass.

## Philosophy

Tests are the primary evidence that QueueBridge's behavioral claims are true. Every architectural invariant
must have a corresponding automated test. "It works on my machine" is not evidence. Passing CI is the bar.

Do not write tests that merely assert mocks return what you told them to return. Test real behavior:
real state machine transitions, real SQL against a real (test) database, real reconciliation logic.

## Test framework and tooling

- **Vitest** across all packages and apps (consistent runner, native TypeScript, fast).
- Test files: `*.test.ts` (unit/integration) or `*.spec.ts` (end-to-end / scenario).
- Coverage reporting: enabled but coverage thresholds are not a substitute for meaningful tests.
- Database tests: use a dedicated test PostgreSQL database; run migrations before test suite; wrap tests in transactions rolled back after each test where possible.
- No mocking of PostgreSQL — use a real test database for any test that involves SQL.

## Test groups and their scope

### Group 1 — Domain state machine and routing (packages/domain)

- Pure TypeScript, zero I/O.
- Test every permitted and rejected ticket state transition.
- Test routing rules: service match, priority class, waiting age, counter availability.
- Test wait-time estimate calculations: counter open/close, insufficient data, class changes.
- Test fairness policy: FIFO ordering, priority insertion, policy version determinism.
- Property-based test: applying the same authorized events in order always produces the same queue state.

### Group 2 — Contracts validation (packages/contracts)

- Zod schema parse/reject tests for every schema: valid inputs parse, invalid inputs are rejected with descriptive errors.
- Command envelope: required fields, UUID v7 format, missing fields rejected.
- API DTOs: test serialization roundtrips.

### Group 3 — Continuity and reconciliation (packages/continuity)

- Offline command schema validation.
- Authority check: expired epoch rejected, valid epoch accepted.
- Deduplication: identical `operation_id` processed once, second call returns stored disposition.
- Reconciliation: provisional ticket creation reconciles to confirmed after server commit.
- Conflict detection: two independent call-next commands for same queue — one committed, one rejected/needs_review.
- Client sequence ordering: out-of-order commands handled deterministically.

### Group 4 — Concurrent PostgreSQL transactions (apps/api + infra)

- Concurrent `call-next` on the same queue session: only one commits, other is rejected.
- `SELECT ... FOR UPDATE` on queue session row prevents double-sequence.
- `UNIQUE (queue_session_id, sequence)` constraint verified under concurrent insert.
- `UNIQUE (organization_id, operation_id)` verified under concurrent insert.
- Cross-tenant isolation: query for org A cannot return org B data even with a valid session.

### Group 5 — Offline outbox behavior (packages/continuity + browser simulation)

- Operations persist in IndexedDB before success is shown.
- Browser-kill simulation: pending operations survive reload and are replayed.
- Clock skew: `created_at_client` does not affect server ordering.
- Storage exception: graceful degradation, not silent failure.
- Coordinator epoch expiry: stops offline advancement, capture-only mode.

### Group 6 — Partition simulation and failover

- Stale epoch reconnect: fenced, surfaced as conflict review.
- Simultaneous online and offline call-next: only server-side wins.
- Failover: supervisor assigns new coordinator; old coordinator's subsequent sync is rejected.
- Lost ACK: retrying a committed operation returns `duplicate` not a second `committed`.
- Queue session closed during outage: tickets not silently migrated.

### Group 7 — Sync batch idempotency (apps/api)

- Submit the same batch twice: second submission returns same dispositions, no state change.
- Reordered commands within a batch: processed in `client_sequence` order.
- Mixed results in a batch: some `committed`, some `rejected`, each correctly labeled.
- Batch with one invalid command: valid commands still processed (no all-or-nothing unless requested).

### Group 8 — Security and access control (apps/api)

- Unauthorized priority override: rejected with 403.
- Cross-tenant ticket access: rejected with 404 (not 403 — do not confirm existence).
- Recovery credential rate limiting: 6th attempt within 15 minutes is rejected.
- Expired recovery credential: rejected safely, no data leaked.
- Visitor anonymous role: cannot call `POST /queues/:id/commands`.
- Webhook without valid signature: rejected with 401, payload not processed.
- Webhook replay (duplicate nonce within 5 minutes): rejected with 409.

### Group 9 — Audit integrity

- Hash chain verification: known event sequence verifies correctly.
- Tamper detection: modifying a single character in a committed event's canonical JSON breaks the chain.
- `audit_checkpoints` root hash covers correct sequence range.
- Priority override always has actor, policy version, reason code, reason text: enforced at DB constraint level and tested.
- Append-only enforcement: attempt to UPDATE a `queue_events` row fails (test the DB trigger or app-layer guard).

### Group 10 — Channel adapter contracts (packages/channels)

- Sandbox adapter: `sendMessage` logs `[SANDBOX]` prefix, never makes real network calls.
- `verifyWebhook`: valid HMAC signature accepted, invalid rejected.
- `parseDeliveryReceipt`: known provider payloads parsed correctly; unknown payloads return safe error.
- Idempotency key: same key does not trigger re-send.
- USSD session: menu navigation, invalid input recovery, session expiration handled.

### Group 11 — Accessibility (apps/web)

- Core visitor flows (join, status, recovery) navigable by keyboard alone.
- Screen reader announcements on status changes (ARIA live regions).
- No color-only status indicators (verify with text/icon alternatives).
- Mobile viewport rendering at 320px and 375px widths.
- Focus management: modal dialogs trap focus; return focus on close.

### Group 12 — End-to-end scenario tests (apps/api + infra)

- Journey A: walk-in visitor, staff creates ticket, counter calls, service completes, event audited.
- Journey B: smartphone visitor, QR join, status track, recovery after browser clear, calling.
- Journey C: outage simulation, coordinator records calls, reconnect, reconciliation, no duplicates.
- Journey D: priority exception, supervisor authorizes, audit event emitted, override visible.
- Journey E: counter unavailable, routing reassigns waiting tickets, transfer chain preserved.
- Journey F (sandbox): SMS confirmation sent, delivery receipt processed, USSD menu navigated.

## Core invariants every test suite must enforce

1. No two final authoritative events share a `(queue_session_id, sequence)`.
2. No mutation creates duplicate committed ticket codes in one queue session.
3. An identical `operation_id` cannot produce two `committed` dispositions.
4. A fenced/expired coordinator cannot finalize obsolete offline actions.
5. Unauthorized actors cannot commit staff or supervisor transitions.
6. Ticket status shown as `committed` must have a server `queue_event` behind it.
7. Priority overrides always have named actor, policy, and reason.

## Acceptance targets (from PRD §10)

These are targets to be validated, not assumed:

- 100% of committed, acknowledged queue events durably retained in outage/recovery test runs.
- 0 duplicate final ticket IDs or double-advancement events in adversarial sync tests.
- 1,000+ scripted sequential/mixed event operations reconcile idempotently (Group 7 scale test).

## Running tests

```bash
pnpm test                    # run all tests across workspace
pnpm test --filter contracts # run tests in one package
pnpm test:coverage           # with coverage report
pnpm test:db                 # database-dependent tests (requires TEST_DATABASE_URL)
```

Tests requiring a database read `TEST_DATABASE_URL` from environment. CI provides this via a PostgreSQL service container. Locally, set it in `.env.test` (gitignored).

## What tests must NOT do

- Assert on mock return values that you wrote yourself without any real behavior underneath.
- Skip the database by mocking SQL queries in tests labeled as "integration" or "concurrent".
- Use `setTimeout` or `sleep` as a substitute for proper async coordination.
- Silently pass when a constraint violation should occur.
- Omit the failing test case for a security check because "it's obvious it works".
- Use `test.skip` or `test.todo` to avoid writing a test that the acceptance gate requires.
