import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signSmsWebhook, signUssdWebhook } from '@queuebridge/channels';
import {
  TEST_ORIGIN,
  assertEventLogIntact,
  createStaff,
  createTestApp,
  queueCommand,
  setupQueue,
  signupOrg,
  visitorJoin,
  ticketStatus,
  type QueueFixture,
  type TestApp,
} from './testing/harness.js';
import { createUssdCrypto } from './ussd/crypto.js';
import { createRecoveryCrypto } from './recovery/crypto.js';
import { targetKeys } from './recovery/throttle.js';

/**
 * M6.2 USSD on real PostgreSQL through the real webhook (REQ-F12.1–F12.5; Group 10 USSD
 * contract and integration; security steering "Webhook security", "Ticket recovery security").
 * Real: the API, the session store, the join path, the recovery-key check, the status view.
 * Simulated: the provider (signed sandbox requests); no shortcode, no mobile network.
 */
const SECRET = 'test-only-ussd-webhook-secret-0123456789abcdef';
const USSD_ON = {
  USSD_PROVIDER: 'sandbox',
  USSD_WEBHOOK_SECRET: SECRET,
  // every test posts from the same address; the limit itself is tested below
  USSD_WEBHOOK_RATE_LIMIT_MAX: '100000',
  SMS_RATE_LIMIT_MAX: '1000',
};
let t: TestApp; // USSD sandbox on
let off: TestApp; // same database, USSD not configured (the production default)
beforeAll(async () => {
  t = await createTestApp(USSD_ON);
  off = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await off.close();
});

const crypto = createUssdCrypto({ CONTACT_ENCRYPTION_KEY: '7e57'.repeat(16) })!;
/** The same key the test apps use (harness), to derive the throttle keys a request can write */
const recoveryCrypto = createRecoveryCrypto({ CONTACT_ENCRYPTION_KEY: '7e57'.repeat(16) })!;
const fresh = (n = 6): string => randomBytes(n).toString('hex');
const freshMsisdn = (): string =>
  `+234803${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;

interface Res {
  status: number;
  text: string;
  type: string;
}
async function post(
  app: TestApp,
  body: unknown,
  o: { headers?: Record<string, string>; secret?: string; provider?: string; raw?: string } = {},
): Promise<Res> {
  const raw = o.raw ?? JSON.stringify(body);
  const res = await app.app.inject({
    method: 'POST',
    url: `/api/v1/webhooks/ussd/${o.provider ?? 'sandbox'}`,
    headers: {
      'content-type': 'application/json',
      ...signUssdWebhook(o.secret ?? SECRET, raw),
      ...(o.headers ?? {}),
    },
    payload: raw,
  });
  return {
    status: res.statusCode,
    text: res.body,
    type: String(res.headers['content-type'] ?? ''),
  };
}

/** A subscriber dialling: each `send` adds an input and posts the cumulative text. */
class Phone {
  readonly inputs: string[] = [];
  constructor(
    public app: TestApp = t,
    readonly msisdn: string = freshMsisdn(),
    readonly session: string = `sess_${fresh()}`,
  ) {}
  body(): Record<string, string> {
    return { session_id: this.session, msisdn: this.msisdn, text: this.inputs.join('*') };
  }
  /** The first request (no input) or the next input. */
  async send(input?: string): Promise<Res> {
    if (input !== undefined) this.inputs.push(input);
    return post(this.app, this.body());
  }
  /** The provider repeating the last callback (same text, re-signed with a new nonce). */
  async repeat(): Promise<Res> {
    return post(this.app, this.body());
  }
  async run(...inputs: string[]): Promise<Res[]> {
    const out = [await this.send()];
    for (const i of inputs) out.push(await this.send(i));
    return out;
  }
  sessionHash(): string {
    return crypto.sessionKeyHash('sandbox', this.session);
  }
}
const lastOf = (rs: Res[]): Res => rs[rs.length - 1] as Res;

async function enableUssd(q: { org: QueueFixture['org']; fid: string }, app = t): Promise<string> {
  const r = await q.org.admin.request<{ ussd: { access_code: string; enabled: boolean } }>(
    'PUT',
    `/api/v1/facilities/${q.fid}/ussd`,
    { enabled: true },
  );
  // a refused setup would make "nothing happened" pass vacuously
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  void app;
  return r.body.ussd.access_code;
}
async function ussdQueue(): Promise<QueueFixture & { code: string }> {
  const q = await setupQueue(t.app, { counters: 1, serviceName: `General ${fresh(2)}` });
  return { ...q, code: await enableUssd(q) };
}
const ussdTickets = async (queueId: string): Promise<{ id: string; public_code: string }[]> =>
  t.db`SELECT id, public_code FROM tickets WHERE queue_session_id = ${queueId} AND created_channel = 'ussd'`;
const eventCount = async (queueId: string): Promise<number> =>
  (
    await t.db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM queue_events WHERE queue_session_id = ${queueId}`
  )[0]?.n ?? 0;
/** Join over USSD; returns the ticket code and the recovery key read from the END screen. */
async function ussdJoin(
  q: { code: string },
  phone = new Phone(),
): Promise<{ code: string; key: string; phone: Phone; screen: string }> {
  const r = lastOf(await phone.run(q.code, '1', '1', '1'));
  const m = /Ticket ([A-Z]{1,3}[0-9]{3,4}),[\s\S]*Key: ((?:[0-9A-Z]{4} ?){8})/.exec(r.text);
  expect(m, r.text).not.toBeNull();
  return { code: m?.[1] ?? '', key: (m?.[2] ?? '').replace(/ /g, ''), phone, screen: r.text };
}

// ---------------------------------------------------------------------------------------------
describe('deployment, capability and facility setting', () => {
  it('sandbox configured: ussd is sandbox/available; default deployment: sandbox/unavailable and no webhook', async () => {
    const on = await t.app.inject({ method: 'GET', url: '/api/v1/que/capabilities' });
    expect(JSON.parse(on.body).capabilities.ussd).toMatchObject({
      status: 'sandbox',
      availability: 'available',
    });
    const d = await off.app.inject({ method: 'GET', url: '/api/v1/que/capabilities' });
    expect(JSON.parse(d.body).capabilities.ussd).toMatchObject({
      status: 'sandbox',
      availability: 'unavailable',
      unavailableReason: 'not_configured',
    });
    expect((await post(off, new Phone().body())).status).toBe(404);
    expect((await post(t, new Phone().body(), { provider: 'africastalking' })).status).toBe(404);
  });

  it('off by default; administrators turn it on (audited) and get a server-generated 6-digit code kept on turning off', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const get = await q.org.admin.get<{ ussd: Record<string, unknown> }>(
      `/api/v1/facilities/${q.fid}/ussd`,
    );
    expect(get.body.ussd).toEqual({
      enabled: false,
      access_code: null,
      deployment_available: true,
      deployment_mode: 'sandbox',
    });
    const code = await enableUssd(q);
    expect(code).toMatch(/^[1-9][0-9]{5}$/);
    const offAgain = await q.org.admin.request<{ ussd: Record<string, unknown> }>(
      'PUT',
      `/api/v1/facilities/${q.fid}/ussd`,
      { enabled: false },
    );
    expect(offAgain.body.ussd).toMatchObject({ enabled: false, access_code: code });
    // repeating the same value is not a change (one event per change)
    await q.org.admin.request('PUT', `/api/v1/facilities/${q.fid}/ussd`, { enabled: false });
    const events = await t.db<{ event_type: string }[]>`
      SELECT event_type FROM admin_events WHERE facility_id = ${q.fid} AND event_type LIKE 'ussd.%' ORDER BY created_at`;
    expect(events.map((e) => e.event_type)).toEqual(['ussd.enabled', 'ussd.disabled']);
    expect(JSON.stringify(events)).not.toContain(code);
  });

  it('only facility administrators configure it; readers read; other tenants get 404; bodies are strict', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    expect(
      (await counter.client.request('PUT', `/api/v1/facilities/${q.fid}/ussd`, { enabled: true }))
        .status,
    ).toBe(403);
    const auditor = await createStaff(t.app, q.org, q.fid, 'auditor');
    expect((await auditor.client.get(`/api/v1/facilities/${q.fid}/ussd`)).status).toBe(200);
    expect(
      (await auditor.client.request('PUT', `/api/v1/facilities/${q.fid}/ussd`, { enabled: true }))
        .status,
    ).toBe(403);
    const other = await signupOrg(t.app, 'Other');
    expect((await other.admin.get(`/api/v1/facilities/${q.fid}/ussd`)).status).toBe(404);
    expect(
      (await other.admin.request('PUT', `/api/v1/facilities/${q.fid}/ussd`, { enabled: true }))
        .status,
    ).toBe(404);
    expect(
      (
        await q.org.admin.request('PUT', `/api/v1/facilities/${q.fid}/ussd`, {
          enabled: true,
          access_code: '111111',
        })
      ).status,
    ).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
describe('POST /webhooks/ussd/:provider security', () => {
  it('malformed requests are refused before the signature (400); unsigned, wrong, stale or SMS-signed ones after it (401)', async () => {
    const body = new Phone().body();
    const raw = JSON.stringify(body);
    expect((await post(t, null, { raw: 'not json' })).status).toBe(400);
    expect((await post(t, { ...body, extra: 1 })).status).toBe(400);
    expect((await post(t, { ...body, msisdn: 'call me' })).status).toBe(400);
    expect((await post(t, { ...body, text: '<b>' })).status).toBe(400);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/ussd/sandbox',
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });
    expect(res.statusCode).toBe(400);
    expect((await post(t, body, { secret: 'x'.repeat(48) })).status).toBe(401);
    const stale = signUssdWebhook(SECRET, raw, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect((await post(t, body, { headers: stale })).status).toBe(401);
    const sms = Object.fromEntries(
      Object.entries(signSmsWebhook(SECRET, raw)).map(([k, v]) => [
        k.replace('-sms-', '-ussd-'),
        v,
      ]),
    );
    expect((await post(t, body, { headers: sms })).status).toBe(401);
    // nothing was stored for any of them
    const [n] = await t.db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM ussd_sessions
       WHERE provider_session_key_hash = ${crypto.sessionKeyHash('sandbox', body['session_id'] ?? '')}`;
    expect(n?.n).toBe(0);
  });

  it('an exact replay (same nonce) is refused (409) and changes nothing; an oversized body is refused (413)', async () => {
    const p = new Phone();
    const raw = JSON.stringify(p.body());
    const headers = signUssdWebhook(SECRET, raw);
    const first = await post(t, p.body(), { headers });
    expect(first.status).toBe(200);
    expect((await post(t, p.body(), { headers })).status).toBe(409);
    const big = { ...p.body(), text: '1'.repeat(240) };
    const huge = JSON.stringify({ ...big, service_code: '*'.repeat(32) }) + ' '.repeat(5000);
    expect((await post(t, null, { raw: huge })).status).toBe(413);
  });

  it('answers in the CON/END text contract, labelled [SANDBOX], within 182 characters', async () => {
    const r = await new Phone().send();
    expect(r.status).toBe(200);
    expect(r.type).toContain('text/plain');
    expect(r.text.startsWith('CON [SANDBOX]')).toBe(true);
    expect(r.text.length - 4).toBeLessThanOrEqual(182);
  });

  it('the webhook needs no browser CSRF header and ignores any session cookie', async () => {
    const q = await ussdQueue();
    const p = new Phone();
    const raw = JSON.stringify(p.body());
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/ussd/sandbox',
      headers: {
        'content-type': 'application/json',
        cookie: q.org.admin.cookie ?? '',
        origin: 'https://evil.example',
        ...signUssdWebhook(SECRET, raw),
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
  });

  it('is rate-limited per source address', async () => {
    const small = await createTestApp({ ...USSD_ON, USSD_WEBHOOK_RATE_LIMIT_MAX: '2' });
    try {
      const codes = [];
      for (let i = 0; i < 3; i++) codes.push((await post(small, new Phone(small).body())).status);
      expect(codes).toEqual([200, 200, 429]);
    } finally {
      await small.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('discovery: a facility code, then the services taking visitors', () => {
  it('lists only the facility’s open services; unknown, disabled and suspended facilities are not found', async () => {
    const q = await ussdQueue();
    const paused = await setupQueue(t.app, {
      counters: 1,
      org: q.org,
      fid: q.fid,
      facilitySlug: q.facilitySlug,
      serviceName: `Pharmacy ${fresh(2)}`,
    });
    await queueCommand(q.org.admin, paused.queueId, { action: 'queue.pause' });
    const menu = lastOf(await new Phone().run(q.code, '1'));
    expect(menu.text).toContain('Choose a service:');
    expect(menu.text).toContain('General');
    expect(menu.text).not.toContain('Pharmacy');
    expect(lastOf(await new Phone().run('100000')).text).toContain('No facility has that code');
    // turned off: the code no longer opens it
    await q.org.admin.request('PUT', `/api/v1/facilities/${q.fid}/ussd`, { enabled: false });
    expect(lastOf(await new Phone().run(q.code)).text).toContain('No facility has that code');
    await q.org.admin.request('PUT', `/api/v1/facilities/${q.fid}/ussd`, { enabled: true });
    await t.db`UPDATE facilities SET status = 'suspended' WHERE id = ${q.fid}`;
    expect(lastOf(await new Phone().run(q.code)).text).toContain('No facility has that code');
    await t.db`UPDATE facilities SET status = 'active' WHERE id = ${q.fid}`;
    expect(lastOf(await new Phone().run(q.code)).text).toContain('1 Join a queue');
  });

  it('says plainly when no service is taking visitors', async () => {
    const q = await ussdQueue();
    await queueCommand(q.org.admin, q.queueId, { action: 'queue.pause' });
    expect(lastOf(await new Phone().run(q.code, '1')).text).toContain(
      'is taking visitors right now',
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('joining the authoritative queue', () => {
  it('creates one real ticket through the join path (channel ussd), with a working recovery key and an intact event log', async () => {
    const q = await ussdQueue();
    const before = await eventCount(q.queueId);
    const j = await ussdJoin(q);
    expect(j.screen.startsWith('END [SANDBOX]')).toBe(true);
    expect(j.screen).toContain('Write down the code and key');
    const tickets = await ussdTickets(q.queueId);
    expect(tickets.map((x) => x.public_code)).toEqual([j.code]);
    expect(await eventCount(q.queueId)).toBe(before + 1);
    await assertEventLogIntact(t.db, q.queueId);
    // the key shown is the ticket's real recovery key (web recovery accepts it)
    const rec = await t.app.inject({
      method: 'POST',
      url: '/api/v1/tickets/recover',
      headers: { origin: TEST_ORIGIN, 'x-qb-csrf': '1', 'content-type': 'application/json' },
      payload: {
        org_slug: q.org.slug,
        facility_slug: q.facilitySlug,
        ticket_code: j.code,
        recovery_key: j.key,
      },
    });
    expect(rec.statusCode).toBe(200);
    // the same ordinary waiting ticket as a web join: fairness untouched
    const [tk] = await t.db<
      { state: string; priority_class: string; provisional_source_op_id: string | null }[]
    >`
      SELECT state, priority_class, provisional_source_op_id FROM tickets WHERE id = ${tickets[0]?.id ?? ''}`;
    expect(tk).toMatchObject({
      state: 'waiting',
      priority_class: 'normal',
      provisional_source_op_id: null,
    });
  });

  it('stores no phone number, session id or key: hashes and an encrypted last screen only', async () => {
    const q = await ussdQueue();
    const j = await ussdJoin(q);
    const [row] = await t.db<Record<string, unknown>[]>`
      SELECT * FROM ussd_sessions WHERE provider_session_key_hash = ${j.phone.sessionHash()}`;
    expect(row).toBeDefined();
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(j.phone.msisdn.slice(-7));
    expect(dump).not.toContain(j.phone.session);
    expect(dump).not.toContain(j.key);
    expect(dump).not.toContain(j.key.slice(0, 8));
    expect(row?.['facility_id']).toBe(q.fid);
    expect(row?.['organization_id']).toBe(q.org.organizationId);
    expect(row?.['joined_at']).toBeInstanceOf(Date);
    expect(row?.['ended_at']).toBeInstanceOf(Date);
  });

  it('a repeated confirm callback returns the same screen and never a second ticket (sequential and concurrent)', async () => {
    const q = await ussdQueue();
    const j = await ussdJoin(q);
    const again = await j.phone.repeat();
    expect(again.text).toBe(j.screen);
    const q2 = await ussdQueue();
    const p = new Phone();
    await p.run(q2.code, '1', '1');
    p.inputs.push('1');
    const all = await Promise.all(Array.from({ length: 6 }, () => p.repeat()));
    expect(all.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect(new Set(all.map((r) => r.text)).size).toBe(1);
    expect(await ussdTickets(q2.queueId)).toHaveLength(1);
    expect(await ussdTickets(q.queueId)).toHaveLength(1);
  });

  it('different concurrent inputs for one step: one applies, the rest end without effect', async () => {
    const q = await ussdQueue();
    const p = new Phone();
    await p.run(q.code);
    const racers = ['1', '2', '3'].map((input) =>
      post(t, { session_id: p.session, msisdn: p.msisdn, text: `${q.code}*${input}` }),
    );
    const out = await Promise.all(racers);
    // one applies; of the others, the first ends the session as out of step, the next finds it ended
    expect(out.filter((r) => r.text.startsWith('CON')).length).toBe(1);
    const ends = out.filter((r) => r.text.startsWith('END')).map((r) => r.text);
    expect(ends).toHaveLength(2);
    for (const e of ends) expect(e).toMatch(/out of step|has ended/);
    expect(await ussdTickets(q.queueId)).toHaveLength(0);
  });

  it('the per-phone join limit applies across sessions; other phones are unaffected', async () => {
    const lim = await createTestApp({ ...USSD_ON, USSD_JOINS_PER_PHONE_PER_HOUR: '2' });
    try {
      const q = await ussdQueue();
      const msisdn = freshMsisdn();
      for (let i = 0; i < 2; i++) await ussdJoin(q, new Phone(lim, msisdn));
      const third = lastOf(await new Phone(lim, msisdn).run(q.code, '1', '1', '1'));
      expect(third.text).toContain('joined as many queues as allowed');
      expect(await ussdTickets(q.queueId)).toHaveLength(2);
      await ussdJoin(q, new Phone(lim));
      expect(await ussdTickets(q.queueId)).toHaveLength(3);
    } finally {
      await lim.close();
    }
  });

  it('a session resumes after an API restart (state is in PostgreSQL, not process memory)', async () => {
    const q = await ussdQueue();
    const a = await createTestApp(USSD_ON);
    const p = new Phone(a);
    await p.run(q.code, '1', '1');
    await a.close();
    const b = await createTestApp(USSD_ON);
    try {
      p.app = b;
      const r = await p.send('1');
      expect(r.text).toMatch(/END \[SANDBOX\]\nTicket [A-Z]+[0-9]+/);
      expect(await ussdTickets(q.queueId)).toHaveLength(1);
    } finally {
      await b.close();
    }
  });

  it('a session that expires midway cannot join; dialling again starts over safely', async () => {
    const q = await ussdQueue();
    const p = new Phone();
    await p.run(q.code, '1', '1');
    await t.db`UPDATE ussd_sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE provider_session_key_hash = ${p.sessionHash()}`;
    const late = await p.send('1');
    expect(late.text).toContain('timed out');
    expect(late.text.startsWith('END')).toBe(true);
    expect(await ussdTickets(q.queueId)).toHaveLength(0);
    // a late repeat of that callback gets the same answer, still nothing joined
    expect((await p.repeat()).text).toBe(late.text);
    // the same session id dialled fresh: a new start
    const restart = await post(t, { session_id: p.session, msisdn: p.msisdn, text: '' });
    expect(restart.text).toContain('6-digit facility code');
    expect(await ussdTickets(q.queueId)).toHaveLength(0);
  });

  it('the facility becoming unavailable, or the service pausing or closing before confirmation, refuses the join', async () => {
    const q = await ussdQueue();
    const a = new Phone();
    await a.run(q.code, '1');
    await t.db`UPDATE facilities SET status = 'suspended' WHERE id = ${q.fid}`;
    expect((await a.send('1')).text).toContain('is not taking visitors right now');
    await t.db`UPDATE facilities SET status = 'active' WHERE id = ${q.fid}`;
    const b = new Phone();
    await b.run(q.code, '1', '1');
    await queueCommand(q.org.admin, q.queueId, { action: 'queue.pause' });
    expect((await b.send('1')).text).toContain('is paused');
    await queueCommand(q.org.admin, q.queueId, { action: 'queue.open' });
    const c = new Phone();
    await c.run(q.code, '1', '1');
    expect((await queueCommand(q.org.admin, q.queueId, { action: 'queue.close' })).status).toBe(
      200,
    );
    expect((await c.send('1')).text).toContain('has closed');
    expect(await ussdTickets(q.queueId)).toHaveLength(0);
  });

  it('out-of-step and foreign-phone callbacks end without effect', async () => {
    const q = await ussdQueue();
    const p = new Phone();
    await p.send();
    // a gap (step 3 before step 2)
    const gap = await post(t, { session_id: p.session, msisdn: p.msisdn, text: `${q.code}*1` });
    expect(gap.text).toContain('out of step');
    const s = new Phone();
    await s.run(q.code, '1');
    const thief = await post(t, {
      session_id: s.session,
      msisdn: freshMsisdn(),
      text: `${q.code}*1*1`,
    });
    expect(thief.text).toContain('cannot continue');
    // the real phone continues normally
    expect((await s.send('1')).text).toContain('Join');
    expect(await ussdTickets(q.queueId)).toHaveLength(0);
  });

  it('the database being unavailable gives a USSD screen (503) and creates nothing', async () => {
    const q = await ussdQueue();
    const broken = await createTestApp(USSD_ON);
    await broken.db.end({ timeout: 1 });
    const r = await post(broken, new Phone(broken).body());
    expect(r.status).toBe(503);
    expect(r.text).toBe(
      'END [SANDBOX]\nQueueBridge is not available right now. Please try again later.',
    );
    await broken.app.close();
    expect(await ussdTickets(q.queueId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('status and recovery: the ticket code AND its recovery key, never a code or a number alone', () => {
  it('status with code and key shows committed state; it issues no token and changes nothing', async () => {
    const q = await ussdQueue();
    const j = await ussdJoin(q);
    const [root] = await t.db<
      { id: string }[]
    >`SELECT id FROM tickets WHERE queue_session_id = ${q.queueId} AND public_code = ${j.code}`;
    const tokens = async (): Promise<number> =>
      (
        await t.db<
          { n: number }[]
        >`SELECT COUNT(*)::int AS n FROM ticket_recovery_credentials WHERE ticket_id = ${root?.id ?? ''}`
      )[0]?.n ?? -1;
    const tokensBefore = await tokens();
    const events = await eventCount(q.queueId);
    const r = lastOf(await new Phone().run(q.code, '2', j.code.toLowerCase(), j.key));
    expect(r.text).toContain(`${j.code} `);
    expect(r.text).toContain('waiting, you are next.');
    expect(await tokens()).toBe(tokensBefore);
    expect(await eventCount(q.queueId)).toBe(events);
    // after a committed call, the status follows
    await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.call_next',
      counter_id: q.counterIds[0],
    });
    const called = lastOf(await new Phone().run(q.code, '2', j.code, j.key));
    expect(called.text).toContain('called. Go to');
  });

  it('a wrong key, a code alone, another facility’s key and an unknown code all give the same failure', async () => {
    const qa = await ussdQueue();
    const qb = await ussdQueue(); // another organization: its first ticket has the same code
    const a = await ussdJoin(qa);
    const b = await ussdJoin(qb);
    expect(b.code).toBe(a.code);
    const fail = (rs: Res[]): string => lastOf(rs).text;
    const wrong = fail(await new Phone().run(qa.code, '2', a.code, 'A'.repeat(32)));
    expect(wrong).toContain('could not open a ticket with these details');
    expect(fail(await new Phone().run(qa.code, '2', a.code, b.key))).toBe(wrong);
    expect(fail(await new Phone().run(qa.code, '2', 'Z999', a.key))).toBe(wrong);
    expect(fail(await new Phone().run(qa.code, '2', a.code, ''))).toBe(wrong);
    // each facility opens only its own ticket with its own key
    expect(fail(await new Phone().run(qb.code, '2', b.code, b.key))).toContain('waiting');
  });

  it('wrong keys from one phone are throttled with the recovery limits (never keyed on the guess); a clean phone still succeeds', async () => {
    const q = await ussdQueue();
    const j = await ussdJoin(q);
    const attacker = freshMsisdn();
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i++) {
      const guess = randomBytes(16).toString('hex').toUpperCase().slice(0, 32);
      outcomes.push(lastOf(await new Phone(t, attacker).run(q.code, '2', j.code, guess)).text);
    }
    expect(outcomes.slice(0, 5).every((o) => o.includes('could not open a ticket'))).toBe(true);
    expect(outcomes[5]).toContain('Too many attempts');
    // even the right key is refused from that phone for now (L2 is per source and ticket)
    expect(lastOf(await new Phone(t, attacker).run(q.code, '2', j.code, j.key)).text).toContain(
      'Too many attempts',
    );
    // no lockout of the rightful holder from another phone
    expect(lastOf(await new Phone().run(q.code, '2', j.code, j.key)).text).toContain('waiting');
  });

  it('recovery with code and key names the current ticket after a transfer; "lost" gives staff guidance only', async () => {
    const q = await ussdQueue();
    const dest = await setupQueue(t.app, {
      counters: 1,
      org: q.org,
      fid: q.fid,
      facilitySlug: q.facilitySlug,
      serviceName: `Pharmacy ${fresh(2)}`,
    });
    const j = await ussdJoin(q);
    const [tk] = await t.db<
      { id: string }[]
    >`SELECT id FROM tickets WHERE queue_session_id = ${q.queueId} AND public_code = ${j.code}`;
    const tr = await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.transfer',
      ticket_id: tk?.id ?? '',
      destination_service_id: dest.serviceId,
      reason_code: 'needs_other_service',
    });
    expect(tr.status).toBe(200);
    const recoverer = new Phone();
    const r = lastOf(await recoverer.run(q.code, '3', '1', j.code, j.key));
    expect(r.text).toContain(`Moved from ${j.code}.`);
    expect(r.text).toMatch(/Your ticket is [A-Z]+[0-9]+\./);
    // "Lost code or key" records no recovery attempt. `recovery_throttle` is shared by every
    // suite running concurrently against the test database, so a global row count is not a
    // valid measure (M7.2 stability investigation). Instead: every throttle key the recovery
    // code can derive (`targetKeys`: source, target, target-source, facility, facility-source)
    // for THIS phone, THIS facility and both ticket codes of this test is checked unchanged.
    const lostPhone = new Phone();
    const source = `ussd:${crypto.msisdnHash(lostPhone.msisdn)}`;
    const keys = [j.code, r.text.match(/Your ticket is ([A-Z]+[0-9]+)\./)?.[1] ?? ''].flatMap(
      (code) =>
        Object.values(
          targetKeys(
            recoveryCrypto,
            { orgSlug: q.org.slug, facilitySlug: q.facilitySlug, ticketCode: code },
            source,
          ),
        ),
    );
    const throttleRows = async (): Promise<unknown[]> => [
      ...(await t.db`SELECT scope, key_hash, attempts, failures FROM recovery_throttle
                      WHERE key_hash IN ${t.db(keys)} ORDER BY scope, key_hash`),
    ];
    // the derivation is the one the server uses: the recovering phone's own attempt is found
    const recovererSource = recoveryCrypto.throttleKey(
      'source',
      `ussd:${crypto.msisdnHash(recoverer.msisdn)}`,
    );
    const [counted] = await t.db<{ attempts: number }[]>`
      SELECT attempts FROM recovery_throttle WHERE scope = 'source' AND key_hash = ${recovererSource}`;
    expect(counted?.attempts).toBeGreaterThanOrEqual(1);
    const throttleBefore = await throttleRows();
    const lost = lastOf(await lostPhone.run(q.code, '3', '2'));
    expect(lost.text).toContain('Ask staff at');
    expect(lost.text).toContain('A phone number or a ticket code alone cannot open a ticket.');
    expect(await throttleRows()).toEqual(throttleBefore);
    // and this phone, which never submitted a code or key, has no throttle state at all
    const sourceKey = recoveryCrypto.throttleKey('source', source);
    expect(
      await t.db`SELECT 1 FROM recovery_throttle WHERE scope = 'source' AND key_hash = ${sourceKey}`,
    ).toHaveLength(0);
  });

  it('a ticket that has ended cannot be opened (same uniform failure)', async () => {
    const q = await ussdQueue();
    const j = await ussdJoin(q);
    const c = await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.call_next',
      counter_id: q.counterIds[0],
    });
    await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.serve',
      ticket_id: c.body.outcome?.ticket_id,
    });
    await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.complete',
      ticket_id: c.body.outcome?.ticket_id,
    });
    expect(lastOf(await new Phone().run(q.code, '2', j.code, j.key)).text).toContain(
      'could not open a ticket',
    );
  });

  it('a web visitor’s ticket can be checked by phone with its key, and their browser token keeps working', async () => {
    const q = await ussdQueue();
    const w = await visitorJoin(t.app, q.queueId);
    const code = w.body.ticket?.public_code ?? '';
    const key = String(w.body.ticket?.recovery_key ?? '');
    expect(lastOf(await new Phone().run(q.code, '2', code, key)).text).toContain('waiting');
    expect((await ticketStatus(t.app, code, w.body.ticket?.status_token ?? '')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
describe('no unintended queue-state transitions', () => {
  it('browsing, failed joins, status, recovery and invalid input append no queue event and change no ticket', async () => {
    const q = await ussdQueue();
    const web = await visitorJoin(t.app, q.queueId);
    const snapshot = async (): Promise<string> =>
      JSON.stringify(
        await t.db`SELECT id, state, wait_since, updated_at FROM tickets WHERE queue_session_id = ${q.queueId} ORDER BY id`,
      );
    const before = await snapshot();
    const events = await eventCount(q.queueId);
    await new Phone().run(q.code, '1', '9', '2', 'A001', 'B'.repeat(32));
    await new Phone().run(q.code, '7', '7', '7');
    await new Phone().run(q.code, '3', '2');
    await new Phone().run(
      q.code,
      '2',
      web.body.ticket?.public_code ?? '',
      String(web.body.ticket?.recovery_key ?? ''),
    );
    await new Phone().run(q.code, '1', '1', '9', '0');
    expect(await eventCount(q.queueId)).toBe(events);
    expect(await snapshot()).toBe(before);
  });
});
