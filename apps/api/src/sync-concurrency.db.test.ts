import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueAction } from '@queuebridge/contracts';
import { replayQueueEvents } from '@queuebridge/domain';
import {
  assertEventLogIntact,
  assignCoordinator,
  createTestApp,
  setupContinuity,
  snapshot,
  syncBatch,
  tempRef,
  uuidv7Sync,
  visitorJoin,
  type TestApp,
} from './testing/harness.js';

/**
 * Groups 4 and 7 — concurrent PostgreSQL transactions and scale for the sync endpoint.
 * Requests genuinely overlap (pooled connections); no SQL is mocked.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('concurrent sync', () => {
  it('the same capture submitted 12 times at once yields exactly one committed ticket and one event', async () => {
    const f = await setupContinuity(t.app);
    const c = f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() });
    const results = await Promise.all(
      Array.from({ length: 12 }, () => syncBatch(f.reception.client, [c])),
    );
    const dispositions = results.map((r) => r.body.results[0]?.disposition);
    expect(dispositions.filter((d) => d === 'committed')).toHaveLength(1);
    expect(dispositions.filter((d) => d === 'duplicate')).toHaveLength(11);
    expect(new Set(results.map((r) => r.body.results[0]?.public_code)).size).toBe(1);
    expect(await t.db`SELECT 1 FROM tickets WHERE queue_session_id = ${f.queueId}`).toHaveLength(1);
    expect(
      await t.db`SELECT 1 FROM client_operations WHERE operation_id = ${c['operation_id'] as string}`,
    ).toHaveLength(1);
    await assertEventLogIntact(t.db, f.queueId);
  });

  it('captures from two devices racing with online joins get distinct, gap-free numbers and sequences', async () => {
    const f = await setupContinuity(t.app);
    const mk = (who: typeof f.reception, n: number): Record<string, unknown>[] =>
      Array.from({ length: n }, () =>
        f.cmd(who, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() }),
      );
    const [a, b] = [mk(f.reception, 10), mk(f.counter, 10)];
    const results = await Promise.all([
      syncBatch(f.reception.client, a),
      syncBatch(f.counter.client, b),
      ...Array.from({ length: 10 }, () => visitorJoin(t.app, f.queueId)),
    ]);
    const synced = results.slice(0, 2) as Awaited<ReturnType<typeof syncBatch>>[];
    expect(synced.flatMap((r) => r.body.results).every((r) => r.disposition === 'committed')).toBe(
      true,
    );
    const issued = await t.db<{ issued_sequence: number }[]>`
      SELECT issued_sequence FROM tickets WHERE queue_session_id = ${f.queueId} ORDER BY issued_sequence`;
    expect(issued.map((r) => r.issued_sequence)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
    await assertEventLogIntact(t.db, f.queueId);
  });

  it('a lost ACK on an advancement: retrying (even concurrently) never advances the ticket twice', async () => {
    const f = await setupContinuity(t.app);
    const ref = tempRef();
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const auth = await f.authorityFor(f.counter);
    const create = f.cmd(
      f.counter,
      QueueAction.TICKET_CREATE,
      { temporary_ref: ref },
      { epoch: 1 },
    );
    const call = f.cmd(
      f.counter,
      QueueAction.TICKET_CALL_NEXT,
      { counter_id: f.counterIds[0], ticket_ref: ref },
      { epoch: 1 },
    );
    const first = await syncBatch(f.counter.client, [create, call], [auth]);
    expect(first.body.results.map((r) => r.disposition)).toEqual(['committed', 'committed']);
    const retries = await Promise.all(
      Array.from({ length: 8 }, () => syncBatch(f.counter.client, [create, call], [auth])),
    );
    for (const r of retries) {
      expect(r.body.results.map((x) => x.disposition)).toEqual(['duplicate', 'duplicate']);
    }
    expect(
      await t.db`SELECT 1 FROM queue_events WHERE queue_session_id = ${f.queueId} AND event_type = 'ticket.call_next'`,
    ).toHaveLength(1);
    const [tk] = await t.db<
      { version: number }[]
    >`SELECT version FROM tickets WHERE queue_session_id = ${f.queueId}`;
    expect(tk?.version).toBe(1);
  });

  it('a coordinator batch racing online joins and a renewal keeps one linear, replayable history', async () => {
    const f = await setupContinuity(t.app);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const auth = await f.authorityFor(f.counter);
    const base = (await snapshot(f.counter.client, f.queueId, f.counter.deviceId)).body.snapshot
      .revision;
    const refs = Array.from({ length: 15 }, () => tempRef());
    const cmds = refs.flatMap((ref) => [
      f.cmd(
        f.counter,
        QueueAction.TICKET_CREATE,
        { temporary_ref: ref },
        { epoch: 1, baseRevision: base },
      ),
      f.cmd(
        f.counter,
        QueueAction.TICKET_CALL_NEXT,
        { counter_id: f.counterIds[0], ticket_ref: ref },
        { epoch: 1, baseRevision: base },
      ),
      f.cmd(
        f.counter,
        QueueAction.TICKET_SERVE,
        { ticket_ref: ref },
        { epoch: 1, baseRevision: base },
      ),
      f.cmd(
        f.counter,
        QueueAction.TICKET_COMPLETE,
        { ticket_ref: ref },
        { epoch: 1, baseRevision: base },
      ),
    ]);
    const [res] = await Promise.all([
      syncBatch(f.counter.client, cmds.slice(0, 60), [auth]),
      ...Array.from({ length: 6 }, () => visitorJoin(t.app, f.queueId)),
      f.supervisor.client.post(`/api/v1/queues/${f.queueId}/coordinator/renew`, {
        operation_id: uuidv7Sync(),
        ttl_minutes: 60,
      }),
    ]);
    // Visitors who joined mid-batch legitimately take their FIFO place ahead of later captures, so
    // an offline "call next" naming a different ticket is surfaced for review rather than applied.
    for (const r of res.body.results) {
      expect(['committed', 'needs_review']).toContain(r.disposition);
      if (r.disposition === 'needs_review') {
        expect(['call_mismatch', 'invalid_state', 'counter_busy']).toContain(r.reason_code);
      }
    }
    expect(res.body.results.some((r) => r.disposition === 'committed')).toBe(true);
    // Whatever interleaving happened, history is one gap-free, hash-valid, replayable line
    // and no ticket was called twice
    const types = await assertEventLogIntact(t.db, f.queueId);
    expect(types.filter((x) => x === 'ticket.create').length).toBeGreaterThanOrEqual(6);
    const calls = await t.db<{ payload: { ticket_id: string } }[]>`
      SELECT payload FROM queue_events WHERE queue_session_id = ${f.queueId} AND event_type = 'ticket.call_next'`;
    expect(new Set(calls.map((c) => c.payload.ticket_id)).size).toBe(calls.length);
  });
});

describe('scale: 1,000 scripted operations reconcile idempotently (acceptance target)', () => {
  it('commits 1,000 mixed operations, then a full replay changes nothing', async () => {
    const f = await setupContinuity(t.app, { counters: 1 });
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId, {
      ttl_minutes: 720,
    });
    const auth = await f.authorityFor(f.counter);
    const base = (await snapshot(f.counter.client, f.queueId, f.counter.deviceId)).body.snapshot
      .revision;

    // 250 visits × (capture, call, serve, complete) = 1,000 operations in client_sequence order
    const script: Record<string, unknown>[] = [];
    for (let i = 0; i < 250; i++) {
      const ref = tempRef();
      const over = { epoch: 1, baseRevision: base };
      script.push(
        f.cmd(f.counter, QueueAction.TICKET_CREATE, { temporary_ref: ref }, over),
        f.cmd(
          f.counter,
          QueueAction.TICKET_CALL_NEXT,
          { counter_id: f.counterIds[0], ticket_ref: ref },
          over,
        ),
        f.cmd(f.counter, QueueAction.TICKET_SERVE, { ticket_ref: ref }, over),
        f.cmd(f.counter, QueueAction.TICKET_COMPLETE, { ticket_ref: ref }, over),
      );
    }
    expect(script).toHaveLength(1000);

    const submit = async (): Promise<string[]> => {
      const out: string[] = [];
      for (let i = 0; i < script.length; i += 100) {
        const r = await syncBatch(f.counter.client, script.slice(i, i + 100), [auth]);
        expect(r.status).toBe(200);
        out.push(...r.body.results.map((x) => x.disposition));
      }
      return out;
    };

    const first = await submit();
    expect(first.every((d) => d === 'committed')).toBe(true);
    const [afterFirst] = await t.db<{ revision: number; last_sequence: number }[]>`
      SELECT revision, last_sequence FROM queue_sessions WHERE id = ${f.queueId}`;

    const second = await submit();
    expect(second.every((d) => d === 'duplicate')).toBe(true);
    const [afterSecond] = await t.db<{ revision: number; last_sequence: number }[]>`
      SELECT revision, last_sequence FROM queue_sessions WHERE id = ${f.queueId}`;
    expect(afterSecond).toEqual(afterFirst);

    const tickets = await t.db<
      { state: string }[]
    >`SELECT state FROM tickets WHERE queue_session_id = ${f.queueId}`;
    expect(tickets).toHaveLength(250);
    expect(tickets.every((x) => x.state === 'completed')).toBe(true);
    expect(
      await t.db`SELECT 1 FROM client_operations WHERE queue_session_id = ${f.queueId} AND source = 'offline_sync'`,
    ).toHaveLength(1000);
    // every one of the 1,000 operations is exactly one event in the hash-chained log
    const types = await assertEventLogIntact(t.db, f.queueId);
    expect(types.filter((x) => x.startsWith('ticket.'))).toHaveLength(1000);

    // determinism: replaying the committed log reproduces the same final queue state
    const log = await t.db<
      { sequence: number; event_type: string; payload: Record<string, unknown> }[]
    >`
      SELECT sequence, event_type, payload FROM queue_events WHERE queue_session_id = ${f.queueId} ORDER BY sequence`;
    const projection = replayQueueEvents(log);
    expect(Object.values(projection.tickets).every((x) => x.state === 'completed')).toBe(true);
  }, 120_000);
});
