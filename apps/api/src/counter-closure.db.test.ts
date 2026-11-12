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
  type ApiResult,
  type QueueFixture,
  type TestApp,
  type TestClient,
} from './testing/harness.js';

/**
 * Manual-acceptance defects (M4): a SERVING counter could be taken out of service, and a CALLED
 * visitor stayed assigned to a counter taken out of service and could still be served there.
 *
 * Root cause: the admin "Deactivate" switch (PATCH /facilities/:id/counters/:id) bypassed every
 * rule of the M4 close operation, and starting service never re-checked the ticket's counter.
 * These tests drive BOTH out-of-service paths — operational close (availability) and admin
 * deactivation (active) — against real PostgreSQL.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

type Outcome = {
  outcome?: { disposition: string; reason_code: string | null; ticket_id?: string };
};

type DeactivateBody = {
  counter?: { active: boolean };
  released?: { public_code: string }[];
  type?: string;
  detail?: string;
};
type CloseBody = { result?: { released: { public_code: string }[] }; type?: string };
type TicketRow = {
  state: string;
  current_counter_id: string | null;
  wait_since: Date;
  called_at: Date | null;
};

const deactivate = (
  client: TestClient,
  q: QueueFixture,
  i: number,
): Promise<ApiResult<DeactivateBody>> =>
  client.patch<DeactivateBody>(`/api/v1/facilities/${q.fid}/counters/${q.counterIds[i]}`, {
    active: false,
  });
const close = (client: TestClient, q: QueueFixture, i: number): Promise<ApiResult<CloseBody>> =>
  client.post<CloseBody>(`/api/v1/counters/${q.counterIds[i]}/availability`, {
    availability: 'closed',
    reason_code: 'break',
  });
const call = (client: TestClient, q: QueueFixture, i: number): ReturnType<typeof queueCommand> =>
  queueCommand(client, q.queueId, { action: 'ticket.call_next', counter_id: q.counterIds[i] });
const act = (
  client: TestClient,
  q: QueueFixture,
  action: string,
  ticketId: string,
): ReturnType<typeof queueCommand> =>
  queueCommand(client, q.queueId, { action, ticket_id: ticketId });
const reasonOf = (r: { body: object }): string | null =>
  (r.body as Outcome).outcome?.reason_code ?? null;

async function join(q: QueueFixture, n: number): Promise<{ id: string; code: string }[]> {
  const out: { id: string; code: string }[] = [];
  for (let i = 0; i < n; i++) {
    const j = await visitorJoin(t.app, q.queueId);
    const code = j.body.ticket?.public_code ?? '';
    const [row] = await t.db<{ id: string }[]>`
      SELECT id FROM tickets WHERE queue_session_id = ${q.queueId} AND public_code = ${code}`;
    out.push({ id: row?.id ?? '', code });
  }
  return out;
}

const ticketRow = async (id: string): Promise<TicketRow | undefined> =>
  (
    await t.db<TicketRow[]>`
      SELECT state, current_counter_id, wait_since, called_at FROM tickets WHERE id = ${id}`
  )[0];
const counterRow = async (
  id: string,
): Promise<{ active: boolean; availability: string } | undefined> =>
  (
    await t.db<{ active: boolean; availability: string }[]>`
      SELECT active, availability FROM counters WHERE id = ${id}`
  )[0];

/** No counter that is out of service (inactive OR closed) may hold a called or serving ticket. */
async function assertNoTicketAtOutOfServiceCounter(queueId: string): Promise<void> {
  const bad = await t.db<{ public_code: string; state: string }[]>`
    SELECT tk.public_code, tk.state FROM tickets tk JOIN counters c ON c.id = tk.current_counter_id
     WHERE tk.queue_session_id = ${queueId} AND tk.state IN ('called', 'serving')
       AND (NOT c.active OR c.availability <> 'open')`;
  expect(bad).toEqual([]);
}

// ---------------------------------------------------------------------------
// 1–3: closing / deactivating
// ---------------------------------------------------------------------------

describe('taking an idle counter out of service', () => {
  it('closing or deactivating an idle counter succeeds', async () => {
    const q = await setupQueue(t.app, { counters: 2 });
    expect((await close(q.org.admin, q, 0)).status).toBe(200);
    const d = await deactivate(q.org.admin, q, 1);
    expect(d.status).toBe(200);
    expect(d.body.counter?.active).toBe(false);
    expect(await counterRow(q.counterIds[0] ?? '')).toMatchObject({ availability: 'closed' });
    expect(await counterRow(q.counterIds[1] ?? '')).toMatchObject({ active: false });
  });
});

describe('a counter that is SERVING a visitor cannot be taken out of service', () => {
  it.each([
    ['operational close', close],
    ['admin deactivation', deactivate],
  ] as const)('%s is refused (409) and nothing changes', async (_name, takeOut) => {
    const q = await setupQueue(t.app, { counters: 1 });
    const [g1] = await join(q, 1);
    await call(q.org.admin, q, 0);
    expect((await act(q.org.admin, q, 'ticket.serve', g1?.id ?? '')).status).toBe(200);
    const r = await takeOut(q.org.admin, q, 0);
    expect(r.status).toBe(409);
    expect(await counterRow(q.counterIds[0] ?? '')).toEqual({ active: true, availability: 'open' });
    expect(await ticketRow(g1?.id ?? '')).toMatchObject({
      state: 'serving',
      current_counter_id: q.counterIds[0],
    });
    // the visit can still be completed normally
    expect((await act(q.org.admin, q, 'ticket.complete', g1?.id ?? '')).status).toBe(200);
  });
});

describe('a counter that is CALLING a visitor: the visitor is atomically requeued', () => {
  it.each([
    ['operational close', close, 'counter_closed:break'],
    ['admin deactivation', deactivate, 'counter_deactivated'],
  ] as const)(
    '%s returns them to the head of the line, keeps their waiting age, clears the counter',
    async (_n, takeOut, reason) => {
      const q = await setupQueue(t.app, { counters: 2 });
      const [g1, g2] = await join(q, 2);
      const before = await ticketRow(g1?.id ?? '');
      await call(q.org.admin, q, 0); // g1 called at counter 0
      const r = await takeOut(q.org.admin, q, 0);
      expect(r.status).toBe(200);
      const released =
        'result' in r.body && r.body.result
          ? r.body.result.released
          : (r.body as { released?: { public_code: string }[] }).released;
      expect(released?.map((x) => x.public_code)).toEqual([g1?.code]);
      expect(await ticketRow(g1?.id ?? '')).toMatchObject({
        state: 'waiting',
        current_counter_id: null,
        called_at: null,
        wait_since: before?.wait_since,
      });
      await assertNoTicketAtOutOfServiceCounter(q.queueId);

      // 4. a stale serve (old console) for the requeued ticket is refused
      const stale = await act(q.org.admin, q, 'ticket.serve', g1?.id ?? '');
      expect(stale.status).toBe(409);
      expect(reasonOf(stale)).toBe('invalid_state');
      // ...and so is a stale "missed" from the same console
      expect(reasonOf(await act(q.org.admin, q, 'ticket.miss', g1?.id ?? ''))).toBe(
        'invalid_state',
      );

      // 7. still eligible: the next open, capable counter calls g1 FIRST (waiting age), then g2
      const next = await call(q.org.admin, q, 1);
      expect(next.body.outcome?.ticket_id).toBe(g1?.id);
      expect(g2).toBeDefined();

      // 9. audit: release event explains the closure; the chain and decision replay still verify
      const [ev] = await t.db<{ payload: Record<string, unknown>; actor_id: string | null }[]>`
      SELECT payload, actor_id FROM queue_events
       WHERE queue_session_id = ${q.queueId} AND event_type = 'ticket.release'`;
      expect(ev?.actor_id).toBe(q.org.adminId);
      expect(ev?.payload).toMatchObject({
        ticket_id: g1?.id,
        from_state: 'called',
        to_state: 'waiting',
        counter_id: null,
        from_counter_id: q.counterIds[0],
        reason_code: reason,
        policy_version: 'v1',
      });
      await assertEventLogIntact(t.db, q.queueId);
      const v = await q.org.admin.get<{
        verification: { status: string; replay: { valid: boolean } };
      }>(`/api/v1/queues/${q.queueId}/audit/verify`);
      expect(v.body.verification).toMatchObject({ status: 'verified', replay: { valid: true } });
    },
  );

  it('admin deactivation records the release count in the admin event and signals consoles', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await join(q, 1);
    await call(q.org.admin, q, 0);
    const rev0 = (
      await q.org.admin.get<{ queue: { revision: number } }>(`/api/v1/queues/${q.queueId}`)
    ).body.queue.revision;
    expect((await deactivate(q.org.admin, q, 0)).status).toBe(200);
    const [ae] = await t.db<{ details: Record<string, unknown> }[]>`
      SELECT details FROM admin_events WHERE target_id = ${q.counterIds[0] ?? ''} AND event_type = 'counter.updated'
       ORDER BY created_at DESC LIMIT 1`;
    expect(ae?.details).toMatchObject({ fields: 'active', active: false, released: 1 });
    // the staff console projection moved on (revision advanced by the release event)
    const view = await q.org.admin.get<{
      queue: { revision: number; counters: { active: boolean; busy_with_code: string | null }[] };
    }>(`/api/v1/queues/${q.queueId}`);
    expect(view.body.queue.revision).toBe(rev0 + 1);
    expect(view.body.queue.counters[0]).toMatchObject({ active: false, busy_with_code: null });
  });

  it('deactivation follows the same role rules: only configurators (facility admin / org admin) may deactivate', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await join(q, 1);
    await call(q.org.admin, q, 0);
    for (const role of ['supervisor', 'staff_counter', 'auditor']) {
      const s = await createStaff(t.app, q.org, q.fid, role);
      expect((await deactivate(s.client, q, 0)).status, role).toBe(403);
    }
    const fa = await createStaff(t.app, q.org, q.fid, 'facility_admin');
    expect((await deactivate(fa.client, q, 0)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 5: an out-of-service counter cannot call or serve
// ---------------------------------------------------------------------------

describe('an out-of-service counter cannot call or start serving', () => {
  it('calls to an inactive or closed counter are refused', async () => {
    const q = await setupQueue(t.app, { counters: 2 });
    await join(q, 2);
    await deactivate(q.org.admin, q, 0);
    await close(q.org.admin, q, 1);
    expect(reasonOf(await call(q.org.admin, q, 0))).toBe('counter_inactive');
    expect(reasonOf(await call(q.org.admin, q, 1))).toBe('counter_closed');
  });

  it.each([
    ['inactive', `active = FALSE`, 'counter_inactive'],
    ['closed', `availability = 'closed'`, 'counter_closed'],
  ] as const)(
    'a visitor left CALLED at a %s counter (data from before this fix) cannot be served there; recall still works',
    async (_n, setSql, reason) => {
      const q = await setupQueue(t.app, { counters: 1 });
      const [g1] = await join(q, 1);
      await call(q.org.admin, q, 0);
      // Recreate the stranded state the defective admin switch could produce (now impossible via API)
      await t.db.unsafe(`UPDATE counters SET ${setSql} WHERE id = $1`, [q.counterIds[0] ?? '']);
      const r = await act(q.org.admin, q, 'ticket.serve', g1?.id ?? '');
      expect(r.status).toBe(409);
      expect(reasonOf(r)).toBe(reason);
      expect(await ticketRow(g1?.id ?? '')).toMatchObject({ state: 'called' });
      // a supervisor can return the visitor to the queue so an open counter can call them
      expect((await act(q.org.admin, q, 'ticket.resume', g1?.id ?? '')).status).toBe(200);
      expect(await ticketRow(g1?.id ?? '')).toMatchObject({
        state: 'waiting',
        current_counter_id: null,
      });
    },
  );
});

// ---------------------------------------------------------------------------
// 6: concurrency
// ---------------------------------------------------------------------------

describe('concurrent serve vs. taking the counter out of service', () => {
  it.each([
    ['operational close', close],
    ['admin deactivation', deactivate],
  ] as const)(
    '%s racing a serve: exactly one wins, the invariant always holds',
    async (_n, takeOut) => {
      const outcomes = new Set<string>();
      for (let round = 0; round < 8; round++) {
        const q = await setupQueue(t.app, { counters: 1 });
        const [g1] = await join(q, 1);
        await call(q.org.admin, q, 0);
        const [s, c] = await Promise.all([
          act(q.org.admin, q, 'ticket.serve', g1?.id ?? ''),
          takeOut(q.org.admin, q, 0),
        ]);
        const tk = await ticketRow(g1?.id ?? '');
        const ctr = await counterRow(q.counterIds[0] ?? '');
        const inService = ctr?.active === true && ctr.availability === 'open';
        if (s.status === 200) {
          // serve won: the counter must still be in service and the take-out refused
          expect(c.status).toBe(409);
          expect(inService).toBe(true);
          expect(tk?.state).toBe('serving');
          outcomes.add('serve');
        } else {
          // take-out won: ticket requeued, serve refused
          expect(c.status).toBe(200);
          expect(s.status).toBe(409);
          expect(inService).toBe(false);
          expect(tk).toMatchObject({ state: 'waiting', current_counter_id: null });
          outcomes.add('takeout');
        }
        await assertNoTicketAtOutOfServiceCounter(q.queueId);
        await assertEventLogIntact(t.db, q.queueId);
      }
      expect(outcomes.size).toBeGreaterThan(0);
    },
  );

  it('deactivation racing a call to the same counter never leaves a called ticket at an inactive counter', async () => {
    for (let round = 0; round < 8; round++) {
      const q = await setupQueue(t.app, { counters: 1 });
      await join(q, 1);
      await Promise.all([call(q.org.admin, q, 0), deactivate(q.org.admin, q, 0)]);
      await assertNoTicketAtOutOfServiceCounter(q.queueId);
      await assertEventLogIntact(t.db, q.queueId);
    }
  });
});

// ---------------------------------------------------------------------------
// 7: priority order after a release
// ---------------------------------------------------------------------------

describe('routing order after a release', () => {
  it('a released normal visitor goes ahead of later normal visitors but behind a waiting higher class', async () => {
    const q = await setupQueue(t.app, { counters: 2 });
    await q.org.admin.patch(`/api/v1/facilities/${q.fid}/services/${q.serviceId}`, {
      policy: { priority_order: ['priority', 'normal'] },
    });
    const [g1, g2, g3] = await join(q, 3);
    await call(q.org.admin, q, 0); // g1 called
    const o = await q.org.admin.post(`/api/v1/tickets/${g3?.id}/priority-override`, {
      operation_id: (await import('@queuebridge/contracts')).uuidv7(),
      to_class: 'priority',
      reason_code: 'accessibility_need',
      reason_text: 'Uses a wheelchair today',
    });
    expect(o.status).toBe(200);
    await deactivate(q.org.admin, q, 0); // g1 released
    const order: (string | null | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await call(q.org.admin, q, 1);
      order.push(c.body.outcome?.ticket_id);
      await act(q.org.admin, q, 'ticket.serve', c.body.outcome?.ticket_id ?? '');
      await act(q.org.admin, q, 'ticket.complete', c.body.outcome?.ticket_id ?? '');
    }
    expect(order).toEqual([g3?.id, g1?.id, g2?.id]);
    const v = await q.org.admin.get<{
      verification: { status: string; replay: { decisions_verified: number } };
    }>(`/api/v1/queues/${q.queueId}/audit/verify`);
    expect(v.body.verification.status).toBe('verified');
    expect(v.body.verification.replay.decisions_verified).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 8: M3 coordinator fencing
// ---------------------------------------------------------------------------

describe('offline coordinator fencing still applies', () => {
  it('admin deactivation that would release a visitor is refused while a coordinator holds the queue', async () => {
    const f = await setupContinuity(t.app, { counters: 2 });
    await visitorJoin(t.app, f.queueId);
    // the visitor is called ONLINE before the coordinator takes over
    const c = await queueCommand(f.supervisor.client, f.queueId, {
      action: 'ticket.call_next',
      counter_id: f.counterIds[0],
    });
    expect(c.body.outcome?.disposition).toBe('committed');
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const r = await f.org.admin.patch<{ type?: string }>(
      `/api/v1/facilities/${f.fid}/counters/${f.counterIds[0]}`,
      { active: false },
    );
    expect(r.status).toBe(409);
    expect(r.body.type).toMatch(/coordinator-active/);
    const [ctr] = await t.db<
      { active: boolean }[]
    >`SELECT active FROM counters WHERE id = ${f.counterIds[0] ?? ''}`;
    expect(ctr?.active).toBe(true);
    // an IDLE counter can still be deactivated while the coordinator holds the queue
    expect(
      (
        await f.org.admin.patch(`/api/v1/facilities/${f.fid}/counters/${f.counterIds[1]}`, {
          active: false,
        })
      ).status,
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Manual-acceptance test 1: who may configure priority classes
// ---------------------------------------------------------------------------

describe('priority-class configuration permissions (manual test 1)', () => {
  it('org admins and facility admins may change the policy; supervisors, counter staff, reception and auditors may not', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const path = `/api/v1/facilities/${q.fid}/services/${q.serviceId}`;
    const patch = (
      c: TestClient,
      order: string[],
    ): Promise<ApiResult<{ service?: { policy: { version: string } } }>> =>
      c.patch<{ service?: { policy: { version: string } } }>(path, {
        policy: { priority_order: order },
      });
    expect((await patch(q.org.admin, ['priority', 'normal'])).body.service?.policy.version).toBe(
      'v2',
    );
    const fa = await createStaff(t.app, q.org, q.fid, 'facility_admin');
    expect(
      (await patch(fa.client, ['urgent', 'priority', 'normal'])).body.service?.policy.version,
    ).toBe('v3');
    for (const role of ['supervisor', 'staff_counter', 'staff_reception', 'auditor']) {
      const s = await createStaff(t.app, q.org, q.fid, role);
      expect((await patch(s.client, ['normal'])).status, role).toBe(403);
    }
    const [svc] = await t.db<
      { policy: { version: string } }[]
    >`SELECT policy FROM services WHERE id = ${q.serviceId}`;
    expect(svc?.policy.version).toBe('v3');
  });
});
