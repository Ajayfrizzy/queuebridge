import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { replayQueueEvents } from '@queuebridge/domain';
import { uuidv7 } from '@queuebridge/contracts';
import { verifyChain, type StoredEvent } from './queue/hash.js';
import {
  createStaff,
  createTestApp,
  queueCommand,
  setupQueue,
  ticketStatus,
  TestClient,
  visitorJoin,
  type QueueFixture,
  type TestApp,
} from './testing/harness.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

async function events(queueId: string): Promise<StoredEvent[]> {
  const rows = await t.db<(Omit<StoredEvent, 'committed_at'> & { committed_at: Date })[]>`
    SELECT organization_id, queue_session_id, sequence, event_type, actor_id, operation_id,
           payload, prev_hash, event_hash, committed_at
      FROM queue_events WHERE queue_session_id = ${queueId} ORDER BY sequence`;
  return rows.map((r) => ({ ...r, committed_at: r.committed_at.toISOString() }));
}

/** The event log must fully explain the ticket table (no state change without an event). */
async function expectLogMatchesTables(queueId: string): Promise<void> {
  const log = await events(queueId);
  expect(verifyChain(log)).toMatchObject({ valid: true, checked: log.length });
  const projection = replayQueueEvents(log);
  const [session] = await t.db<{ state: string; last_sequence: number }[]>`
    SELECT state, last_sequence FROM queue_sessions WHERE id = ${queueId}`;
  expect(projection.state).toBe(session?.state);
  expect(projection.last_sequence).toBe(session?.last_sequence);
  const tickets = await t.db<{ id: string; state: string; public_code: string }[]>`
    SELECT id, state, public_code FROM tickets WHERE queue_session_id = ${queueId}`;
  expect(Object.keys(projection.tickets).sort()).toEqual(tickets.map((x) => x.id).sort());
  for (const row of tickets) {
    expect(projection.tickets[row.id]).toMatchObject({
      state: row.state,
      public_code: row.public_code,
    });
  }
}

describe('M2 journey: visitor web join → call → serve → complete', () => {
  it('runs end to end on real persisted state with an intact, replayable event log', async () => {
    const q = await setupQueue(t.app, { counters: 1, serviceName: 'General Consultation' });
    const counter = q.counterIds[0] as string;

    // Visitor joins anonymously
    const join = await visitorJoin(t.app, q.queueId);
    expect(join.status).toBe(201);
    const ticket = join.body.ticket!;
    expect(ticket.disposition).toBe('committed');
    expect(ticket.public_code).toBe('G001');
    expect(ticket.status_path).toBe('/ticket/G001');
    expect(ticket.status_token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Status (token-protected): waiting, next in line, confirmed, explainable estimate
    let st = await ticketStatus(t.app, 'G001', ticket.status_token);
    expect(st.status).toBe(200);
    expect(st.body.status).toMatchObject({
      public_code: 'G001',
      service_name: 'General Consultation',
      state: 'waiting',
      sync_status: 'committed',
      queue_state: 'open',
      position: 0,
      counter_name: null,
    });
    expect(st.body.status?.['estimate']).toMatchObject({ confidence: 'insufficient_data' });

    // Staff call / serve / complete
    const call = await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.call_next',
      counter_id: counter,
    });
    expect(call.status).toBe(200);
    expect(call.body.outcome).toMatchObject({ disposition: 'committed', public_code: 'G001' });
    const ticketId = call.body.outcome!.ticket_id as string;

    st = await ticketStatus(t.app, 'G001', ticket.status_token);
    expect(st.body.status).toMatchObject({ state: 'called', position: null });
    expect(String(st.body.status?.['status_message'])).toMatch(/your turn.*Counter/i);

    expect(
      (await queueCommand(q.org.admin, q.queueId, { action: 'ticket.serve', ticket_id: ticketId }))
        .status,
    ).toBe(200);
    expect((await ticketStatus(t.app, 'G001', ticket.status_token)).body.status?.state).toBe(
      'serving',
    );
    expect(
      (
        await queueCommand(q.org.admin, q.queueId, {
          action: 'ticket.complete',
          ticket_id: ticketId,
        })
      ).status,
    ).toBe(200);
    st = await ticketStatus(t.app, 'G001', ticket.status_token);
    expect(st.body.status?.state).toBe('completed');

    // Audited: every transition is a hash-chained event that replays to the stored state
    const log = await events(q.queueId);
    expect(log.map((e) => e.event_type)).toEqual([
      'queue.open',
      'ticket.create',
      'ticket.call_next',
      'ticket.serve',
      'ticket.complete',
    ]);
    expect(log.slice(2).every((e) => e.actor_id === q.org.adminId)).toBe(true);
    await expectLogMatchesTables(q.queueId);
    const transitions =
      await t.db`SELECT from_state, to_state FROM ticket_transitions WHERE ticket_id = ${ticketId} ORDER BY transitioned_at`;
    expect(transitions.map((r) => `${r['from_state']}>${r['to_state']}`)).toEqual([
      'none>waiting',
      'waiting>called',
      'called>serving',
      'serving>completed',
    ]);
  });

  it('staff walk-in and web tickets share one queue and one FIFO order', async () => {
    const q = await setupQueue(t.app, { counters: 1, serviceName: 'Registration' });
    const reception = await createStaff(t.app, q.org, q.fid, 'staff_reception');
    const web1 = await visitorJoin(t.app, q.queueId);
    const walk = await reception.client.post<{
      ticket: { public_code: string; status_token: string };
    }>(`/api/v1/queues/${q.queueId}/walk-ins`, { operation_id: uuidv7() });
    expect(walk.status).toBe(201);
    const web2 = await visitorJoin(t.app, q.queueId);
    expect([
      web1.body.ticket?.public_code,
      walk.body.ticket.public_code,
      web2.body.ticket?.public_code,
    ]).toEqual(['R001', 'R002', 'R003']);
    const view = await reception.client.get<{
      queue: { tickets: { public_code: string; channel: string; position: number }[] };
    }>(`/api/v1/queues/${q.queueId}`);
    expect(view.body.queue.tickets.map((x) => [x.public_code, x.channel, x.position])).toEqual([
      ['R001', 'web', 0],
      ['R002', 'staff', 1],
      ['R003', 'web', 2],
    ]);
    const counterOp = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const first = await queueCommand(counterOp.client, q.queueId, {
      action: 'ticket.call_next',
      counter_id: q.counterIds[0],
    });
    expect(first.body.outcome?.public_code).toBe('R001');
    // Walk-in status link works too
    expect(
      (await ticketStatus(t.app, 'R002', walk.body.ticket.status_token)).body.status?.position,
    ).toBe(0);
  });
});

describe('ticket lifecycle rules', () => {
  let q: QueueFixture;
  beforeAll(async () => {
    q = await setupQueue(t.app, { counters: 2, serviceName: 'Lifecycle' });
  });

  async function calledTicket(
    counter: string,
  ): Promise<{ id: string; code: string; token: string }> {
    const j = await visitorJoin(t.app, q.queueId);
    const c = await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.call_next',
      counter_id: counter,
    });
    expect(c.body.outcome?.disposition).toBe('committed');
    return {
      id: c.body.outcome!.ticket_id as string,
      code: j.body.ticket!.public_code,
      token: j.body.ticket!.status_token,
    };
  }

  it('rejects illegal transitions with a recorded, replayable disposition', async () => {
    const j = await visitorJoin(t.app, q.queueId);
    const view = await q.org.admin.get<{
      queue: { tickets: { id: string; public_code: string }[] };
    }>(`/api/v1/queues/${q.queueId}`);
    const id = view.body.queue.tickets.find(
      (x) => x.public_code === j.body.ticket?.public_code,
    )!.id;
    const opId = uuidv7();
    const bad = await q.org.admin.post<{ outcome: { disposition: string; reason_code: string } }>(
      `/api/v1/queues/${q.queueId}/commands`,
      { operation_id: opId, action: 'ticket.complete', ticket_id: id },
    );
    expect(bad.status).toBe(409);
    expect(bad.headers['content-type']).toContain('application/problem+json');
    expect(bad.body.outcome).toMatchObject({
      disposition: 'rejected',
      reason_code: 'invalid_state',
    });
    // Replay returns the same stored rejection, and nothing changed
    const again = await q.org.admin.post<{ outcome: { reason_code: string } }>(
      `/api/v1/queues/${q.queueId}/commands`,
      {
        operation_id: opId,
        action: 'ticket.complete',
        ticket_id: id,
      },
    );
    expect(again.status).toBe(409);
    expect(again.body.outcome.reason_code).toBe('invalid_state');
    const [row] = await t.db<{ state: string }[]>`SELECT state FROM tickets WHERE id = ${id}`;
    expect(row?.state).toBe('waiting');
    await queueCommand(q.org.admin, q.queueId, { action: 'ticket.cancel', ticket_id: id });
  });

  it('pause → resume returns to waiting; called → recall (supervisor) frees the counter', async () => {
    const tk = await calledTicket(q.counterIds[0] as string);
    expect(
      (await queueCommand(q.org.admin, q.queueId, { action: 'ticket.resume', ticket_id: tk.id }))
        .status,
    ).toBe(200);
    const [r] = await t.db<
      { state: string; current_counter_id: string | null }[]
    >`SELECT state, current_counter_id FROM tickets WHERE id = ${tk.id}`;
    expect(r).toEqual({ state: 'waiting', current_counter_id: null });
    expect(
      (await queueCommand(q.org.admin, q.queueId, { action: 'ticket.pause', ticket_id: tk.id }))
        .status,
    ).toBe(200);
    expect((await ticketStatus(t.app, tk.code, tk.token)).body.status?.state).toBe('paused');
    expect(
      (await queueCommand(q.org.admin, q.queueId, { action: 'ticket.resume', ticket_id: tk.id }))
        .status,
    ).toBe(200);
    await queueCommand(q.org.admin, q.queueId, { action: 'ticket.cancel', ticket_id: tk.id });
  });

  it('missed tickets can return within the grace window, not after it', async () => {
    const a = await calledTicket(q.counterIds[0] as string);
    expect(
      (await queueCommand(q.org.admin, q.queueId, { action: 'ticket.miss', ticket_id: a.id }))
        .status,
    ).toBe(200);
    expect((await ticketStatus(t.app, a.code, a.token)).body.status?.state).toBe('missed');
    expect(
      (await queueCommand(q.org.admin, q.queueId, { action: 'ticket.resume', ticket_id: a.id }))
        .status,
    ).toBe(200);

    const b = await calledTicket(q.counterIds[0] as string);
    await queueCommand(q.org.admin, q.queueId, { action: 'ticket.miss', ticket_id: b.id });
    await t.db`UPDATE tickets SET missed_at = NOW() - INTERVAL '1 hour' WHERE id = ${b.id}`; // grace is 300s
    const late = await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.resume',
      ticket_id: b.id,
    });
    expect(late.status).toBe(409);
    expect(late.body.outcome?.reason_code).toBe('grace_window_expired');
    expect(
      (await queueCommand(q.org.admin, q.queueId, { action: 'ticket.cancel', ticket_id: b.id }))
        .status,
    ).toBe(200);
    await queueCommand(q.org.admin, q.queueId, { action: 'ticket.cancel', ticket_id: a.id });
  });

  it('a counter can hold only one called/serving ticket; inactive or unassigned counters cannot call', async () => {
    const tk = await calledTicket(q.counterIds[0] as string);
    await visitorJoin(t.app, q.queueId);
    const busy = await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.call_next',
      counter_id: q.counterIds[0],
    });
    expect(busy.body.outcome?.reason_code).toBe('counter_busy');

    await q.org.admin.patch(`/api/v1/facilities/${q.fid}/counters/${q.counterIds[1]}`, {
      active: false,
    });
    const inactive = await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.call_next',
      counter_id: q.counterIds[1],
    });
    expect(inactive.body.outcome?.reason_code).toBe('counter_inactive');
    await q.org.admin.patch(`/api/v1/facilities/${q.fid}/counters/${q.counterIds[1]}`, {
      active: true,
    });

    const other = await q.org.admin.post<{ counter: { id: string } }>(
      `/api/v1/facilities/${q.fid}/counters`,
      { name: `Unassigned ${Date.now()}` },
    );
    const notCapable = await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.call_next',
      counter_id: other.body.counter.id,
    });
    expect(notCapable.body.outcome?.reason_code).toBe('counter_not_capable');
    await queueCommand(q.org.admin, q.queueId, { action: 'ticket.cancel', ticket_id: tk.id });
  });

  it('the event log of a busy session still verifies and replays', async () => {
    await expectLogMatchesTables(q.queueId);
  });
});

describe('queue session management', () => {
  it('opens idempotently, assigns a facility-unique prefix, pauses, refuses to close with active tickets', async () => {
    const q = await setupQueue(t.app, { counters: 1, serviceName: 'Pharmacy' });
    // Re-opening today's session returns the same queue (200), no duplicate session or event
    const again = await q.org.admin.post<{ queue: { id: string } }>(
      `/api/v1/facilities/${q.fid}/queues`,
      { service_id: q.serviceId },
    );
    expect(again.status).toBe(200);
    expect(again.body.queue.id).toBe(q.queueId);
    expect(
      await t.db`SELECT 1 FROM queue_events WHERE queue_session_id = ${q.queueId}`,
    ).toHaveLength(1);

    // Second service with the same initial gets a different prefix
    const svc2 = await q.org.admin.post<{ service: { id: string } }>(
      `/api/v1/facilities/${q.fid}/services`,
      { name: 'Physio' },
    );
    await q.org.admin.post(`/api/v1/facilities/${q.fid}/queues`, {
      service_id: svc2.body.service.id,
    });
    const prefixes = await t.db<
      { ticket_prefix: string }[]
    >`SELECT ticket_prefix FROM services WHERE facility_id = ${q.fid} ORDER BY created_at`;
    expect(prefixes.map((p) => p.ticket_prefix)).toEqual(['P', 'A']);

    const j = await visitorJoin(t.app, q.queueId);
    expect((await queueCommand(q.org.admin, q.queueId, { action: 'queue.pause' })).status).toBe(
      200,
    );
    // Paused: no joins, no calls
    expect((await visitorJoin(t.app, q.queueId)).status).toBe(409);
    const call = await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.call_next',
      counter_id: q.counterIds[0],
    });
    expect(call.body.outcome?.reason_code).toBe('queue_not_open');
    // Visitor sees the paused state honestly
    const st = await ticketStatus(t.app, j.body.ticket!.public_code, j.body.ticket!.status_token);
    expect(String(st.body.status?.['status_message'])).toMatch(/paused/i);
    expect(JSON.stringify(st.body.status?.['estimate'])).toMatch(/paused/i);

    const close = await queueCommand(q.org.admin, q.queueId, { action: 'queue.close' });
    expect(close.body.outcome?.reason_code).toBe('queue_has_active_tickets');

    await queueCommand(q.org.admin, q.queueId, { action: 'queue.open' });
    const c = await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.call_next',
      counter_id: q.counterIds[0],
    });
    await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.serve',
      ticket_id: c.body.outcome!.ticket_id,
    });
    await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.complete',
      ticket_id: c.body.outcome!.ticket_id,
    });
    expect((await queueCommand(q.org.admin, q.queueId, { action: 'queue.close' })).status).toBe(
      200,
    );
    expect((await visitorJoin(t.app, q.queueId)).body.title).toBe('Conflict');
    // Reopen the same day
    expect((await queueCommand(q.org.admin, q.queueId, { action: 'queue.open' })).status).toBe(200);
    expect((await visitorJoin(t.app, q.queueId)).status).toBe(201);
    await expectLogMatchesTables(q.queueId);
  });

  it('cannot open a queue for an inactive service', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const svc = await q.org.admin.post<{ service: { id: string } }>(
      `/api/v1/facilities/${q.fid}/services`,
      { name: 'Dormant' },
    );
    await q.org.admin.patch(`/api/v1/facilities/${q.fid}/services/${svc.body.service.id}`, {
      status: 'inactive',
    });
    expect(
      (
        await q.org.admin.post(`/api/v1/facilities/${q.fid}/queues`, {
          service_id: svc.body.service.id,
        })
      ).status,
    ).toBe(409);
  });
});

describe('transfers', () => {
  it('moves a ticket to another open service, preserving original join time and the visitor link', async () => {
    const src = await setupQueue(t.app, { counters: 1, serviceName: 'Triage Desk' });
    const dst = await setupQueue(t.app, {
      counters: 1,
      serviceName: 'Lab',
      org: src.org,
      fid: src.fid,
      facilitySlug: src.facilitySlug,
    });
    const j = await visitorJoin(t.app, src.queueId);
    const call = await queueCommand(src.org.admin, src.queueId, {
      action: 'ticket.call_next',
      counter_id: src.counterIds[0],
    });
    const sourceId = call.body.outcome!.ticket_id as string;
    await queueCommand(src.org.admin, src.queueId, { action: 'ticket.serve', ticket_id: sourceId });

    const missingReason = await queueCommand(src.org.admin, src.queueId, {
      action: 'ticket.transfer',
      ticket_id: sourceId,
      destination_service_id: dst.serviceId,
    });
    expect(missingReason.status).toBe(400);

    const tr = await queueCommand(src.org.admin, src.queueId, {
      action: 'ticket.transfer',
      ticket_id: sourceId,
      destination_service_id: dst.serviceId,
      reason_code: 'needs_other_service',
    });
    expect(tr.status).toBe(200);
    expect(tr.body.outcome?.public_code).toBe('L001');

    const rows = await t.db<
      {
        id: string;
        state: string;
        joined_at: Date;
        transferred_from_ticket_id: string | null;
        created_channel: string;
      }[]
    >`
      SELECT id, state, joined_at, transferred_from_ticket_id, created_channel FROM tickets
       WHERE id IN (${sourceId}, ${tr.body.outcome!.ticket_id as string})`;
    const source = rows.find((r) => r.id === sourceId)!;
    const dest = rows.find((r) => r.id !== sourceId)!;
    expect(source.state).toBe('transferred');
    expect(dest).toMatchObject({
      state: 'waiting',
      transferred_from_ticket_id: sourceId,
      created_channel: 'transfer',
    });
    expect(dest.joined_at.toISOString()).toBe(source.joined_at.toISOString());

    // The visitor's original link follows the transfer
    const st = await ticketStatus(t.app, 'T001', j.body.ticket!.status_token);
    expect(st.body.status).toMatchObject({
      public_code: 'L001',
      service_name: 'Lab',
      state: 'waiting',
      transferred_from_code: 'T001',
    });
    expect((await ticketStatus(t.app, 'L001', j.body.ticket!.status_token)).status).toBe(200);
    // Both chains stay valid and replayable; the source event links to the destination
    await expectLogMatchesTables(src.queueId);
    await expectLogMatchesTables(dst.queueId);
    const ev = (await events(src.queueId)).at(-1)!;
    expect(ev.payload).toMatchObject({
      destination_code: 'L001',
      reason_code: 'needs_other_service',
    });
    // A ticket cannot be transferred twice
    const twice = await queueCommand(src.org.admin, src.queueId, {
      action: 'ticket.transfer',
      ticket_id: sourceId,
      destination_service_id: dst.serviceId,
      reason_code: 'wrong_service',
    });
    expect(twice.body.outcome?.reason_code).toBe('invalid_state');
  });

  it('refuses transfers to a queue that is not open, or to the same service', async () => {
    const src = await setupQueue(t.app, { counters: 1, serviceName: 'Front Desk' });
    const svc = await src.org.admin.post<{ service: { id: string } }>(
      `/api/v1/facilities/${src.fid}/services`,
      { name: 'Not Opened' },
    );
    await visitorJoin(t.app, src.queueId);
    const view = await src.org.admin.get<{ queue: { tickets: { id: string }[] } }>(
      `/api/v1/queues/${src.queueId}`,
    );
    const id = view.body.queue.tickets[0]!.id;
    const notOpen = await queueCommand(src.org.admin, src.queueId, {
      action: 'ticket.transfer',
      ticket_id: id,
      destination_service_id: svc.body.service.id,
      reason_code: 'wrong_service',
    });
    expect(notOpen.body.outcome?.reason_code).toBe('destination_not_open');
    const same = await queueCommand(src.org.admin, src.queueId, {
      action: 'ticket.transfer',
      ticket_id: id,
      destination_service_id: src.serviceId,
      reason_code: 'wrong_service',
    });
    expect(same.body.outcome?.reason_code).toBe('same_service');
  });
});

describe('wait estimates (F6)', () => {
  it('states insufficient data until enough real service history exists, then gives an interval with factors', async () => {
    const q = await setupQueue(t.app, { counters: 1, serviceName: 'Estimates' });
    const counter = q.counterIds[0] as string;
    for (let i = 0; i < 5; i++) {
      await visitorJoin(t.app, q.queueId);
      const c = await queueCommand(q.org.admin, q.queueId, {
        action: 'ticket.call_next',
        counter_id: counter,
      });
      const id = c.body.outcome!.ticket_id as string;
      await queueCommand(q.org.admin, q.queueId, { action: 'ticket.serve', ticket_id: id });
      await queueCommand(q.org.admin, q.queueId, { action: 'ticket.complete', ticket_id: id });
      // Give each completed service a realistic, known duration (4 minutes)
      await t.db`UPDATE tickets SET serving_started_at = completed_at - INTERVAL '240 seconds' WHERE id = ${id}`;
      if (i === 3) {
        const j = await visitorJoin(t.app, q.queueId);
        const st = await ticketStatus(
          t.app,
          j.body.ticket!.public_code,
          j.body.ticket!.status_token,
        );
        const est = st.body.status?.['estimate'] as { confidence: string; factors: string[] };
        expect(est.confidence).toBe('insufficient_data'); // 4 samples < 5
        expect(est.factors.join(' ')).toMatch(/Insufficient service history/);
        await queueCommand(q.org.admin, q.queueId, {
          action: 'ticket.cancel',
          ticket_id: (
            await t.db<
              { id: string }[]
            >`SELECT id FROM tickets WHERE queue_session_id = ${q.queueId} AND state = 'waiting'`
          )[0]!.id,
        });
      }
    }
    await visitorJoin(t.app, q.queueId);
    const j = await visitorJoin(t.app, q.queueId); // one ahead
    const st = await ticketStatus(t.app, j.body.ticket!.public_code, j.body.ticket!.status_token);
    const est = st.body.status?.['estimate'] as {
      confidence: string;
      low_seconds: number;
      high_seconds: number;
      factors: string[];
      sample_size: number;
    };
    expect(est.sample_size).toBe(5);
    expect(est.confidence).toBe('low');
    // 1 ahead, 1 counter, median 240s: low = 240*0.7, high = 2*240*1.5
    expect(est).toMatchObject({ low_seconds: 168, high_seconds: 720 });
    expect(est.high_seconds).toBeGreaterThan(est.low_seconds);
    expect(est.factors.join(' | ')).toMatch(
      /1 ticket ahead.*1 counter active.*5 samples.*Operating hours are not configured.*not an appointment/,
    );
  });

  it('with no active counter the estimate says so instead of inventing a number', async () => {
    const q = await setupQueue(t.app, { counters: 1, serviceName: 'Nobody Home' });
    await q.org.admin.patch(`/api/v1/facilities/${q.fid}/counters/${q.counterIds[0]}`, {
      active: false,
    });
    const j = await visitorJoin(t.app, q.queueId);
    const est = (await ticketStatus(t.app, j.body.ticket!.public_code, j.body.ticket!.status_token))
      .body.status?.['estimate'] as {
      confidence: string;
      low_seconds: number;
      high_seconds: number;
      factors: string[];
    };
    expect(est.confidence).toBe('insufficient_data');
    expect(est.factors.join(' ')).toMatch(/No active counters/);
  });
});

describe('public catalog and display board (data minimization)', () => {
  it('catalog lists open queues; board shows only codes and counter names', async () => {
    const q = await setupQueue(t.app, { counters: 1, serviceName: 'Board Service' });
    const j = await visitorJoin(t.app, q.queueId);
    await visitorJoin(t.app, q.queueId);
    await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.call_next',
      counter_id: q.counterIds[0],
    });

    const anon = new TestClient(t.app);
    const cat = await anon.get<{
      facility: {
        queues: { queue_id: string; waiting_count: number; accepting_visitors: boolean }[];
      };
    }>(`/api/v1/public/facilities/${q.org.slug}/${q.facilitySlug}`);
    expect(cat.status).toBe(200);
    expect(cat.body.facility.queues).toHaveLength(1);
    expect(cat.body.facility.queues[0]).toMatchObject({
      queue_id: q.queueId,
      waiting_count: 1,
      accepting_visitors: true,
    });

    const board = await anon.get<{
      board: { services: { now_calling: { public_code: string }[]; next_codes: string[] }[] };
    }>(`/api/v1/public/facilities/${q.org.slug}/${q.facilitySlug}/board`);
    expect(board.status).toBe(200);
    expect(board.body.board.services[0]?.now_calling[0]?.public_code).toBe(
      j.body.ticket?.public_code,
    );
    expect(board.body.board.services[0]?.next_codes).toEqual(['B002']);
    const raw = JSON.stringify(board.body);
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); // no UUIDs at all
    expect(raw).not.toMatch(/token|email|admin/i);
    expect(Object.keys(board.body.board.services[0]?.now_calling[0] ?? {}).sort()).toEqual([
      'counter_name',
      'public_code',
      'state',
    ]);
  });

  it('unknown facilities, inactive facilities and malformed slugs all return the same 404', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const anon = new TestClient(t.app);
    const a = await anon.get(`/api/v1/public/facilities/${q.org.slug}/no-such-facility`);
    const b = await anon.get(`/api/v1/public/facilities/NOT_A_SLUG/x`);
    await t.db`UPDATE facilities SET status = 'suspended' WHERE id = ${q.fid}`;
    const c = await anon.get(`/api/v1/public/facilities/${q.org.slug}/${q.facilitySlug}/board`);
    for (const r of [a, b, c]) expect(r.status).toBe(404);
    const strip = (x: Record<string, unknown>): unknown => ({ ...x, instance: undefined });
    expect(strip(a.body)).toEqual(strip(c.body));
  });
});

describe('append-only audit log', () => {
  it('queue_events cannot be updated or deleted, and tampering is detected by verification', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await visitorJoin(t.app, q.queueId);
    await expect(
      t.db`UPDATE queue_events SET payload = '{}' WHERE queue_session_id = ${q.queueId}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      t.db`DELETE FROM queue_events WHERE queue_session_id = ${q.queueId}`,
    ).rejects.toThrow(/append-only/);
    const log = await events(q.queueId);
    expect(verifyChain(log).valid).toBe(true);
    const tampered = log.map((e, i) =>
      i === 1 ? { ...e, payload: { ...e.payload, public_code: 'Z999' } } : e,
    );
    expect(verifyChain(tampered)).toMatchObject({
      valid: false,
      broken_at_sequence: 2,
      reason: 'event_hash mismatch',
    });
    // Event payloads carry no personal data: only ids, codes, states and policy references
    const keys = new Set(log.flatMap((e) => Object.keys(e.payload)));
    for (const k of keys) {
      expect([
        'ticket_id',
        'public_code',
        'issued_sequence',
        'priority_class',
        'channel',
        'policy_version',
        'from_state',
        'to_state',
        'genesis',
        'wait_since', // M4: the ticket's place-in-line timestamp (not personal data)
      ]).toContain(k);
    }
  });
});
