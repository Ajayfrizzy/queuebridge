import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_ORIGIN,
  createStaff,
  createTestApp,
  setupQueue,
  visitorJoin,
  type QueueFixture,
  type TestApp,
  type TestClient,
} from './testing/harness.js';

/**
 * Recovery activity audit view (design §15.9a; ADR-015 amendment 1; manual check 12) on real
 * PostgreSQL. `GET /queues/:id/recovery/audit` reads the existing `ticket_recovery.*`
 * admin_events; recovery still writes no queue events. Nothing is mocked.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

interface Entry {
  at: string;
  ticket_code: string;
  kind: string;
  performed_by: { kind: string; name?: string; account_status?: string };
  reason_code: string | null;
  assurance: string | null;
  method: string | null;
  revoked_devices: number | null;
}
interface Page {
  entries: Entry[];
  next_after: string | null;
}

const audit = (
  c: TestClient,
  q: QueueFixture,
  qs = '',
): Promise<{ status: number; body: Page & Record<string, unknown> }> =>
  c.get<Page & Record<string, unknown>>(`/api/v1/queues/${q.queueId}/recovery/audit${qs}`);

async function join(q: QueueFixture): Promise<{ code: string; ticketId: string; key: string }> {
  const j = await visitorJoin(t.app, q.queueId);
  const tk = j.body.ticket;
  if (!tk?.recovery_key) throw new Error('join failed');
  const [row] = await t.db<{ id: string }[]>`
    SELECT id FROM tickets WHERE queue_session_id = ${q.queueId} AND public_code = ${tk.public_code}`;
  return { code: tk.public_code, ticketId: row?.id ?? '', key: tk.recovery_key };
}

async function redeem(grant: string): Promise<number> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/tickets/recover',
    remoteAddress: `10.${randomInt(1, 255)}.${randomInt(0, 255)}.${randomInt(1, 255)}`,
    headers: { origin: TEST_ORIGIN, 'x-qb-csrf': '1' },
    payload: { grant },
  });
  return res.statusCode;
}

/** The check 9 scenario: counter requests, a different supervisor approves, the visitor redeems. */
async function staffRecovery(): Promise<{
  q: QueueFixture;
  code: string;
  ticketId: string;
  counter: Awaited<ReturnType<typeof createStaff>>;
  sup: Awaited<ReturnType<typeof createStaff>>;
  auditor: Awaited<ReturnType<typeof createStaff>>;
  secrets: string[];
}> {
  const q = await setupQueue(t.app, { counters: 1 });
  const v = await join(q);
  const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
  const sup = await createStaff(t.app, q.org, q.fid, 'supervisor');
  const auditor = await createStaff(t.app, q.org, q.fid, 'auditor');
  const base = `/api/v1/queues/${q.queueId}/tickets/${v.ticketId}/recovery`;
  // the counter first cannot verify the visitor (restricted assistance), then can
  const restricted = await counter.client.post(`${base}/assist`, {
    reason_code: 'cleared_browser',
    account_matches: false,
    asked_before_revealing: true,
  });
  expect(restricted.status).toBe(200);
  const a = await counter.client.post<{ grant: string; request_id: string }>(`${base}/assist`, {
    reason_code: 'lost_device',
    account_matches: true,
    asked_before_revealing: true,
  });
  expect(a.status).toBe(200);
  expect((await sup.client.post(`${base}/approve`, { request_id: a.body.request_id })).status).toBe(
    200,
  );
  expect(await redeem(a.body.grant)).toBe(200);
  // a second redemption fails and records nothing
  expect(await redeem(a.body.grant)).toBe(404);
  return {
    q,
    code: v.code,
    ticketId: v.ticketId,
    counter,
    sup,
    auditor,
    secrets: [a.body.grant, a.body.request_id, v.key],
  };
}

describe('recovery activity audit view (design §15.9a)', () => {
  it('names the requester and the approver correctly, never mixed up, with reasons, and shows the redemption as the visitor device', async () => {
    const r = await staffRecovery();
    const res = await audit(r.sup.client, r.q);
    expect(res.status).toBe(200);
    const kinds = res.body.entries.map((e) => e.kind);
    expect(kinds).toEqual(['restricted_assistance', 'request', 'approval', 'recovered']);
    const [restricted, request, approval, recovered] = res.body.entries;
    for (const e of res.body.entries) expect(e.ticket_code).toBe(r.code);
    // requester = the counter account; approver = the supervisor; never swapped
    expect(request?.performed_by).toEqual({
      kind: 'staff',
      name: 'Staff staff_counter',
      account_status: 'active',
    });
    expect(approval?.performed_by).toEqual({
      kind: 'staff',
      name: 'Staff supervisor',
      account_status: 'active',
    });
    expect(restricted?.performed_by).toMatchObject({ kind: 'staff', name: 'Staff staff_counter' });
    // reasons and assurance as recorded
    expect(restricted?.reason_code).toBe('cleared_browser');
    expect(request?.reason_code).toBe('lost_device');
    expect(request?.assurance).toBe('basic');
    expect(approval?.reason_code).toBe('lost_device');
    // the redemption is the visitor's device, not the supervisor, with its method
    expect(recovered?.performed_by).toEqual({ kind: 'visitor_device' });
    expect(recovered?.method).toBe('staff_grant');
    // chronological order
    const times = res.body.entries.map((e) => Date.parse(e.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(res.body.next_after).toBeNull();
  });

  it('supervisor and auditor see the same history; the auditor cannot change anything', async () => {
    const r = await staffRecovery();
    const bySup = await audit(r.sup.client, r.q);
    const byAuditor = await audit(r.auditor.client, r.q);
    expect(byAuditor.status).toBe(200);
    expect(byAuditor.body).toEqual(bySup.body);
    // read-only: no write route exists, and the auditor still cannot act on recovery
    const base = `/api/v1/queues/${r.q.queueId}`;
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await t.app.inject({
        method,
        url: `${base}/recovery/audit`,
        headers: { origin: TEST_ORIGIN, 'x-qb-csrf': '1' },
      });
      expect([404, 405]).toContain(res.statusCode);
    }
    expect(
      (
        await r.auditor.client.post(`${base}/tickets/${r.ticketId}/recovery/assist`, {
          reason_code: 'other',
          account_matches: true,
          asked_before_revealing: true,
        })
      ).status,
    ).toBe(403);
    // counter staff (no AUDIT_VIEW) are refused
    expect((await audit(r.counter.client, r.q)).status).toBe(403);
  });

  it('another organization, another facility and another queue see nothing', async () => {
    const r = await staffRecovery();
    // another organization's admin: 404, the queue does not exist for them
    const foreign = await setupQueue(t.app, { counters: 1 });
    expect((await audit(foreign.org.admin, r.q)).status).toBe(404);
    // a supervisor of ANOTHER facility in the same organization: refused, nothing returned
    const otherFac = await setupQueue(t.app, { counters: 1, org: r.q.org });
    const supElsewhere = await createStaff(t.app, r.q.org, otherFac.fid, 'supervisor');
    const denied = await audit(supElsewhere.client, r.q);
    expect([403, 404]).toContain(denied.status);
    expect(denied.body.entries).toBeUndefined();
    // another queue of the same facility lists none of this queue's recovery events
    const sameFac = await setupQueue(t.app, {
      counters: 1,
      org: r.q.org,
      fid: r.q.fid,
      facilitySlug: r.q.facilitySlug,
    });
    const other = await audit(r.sup.client, sameFac);
    expect(other.status).toBe(200);
    expect(other.body.entries).toEqual([]);
  });

  it('attribution survives renamed and deactivated accounts: same actor, current name, marked', async () => {
    const r = await staffRecovery();
    await t.db`UPDATE staff_users SET display_name = 'Renamed Counter' WHERE id = ${r.counter.userId}`;
    expect(
      (await r.q.org.admin.patch(`/api/v1/staff/${r.sup.userId}`, { status: 'inactive' })).status,
    ).toBe(200);
    const res = await audit(r.auditor.client, r.q);
    const request = res.body.entries.find((e) => e.kind === 'request');
    const approval = res.body.entries.find((e) => e.kind === 'approval');
    expect(request?.performed_by).toEqual({
      kind: 'staff',
      name: 'Renamed Counter',
      account_status: 'active',
    });
    expect(approval?.performed_by).toEqual({
      kind: 'staff',
      name: 'Staff supervisor',
      account_status: 'inactive',
    });
  });

  it('historical records stay intact: reading writes nothing and recovery adds no queue event', async () => {
    const r = await staffRecovery();
    const snapshot = async (): Promise<string> =>
      JSON.stringify([
        await t.db`SELECT id, actor_id, event_type, details, created_at FROM admin_events
                    WHERE organization_id = ${r.q.org.organizationId} ORDER BY created_at, id`,
        await t.db`SELECT sequence, event_hash FROM queue_events
                    WHERE queue_session_id = ${r.q.queueId} ORDER BY sequence`,
      ]);
    const before = await snapshot();
    await audit(r.sup.client, r.q);
    await audit(r.auditor.client, r.q, '?limit=1');
    expect(await snapshot()).toBe(before);
    const recoveryInChain = await t.db`
      SELECT 1 FROM queue_events WHERE queue_session_id = ${r.q.queueId}
         AND event_type LIKE '%recover%'`;
    expect(recoveryInChain).toHaveLength(0);
  });

  it('pages are bounded, chronological and complete, scoped to the queue', async () => {
    const r = await staffRecovery();
    const all = (await audit(r.sup.client, r.q, '?limit=100')).body.entries;
    const seen: Entry[] = [];
    let after: string | null = null;
    for (let i = 0; i < 10; i++) {
      const res = await audit(r.sup.client, r.q, `?limit=1${after ? `&after=${after}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.entries.length).toBeLessThanOrEqual(1);
      seen.push(...res.body.entries);
      after = res.body.next_after;
      if (!after) break;
    }
    expect(seen).toEqual(all);
    expect((await audit(r.sup.client, r.q, '?limit=0')).status).toBe(400);
    expect((await audit(r.sup.client, r.q, '?limit=101')).status).toBe(400);
    expect((await audit(r.sup.client, r.q, '?after=not-a-cursor')).status).toBe(400);
    expect((await audit(r.sup.client, r.q, '?extra=1')).status).toBe(400);
  });

  it('never returns a key, grant, token, hash, link, email or staff id', async () => {
    const r = await staffRecovery();
    const body = JSON.stringify((await audit(r.auditor.client, r.q)).body);
    for (const s of [...r.secrets, r.counter.userId, r.sup.userId, r.counter.email, r.sup.email]) {
      expect(body.includes(s), 'secret or identifier in the response').toBe(false);
    }
    const [g] = await t.db<{ grant_hmac: string }[]>`
      SELECT grant_hmac FROM ticket_recovery_grants WHERE ticket_id = ${r.ticketId} LIMIT 1`;
    if (g) expect(body.includes(g.grant_hmac)).toBe(false);
    expect(body).not.toMatch(/#g=|#k=|status_token|grant_hmac|key_hmac|credential_hash|actor_id/);
    // only the allow-listed fields
    for (const e of JSON.parse(body).entries as Record<string, unknown>[]) {
      expect(Object.keys(e).sort()).toEqual(
        [
          'assurance',
          'at',
          'kind',
          'method',
          'performed_by',
          'reason_code',
          'revoked_devices',
          'ticket_code',
        ].sort(),
      );
    }
  });
});
