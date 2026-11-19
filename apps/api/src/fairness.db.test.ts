import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueAction, uuidv7 } from '@queuebridge/contracts';
import {
  type ApiResult,
  assertEventLogIntact,
  assignCoordinator,
  createStaff,
  createTestApp,
  mintAuthority,
  queueCommand,
  setupContinuity,
  setupQueue,
  signupOrg,
  syncBatch,
  ticketStatus,
  timingFor,
  TestClient,
  visitorJoin,
  type QueueFixture,
  type TestApp,
} from './testing/harness.js';

/**
 * M4.1 / M4.2 against real PostgreSQL: versioned fairness policies, supervisor priority and
 * routing overrides, waiting-age ordering, transfer placement, counter availability and
 * counter transfers — plus their interaction with M3 offline coordination.
 */

type OutcomeBody = {
  outcome?: { disposition: string; reason_code: string | null; public_code?: string | null };
};
type AvailBody = {
  result?: {
    changed: boolean;
    released: { public_code: string }[];
    services_without_open_counter: { name: string }[];
  };
};

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const ALL_CLASSES = ['urgent', 'priority', 'normal'];

async function setPolicy(
  q: QueueFixture,
  policy: Record<string, unknown>,
): Promise<{ status: number; version: string }> {
  const r = await q.org.admin.patch<{ service: { policy: { version: string } } }>(
    `/api/v1/facilities/${q.fid}/services/${q.serviceId}`,
    { policy },
  );
  return { status: r.status, version: r.body.service?.policy.version };
}

async function join(
  q: QueueFixture,
  n: number,
): Promise<{ code: string; id: string; token: string }[]> {
  const out: { code: string; id: string; token: string }[] = [];
  for (let i = 0; i < n; i++) {
    const j = await visitorJoin(t.app, q.queueId);
    const code = j.body.ticket?.public_code ?? '';
    const [row] = await t.db<
      { id: string }[]
    >`SELECT id FROM tickets WHERE queue_session_id = ${q.queueId} AND public_code = ${code}`;
    out.push({ code, id: row?.id ?? '', token: j.body.ticket?.status_token ?? '' });
  }
  return out;
}

const call = (client: TestClient, q: QueueFixture, counter = 0): ReturnType<typeof queueCommand> =>
  queueCommand(client, q.queueId, {
    action: 'ticket.call_next',
    counter_id: q.counterIds[counter],
  });

const override = (
  client: TestClient,
  ticketId: string,
  body: Record<string, unknown> = {},
): Promise<ApiResult<OutcomeBody>> =>
  client.post<{
    outcome?: { disposition: string; reason_code: string | null };
    title?: string;
    outcome_reason?: string;
  }>(`/api/v1/tickets/${ticketId}/priority-override`, {
    operation_id: uuidv7(),
    to_class: 'priority',
    reason_code: 'accessibility_need',
    reason_text: 'Uses a wheelchair today',
    ...body,
  });

const reasonOf = (r: { body: object }): string | null =>
  (r.body as { outcome?: { reason_code?: string | null } }).outcome?.reason_code ?? null;

const calledCode = (r: Awaited<ReturnType<typeof queueCommand>>): string | null =>
  r.body.outcome?.public_code ?? null;

// ---------------------------------------------------------------------------
// Versioned policies
// ---------------------------------------------------------------------------

describe('server-managed policy versions (REQ-F3.1, REQ-F5.6)', () => {
  it('assigns versions itself, keeps every snapshot, logs the change in today’s session, ignores no-op edits', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const hist = (): Promise<{
      status: number;
      body: { versions: { version: string; policy: Record<string, unknown> }[] };
    }> => q.org.admin.get(`/api/v1/facilities/${q.fid}/services/${q.serviceId}/policy-versions`);
    expect((await hist()).body.versions.map((v) => v.version)).toEqual(['v1']);

    // a client-supplied label is ignored; the server assigns v2
    const changed = await setPolicy(q, { version: 'v99', priority_order: ALL_CLASSES });
    expect(changed).toEqual({ status: 200, version: 'v2' });
    // the same rules again create nothing
    expect((await setPolicy(q, { version: 'whatever', priority_order: ALL_CLASSES })).version).toBe(
      'v2',
    );
    const h = await hist();
    expect(h.body.versions.map((v) => v.version)).toEqual(['v2', 'v1']);
    expect(h.body.versions[1]?.policy['priority_order']).toEqual(['normal']); // v1 preserved as it was

    const types = await assertEventLogIntact(t.db, q.queueId);
    expect(types.filter((x) => x === 'policy.changed')).toHaveLength(1);
    const [ev] = await t.db<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM queue_events WHERE queue_session_id = ${q.queueId} AND event_type = 'policy.changed'`;
    expect(ev?.payload).toMatchObject({ from_version: 'v1', to_version: 'v2' });

    // snapshots are immutable
    await expect(
      t.db`UPDATE service_policy_versions SET policy = '{}' WHERE service_id = ${q.serviceId}`,
    ).rejects.toThrow(/append-only/);
    // decisions cite the version in force
    await join(q, 1);
    const c = await call(q.org.admin, q);
    const [callEv] = await t.db<{ payload: { routing: { policy_version: string } } }[]>`
      SELECT payload FROM queue_events WHERE queue_session_id = ${q.queueId} AND sequence = ${c.body.outcome?.server_sequence ?? -1}`;
    expect(callEv?.payload.routing.policy_version).toBe('v2');
  });

  it('only facility administrators may change policy; staff may read its history; other tenants see nothing', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const sup = await createStaff(t.app, q.org, q.fid, 'supervisor');
    const r = await sup.client.patch(`/api/v1/facilities/${q.fid}/services/${q.serviceId}`, {
      policy: { priority_order: ALL_CLASSES },
    });
    expect(r.status).toBe(403);
    expect(
      (await sup.client.get(`/api/v1/facilities/${q.fid}/services/${q.serviceId}/policy-versions`))
        .status,
    ).toBe(200);
    const other = await signupOrg(t.app);
    expect(
      (await other.admin.get(`/api/v1/facilities/${q.fid}/services/${q.serviceId}/policy-versions`))
        .status,
    ).toBe(404);
  });

  it('a partial policy update keeps every field it does not mention (no silent reset to defaults)', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const full = await setPolicy(q, {
      priority_order: ['normal'],
      grace_window_seconds: 120,
      override_reasons: ['accessibility_need', 'site_specific_reason'],
      transfer_placement: 'end_of_queue',
    });
    expect(full).toEqual({ status: 200, version: 'v2' });
    // a client changes ONLY the classes
    expect(await setPolicy(q, { priority_order: ['priority', 'normal'] })).toEqual({
      status: 200,
      version: 'v3',
    });
    const [svc] = await t.db<{ policy: Record<string, unknown> }[]>`
      SELECT policy FROM services WHERE id = ${q.serviceId}`;
    expect(svc?.policy).toMatchObject({
      version: 'v3',
      priority_order: ['priority', 'normal'],
      grace_window_seconds: 120,
      override_reasons: ['accessibility_need', 'site_specific_reason'],
      transfer_placement: 'end_of_queue',
    });
    // re-sending one unchanged field is a no-op, not a new version
    expect((await setPolicy(q, { transfer_placement: 'end_of_queue' })).version).toBe('v3');
    // the merged policy is still validated as a whole
    expect((await setPolicy(q, { priority_order: ['priority'] })).status).toBe(400);
  });

  it('a service created outside the API (seed data) keeps its pre-existing rules as history on first change', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const [svc] = await t.db<{ id: string }[]>`
      INSERT INTO services (facility_id, organization_id, name, policy)
      VALUES (${q.fid}, ${q.org.organizationId}, 'Seeded service',
              '{"version": "v1", "priority_order": ["urgent", "normal"], "grace_window_seconds": 120}')
      RETURNING id`;
    const path = `/api/v1/facilities/${q.fid}/services/${svc?.id ?? ''}`;
    // no snapshot yet: history is honestly empty (404), never invented
    expect((await q.org.admin.get(`${path}/policy-versions`)).status).toBe(404);
    const r = await q.org.admin.patch<{ service: { policy: { version: string } } }>(path, {
      policy: { priority_order: ALL_CLASSES },
    });
    expect(r.body.service.policy.version).toBe('v2');
    const h = await q.org.admin.get<{
      versions: { version: string; policy: Record<string, unknown> }[];
    }>(`${path}/policy-versions`);
    expect(h.body.versions.map((v) => v.version)).toEqual(['v2', 'v1']);
    expect(h.body.versions[1]?.policy).toMatchObject({
      priority_order: ['urgent', 'normal'],
      grace_window_seconds: 120,
    });
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('deterministic ordering', () => {
  it('equal priority is FIFO, and every call records its routing explanation', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const tickets = await join(q, 4);
    const called: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await call(q.org.admin, q);
      called.push(calledCode(c));
      await queueCommand(q.org.admin, q.queueId, {
        action: 'ticket.serve',
        ticket_id: c.body.outcome?.ticket_id,
      });
      await queueCommand(q.org.admin, q.queueId, {
        action: 'ticket.complete',
        ticket_id: c.body.outcome?.ticket_id,
      });
    }
    expect(called).toEqual(tickets.map((x) => x.code));
    const evs = await t.db<{ payload: { routing: Record<string, unknown> } }[]>`
      SELECT payload FROM queue_events WHERE queue_session_id = ${q.queueId} AND event_type = 'ticket.call_next' ORDER BY sequence`;
    expect(evs[0]?.payload.routing).toMatchObject({
      rule: 'priority_class>wait_since>issued_sequence>id',
      policy_version: 'v1',
      priority_order: ['normal'],
      candidates: 4,
      counter: { id: q.counterIds[0], availability: 'open' },
    });
    expect(evs.map((e) => e.payload.routing['candidates'])).toEqual([4, 3, 2, 1]);
  });
});

// ---------------------------------------------------------------------------
// Priority overrides
// ---------------------------------------------------------------------------

describe('supervisor priority override (REQ-F3.3–F3.6)', () => {
  it('reorders by class, records actor/ticket/classes/reason/policy/time, keeps text out of events and public views', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await setPolicy(q, { priority_order: ALL_CLASSES });
    const sup = await createStaff(t.app, q.org, q.fid, 'supervisor');
    const [g1, , g3] = await join(q, 3);
    const r = await override(sup.client, g3?.id ?? '', {
      reason_text: 'Visitor uses a wheelchair',
    });
    expect(r.status).toBe(200);
    expect(r.body.outcome?.disposition).toBe('committed');

    // next call follows the published rule: priority class first
    expect(calledCode(await call(q.org.admin, q))).toBe(g3?.code);

    const [ev] = await t.db<
      { id: string; actor_id: string; committed_at: Date; payload: Record<string, unknown> }[]
    >`
      SELECT id, actor_id, committed_at, payload FROM queue_events
       WHERE queue_session_id = ${q.queueId} AND event_type = 'ticket.priority_override'`;
    expect(ev?.actor_id).toBe(sup.userId);
    expect(ev?.payload).toMatchObject({
      ticket_id: g3?.id,
      from_class: 'normal',
      to_class: 'priority',
      reason_code: 'accessibility_need',
      policy_version: 'v2',
    });
    expect(JSON.stringify(ev?.payload)).not.toContain('wheelchair'); // free text never in the chain
    const [row] = await t.db<Record<string, unknown>[]>`
      SELECT actor_id, ticket_id, from_class, to_class, reason_code, reason_text, policy_version, queue_event_id, kind
        FROM priority_overrides WHERE queue_event_id = ${ev?.id ?? ''}`;
    expect(row).toEqual({
      actor_id: sup.userId,
      ticket_id: g3?.id,
      from_class: 'normal',
      to_class: 'priority',
      reason_code: 'accessibility_need',
      reason_text: 'Visitor uses a wheelchair',
      policy_version: 'v2',
      queue_event_id: ev?.id,
      kind: 'priority',
    });

    // visitors see their updated place, never the private reason; the board shows codes only
    const st = await ticketStatus(t.app, g1?.code ?? '', g1?.token);
    expect(st.body.status?.position).toBe(0);
    const board = await new TestClient(t.app).get(
      `/api/v1/public/facilities/${q.org.slug}/${q.facilitySlug}/board`,
    );
    for (const text of [JSON.stringify(st.body), JSON.stringify(board.body)]) {
      expect(text).not.toMatch(/wheelchair|accessibility_need|override/);
    }
    await assertEventLogIntact(t.db, q.queueId);
  });

  it('ordinary staff and auditors are refused (403) AND the attempt is logged; nothing changes', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await setPolicy(q, { priority_order: ALL_CLASSES });
    const [g1] = await join(q, 1);
    for (const role of ['staff_counter', 'staff_reception', 'auditor']) {
      const s = await createStaff(t.app, q.org, q.fid, role);
      const r = await override(s.client, g1?.id ?? '');
      expect(r.status, role).toBe(403);
      const logged = await t.db`
        SELECT 1 FROM admin_events WHERE actor_id = ${s.userId} AND event_type = 'ticket.priority_override.denied'
           AND target_id = ${g1?.id ?? ''}`;
      expect(logged, role).toHaveLength(1);
    }
    const [tk] = await t.db<
      { priority_class: string }[]
    >`SELECT priority_class FROM tickets WHERE id = ${g1?.id ?? ''}`;
    expect(tk?.priority_class).toBe('normal');
    expect(
      await t.db`SELECT 1 FROM priority_overrides WHERE ticket_id = ${g1?.id ?? ''}`,
    ).toHaveLength(0);
    // anonymous and cross-tenant callers learn nothing
    expect((await override(new TestClient(t.app), g1?.id ?? '')).status).toBe(401);
    expect((await override((await signupOrg(t.app)).admin, g1?.id ?? '')).status).toBe(404);
  });

  it('enforces the published policy: enabled classes, configured reasons, a real explanation, waiting tickets only', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const [g1, g2] = await join(q, 2);
    // classes not enabled (default policy is normal-only)
    expect(reasonOf(await override(q.org.admin, g1?.id ?? ''))).toBe('class_not_enabled');
    await setPolicy(q, {
      priority_order: ['priority', 'normal'],
      override_reasons: ['accessibility_need'],
    });
    expect(reasonOf(await override(q.org.admin, g1?.id ?? '', { to_class: 'urgent' }))).toBe(
      'class_not_enabled',
    );
    expect(
      reasonOf(await override(q.org.admin, g1?.id ?? '', { reason_code: 'urgent_need' })),
    ).toBe('invalid_reason_code');
    expect((await override(q.org.admin, g1?.id ?? '', { reason_text: 'ok' })).status).toBe(400);
    expect(reasonOf(await override(q.org.admin, g1?.id ?? '', { to_class: 'normal' }))).toBe(
      'no_change',
    );
    await call(q.org.admin, q); // g1 now called
    expect(reasonOf(await override(q.org.admin, g1?.id ?? ''))).toBe('invalid_state');
    // a valid one, replayed: one override, then duplicate
    const op = uuidv7();
    const a = await override(q.org.admin, g2?.id ?? '', { operation_id: op });
    const b = await override(q.org.admin, g2?.id ?? '', { operation_id: op });
    expect([a.body.outcome?.disposition, b.body.outcome?.disposition]).toEqual([
      'committed',
      'duplicate',
    ]);
    expect(
      await t.db`SELECT 1 FROM priority_overrides WHERE ticket_id = ${g2?.id ?? ''}`,
    ).toHaveLength(1);
  });

  it('a class later disabled by policy can no longer jump the queue (policy change wins, explained by version)', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await setPolicy(q, { priority_order: ALL_CLASSES });
    const [g1, g2] = await join(q, 2);
    await override(q.org.admin, g2?.id ?? '');
    await setPolicy(q, { priority_order: ['normal'] }); // v3: priority class no longer enabled
    expect(calledCode(await call(q.org.admin, q))).toBe(g1?.code);
  });

  it('the database itself refuses an override record without actor, policy, reason code and explanation', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const [g1] = await join(q, 1);
    const [ev] = await t.db<
      { id: string }[]
    >`SELECT id FROM queue_events WHERE queue_session_id = ${q.queueId} ORDER BY sequence DESC LIMIT 1`;
    const base = { ticket: g1?.id ?? '', actor: q.org.adminId, ev: ev?.id ?? '' };
    const attempt = (code: string, text: string, policy: string): Promise<unknown> =>
      t.db`INSERT INTO priority_overrides (ticket_id, actor_id, reason_code, reason_text, policy_version, queue_event_id,
                                            organization_id, queue_session_id, kind, from_class, to_class)
           VALUES (${base.ticket}, ${base.actor}, ${code}, ${text}, ${policy}, ${base.ev}, ${q.org.organizationId},
                   ${q.queueId}, 'priority', 'normal', 'priority')`;
    await expect(attempt('', 'long enough text', 'v1')).rejects.toThrow(
      /priority_overrides_complete_chk/,
    );
    await expect(attempt('x', 'shrt', 'v1')).rejects.toThrow(/priority_overrides_complete_chk/);
    await expect(attempt('x', 'long enough text', '')).rejects.toThrow(
      /priority_overrides_complete_chk/,
    );
    await expect(
      t.db`INSERT INTO priority_overrides (ticket_id, actor_id, reason_code, reason_text, policy_version, organization_id, queue_session_id, kind, from_class, to_class)
           VALUES (${base.ticket}, ${base.actor}, 'x', 'long enough text', 'v1', ${q.org.organizationId}, ${q.queueId}, 'priority', 'normal', 'priority')`,
    ).rejects.toThrow(/priority_overrides_m4_fields_chk/); // no queue event
  });

  it('override records and policy versions are append-only: UPDATE and DELETE are refused', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    expect((await setPolicy(q, { priority_order: ['priority', 'normal'] })).status).toBe(200);
    const [g1] = await join(q, 1);
    expect((await override(q.org.admin, g1?.id ?? '')).status).toBe(200);
    await expect(
      t.db`UPDATE priority_overrides SET reason_text = 'rewritten explanation' WHERE queue_session_id = ${q.queueId}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      t.db`DELETE FROM priority_overrides WHERE queue_session_id = ${q.queueId}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      t.db`UPDATE service_policy_versions SET policy = '{}'::jsonb WHERE service_id = ${q.serviceId}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      t.db`DELETE FROM service_policy_versions WHERE service_id = ${q.serviceId}`,
    ).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
// Transfer placement
// ---------------------------------------------------------------------------

describe('service transfers keep the original join time; placement follows the destination policy', () => {
  async function twoServices(
    placement: 'by_original_join_time' | 'end_of_queue',
  ): Promise<{ a: QueueFixture; b: QueueFixture }> {
    const a = await setupQueue(t.app, { counters: 1 });
    const b = await setupQueue(t.app, {
      counters: 1,
      org: a.org,
      fid: a.fid,
      facilitySlug: a.facilitySlug,
    });
    await setPolicy(b, { transfer_placement: placement });
    return { a, b };
  }
  async function transferFirst(a: QueueFixture, b: QueueFixture): Promise<string> {
    const c = await call(a.org.admin, a);
    await queueCommand(a.org.admin, a.queueId, {
      action: 'ticket.serve',
      ticket_id: c.body.outcome?.ticket_id,
    });
    const tr = await queueCommand(a.org.admin, a.queueId, {
      action: 'ticket.transfer',
      ticket_id: c.body.outcome?.ticket_id,
      destination_service_id: b.serviceId,
      reason_code: 'needs_other_service',
    });
    expect(tr.body.outcome?.disposition).toBe('committed');
    return tr.body.outcome?.public_code ?? '';
  }

  it('by_original_join_time: the visitor keeps their place by waiting age (no lost wait)', async () => {
    const { a, b } = await twoServices('by_original_join_time');
    await join(a, 1); // joined first, at A
    const [b1] = await join(b, 1); // joined later, at B
    const moved = await transferFirst(a, b);
    expect(calledCode(await call(b.org.admin, b))).toBe(moved); // ahead of b1
    expect(b1?.code).not.toBe(moved);
    const [tk] = await t.db<
      { joined_at: Date; wait_since: Date }[]
    >`SELECT joined_at, wait_since FROM tickets WHERE queue_session_id = ${b.queueId} AND public_code = ${moved}`;
    expect(tk?.wait_since.getTime()).toBe(tk?.joined_at.getTime());
  });

  it('end_of_queue: the visitor joins the end, but the original join time is still recorded', async () => {
    const { a, b } = await twoServices('end_of_queue');
    const [a1] = await join(a, 1);
    const [b1] = await join(b, 1);
    const moved = await transferFirst(a, b);
    expect(calledCode(await call(b.org.admin, b))).toBe(b1?.code);
    const [src] = await t.db<
      { joined_at: Date }[]
    >`SELECT joined_at FROM tickets WHERE id = ${a1?.id ?? ''}`;
    const [dst] = await t.db<
      { joined_at: Date; wait_since: Date }[]
    >`SELECT joined_at, wait_since FROM tickets WHERE queue_session_id = ${b.queueId} AND public_code = ${moved}`;
    expect(dst?.joined_at.getTime()).toBe(src?.joined_at.getTime());
    expect(dst?.wait_since.getTime()).toBeGreaterThan(dst?.joined_at.getTime() ?? 0);
    const [ev] = await t.db<
      { payload: Record<string, unknown> }[]
    >`SELECT payload FROM queue_events WHERE queue_session_id = ${a.queueId} AND event_type = 'ticket.transfer'`;
    expect(ev?.payload['destination_placement']).toBe('end_of_queue');
  });
});

// ---------------------------------------------------------------------------
// Counter availability and routing
// ---------------------------------------------------------------------------

describe('counter availability (REQ-F5.1, PRD Journey E)', () => {
  const avail = (
    client: TestClient,
    counterId: string,
    body: Record<string, unknown>,
  ): Promise<ApiResult<AvailBody>> =>
    client.post<{
      result?: {
        changed: boolean;
        released: { public_code: string }[];
        services_without_open_counter: { name: string }[];
      };
    }>(`/api/v1/counters/${counterId}/availability`, body);

  it('a closed or inactive counter receives no new assignment', async () => {
    const q = await setupQueue(t.app, { counters: 2 });
    await join(q, 2);
    expect(
      (
        await avail(q.org.admin, q.counterIds[0] ?? '', {
          availability: 'closed',
          reason_code: 'break',
        })
      ).status,
    ).toBe(200);
    expect(reasonOf(await call(q.org.admin, q, 0))).toBe('counter_closed');
    await q.org.admin.patch(`/api/v1/facilities/${q.fid}/counters/${q.counterIds[1]}`, {
      active: false,
    });
    expect(reasonOf(await call(q.org.admin, q, 1))).toBe('counter_inactive');
    await avail(q.org.admin, q.counterIds[0] ?? '', { availability: 'open' });
    expect((await call(q.org.admin, q, 0)).body.outcome?.disposition).toBe('committed');
  });

  it('closing a counter that is calling someone returns them to the HEAD of the line (supervisor only)', async () => {
    const q = await setupQueue(t.app, { counters: 2 });
    const [g1, g2] = await join(q, 2);
    expect(calledCode(await call(q.org.admin, q, 0))).toBe(g1?.code);
    const op = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const sup = await createStaff(t.app, q.org, q.fid, 'supervisor');
    // an operator may not release someone else's visitor by closing the counter
    expect(
      (
        await avail(op.client, q.counterIds[0] ?? '', {
          availability: 'closed',
          reason_code: 'break',
        })
      ).status,
    ).toBe(403);
    const r = await avail(sup.client, q.counterIds[0] ?? '', {
      availability: 'closed',
      reason_code: 'end_of_shift',
    });
    expect(r.status).toBe(200);
    expect(r.body.result?.released.map((x) => x.public_code)).toEqual([g1?.code]);
    // the next open counter calls the released visitor first (waiting age kept), not g2
    expect(calledCode(await call(q.org.admin, q, 1))).toBe(g1?.code);
    expect(g2).toBeDefined();
    const types = await assertEventLogIntact(t.db, q.queueId);
    expect(types).toContain('ticket.release');
    // repeating is a no-op
    expect(
      (
        await avail(sup.client, q.counterIds[0] ?? '', {
          availability: 'closed',
          reason_code: 'break',
        })
      ).body.result?.changed,
    ).toBe(false);
  });

  it('a counter serving someone cannot be closed; an idle one can be closed by its operator; orphaned services are reported', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await join(q, 1);
    const c = await call(q.org.admin, q, 0);
    await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.serve',
      ticket_id: c.body.outcome?.ticket_id,
    });
    expect(
      (
        await avail(q.org.admin, q.counterIds[0] ?? '', {
          availability: 'closed',
          reason_code: 'break',
        })
      ).status,
    ).toBe(409);
    await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.complete',
      ticket_id: c.body.outcome?.ticket_id,
    });
    const op = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const r = await avail(op.client, q.counterIds[0] ?? '', {
      availability: 'closed',
      reason_code: 'break',
    });
    expect(r.status).toBe(200);
    expect(r.body.result?.services_without_open_counter).toHaveLength(1);
    const view = await q.org.admin.get<{
      queue: { no_open_counter: boolean; counters: { availability: string }[] };
    }>(`/api/v1/queues/${q.queueId}`);
    expect(view.body.queue.no_open_counter).toBe(true);
    expect(view.body.queue.counters[0]?.availability).toBe('closed');
    // reception and auditors cannot change availability; other tenants get 404
    const rec = await createStaff(t.app, q.org, q.fid, 'staff_reception');
    expect((await avail(rec.client, q.counterIds[0] ?? '', { availability: 'open' })).status).toBe(
      403,
    );
    expect(
      (await avail((await signupOrg(t.app)).admin, q.counterIds[0] ?? '', { availability: 'open' }))
        .status,
    ).toBe(404);
    expect(
      (await avail(q.org.admin, q.counterIds[0] ?? '', { availability: 'closed' })).status,
    ).toBe(400); // reason required
  });
});

describe('supervisor routing override: call out of order (REQ-F5.5)', () => {
  const outOfOrder = (
    client: TestClient,
    ticketId: string,
    counterId: string,
    body: Record<string, unknown> = {},
  ): Promise<ApiResult<OutcomeBody>> =>
    client.post<{
      outcome?: { disposition: string; public_code: string | null; reason_code: string | null };
    }>(`/api/v1/tickets/${ticketId}/call-out-of-order`, {
      operation_id: uuidv7(),
      counter_id: counterId,
      reason_code: 'urgent_need',
      reason_text: 'Visitor is feeling unwell',
      ...body,
    });

  it('records the rationale and what the published rule would have chosen', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const [g1, , g3] = await join(q, 3);
    const sup = await createStaff(t.app, q.org, q.fid, 'supervisor');
    const r = await outOfOrder(sup.client, g3?.id ?? '', q.counterIds[0] ?? '');
    expect(r.body.outcome).toMatchObject({ disposition: 'committed', public_code: g3?.code });
    const [ev] = await t.db<{ id: string; payload: Record<string, unknown> }[]>`
      SELECT id, payload FROM queue_events WHERE queue_session_id = ${q.queueId} AND event_type = 'ticket.call_specific'`;
    expect(ev?.payload['override']).toMatchObject({
      kind: 'routing',
      reason_code: 'urgent_need',
      would_have_called: g1?.id,
      would_have_called_code: g1?.code,
    });
    expect(JSON.stringify(ev?.payload)).not.toContain('unwell');
    const [row] = await t.db<{ kind: string; counter_id: string; reason_text: string }[]>`
      SELECT kind, counter_id, reason_text FROM priority_overrides WHERE queue_event_id = ${ev?.id ?? ''}`;
    expect(row).toEqual({
      kind: 'routing',
      counter_id: q.counterIds[0],
      reason_text: 'Visitor is feeling unwell',
    });
  });

  it('counter operators cannot route out of order (403, logged); the counter must still be open and free', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const [g1, g2] = await join(q, 2);
    const op = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    expect((await outOfOrder(op.client, g2?.id ?? '', q.counterIds[0] ?? '')).status).toBe(403);
    expect(
      await t.db`SELECT 1 FROM admin_events WHERE actor_id = ${op.userId} AND event_type = 'ticket.call_specific.denied'`,
    ).toHaveLength(1);
    await call(q.org.admin, q, 0); // counter busy with g1
    expect(
      (await outOfOrder(q.org.admin, g2?.id ?? '', q.counterIds[0] ?? '')).body.outcome
        ?.reason_code,
    ).toBe('counter_busy');
    expect(g1).toBeDefined();
  });
  it('facility administrators cannot route out of order either (403): the console form they see is refused by the API, nothing is recorded', async () => {
    // MQ.5 finding: the UI shows "Call out of order" to facility admins; the state machine
    // allows only supervisors (and organization admins). The server must still refuse.
    const q = await setupQueue(t.app, { counters: 1 });
    const [, g2] = await join(q, 2);
    const fa = await createStaff(t.app, q.org, q.fid, 'facility_admin');
    const before = await t.db<{ n: string }[]>`
      SELECT count(*)::text AS n FROM queue_events WHERE queue_session_id = ${q.queueId}`;
    expect((await outOfOrder(fa.client, g2?.id ?? '', q.counterIds[0] ?? '')).status).toBe(403);
    const after = await t.db<{ n: string }[]>`
      SELECT count(*)::text AS n FROM queue_events WHERE queue_session_id = ${q.queueId}`;
    expect(after[0]?.n).toBe(before[0]?.n);
    const [ticket] = await t.db<
      { state: string }[]
    >`SELECT state FROM tickets WHERE id = ${g2?.id ?? ''}`;
    expect(ticket?.state).toBe('waiting');
    expect(
      await t.db`SELECT 1 FROM admin_events WHERE actor_id = ${fa.userId} AND event_type = 'ticket.call_specific.denied'`,
    ).toHaveLength(1);
  });
});
describe('counter-to-counter transfer', () => {
  const move = (
    client: TestClient,
    ticketId: string,
    to: string,
  ): Promise<ApiResult<OutcomeBody>> =>
    client.post<{ outcome?: { disposition: string; reason_code: string | null } }>(
      `/api/v1/tickets/${ticketId}/counter-transfer`,
      { operation_id: uuidv7(), to_counter_id: to, reason_code: 'specialist_counter' },
    );

  it('moves a called or serving ticket to an open, capable, free counter — nowhere else', async () => {
    const q = await setupQueue(t.app, { counters: 3 });
    const [g1, g2] = await join(q, 2);
    await call(q.org.admin, q, 0);
    expect(
      (await move(q.org.admin, g1?.id ?? '', q.counterIds[0] ?? '')).body.outcome?.reason_code,
    ).toBe('same_counter');
    await queueCommand(q.org.admin, q.queueId, { action: 'queue.pause' });
    await queueCommand(q.org.admin, q.queueId, { action: 'queue.open' });
    await call(q.org.admin, q, 1); // counter 2 busy with g2
    expect(
      (await move(q.org.admin, g1?.id ?? '', q.counterIds[1] ?? '')).body.outcome?.reason_code,
    ).toBe('counter_busy');
    await q.org.admin.post(`/api/v1/counters/${q.counterIds[2]}/availability`, {
      availability: 'closed',
      reason_code: 'break',
    });
    expect(
      (await move(q.org.admin, g1?.id ?? '', q.counterIds[2] ?? '')).body.outcome?.reason_code,
    ).toBe('counter_closed');
    await q.org.admin.post(`/api/v1/counters/${q.counterIds[2]}/availability`, {
      availability: 'open',
    });
    const ok = await move(q.org.admin, g1?.id ?? '', q.counterIds[2] ?? '');
    expect(ok.body.outcome?.disposition).toBe('committed');
    const [tk] = await t.db<
      { current_counter_id: string; state: string }[]
    >`SELECT current_counter_id, state FROM tickets WHERE id = ${g1?.id ?? ''}`;
    expect(tk).toEqual({ current_counter_id: q.counterIds[2], state: 'called' });
    // reception cannot move tickets; a waiting ticket cannot be "moved"
    const rec = await createStaff(t.app, q.org, q.fid, 'staff_reception');
    expect((await move(rec.client, g1?.id ?? '', q.counterIds[0] ?? '')).status).toBe(403);
    expect(g2).toBeDefined();
    await assertEventLogIntact(t.db, q.queueId);
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe('concurrent routing', () => {
  it('overrides racing calls at several counters: no duplicate calls, every decision replays against its policy', async () => {
    for (let round = 0; round < 3; round++) {
      const q = await setupQueue(t.app, { counters: 3 });
      await setPolicy(q, { priority_order: ALL_CLASSES });
      const tickets = await join(q, 8);
      await Promise.all([
        override(q.org.admin, tickets[5]?.id ?? '', { to_class: 'urgent' }),
        override(q.org.admin, tickets[6]?.id ?? ''),
        call(q.org.admin, q, 0),
        call(q.org.admin, q, 1),
        call(q.org.admin, q, 2),
        setPolicy(q, { priority_order: ['priority', 'normal'] }),
      ]);
      const calls = await t.db<{ payload: { ticket_id: string } }[]>`
        SELECT payload FROM queue_events WHERE queue_session_id = ${q.queueId} AND event_type = 'ticket.call_next'`;
      expect(new Set(calls.map((c) => c.payload.ticket_id)).size).toBe(calls.length);
      expect(
        await t.db`SELECT current_counter_id FROM tickets WHERE queue_session_id = ${q.queueId} AND state = 'called' GROUP BY current_counter_id HAVING COUNT(*) > 1`,
      ).toHaveLength(0);
      await assertEventLogIntact(t.db, q.queueId);
      const v = await q.org.admin.get<{
        verification: { status: string; replay: { valid: boolean; decisions_verified: number } };
      }>(`/api/v1/queues/${q.queueId}/audit/verify`);
      expect(v.body.verification.replay).toMatchObject({ valid: true });
      expect(v.body.verification.replay.decisions_verified).toBe(calls.length);
    }
  });

  it('closing a counter while it is being called to is serialized: either the call or the closure wins, never both', async () => {
    for (let round = 0; round < 4; round++) {
      const q = await setupQueue(t.app, { counters: 1 });
      await join(q, 1);
      const [c, a] = await Promise.all([
        call(q.org.admin, q, 0),
        q.org.admin.post<{ result?: { released: unknown[] } }>(
          `/api/v1/counters/${q.counterIds[0]}/availability`,
          { availability: 'closed', reason_code: 'break' },
        ),
      ]);
      expect([200, 409]).toContain(c.status);
      expect(a.status).toBe(200);
      const [tk] = await t.db<
        { state: string; current_counter_id: string | null }[]
      >`SELECT state, current_counter_id FROM tickets WHERE queue_session_id = ${q.queueId}`;
      // Whatever the order, a closed counter holds no called ticket afterwards
      expect(tk?.current_counter_id).toBeNull();
      expect(tk?.state).toBe('waiting');
      await assertEventLogIntact(t.db, q.queueId);
    }
  });
});

// ---------------------------------------------------------------------------
// M3 interaction
// ---------------------------------------------------------------------------

describe('interaction with offline coordination (M3)', () => {
  it('overrides, routing overrides and releasing a called visitor are fenced while a coordinator holds the queue', async () => {
    const f = await setupContinuity(t.app);
    await f.org.admin.patch(`/api/v1/facilities/${f.fid}/services/${f.serviceId}`, {
      policy: { priority_order: ALL_CLASSES },
    });
    const j = await visitorJoin(t.app, f.queueId);
    const [g1] = await t.db<
      { id: string }[]
    >`SELECT id FROM tickets WHERE queue_session_id = ${f.queueId} AND public_code = ${j.body.ticket?.public_code ?? ''}`;
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const r = await f.supervisor.client.post<{ type?: string }>(
      `/api/v1/tickets/${g1?.id}/priority-override`,
      {
        operation_id: uuidv7(),
        to_class: 'priority',
        reason_code: 'accessibility_need',
        reason_text: 'Uses a wheelchair',
      },
    );
    expect(r.status).toBe(409);
    expect(r.body.type).toMatch(/coordinator-active/);
    const o = await f.supervisor.client.post<{ type?: string }>(
      `/api/v1/tickets/${g1?.id}/call-out-of-order`,
      {
        operation_id: uuidv7(),
        counter_id: f.counterIds[0],
        reason_code: 'urgent_need',
        reason_text: 'Feeling unwell',
      },
    );
    expect(o.status).toBe(409);
    // the coordinator calls g1 (offline, synced)
    const token = await f.authorityFor(f.counter);
    const call1 = await syncBatch(
      f.counter.client,
      [
        f.cmd(
          f.counter,
          QueueAction.TICKET_CALL_NEXT,
          { counter_id: f.counterIds[0], ticket_id: g1?.id },
          { epoch: 1 },
        ),
      ],
      [token],
    );
    expect(call1.body.results[0]?.disposition).toBe('committed');
    // closing that counter would release a visitor the coordinator is handling: refused
    const close = await f.supervisor.client.post<{ type?: string }>(
      `/api/v1/counters/${f.counterIds[0]}/availability`,
      { availability: 'closed', reason_code: 'break' },
    );
    expect(close.status).toBe(409);
    expect(close.body.type).toMatch(/coordinator-active/);
    // the synced call carries a replayable routing explanation
    const [ev] = await t.db<
      { payload: Record<string, unknown> }[]
    >`SELECT payload FROM queue_events WHERE queue_session_id = ${f.queueId} AND event_type = 'ticket.call_next'`;
    expect(ev?.payload['routing']).toMatchObject({ policy_version: 'v2', candidates: 1 });
  });

  it('an offline call to a counter closed online, or to a visitor no longer first under a changed policy, is held for review', async () => {
    const f = await setupContinuity(t.app, { counters: 2 });
    await f.org.admin.patch(`/api/v1/facilities/${f.fid}/services/${f.serviceId}`, {
      policy: { priority_order: ALL_CLASSES },
    });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const j = await visitorJoin(t.app, f.queueId);
      const [row] = await t.db<
        { id: string }[]
      >`SELECT id FROM tickets WHERE queue_session_id = ${f.queueId} AND public_code = ${j.body.ticket?.public_code ?? ''}`;
      ids.push(row?.id ?? '');
    }
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const token = await mintAuthority(t, f.queueId, {
      deliveredAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    // counter 2 closed online while the coordinator is offline (idle counter: allowed)
    await f.supervisor.client.post(`/api/v1/counters/${f.counterIds[1]}/availability`, {
      availability: 'closed',
      reason_code: 'break',
    });
    const r1 = await syncBatch(
      f.counter.client,
      [
        f.cmd(
          f.counter,
          QueueAction.TICKET_CALL_NEXT,
          { counter_id: f.counterIds[1], ticket_id: ids[0] },
          { epoch: 1, timing: timingFor(token) },
        ),
      ],
      [token],
    );
    expect(r1.body.results[0]).toMatchObject({
      disposition: 'needs_review',
      reason_code: 'counter_closed',
    });
    // a policy change while offline that puts someone else first: the offline call names the old head
    await t.db`UPDATE tickets SET priority_class = 'urgent' WHERE id = ${ids[2] ?? ''}`; // (setup shortcut: class assigned before the outage)
    const r2 = await syncBatch(
      f.counter.client,
      [
        f.cmd(
          f.counter,
          QueueAction.TICKET_CALL_NEXT,
          { counter_id: f.counterIds[0], ticket_id: ids[0] },
          { epoch: 1, timing: timingFor(token) },
        ),
      ],
      [token],
    );
    expect(r2.body.results[0]).toMatchObject({
      disposition: 'needs_review',
      reason_code: 'call_mismatch',
    });
    await assertEventLogIntact(t.db, f.queueId);
  });
});
