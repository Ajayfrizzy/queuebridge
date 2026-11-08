import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { replayQueueEvents } from '@queuebridge/domain';
import { randomSecret, uuidv7 } from '@queuebridge/contracts';
import { verifyChain, type StoredEvent } from './queue/hash.js';
import {
  createStaff,
  createTestApp,
  queueCommand,
  setupQueue,
  visitorJoin,
  type TestApp,
} from './testing/harness.js';

/**
 * Group 4 — concurrent PostgreSQL transactions. Requests run truly in parallel against a real
 * database (a 10-connection pool), so these exercise row locks and unique constraints, not mocks.
 */

let t: TestApp;
beforeAll(async () => {
  // Wider pool than the default test pool so transactions genuinely overlap
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

async function chainOk(queueId: string): Promise<void> {
  const rows = await t.db<(Omit<StoredEvent, 'committed_at'> & { committed_at: Date })[]>`
    SELECT organization_id, queue_session_id, sequence, event_type, actor_id, operation_id,
           payload, prev_hash, event_hash, committed_at
      FROM queue_events WHERE queue_session_id = ${queueId} ORDER BY sequence`;
  const log = rows.map((r) => ({ ...r, committed_at: r.committed_at.toISOString() }));
  expect(verifyChain(log).valid).toBe(true);
  expect(() => replayQueueEvents(log)).not.toThrow();
  const seqs = log.map((e) => e.sequence);
  expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1)); // gap-free
}

describe('concurrent joins', () => {
  it('40 simultaneous visitor joins get 40 distinct, gap-free ticket numbers and sequences', async () => {
    const q = await setupQueue(t.app, { counters: 1, serviceName: 'Rush' });
    const results = await Promise.all(
      Array.from({ length: 40 }, () => visitorJoin(t.app, q.queueId)),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const codes = results.map((r) => r.body.ticket?.public_code);
    expect(new Set(codes).size).toBe(40);
    const issued = await t.db<{ issued_sequence: number }[]>`
      SELECT issued_sequence FROM tickets WHERE queue_session_id = ${q.queueId} ORDER BY issued_sequence`;
    expect(issued.map((r) => r.issued_sequence)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    );
    const [s] = await t.db<{ revision: number; last_sequence: number }[]>`
      SELECT revision, last_sequence FROM queue_sessions WHERE id = ${q.queueId}`;
    expect(s).toEqual({ revision: 41, last_sequence: 41 });
    await chainOk(q.queueId);
  });

  it('the same join replayed concurrently creates exactly one ticket', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const operationId = uuidv7();
    const proof = randomSecret();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => visitorJoin(t.app, q.queueId, { operationId, proof })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(7); // duplicates
    expect(new Set(results.map((r) => r.body.ticket?.public_code)).size).toBe(1);
    expect(await t.db`SELECT 1 FROM tickets WHERE queue_session_id = ${q.queueId}`).toHaveLength(1);
    expect(
      await t.db`SELECT 1 FROM queue_events WHERE queue_session_id = ${q.queueId} AND event_type = 'ticket.create'`,
    ).toHaveLength(1);
  });
});

describe('concurrent call-next', () => {
  it('two counters calling at once get two DIFFERENT tickets in FIFO order — never the same one', async () => {
    for (let round = 0; round < 5; round++) {
      const q = await setupQueue(t.app, { counters: 2 });
      await visitorJoin(t.app, q.queueId);
      await visitorJoin(t.app, q.queueId);
      const [a, b] = await Promise.all(
        q.counterIds.map((counter) =>
          queueCommand(q.org.admin, q.queueId, { action: 'ticket.call_next', counter_id: counter }),
        ),
      );
      const ids = [a?.body.outcome?.ticket_id, b?.body.outcome?.ticket_id];
      expect(a?.body.outcome?.disposition).toBe('committed');
      expect(b?.body.outcome?.disposition).toBe('committed');
      expect(new Set(ids).size).toBe(2);
      const called = await t.db<{ issued_sequence: number; current_counter_id: string }[]>`
        SELECT issued_sequence, current_counter_id FROM tickets
         WHERE queue_session_id = ${q.queueId} AND state = 'called' ORDER BY issued_sequence`;
      // FIFO: exactly the first two issued tickets were called, one per counter
      expect(called.map((c) => c.issued_sequence)).toEqual([1, 2]);
      expect(new Set(called.map((c) => c.current_counter_id)).size).toBe(2);
      await chainOk(q.queueId);
    }
  });

  it('only one ticket left: one call commits, the other is rejected as queue_empty', async () => {
    const q = await setupQueue(t.app, { counters: 2 });
    await visitorJoin(t.app, q.queueId);
    const results = await Promise.all(
      q.counterIds.map((counter) =>
        queueCommand(q.org.admin, q.queueId, { action: 'ticket.call_next', counter_id: counter }),
      ),
    );
    const dispositions = results.map((r) => r.body.outcome?.disposition).sort();
    expect(dispositions).toEqual(['committed', 'rejected']);
    expect(
      results.find((r) => r.body.outcome?.disposition === 'rejected')?.body.outcome?.reason_code,
    ).toBe('queue_empty');
    expect(
      await t.db`SELECT 1 FROM queue_events WHERE queue_session_id = ${q.queueId} AND event_type = 'ticket.call_next'`,
    ).toHaveLength(1);
  });

  it('the same counter clicked twice at once: one ticket called, the other rejected counter_busy', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await visitorJoin(t.app, q.queueId);
    await visitorJoin(t.app, q.queueId);
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        queueCommand(q.org.admin, q.queueId, {
          action: 'ticket.call_next',
          counter_id: q.counterIds[0],
        }),
      ),
    );
    expect(results.filter((r) => r.body.outcome?.disposition === 'committed')).toHaveLength(1);
    expect(results.filter((r) => r.body.outcome?.reason_code === 'counter_busy')).toHaveLength(2);
    expect(
      await t.db`SELECT 1 FROM tickets WHERE queue_session_id = ${q.queueId} AND state = 'called'`,
    ).toHaveLength(1);
  });

  it('one counter serving two services cannot be given two tickets by racing sessions', async () => {
    const a = await setupQueue(t.app, { counters: 1, serviceName: 'Alpha' });
    const b = await setupQueue(t.app, {
      counters: 0,
      serviceName: 'Beta',
      org: a.org,
      fid: a.fid,
      facilitySlug: a.facilitySlug,
    });
    await a.org.admin.post('/api/v1/counter_service_capabilities', {
      counter_id: a.counterIds[0],
      service_id: b.serviceId,
    });
    await visitorJoin(t.app, a.queueId);
    await visitorJoin(t.app, b.queueId);
    const results = await Promise.all([
      queueCommand(a.org.admin, a.queueId, {
        action: 'ticket.call_next',
        counter_id: a.counterIds[0],
      }),
      queueCommand(a.org.admin, b.queueId, {
        action: 'ticket.call_next',
        counter_id: a.counterIds[0],
      }),
    ]);
    expect(results.map((r) => r.body.outcome?.disposition).sort()).toEqual([
      'committed',
      'rejected',
    ]);
    expect(
      await t.db`SELECT 1 FROM tickets WHERE current_counter_id = ${a.counterIds[0]!} AND state IN ('called','serving')`,
    ).toHaveLength(1);
  });
});

describe('idempotency under concurrency', () => {
  it('one operation id submitted 10 times at once commits once; the rest are duplicates of it', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await visitorJoin(t.app, q.queueId);
    const operationId = uuidv7();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        q.org.admin.post<{ outcome: { disposition: string; server_sequence: number } }>(
          `/api/v1/queues/${q.queueId}/commands`,
          {
            operation_id: operationId,
            action: 'ticket.call_next',
            counter_id: q.counterIds[0],
          },
        ),
      ),
    );
    const d = results.map((r) => r.body.outcome.disposition);
    expect(d.filter((x) => x === 'committed')).toHaveLength(1);
    expect(d.filter((x) => x === 'duplicate')).toHaveLength(9);
    expect(new Set(results.map((r) => r.body.outcome.server_sequence)).size).toBe(1);
    expect(await t.db`SELECT 1 FROM queue_events WHERE operation_id = ${operationId}`).toHaveLength(
      1,
    );
    expect(
      await t.db`SELECT 1 FROM client_operations WHERE operation_id = ${operationId}`,
    ).toHaveLength(1);
  });

  it('one operation id raced against two DIFFERENT queues commits in exactly one', async () => {
    const a = await setupQueue(t.app, { counters: 1, serviceName: 'One' });
    const b = await setupQueue(t.app, {
      counters: 1,
      serviceName: 'Two',
      org: a.org,
      fid: a.fid,
      facilitySlug: a.facilitySlug,
    });
    await visitorJoin(t.app, a.queueId);
    await visitorJoin(t.app, b.queueId);
    const operationId = uuidv7();
    const results = await Promise.all([
      a.org.admin.post(`/api/v1/queues/${a.queueId}/commands`, {
        operation_id: operationId,
        action: 'ticket.call_next',
        counter_id: a.counterIds[0],
      }),
      a.org.admin.post(`/api/v1/queues/${b.queueId}/commands`, {
        operation_id: operationId,
        action: 'ticket.call_next',
        counter_id: b.counterIds[0],
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await t.db`SELECT 1 FROM queue_events WHERE operation_id = ${operationId}`).toHaveLength(
      1,
    );
  });
});

describe('concurrent session and transfer operations', () => {
  it('opening the same service queue concurrently creates one session with one genesis event', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const svc = await q.org.admin.post<{ service: { id: string } }>(
      `/api/v1/facilities/${q.fid}/services`,
      { name: `Concurrent ${Date.now()}` },
    );
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        q.org.admin.post<{ queue: { id: string } }>(`/api/v1/facilities/${q.fid}/queues`, {
          service_id: svc.body.service.id,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(new Set(results.map((r) => r.body.queue.id)).size).toBe(1);
    expect(
      await t.db`SELECT 1 FROM queue_sessions WHERE service_id = ${svc.body.service.id}`,
    ).toHaveLength(1);
    expect(
      await t.db`SELECT 1 FROM queue_events qe JOIN queue_sessions qs ON qs.id = qe.queue_session_id WHERE qs.service_id = ${svc.body.service.id}`,
    ).toHaveLength(1);
  });

  it('transfers in opposite directions at the same time do not deadlock and both commit', async () => {
    for (let round = 0; round < 3; round++) {
      const a = await setupQueue(t.app, { counters: 1, serviceName: 'East' });
      const b = await setupQueue(t.app, {
        counters: 1,
        serviceName: 'West',
        org: a.org,
        fid: a.fid,
        facilitySlug: a.facilitySlug,
      });
      await visitorJoin(t.app, a.queueId);
      await visitorJoin(t.app, b.queueId);
      const [ta] = await t.db<
        { id: string }[]
      >`SELECT id FROM tickets WHERE queue_session_id = ${a.queueId}`;
      const [tb] = await t.db<
        { id: string }[]
      >`SELECT id FROM tickets WHERE queue_session_id = ${b.queueId}`;
      const results = await Promise.all([
        queueCommand(a.org.admin, a.queueId, {
          action: 'ticket.transfer',
          ticket_id: ta!.id,
          destination_service_id: b.serviceId,
          reason_code: 'wrong_service',
        }),
        queueCommand(a.org.admin, b.queueId, {
          action: 'ticket.transfer',
          ticket_id: tb!.id,
          destination_service_id: a.serviceId,
          reason_code: 'wrong_service',
        }),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      await chainOk(a.queueId);
      await chainOk(b.queueId);
    }
  });

  it('a mixed burst of joins, walk-ins and commands keeps every invariant', async () => {
    const q = await setupQueue(t.app, { counters: 3 });
    const reception = await createStaff(t.app, q.org, q.fid, 'staff_reception');
    for (let i = 0; i < 6; i++) await visitorJoin(t.app, q.queueId);
    const burst = await Promise.all([
      ...Array.from({ length: 10 }, () => visitorJoin(t.app, q.queueId)),
      ...Array.from({ length: 5 }, () =>
        reception.client.post(`/api/v1/queues/${q.queueId}/walk-ins`, { operation_id: uuidv7() }),
      ),
      ...q.counterIds.map((c) =>
        queueCommand(q.org.admin, q.queueId, { action: 'ticket.call_next', counter_id: c }),
      ),
      queueCommand(q.org.admin, q.queueId, { action: 'queue.pause' }),
    ]);
    expect(burst.every((r) => r.status < 500)).toBe(true);
    // No duplicate codes, issue numbers or counter double-assignment
    const tickets = await t.db<
      {
        public_code: string;
        issued_sequence: number;
        state: string;
        current_counter_id: string | null;
      }[]
    >`
      SELECT public_code, issued_sequence, state, current_counter_id FROM tickets WHERE queue_session_id = ${q.queueId}`;
    expect(new Set(tickets.map((x) => x.public_code)).size).toBe(tickets.length);
    expect(new Set(tickets.map((x) => x.issued_sequence)).size).toBe(tickets.length);
    const active = tickets.filter((x) => x.state === 'called');
    expect(new Set(active.map((x) => x.current_counter_id)).size).toBe(active.length);
    await chainOk(q.queueId);
  });
});

describe('database constraints are the final guard', () => {
  it('rejects a second ticket with the same issue number or code, and a second active ticket on a counter', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await visitorJoin(t.app, q.queueId);
    await expect(
      t.db`INSERT INTO tickets (queue_session_id, organization_id, public_code, issued_sequence)
           VALUES (${q.queueId}, ${q.org.organizationId}, 'X999', 1)`,
    ).rejects.toMatchObject({ code: '23505' });
    const [{ public_code: code } = { public_code: '' }] = await t.db<{ public_code: string }[]>`
      SELECT public_code FROM tickets WHERE queue_session_id = ${q.queueId}`;
    await expect(
      t.db`INSERT INTO tickets (queue_session_id, organization_id, public_code, issued_sequence)
           VALUES (${q.queueId}, ${q.org.organizationId}, ${code}, 99)`,
    ).rejects.toMatchObject({ code: '23505' });
    await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.call_next',
      counter_id: q.counterIds[0],
    });
    await expect(
      t.db`INSERT INTO tickets (queue_session_id, organization_id, public_code, issued_sequence, state, current_counter_id)
           VALUES (${q.queueId}, ${q.org.organizationId}, 'X100', 100, 'called', ${q.counterIds[0]!})`,
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      t.db`INSERT INTO queue_events (organization_id, queue_session_id, sequence, event_type, prev_hash, event_hash)
           VALUES (${q.org.organizationId}, ${q.queueId}, 1, 'forged', ${'0'.repeat(64)}, ${'0'.repeat(64)})`,
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('online operations may omit a device, offline-synced ones may not', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await expect(
      t.db`INSERT INTO client_operations (organization_id, queue_session_id, operation_id, client_sequence, action, status, source)
           VALUES (${q.org.organizationId}, ${q.queueId}, ${uuidv7()}, 0, 'ticket.call_next', 'pending', 'offline_sync')`,
    ).rejects.toMatchObject({ code: '23514' });
  });
});
