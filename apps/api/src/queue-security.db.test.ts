import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomSecret, uuidv7 } from '@queuebridge/contracts';
import {
  createStaff,
  createTestApp,
  queueCommand,
  setupQueue,
  signupOrg,
  ticketStatus,
  TestClient,
  TEST_ORIGIN,
  visitorJoin,
  type QueueFixture,
  type TestApp,
} from './testing/harness.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let t: TestApp;
let q: QueueFixture;
const staff: Record<string, { client: TestClient; userId: string }> = {};

beforeAll(async () => {
  t = await createTestApp();
  q = await setupQueue(t.app, { counters: 2, serviceName: 'Secure Service' });
  for (const role of [
    'staff_reception',
    'staff_counter',
    'supervisor',
    'facility_admin',
    'auditor',
  ]) {
    staff[role] = await createStaff(t.app, q.org, q.fid, role);
  }
});
afterAll(async () => {
  await t.close();
});

const as = (role: string): TestClient =>
  role === 'org_admin' ? q.org.admin : (staff[role]?.client as TestClient);

async function waitingTicket(): Promise<string> {
  await visitorJoin(t.app, q.queueId);
  const [row] = await t.db<{ id: string }[]>`
    SELECT id FROM tickets WHERE queue_session_id = ${q.queueId} AND state = 'waiting' ORDER BY issued_sequence DESC LIMIT 1`;
  return row!.id;
}

async function calledTicketOn(counter: string): Promise<string> {
  await visitorJoin(t.app, q.queueId);
  const c = await queueCommand(q.org.admin, q.queueId, {
    action: 'ticket.call_next',
    counter_id: counter,
  });
  return c.body.outcome!.ticket_id as string;
}

async function clearCounters(): Promise<void> {
  const busy = await t.db<{ id: string }[]>`
    SELECT id FROM tickets WHERE queue_session_id = ${q.queueId} AND state IN ('called', 'serving', 'waiting', 'paused', 'missed')`;
  for (const b of busy)
    await queueCommand(q.org.admin, q.queueId, { action: 'ticket.cancel', ticket_id: b.id });
}

describe('RBAC: queue commands are authorized server-side per role (Group 8)', () => {
  it.each([
    ['staff_reception', 403],
    ['auditor', 403],
    ['facility_admin', 403],
    ['staff_counter', 200],
    ['supervisor', 200],
    ['org_admin', 200],
  ])('call_next as %s → %i', async (role, expected) => {
    await clearCounters();
    await waitingTicket();
    const res = await queueCommand(as(role), q.queueId, {
      action: 'ticket.call_next',
      counter_id: q.counterIds[0],
    });
    expect(res.status).toBe(expected);
    if (expected === 403) {
      expect(
        await t.db`SELECT 1 FROM tickets WHERE queue_session_id = ${q.queueId} AND state = 'called'`,
      ).toHaveLength(0);
    }
  });

  it.each([
    ['staff_reception', 403],
    ['staff_counter', 403],
    ['auditor', 403],
    ['supervisor', 200],
    ['facility_admin', 200],
    ['org_admin', 200],
  ])('queue.pause as %s → %i (session management)', async (role, expected) => {
    const res = await queueCommand(as(role), q.queueId, { action: 'queue.pause' });
    expect(res.status).toBe(expected);
    if (expected === 200) await queueCommand(q.org.admin, q.queueId, { action: 'queue.open' });
  });

  it('recall (called → waiting) is supervisor-only; a counter operator gets 403', async () => {
    await clearCounters();
    const id = await calledTicketOn(q.counterIds[0] as string);
    expect(
      (
        await queueCommand(as('staff_counter'), q.queueId, {
          action: 'ticket.resume',
          ticket_id: id,
        })
      ).status,
    ).toBe(403);
    expect(
      (await queueCommand(as('supervisor'), q.queueId, { action: 'ticket.resume', ticket_id: id }))
        .status,
    ).toBe(200);
  });

  it('reception can register walk-ins and cancel waiting tickets but cannot serve', async () => {
    await clearCounters();
    const walk = await as('staff_reception').post(`/api/v1/queues/${q.queueId}/walk-ins`, {
      operation_id: uuidv7(),
    });
    expect(walk.status).toBe(201);
    const auditorWalk = await as('auditor').post(`/api/v1/queues/${q.queueId}/walk-ins`, {
      operation_id: uuidv7(),
    });
    expect(auditorWalk.status).toBe(403);
    const id = await calledTicketOn(q.counterIds[0] as string);
    expect(
      (
        await queueCommand(as('staff_reception'), q.queueId, {
          action: 'ticket.serve',
          ticket_id: id,
        })
      ).status,
    ).toBe(403);
    const waiting = await waitingTicket();
    expect(
      (
        await queueCommand(as('staff_reception'), q.queueId, {
          action: 'ticket.cancel',
          ticket_id: waiting,
        })
      ).status,
    ).toBe(200);
  });

  it('auditors can read the queue but nothing else; opening queues needs supervisor or admin', async () => {
    expect((await as('auditor').get(`/api/v1/queues/${q.queueId}`)).status).toBe(200);
    for (const role of ['auditor', 'staff_counter', 'staff_reception']) {
      expect(
        (await as(role).post(`/api/v1/facilities/${q.fid}/queues`, { service_id: q.serviceId }))
          .status,
      ).toBe(403);
    }
    expect(
      (
        await as('supervisor').post(`/api/v1/facilities/${q.fid}/queues`, {
          service_id: q.serviceId,
        })
      ).status,
    ).toBe(200);
  });

  it('role revocation applies to the very next command of a live session', async () => {
    await clearCounters();
    const op = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    await waitingTicket();
    await q.org.admin.del(`/api/v1/facilities/${q.fid}/staff/${op.userId}/roles/staff_counter`);
    const res = await queueCommand(op.client, q.queueId, {
      action: 'ticket.call_next',
      counter_id: q.counterIds[0],
    });
    expect(res.status).toBe(404); // no remaining role at the facility: queue is invisible
  });

  it('unauthenticated callers get 401 for every staff queue route', async () => {
    const anon = new TestClient(t.app);
    expect((await anon.get(`/api/v1/queues/${q.queueId}`)).status).toBe(401);
    expect((await queueCommand(anon, q.queueId, { action: 'queue.pause' })).status).toBe(401);
    expect(
      (await anon.post(`/api/v1/queues/${q.queueId}/walk-ins`, { operation_id: uuidv7() })).status,
    ).toBe(401);
    expect((await anon.get(`/api/v1/facilities/${q.fid}/queues`)).status).toBe(401);
  });
});

describe('tenant isolation (cross-organization and cross-facility)', () => {
  it("organization B cannot see or operate organization A's queue — 404 like a random id", async () => {
    const b = await setupQueue(t.app, { counters: 1 });
    const fake = '018d1a2b-3c4d-7e5f-8a9b-1c2d3e4f5a6b';
    const aTicket = await waitingTicket();
    const probes = [
      (id: string) => b.org.admin.get(`/api/v1/queues/${id}`),
      (id: string) => queueCommand(b.org.admin, id, { action: 'queue.pause' }),
      (id: string) =>
        queueCommand(b.org.admin, id, { action: 'ticket.call_next', counter_id: b.counterIds[0] }),
      (id: string) => b.org.admin.post(`/api/v1/queues/${id}/walk-ins`, { operation_id: uuidv7() }),
      (id: string) => b.org.admin.get(`/api/v1/queues/${id}/stream`),
    ];
    for (const probe of probes) {
      const real = await probe(q.queueId);
      const unknown = await probe(fake);
      expect(real.status).toBe(404);
      expect(unknown.status).toBe(404);
    }
    expect((await b.org.admin.get(`/api/v1/facilities/${q.fid}/queues`)).status).toBe(404);
    expect(
      (await b.org.admin.post(`/api/v1/facilities/${q.fid}/queues`, { service_id: q.serviceId }))
        .status,
    ).toBe(404);
    // A's ticket id smuggled into B's own queue: not found, and A's ticket untouched
    const smuggle = await queueCommand(b.org.admin, b.queueId, {
      action: 'ticket.cancel',
      ticket_id: aTicket,
    });
    expect(smuggle.status).toBe(404);
    const [row] = await t.db<{ state: string }[]>`SELECT state FROM tickets WHERE id = ${aTicket}`;
    expect(row?.state).toBe('waiting');
    // B cannot call with A's counter or open a queue for A's service in its own facility
    const foreignCounter = await queueCommand(b.org.admin, b.queueId, {
      action: 'ticket.call_next',
      counter_id: q.counterIds[0],
    });
    expect(foreignCounter.status).toBe(404);
    expect(
      (await b.org.admin.post(`/api/v1/facilities/${b.fid}/queues`, { service_id: q.serviceId }))
        .status,
    ).toBe(404);
  });

  it('a facility admin of another facility in the same organization gets 404', async () => {
    const other = await setupQueue(t.app, { counters: 1, org: q.org });
    const otherAdmin = await createStaff(t.app, q.org, other.fid, 'supervisor');
    expect((await otherAdmin.client.get(`/api/v1/queues/${q.queueId}`)).status).toBe(404);
    expect(
      (await queueCommand(otherAdmin.client, q.queueId, { action: 'queue.pause' })).status,
    ).toBe(404);
    // Cross-facility transfer target is invisible too
    const id = await waitingTicket();
    const tr = await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.transfer',
      ticket_id: id,
      destination_service_id: other.serviceId,
      reason_code: 'wrong_service',
    });
    expect(tr.status).toBe(404);
  });
});

describe('visitor ticket status is token-protected and minimal', () => {
  it('requires the exact token for that ticket; every failure is the same 404', async () => {
    const a = await visitorJoin(t.app, q.queueId);
    const b = await visitorJoin(t.app, q.queueId);
    const codeA = a.body.ticket!.public_code;
    const ok = await ticketStatus(t.app, codeA, a.body.ticket!.status_token);
    expect(ok.status).toBe(200);
    const failures = [
      await ticketStatus(t.app, codeA, undefined),
      await ticketStatus(t.app, codeA, randomSecret()),
      await ticketStatus(t.app, codeA, b.body.ticket!.status_token), // another visitor's token
      await ticketStatus(t.app, 'zz', a.body.ticket!.status_token),
      await ticketStatus(t.app, codeA, 'short'),
    ];
    const strip = (x: Record<string, unknown>): unknown => ({ ...x, instance: undefined });
    for (const f of failures) {
      expect(f.status).toBe(404);
      expect(strip(f.body)).toEqual(strip(failures[0]!.body));
    }
    // Expired credentials stop working
    await t.db`UPDATE ticket_recovery_credentials SET expires_at = NOW() - INTERVAL '1 second'
                WHERE ticket_id = (SELECT id FROM tickets WHERE queue_session_id = ${q.queueId} AND public_code = ${codeA})`;
    expect((await ticketStatus(t.app, codeA, a.body.ticket!.status_token)).status).toBe(404);
  });

  it('never returns internal ids or personal data, and the token is never stored in clear', async () => {
    const j = await visitorJoin(t.app, q.queueId);
    const st = await ticketStatus(t.app, j.body.ticket!.public_code, j.body.ticket!.status_token);
    const raw = JSON.stringify(st.body);
    expect(raw).not.toMatch(UUID_RE);
    expect(raw).not.toContain(j.body.ticket!.status_token);
    expect(
      await t.db`SELECT 1 FROM ticket_recovery_credentials WHERE credential_hash = ${j.body.ticket!.status_token}`,
    ).toHaveLength(0);
    expect(await t.db`SELECT 1 FROM client_operations WHERE proof_hash = ${j.proof}`).toHaveLength(
      0,
    );
  });
});

describe('join idempotency and lost-ACK recovery', () => {
  it('replaying with the same operation id AND proof returns the same ticket with a rotated token', async () => {
    const first = await visitorJoin(t.app, q.queueId);
    const replay = await visitorJoin(t.app, q.queueId, {
      operationId: first.operationId,
      proof: first.proof,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.ticket).toMatchObject({
      disposition: 'duplicate',
      public_code: first.body.ticket!.public_code,
    });
    expect(replay.body.ticket!.status_token).not.toBe(first.body.ticket!.status_token);
    const code = first.body.ticket!.public_code;
    expect((await ticketStatus(t.app, code, replay.body.ticket!.status_token)).status).toBe(200);
    expect((await ticketStatus(t.app, code, first.body.ticket!.status_token)).status).toBe(404); // rotated
    expect(
      await t.db`SELECT 1 FROM tickets WHERE queue_session_id = ${q.queueId} AND public_code = ${code}`,
    ).toHaveLength(1);
  });

  it('a different proof (or another queue) with a known operation id learns nothing', async () => {
    const first = await visitorJoin(t.app, q.queueId);
    const thief = await visitorJoin(t.app, q.queueId, {
      operationId: first.operationId,
      proof: randomSecret(),
    });
    expect(thief.status).toBe(409);
    expect(JSON.stringify(thief.body)).not.toContain(first.body.ticket!.public_code);
    const other = await setupQueue(t.app, {
      counters: 1,
      org: q.org,
      fid: q.fid,
      facilitySlug: q.facilitySlug,
    });
    const elsewhere = await visitorJoin(t.app, other.queueId, {
      operationId: first.operationId,
      proof: first.proof,
    });
    expect(elsewhere.status).toBe(409);
  });

  it('reusing a command operation id for a different command is a conflict, not a replay', async () => {
    const operationId = uuidv7();
    const a = await q.org.admin.post(`/api/v1/queues/${q.queueId}/commands`, {
      operation_id: operationId,
      action: 'queue.pause',
    });
    expect(a.status).toBe(200);
    const b = await q.org.admin.post(`/api/v1/queues/${q.queueId}/commands`, {
      operation_id: operationId,
      action: 'queue.open',
    });
    expect(b.status).toBe(409);
    const replay = await q.org.admin.post<{ outcome: { disposition: string } }>(
      `/api/v1/queues/${q.queueId}/commands`,
      {
        operation_id: operationId,
        action: 'queue.pause',
      },
    );
    expect(replay.body.outcome.disposition).toBe('duplicate');
    await queueCommand(q.org.admin, q.queueId, { action: 'queue.open' });
  });
});

describe('input validation, CSRF and abuse protection on public endpoints', () => {
  it('rejects unknown/privileged fields and non-v7 operation ids', async () => {
    const anon = new TestClient(t.app);
    for (const body of [
      { operation_id: uuidv7(), join_proof: randomSecret(), priority_class: 'urgent' },
      { operation_id: uuidv7(), join_proof: randomSecret(), organization_id: q.org.organizationId },
      { operation_id: crypto.randomUUID(), join_proof: randomSecret() }, // v4
      { operation_id: uuidv7(), join_proof: 'too-short' },
    ]) {
      expect((await anon.post(`/api/v1/queues/${q.queueId}/join`, body)).status).toBe(400);
    }
    const cmd = await q.org.admin.post(`/api/v1/queues/${q.queueId}/commands`, {
      operation_id: uuidv7(),
      action: 'queue.pause',
      actor_id: staff['auditor']?.userId,
    });
    expect(cmd.status).toBe(400);
    const unknownAction = await q.org.admin.post(`/api/v1/queues/${q.queueId}/commands`, {
      operation_id: uuidv7(),
      action: 'ticket.priority_override',
      ticket_id: await waitingTicket(),
    });
    expect(unknownAction.status).toBe(400); // M4 feature: not accepted by the M2 endpoint
  });

  it('anonymous joins still require the CSRF header and an allowed Origin', async () => {
    const body = { operation_id: uuidv7(), join_proof: randomSecret() };
    const noHeader = await t.app.inject({
      method: 'POST',
      url: `/api/v1/queues/${q.queueId}/join`,
      payload: body,
    });
    expect(noHeader.statusCode).toBe(403);
    const evil = await t.app.inject({
      method: 'POST',
      url: `/api/v1/queues/${q.queueId}/join`,
      headers: { origin: 'https://evil.example', 'x-qb-csrf': '1' },
      payload: body,
    });
    expect(evil.statusCode).toBe(403);
    expect(
      await t.db`SELECT 1 FROM client_operations WHERE operation_id = ${body.operation_id}`,
    ).toHaveLength(0);
  });

  it('joins are rate limited per client', async () => {
    const limited = await createTestApp({ JOIN_RATE_LIMIT_MAX: '3' });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await visitorJoin(limited.app, q.queueId)).status);
      expect(statuses).toEqual([201, 201, 201, 429, 429]);
    } finally {
      await limited.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Live updates over SSE — real HTTP server, real LISTEN/NOTIFY
// ---------------------------------------------------------------------------

describe('SSE live updates carry change signals only', () => {
  let base: string;
  let live: TestApp;
  beforeAll(async () => {
    live = await createTestApp();
    await live.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(live.app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await live.close();
  });

  /** Read SSE frames until `predicate` matches; resolves with all frames read. */
  async function readUntil(
    res: Response,
    predicate: (frames: string[]) => boolean,
  ): Promise<string[]> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const frames: string[] = [];
    while (!predicate(frames)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        frames.push(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
      }
    }
    await reader.cancel();
    return frames;
  }

  const changes = (frames: string[]): string[] => frames.filter((f) => f.includes('event: change'));

  it('public board stream signals a change after a join, filtered to its own facility', async () => {
    const a = await setupQueue(live.app, { counters: 1 });
    const b = await setupQueue(live.app, { counters: 1 });
    const ctrl = new AbortController();
    const res = await fetch(
      `${base}/api/v1/public/facilities/${a.org.slug}/${a.facilitySlug}/stream`,
      { signal: ctrl.signal },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const reading = readUntil(res, (f) => changes(f).length >= 1);
    // fetch() resolves only after the handler subscribed and wrote headers, so the stream is
    // registered. Change B first (must be filtered out), then A.
    await visitorJoin(live.app, b.queueId);
    await visitorJoin(live.app, a.queueId);
    const frames = await reading;
    ctrl.abort();
    const change = changes(frames);
    expect(change).toHaveLength(1);
    const data = JSON.parse(change[0]!.split('data: ')[1]!) as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(['revision']);
    expect(frames.join('\n')).not.toMatch(UUID_RE);
  });

  it('visitor stream needs the ticket token header and fires when the ticket is called', async () => {
    const s = await setupQueue(live.app, { counters: 1 });
    const j = await visitorJoin(live.app, s.queueId);
    const code = j.body.ticket!.public_code;
    const denied = await fetch(`${base}/api/v1/tickets/${code}/stream`);
    expect(denied.status).toBe(404);
    const res = await fetch(`${base}/api/v1/tickets/${code}/stream`, {
      headers: { 'x-qb-ticket-token': j.body.ticket!.status_token },
    });
    expect(res.status).toBe(200);
    const reading = readUntil(res, (f) => changes(f).length >= 1);
    await queueCommand(s.org.admin, s.queueId, {
      action: 'ticket.call_next',
      counter_id: s.counterIds[0],
    });
    expect(changes(await reading)).toHaveLength(1);
  });

  it('streams keep CORS and security headers for cross-origin web deployments', async () => {
    const s = await setupQueue(live.app, { counters: 1 });
    const j = await visitorJoin(live.app, s.queueId);
    const code = j.body.ticket!.public_code;
    const urls: [string, Record<string, string>][] = [
      [`${base}/api/v1/public/facilities/${s.org.slug}/${s.facilitySlug}/stream`, {}],
      [
        `${base}/api/v1/tickets/${code}/stream`,
        { 'x-qb-ticket-token': j.body.ticket!.status_token },
      ],
      [`${base}/api/v1/queues/${s.queueId}/stream`, { cookie: s.org.admin.cookie ?? '' }],
    ];
    for (const [url, headers] of urls) {
      const ctrl = new AbortController();
      const res = await fetch(url, {
        headers: { ...headers, origin: TEST_ORIGIN },
        signal: ctrl.signal,
      });
      expect(res.status, url).toBe(200);
      expect(res.headers.get('access-control-allow-origin'), url).toBe(TEST_ORIGIN);
      expect(res.headers.get('access-control-allow-credentials'), url).toBe('true');
      expect(res.headers.get('x-frame-options'), url).toBe('DENY');
      expect(res.headers.get('referrer-policy'), url).toBe('no-referrer');
      expect(res.headers.get('content-type'), url).toContain('text/event-stream');
      expect(res.headers.get('cache-control'), url).toBe('no-store');
      ctrl.abort();
    }
    // A foreign origin is still not granted access
    const ctrl = new AbortController();
    const foreign = await fetch(urls[0]![0], {
      headers: { origin: 'https://evil.example' },
      signal: ctrl.signal,
    });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    ctrl.abort();
  });

  it('staff stream requires a session with a role at the facility', async () => {
    const s = await setupQueue(live.app, { counters: 1 });
    expect((await fetch(`${base}/api/v1/queues/${s.queueId}/stream`)).status).toBe(401);
    const res = await fetch(`${base}/api/v1/queues/${s.queueId}/stream`, {
      headers: { cookie: s.org.admin.cookie ?? '', origin: TEST_ORIGIN },
    });
    expect(res.status).toBe(200);
    const reading = readUntil(res, (f) => changes(f).length >= 1);
    await queueCommand(s.org.admin, s.queueId, { action: 'queue.pause' });
    expect(changes(await reading)).toHaveLength(1);
    const outsider = await signupOrg(live.app);
    expect(
      (
        await fetch(`${base}/api/v1/queues/${s.queueId}/stream`, {
          headers: { cookie: outsider.admin.cookie ?? '' },
        })
      ).status,
    ).toBe(404);
  });
});
