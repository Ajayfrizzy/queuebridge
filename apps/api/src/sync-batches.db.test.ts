import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueAction } from '@queuebridge/contracts';
import {
  assertEventLogIntact,
  assignCoordinator,
  createTestApp,
  setupContinuity,
  syncBatch,
  tempRef,
  ticketStatus,
  uuidv7Sync,
  type ContinuityFixture,
  type TestApp,
} from './testing/harness.js';

/**
 * Groups 3 and 7 — sync batch behaviour against real PostgreSQL: idempotency, ordering,
 * mixed dispositions, provisional ticket confirmation, and the audit chain of synced events.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

async function coordinated(f: ContinuityFixture): Promise<string> {
  const a = await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
  expect(a.status).toBe(200);
  return f.authorityFor(f.counter);
}

describe('provisional ticket capture (any registered device)', () => {
  it('confirms a captured ticket: server assigns the public code, status link works, temp ref is not a code', async () => {
    const f = await setupContinuity(t.app);
    const ref = tempRef();
    const res = await syncBatch(f.reception.client, [
      f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: ref }),
    ]);
    expect(res.status).toBe(200);
    const r = res.body.results[0];
    expect(r?.disposition).toBe('committed');
    expect(r?.ticket_mapping?.temporary_ref).toBe(ref);
    expect(r?.public_code).toMatch(/^[A-Z]{1,3}\d{3}$/);
    expect(r?.public_code).not.toBe(ref);
    expect(r?.status_token).toBeTruthy();

    // The visitor's view is server-confirmed only
    const st = await ticketStatus(t.app, r?.public_code ?? '', r?.status_token);
    expect(st.status).toBe(200);
    expect(st.body.status?.['sync_status']).toBe('committed');
    // ... and the temporary reference means nothing to the visitor endpoint
    expect((await ticketStatus(t.app, ref, r?.status_token)).status).toBe(404);

    // The one-time status token is not persisted anywhere in the operation record
    const [op] = await t.db<{ result_json: unknown }[]>`
      SELECT result_json FROM client_operations WHERE operation_id = ${r?.operation_id ?? ''}`;
    expect(JSON.stringify(op?.result_json)).not.toContain(r?.status_token ?? 'x');
    await assertEventLogIntact(t.db, f.queueId);
  });

  it('a lost-ACK replay of a capture returns duplicate for the SAME ticket (never a second one)', async () => {
    const f = await setupContinuity(t.app);
    const c = f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() });
    const first = await syncBatch(f.reception.client, [c]);
    const again = await syncBatch(f.reception.client, [c]);
    expect(first.body.results[0]?.disposition).toBe('committed');
    expect(again.body.results[0]?.disposition).toBe('duplicate');
    expect(again.body.results[0]?.public_code).toBe(first.body.results[0]?.public_code);
    expect(await t.db`SELECT 1 FROM tickets WHERE queue_session_id = ${f.queueId}`).toHaveLength(1);
    expect(
      await t.db`SELECT 1 FROM queue_events WHERE queue_session_id = ${f.queueId} AND event_type = 'ticket.create'`,
    ).toHaveLength(1);
  });

  it('events carry origin context but no personal data', async () => {
    const f = await setupContinuity(t.app);
    const ref = tempRef();
    await syncBatch(f.reception.client, [
      f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: ref }),
    ]);
    const ev = await t.db<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM queue_events WHERE queue_session_id = ${f.queueId} AND event_type = 'ticket.create'`;
    expect(ev[0]?.payload['origin']).toBe('offline_sync');
    expect(ev[0]?.payload['device_id']).toBe(f.reception.deviceId);
    expect(ev[0]?.payload['temporary_ref']).toBe(ref);
    const text = JSON.stringify(ev);
    expect(text).not.toMatch(/@example\.test/);
    expect(text).not.toMatch(/Staff staff_reception/);
  });
});

describe('batch semantics (Group 7)', () => {
  it('processes commands in client_sequence order regardless of array order; client clocks do not matter', async () => {
    const f = await setupContinuity(t.app);
    const a = f.cmd(
      f.reception,
      QueueAction.TICKET_CREATE,
      { temporary_ref: tempRef() },
      {
        clientSequence: 10,
        createdAtClient: '2099-01-01T00:00:00.000Z', // far future
      },
    );
    const b = f.cmd(
      f.reception,
      QueueAction.TICKET_CREATE,
      { temporary_ref: tempRef() },
      {
        clientSequence: 11,
        createdAtClient: '2001-01-01T00:00:00.000Z', // far past
      },
    );
    const c = f.cmd(
      f.reception,
      QueueAction.TICKET_CREATE,
      { temporary_ref: tempRef() },
      {
        clientSequence: 9,
      },
    );
    const res = await syncBatch(f.reception.client, [b, a, c]); // submitted out of order
    // Results are returned in submission order ...
    expect(res.body.results.map((r) => r.operation_id)).toEqual([
      b['operation_id'],
      a['operation_id'],
      c['operation_id'],
    ]);
    // ... but numbers were issued in client_sequence order: c(9) < a(10) < b(11)
    const codes = Object.fromEntries(
      res.body.results.map((r) => [r.operation_id, r.public_code]),
    ) as Record<string, string>;
    const num = (op: unknown): number => Number((codes[op as string] ?? '').replace(/\D/g, ''));
    expect(num(c['operation_id'])).toBeLessThan(num(a['operation_id']));
    expect(num(a['operation_id'])).toBeLessThan(num(b['operation_id']));
  });

  it('submitting the same batch twice returns identical dispositions and changes no state', async () => {
    const f = await setupContinuity(t.app);
    const auth = await coordinated(f);
    // A call that refers to a ticket the COUNTER device never captured cannot be resolved
    const orphan = f.cmd(
      f.counter,
      QueueAction.TICKET_CALL_NEXT,
      { counter_id: f.counterIds[0], ticket_ref: tempRef() },
      { epoch: 1 },
    );
    const first = await syncBatch(f.counter.client, [orphan], [auth]);
    expect(first.body.results[0]?.disposition).toBe('needs_review');
    expect(first.body.results[0]?.reason_code).toBe('unresolved_ticket_ref');

    const own = [
      f.cmd(f.counter, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() }, { epoch: 1 }),
    ];
    const r1 = await syncBatch(f.counter.client, own, [auth]);
    const [rev1] = await t.db<
      { revision: number }[]
    >`SELECT revision FROM queue_sessions WHERE id = ${f.queueId}`;
    const r2 = await syncBatch(f.counter.client, own, [auth]);
    const [rev2] = await t.db<
      { revision: number }[]
    >`SELECT revision FROM queue_sessions WHERE id = ${f.queueId}`;
    expect(r1.body.results[0]?.disposition).toBe('committed');
    expect(r2.body.results[0]?.disposition).toBe('duplicate');
    expect(rev2?.revision).toBe(rev1?.revision);
    // the needs_review replay is also stable (same disposition, no second conflict event)
    const eventsBefore =
      await t.db`SELECT 1 FROM queue_events WHERE queue_session_id = ${f.queueId}`;
    const replay = await syncBatch(f.counter.client, [orphan], [auth]);
    expect(replay.body.results[0]?.disposition).toBe('needs_review');
    expect(
      await t.db`SELECT 1 FROM queue_events WHERE queue_session_id = ${f.queueId}`,
    ).toHaveLength(eventsBefore.length);
  });

  it('a mixed batch labels each command correctly and still processes the valid ones', async () => {
    const f = await setupContinuity(t.app);
    const good1 = f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() });
    const malformed = { operation_id: uuidv7Sync(), client_sequence: 2, action: 'nonsense' };
    const badPayload = f.cmd(f.reception, QueueAction.TICKET_CREATE, {
      temporary_ref: 'not-a-ref',
    });
    const notOffline = f.cmd(f.reception, 'queue.close', {});
    const advance = f.cmd(f.reception, QueueAction.TICKET_CALL_NEXT, {
      counter_id: f.counterIds[0],
    });
    const good2 = f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() });
    const res = await syncBatch(f.reception.client, [
      good1,
      malformed,
      badPayload,
      notOffline,
      advance,
      good2,
    ]);
    expect(res.status).toBe(200);
    const d = res.body.results.map((r) => [r.disposition, r.reason_code ?? null]);
    expect(d).toEqual([
      ['committed', null],
      ['rejected', 'invalid_command'],
      ['rejected', 'invalid_payload'],
      ['rejected', 'action_not_offline'], // queue.close is online-only
      ['rejected', 'authority_token_missing'],
      ['committed', null],
    ]);
  });

  it('resolves temporary refs inside one batch: capture → call → serve → complete', async () => {
    const f = await setupContinuity(t.app);
    const auth = await coordinated(f);
    const ref = tempRef();
    const cmds = [
      f.cmd(f.counter, QueueAction.TICKET_CREATE, { temporary_ref: ref }, { epoch: 1 }),
      f.cmd(
        f.counter,
        QueueAction.TICKET_CALL_NEXT,
        { counter_id: f.counterIds[0], ticket_ref: ref },
        { epoch: 1 },
      ),
      f.cmd(f.counter, QueueAction.TICKET_SERVE, { ticket_ref: ref }, { epoch: 1 }),
      f.cmd(f.counter, QueueAction.TICKET_COMPLETE, { ticket_ref: ref }, { epoch: 1 }),
    ];
    const res = await syncBatch(f.counter.client, cmds, [auth]);
    expect(res.body.results.map((r) => r.disposition)).toEqual([
      'committed',
      'committed',
      'committed',
      'committed',
    ]);
    const [ticket] = await t.db<{ state: string }[]>`
      SELECT state FROM tickets WHERE queue_session_id = ${f.queueId}`;
    expect(ticket?.state).toBe('completed');
    const types = await assertEventLogIntact(t.db, f.queueId);
    expect(types.filter((x) => x.startsWith('ticket.'))).toEqual([
      'ticket.create',
      'ticket.call_next',
      'ticket.serve',
      'ticket.complete',
    ]);
    // every synced advancement is attributed to its coordinator epoch and device
    const ev = await t.db<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM queue_events WHERE queue_session_id = ${f.queueId} AND event_type = 'ticket.serve'`;
    expect(ev[0]?.payload['coordinator_epoch']).toBe(1);
    expect(ev[0]?.payload['device_id']).toBe(f.counter.deviceId);
  });

  it('rejects a client that tries to skip ahead with a ticket the server cannot resolve', async () => {
    const f = await setupContinuity(t.app);
    const auth = await coordinated(f);
    const res = await syncBatch(
      f.counter.client,
      [f.cmd(f.counter, QueueAction.TICKET_SERVE, { ticket_ref: tempRef() }, { epoch: 1 })],
      [auth],
    );
    expect(res.body.results[0]?.disposition).toBe('needs_review');
    expect(res.body.results[0]?.reason_code).toBe('unresolved_ticket_ref');
  });

  it('reusing an operation id for a different action is refused, not applied', async () => {
    const f = await setupContinuity(t.app);
    const id = uuidv7Sync();
    const a = f.cmd(
      f.reception,
      QueueAction.TICKET_CREATE,
      { temporary_ref: tempRef() },
      { operationId: id },
    );
    await syncBatch(f.reception.client, [a]);
    const b = f.cmd(
      f.reception,
      QueueAction.TICKET_CALL_NEXT,
      { counter_id: f.counterIds[0] },
      { operationId: id },
    );
    const res = await syncBatch(f.reception.client, [b]);
    expect(res.body.results[0]?.disposition).toBe('rejected');
    expect(res.body.results[0]?.reason_code).toBe('operation_id_reused');
  });
});
