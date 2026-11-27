import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertEventLogIntact,
  assignCoordinator,
  createStaff,
  createTestApp,
  queueCommand,
  setupContinuity,
  setupQueue,
  visitorJoin,
  type QueueFixture,
  type TestApp,
  type TestClient,
} from './testing/harness.js';

/**
 * M4 routing invariant (PR #6 final review): a counter must never keep a CALLED or SERVING
 * visitor of a service whose capability was removed from that counter.
 *
 * Capability removal now takes the shared M4 counter locks (sessions in id order, then the
 * counter FOR UPDATE) and refuses with 409 while the counter is calling or serving a visitor of
 * that service. All tests run against real PostgreSQL through the real API.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const removeCap = (
  client: TestClient,
  counterId: string,
  serviceId: string,
): ReturnType<TestClient['del']> =>
  client.del(`/api/v1/counter_service_capabilities/${counterId}/${serviceId}`);
const call = (
  client: TestClient,
  queueId: string,
  counterId: string,
): ReturnType<typeof queueCommand> =>
  queueCommand(client, queueId, { action: 'ticket.call_next', counter_id: counterId });
const act = (
  client: TestClient,
  queueId: string,
  action: string,
  ticketId: string,
): ReturnType<typeof queueCommand> =>
  queueCommand(client, queueId, { action, ticket_id: ticketId });

async function join(q: QueueFixture): Promise<string> {
  const j = await visitorJoin(t.app, q.queueId);
  const code = j.body.ticket?.public_code ?? '';
  const [row] = await t.db<{ id: string }[]>`
    SELECT id FROM tickets WHERE queue_session_id = ${q.queueId} AND public_code = ${code}`;
  return row?.id ?? '';
}

interface TicketSnapshot {
  state: string;
  current_counter_id: string | null;
  version: number;
  wait_since: Date;
  called_at: Date | null;
}
const ticketRow = async (id: string): Promise<TicketSnapshot | undefined> =>
  (
    await t.db<TicketSnapshot[]>`
      SELECT state, current_counter_id, version, wait_since, called_at FROM tickets WHERE id = ${id}`
  )[0];
const capRows = async (counterId: string, serviceId: string): Promise<object[]> => [
  ...(await t.db<object[]>`SELECT 1 FROM counter_service_capabilities
        WHERE counter_id = ${counterId} AND service_id = ${serviceId}`),
];
const adminEventCount = async (counterId: string, type: string): Promise<number> =>
  (await t.db`SELECT 1 FROM admin_events WHERE target_id = ${counterId} AND event_type = ${type}`)
    .length;
const queueRevision = async (queueId: string): Promise<number> =>
  (await t.db<{ revision: number }[]>`SELECT revision FROM queue_sessions WHERE id = ${queueId}`)[0]
    ?.revision ?? -1;

/** No called/serving ticket may sit at a counter that does not (or no longer) serve its service. */
async function assertNoActiveTicketWithoutCapability(counterId: string): Promise<void> {
  const bad = await t.db<{ public_code: string; state: string }[]>`
    SELECT tk.public_code, tk.state FROM tickets tk
      JOIN queue_sessions qs ON qs.id = tk.queue_session_id
     WHERE tk.current_counter_id = ${counterId} AND tk.state IN ('called', 'serving')
       AND NOT EXISTS (SELECT 1 FROM counter_service_capabilities csc
                        WHERE csc.counter_id = ${counterId} AND csc.service_id = qs.service_id)`;
  expect(bad).toEqual([]);
}

// ---------------------------------------------------------------------------
// Normal behaviour is preserved
// ---------------------------------------------------------------------------

describe('removing a capability when no affected ticket is active', () => {
  it('succeeds (204), records one admin event and the counter stops serving the service', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const counterId = q.counterIds[0] ?? '';
    const r = await removeCap(q.org.admin, counterId, q.serviceId);
    expect(r.status).toBe(204);
    expect(await capRows(counterId, q.serviceId)).toHaveLength(0);
    expect(await adminEventCount(counterId, 'counter_capability.removed')).toBe(1);
    const list = await q.org.admin.get<{ counters: { id: string; service_ids: string[] }[] }>(
      `/api/v1/facilities/${q.fid}/counters`,
    );
    expect(list.body.counters.find((c) => c.id === counterId)?.service_ids).toEqual([]);
  });

  it('a missing capability is still a 404 and records nothing', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const counterId = q.counterIds[0] ?? '';
    expect((await removeCap(q.org.admin, counterId, q.serviceId)).status).toBe(204);
    expect((await removeCap(q.org.admin, counterId, q.serviceId)).status).toBe(404);
    expect(await adminEventCount(counterId, 'counter_capability.removed')).toBe(1);
  });

  it('waiting, completed and missed tickets do not block removal', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const counterId = q.counterIds[0] ?? '';
    const done = await join(q);
    await join(q); // stays waiting
    await call(q.org.admin, q.queueId, counterId);
    await act(q.org.admin, q.queueId, 'ticket.serve', done);
    await act(q.org.admin, q.queueId, 'ticket.complete', done);
    expect((await removeCap(q.org.admin, counterId, q.serviceId)).status).toBe(204);
    await assertEventLogIntact(t.db, q.queueId);
  });
});

// ---------------------------------------------------------------------------
// The refusal
// ---------------------------------------------------------------------------

describe('removal is refused (409) while an affected ticket is called or serving', () => {
  it.each(['called', 'serving'] as const)(
    'a %s visitor blocks removal; counter configuration and the ticket are unchanged; it succeeds afterwards',
    async (state) => {
      const q = await setupQueue(t.app, { counters: 1 });
      const counterId = q.counterIds[0] ?? '';
      const id = await join(q);
      await call(q.org.admin, q.queueId, counterId);
      if (state === 'serving') {
        expect((await act(q.org.admin, q.queueId, 'ticket.serve', id)).status).toBe(200);
      }
      const ticketBefore = await ticketRow(id);
      const revisionBefore = await queueRevision(q.queueId);
      const eventsBefore = await assertEventLogIntact(t.db, q.queueId);

      const r = await removeCap(q.org.admin, counterId, q.serviceId);
      expect(r.status).toBe(409);
      expect((r.body as { detail?: string }).detail).toContain(
        state === 'serving' ? 'is serving a visitor' : 'is calling a visitor',
      );

      // nothing changed: capability, counter flags, ticket, queue revision, event log, admin events
      expect(await capRows(counterId, q.serviceId)).toHaveLength(1);
      const [ctr] = await t.db<{ active: boolean; availability: string }[]>`
        SELECT active, availability FROM counters WHERE id = ${counterId}`;
      expect(ctr).toEqual({ active: true, availability: 'open' });
      expect(await ticketRow(id)).toEqual(ticketBefore);
      expect(await queueRevision(q.queueId)).toBe(revisionBefore);
      expect(await assertEventLogIntact(t.db, q.queueId)).toEqual(eventsBefore);
      expect(await adminEventCount(counterId, 'counter_capability.removed')).toBe(0);
      await assertNoActiveTicketWithoutCapability(counterId);

      // the visit continues normally, then removal succeeds
      if (state === 'called') await act(q.org.admin, q.queueId, 'ticket.serve', id);
      expect((await act(q.org.admin, q.queueId, 'ticket.complete', id)).status).toBe(200);
      expect((await removeCap(q.org.admin, counterId, q.serviceId)).status).toBe(204);
      expect(await adminEventCount(counterId, 'counter_capability.removed')).toBe(1);
    },
  );

  it('only the affected service blocks: other services at the same counter can still be removed', async () => {
    const a = await setupQueue(t.app, { counters: 1, serviceName: 'Alpha' });
    const b = await setupQueue(t.app, {
      counters: 0,
      serviceName: 'Beta',
      org: a.org,
      fid: a.fid,
      facilitySlug: a.facilitySlug,
    });
    const counterId = a.counterIds[0] ?? '';
    await a.org.admin.post('/api/v1/counter_service_capabilities', {
      counter_id: counterId,
      service_id: b.serviceId,
    });
    const alphaTicket = await join(a);
    await call(a.org.admin, a.queueId, counterId); // counter is calling an ALPHA visitor

    // Beta is not affected by the Alpha visitor
    expect((await removeCap(a.org.admin, counterId, b.serviceId)).status).toBe(204);
    // Alpha is
    expect((await removeCap(a.org.admin, counterId, a.serviceId)).status).toBe(409);
    expect(await capRows(counterId, a.serviceId)).toHaveLength(1);
    expect(await ticketRow(alphaTicket)).toMatchObject({
      state: 'called',
      current_counter_id: counterId,
    });
  });

  it('the refusal needs configure permission first (non-admins stay 403, not 409)', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const counterId = q.counterIds[0] ?? '';
    await join(q);
    await call(q.org.admin, q.queueId, counterId);
    const sup = await createStaff(t.app, q.org, q.fid, 'supervisor');
    expect((await removeCap(sup.client, counterId, q.serviceId)).status).toBe(403);
    expect((await removeCap(q.org.admin, counterId, q.serviceId)).status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Concurrency (real PostgreSQL, real transactions)
// ---------------------------------------------------------------------------

describe('concurrent capability removal vs. Call Next / Start Serving', () => {
  it('removal racing Call Next: exactly one wins and a counter never holds a ticket it cannot serve', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 12; round++) {
      const q = await setupQueue(t.app, { counters: 1 });
      const counterId = q.counterIds[0] ?? '';
      const id = await join(q);
      const [c, r] = await Promise.all([
        call(q.org.admin, q.queueId, counterId),
        removeCap(q.org.admin, counterId, q.serviceId),
      ]);
      const caps = await capRows(counterId, q.serviceId);
      const tk = await ticketRow(id);
      if (r.status === 204) {
        // removal first: the call was refused, the visitor still waits
        expect(c.body.outcome?.disposition).toBe('rejected');
        expect(c.body.outcome?.reason_code).toBe('counter_not_capable');
        expect(caps).toHaveLength(0);
        expect(tk).toMatchObject({ state: 'waiting', current_counter_id: null });
        outcomes.add('removed');
      } else {
        // call first: the removal was refused, the capability and the call stand
        expect(r.status).toBe(409);
        expect(c.body.outcome?.disposition).toBe('committed');
        expect(caps).toHaveLength(1);
        expect(tk).toMatchObject({ state: 'called', current_counter_id: counterId });
        outcomes.add('called');
      }
      await assertNoActiveTicketWithoutCapability(counterId);
      await assertEventLogIntact(t.db, q.queueId);
    }
    expect(outcomes.size).toBeGreaterThan(0);
  });

  it('removal racing Start Serving: the called visitor protects the capability, serve always commits', async () => {
    for (let round = 0; round < 12; round++) {
      const q = await setupQueue(t.app, { counters: 1 });
      const counterId = q.counterIds[0] ?? '';
      const id = await join(q);
      await call(q.org.admin, q.queueId, counterId);
      const [s, r] = await Promise.all([
        act(q.org.admin, q.queueId, 'ticket.serve', id),
        removeCap(q.org.admin, counterId, q.serviceId),
      ]);
      expect(s.status).toBe(200);
      expect(r.status).toBe(409);
      expect(await capRows(counterId, q.serviceId)).toHaveLength(1);
      expect(await ticketRow(id)).toMatchObject({
        state: 'serving',
        current_counter_id: counterId,
      });
      await assertNoActiveTicketWithoutCapability(counterId);
      await assertEventLogIntact(t.db, q.queueId);
    }
  });

  it('removal racing the completion of the visit: either order leaves a consistent state', async () => {
    for (let round = 0; round < 12; round++) {
      const q = await setupQueue(t.app, { counters: 1 });
      const counterId = q.counterIds[0] ?? '';
      const id = await join(q);
      await call(q.org.admin, q.queueId, counterId);
      await act(q.org.admin, q.queueId, 'ticket.serve', id);
      const [done, r] = await Promise.all([
        act(q.org.admin, q.queueId, 'ticket.complete', id),
        removeCap(q.org.admin, counterId, q.serviceId),
      ]);
      expect(done.status).toBe(200);
      expect([204, 409]).toContain(r.status);
      expect(await capRows(counterId, q.serviceId)).toHaveLength(r.status === 204 ? 0 : 1);
      await assertNoActiveTicketWithoutCapability(counterId);
      await assertEventLogIntact(t.db, q.queueId);
    }
  });

  it('two racing removals of the same capability: one 204, one 404, a single admin event', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const counterId = q.counterIds[0] ?? '';
    const rs = await Promise.all([
      removeCap(q.org.admin, counterId, q.serviceId),
      removeCap(q.org.admin, counterId, q.serviceId),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([204, 404]);
    expect(await adminEventCount(counterId, 'counter_capability.removed')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// M1–M4 rules and M3 coordinator fencing stay intact
// ---------------------------------------------------------------------------

describe('existing routing and fencing rules are unaffected', () => {
  it('after removal the counter cannot call that service, and re-adding restores it', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const counterId = q.counterIds[0] ?? '';
    await join(q);
    expect((await removeCap(q.org.admin, counterId, q.serviceId)).status).toBe(204);
    const refused = await call(q.org.admin, q.queueId, counterId);
    expect(refused.body.outcome?.reason_code).toBe('counter_not_capable');
    await q.org.admin.post('/api/v1/counter_service_capabilities', {
      counter_id: counterId,
      service_id: q.serviceId,
    });
    expect((await call(q.org.admin, q.queueId, counterId)).body.outcome?.disposition).toBe(
      'committed',
    );
  });

  it('a coordinator-held queue: a CALLED visitor still blocks removal, an idle counter does not; epoch unchanged', async () => {
    const f = await setupContinuity(t.app, { counters: 2 });
    await visitorJoin(t.app, f.queueId);
    const c = await call(f.supervisor.client, f.queueId, f.counterIds[0] ?? '');
    expect(c.body.outcome?.disposition).toBe('committed');
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const [before] = await t.db<{ coordinator_epoch: number; coordinator_device_id: string }[]>`
      SELECT coordinator_epoch, coordinator_device_id FROM queue_sessions WHERE id = ${f.queueId}`;

    expect((await removeCap(f.org.admin, f.counterIds[0] ?? '', f.serviceId)).status).toBe(409);
    expect((await removeCap(f.org.admin, f.counterIds[1] ?? '', f.serviceId)).status).toBe(204);

    const [after] = await t.db<{ coordinator_epoch: number; coordinator_device_id: string }[]>`
      SELECT coordinator_epoch, coordinator_device_id FROM queue_sessions WHERE id = ${f.queueId}`;
    expect(after).toEqual(before);
    await assertEventLogIntact(t.db, f.queueId);
  });
});
