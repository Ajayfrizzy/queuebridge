import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SMS_CONSENT_VERSION, randomSecret, uuidv7 } from '@queuebridge/contracts';
import { signSmsWebhook, sandboxMessageId, signUssdWebhook } from '@queuebridge/channels';
import {
  TEST_ORIGIN,
  createStaff,
  createTestApp,
  queueCommand,
  setupQueue,
  signupOrg,
  type QueueFixture,
  type TestApp,
} from './testing/harness.js';

/**
 * M6.3 channel configuration and monitoring on real PostgreSQL (design §13.4; REQ-F11.10, F11.11,
 * F11.13, F12): the SMS delay setting and its safety bound, the delayed enqueue, the in-app
 * "alert seen" acknowledgement, SMS and USSD monitoring (RBAC, tenancy, pagination, privacy).
 * The worker's side of the delay (skip, send, races) is tested in apps/worker.
 */
const SMS_SECRET = 'test-only-sms-webhook-secret-0123456789abcdef';
const USSD_SECRET = 'test-only-ussd-webhook-secret-0123456789abcdef';
const ON = {
  SMS_PROVIDER: 'sandbox',
  SMS_DAILY_CAP: '100',
  SMS_WEBHOOK_SECRET: SMS_SECRET,
  SMS_RATE_LIMIT_MAX: '1000',
  SMS_WEBHOOK_RATE_LIMIT_MAX: '10000',
  USSD_PROVIDER: 'sandbox',
  USSD_WEBHOOK_SECRET: USSD_SECRET,
  USSD_WEBHOOK_RATE_LIMIT_MAX: '100000',
};
let t: TestApp;
let off: TestApp;
const autoMissOn: string[] = [];
beforeAll(async () => {
  t = await createTestApp(ON);
  off = await createTestApp();
});
afterEach(async () => {
  // never leave automatic no-show on (other suites sweep every queue)
  for (const id of autoMissOn.splice(0)) {
    await t.db`UPDATE services SET policy = jsonb_set(policy, '{auto_miss}', '{"enabled": false}') WHERE id = ${id}`;
  }
});
afterAll(async () => {
  await t.close();
  await off.close();
});

interface Res {
  status: number;
  body: Record<string, unknown>;
}
async function inject(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  o: {
    cookie?: string;
    body?: unknown;
    token?: string;
    app?: TestApp;
    headers?: Record<string, string>;
  } = {},
): Promise<Res> {
  const res = await (o.app ?? t).app.inject({
    method,
    url,
    headers: {
      origin: TEST_ORIGIN,
      'x-qb-csrf': '1',
      ...(o.cookie ? { cookie: o.cookie } : {}),
      ...(o.token ? { 'x-qb-ticket-token': o.token } : {}),
      ...(o.headers ?? {}),
    },
    ...(o.body !== undefined ? { payload: o.body as object } : {}),
  });
  return {
    status: res.statusCode,
    body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {},
  };
}
const smsOf = (r: Res): Record<string, unknown> => r.body['sms'] as Record<string, unknown>;
const putSms = (q: QueueFixture, body: unknown, cookie = q.org.admin.cookie ?? ''): Promise<Res> =>
  inject('PUT', `/api/v1/facilities/${q.fid}/sms`, { cookie, body });
const getSms = (q: QueueFixture, cookie = q.org.admin.cookie ?? ''): Promise<Res> =>
  inject('GET', `/api/v1/facilities/${q.fid}/sms`, { cookie });
async function autoMiss(q: QueueFixture, afterSeconds: number): Promise<void> {
  const r = await q.org.admin.patch(`/api/v1/facilities/${q.fid}/services/${q.serviceId}`, {
    policy: { auto_miss: { enabled: true, after_seconds: afterSeconds } },
  });
  expect(r.status).toBe(200);
  autoMissOn.push(q.serviceId);
}
const phone = (): string => `0803${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
async function joinWithSms(
  q: QueueFixture,
): Promise<{ code: string; token: string; ticketId: string }> {
  const r = await inject('POST', `/api/v1/queues/${q.queueId}/join`, {
    body: {
      operation_id: uuidv7(),
      join_proof: randomSecret(),
      sms: { phone: phone(), consent: true, consent_version: SMS_CONSENT_VERSION },
    },
  });
  expect(r.status).toBe(201);
  const tk = r.body['ticket'] as { public_code: string; status_token: string; sms_alert: string };
  expect(tk.sms_alert).toBe('on');
  const [row] = await t.db<{ id: string }[]>`
    SELECT id FROM tickets WHERE queue_session_id = ${q.queueId} AND public_code = ${tk.public_code}`;
  return { code: tk.public_code, token: tk.status_token, ticketId: row?.id ?? '' };
}
const callNext = async (q: QueueFixture, counter = 0): Promise<number> => {
  const r = await queueCommand(q.org.admin, q.queueId, {
    action: 'ticket.call_next',
    counter_id: q.counterIds[counter],
  });
  expect(r.status).toBe(200);
  const [e] = await t.db<{ sequence: number }[]>`
    SELECT MAX(sequence)::int AS sequence FROM queue_events WHERE queue_session_id = ${q.queueId}`;
  return e?.sequence ?? 0;
};
const outboxOf = async (
  ticketId: string,
): Promise<{ delay: number; skip: boolean; status: string } | undefined> =>
  (
    await t.db<{ delay: number; skip: boolean; status: string }[]>`
      SELECT EXTRACT(EPOCH FROM o.next_attempt_at - o.created_at)::int AS delay,
             (o.payload ->> 'skip_if_seen')::boolean AS skip, n.status
        FROM notification_outbox o JOIN notifications n ON n.id = o.notification_id
       WHERE n.ticket_id = ${ticketId} AND n.channel = 'sms'`
  )[0];
const smsQueue = async (counters = 1): Promise<QueueFixture> => {
  const q = await setupQueue(t.app, { counters });
  expect((await putSms(q, { enabled: true, daily_cap: 50 })).status).toBe(200);
  return q;
};

// ---------------------------------------------------------------------------------------------
describe('SMS settings: the optional delay and its safety bound', () => {
  it('off by default; the allowed maximum leaves the dispatch margin before the turn-alert TTL', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    expect(smsOf(await getSms(q))).toMatchObject({
      enabled: false,
      delay_seconds: null,
      delay_max_seconds: 90, // TTL 120 s − 30 s margin
      deployment_mode: 'sandbox',
      deployment_available: true,
    });
  });

  it('a delay within the bound is saved and audited; above it is refused with a field error; below the minimum is invalid', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const ok = await putSms(q, { enabled: true, daily_cap: 20, delay_seconds: 60 });
    expect(ok.status).toBe(200);
    expect(smsOf(ok)).toMatchObject({ delay_seconds: 60 });
    const tooLong = await putSms(q, { enabled: true, daily_cap: 20, delay_seconds: 91 });
    expect(tooLong.status).toBe(422);
    expect(JSON.stringify(tooLong.body)).toContain('delay_seconds');
    expect(String(tooLong.body['detail'])).toContain('90 seconds');
    expect((await putSms(q, { enabled: true, daily_cap: 20, delay_seconds: 5 })).status).toBe(400);
    // the refused value did not replace the saved one
    expect(smsOf(await getSms(q))).toMatchObject({ delay_seconds: 60 });
    // back to immediate (null), audited once per change
    expect((await putSms(q, { enabled: true, daily_cap: 20, delay_seconds: null })).status).toBe(
      200,
    );
    const events = await t.db<{ event_type: string; details: Record<string, unknown> }[]>`
      SELECT event_type, details FROM admin_events
       WHERE facility_id = ${q.fid} AND event_type = 'sms.delay_changed' ORDER BY created_at`;
    expect(
      events.map((e) => [e.details['previous_delay_seconds'], e.details['delay_seconds']]),
    ).toEqual([
      [null, 60],
      [60, null],
    ]);
  });

  it('automatic no-show tightens the bound, or rules a delay out entirely', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await autoMiss(q, 60);
    expect(smsOf(await getSms(q))).toMatchObject({ delay_max_seconds: 30 });
    expect((await putSms(q, { enabled: true, daily_cap: 5, delay_seconds: 31 })).status).toBe(422);
    expect((await putSms(q, { enabled: true, daily_cap: 5, delay_seconds: 30 })).status).toBe(200);
    // a facility whose TTL leaves no room: an app with TTL 30 s allows no delay at all
    const tight = await createTestApp({ ...ON, TURN_ALERT_TTL_SECONDS: '30' });
    try {
      const q2 = await setupQueue(tight.app, { counters: 1 });
      const r = await inject('GET', `/api/v1/facilities/${q2.fid}/sms`, {
        app: tight,
        cookie: q2.org.admin.cookie ?? '',
      });
      expect(smsOf(r)).toMatchObject({ delay_max_seconds: null });
      const refused = await inject('PUT', `/api/v1/facilities/${q2.fid}/sms`, {
        app: tight,
        cookie: q2.org.admin.cookie ?? '',
        body: { enabled: true, daily_cap: 5, delay_seconds: 10 },
      });
      expect(refused.status).toBe(422);
      expect(String(refused.body['detail'])).toContain('not possible here');
    } finally {
      await tight.close();
    }
  });

  it('only facility administrators write; readers read; other tenants get 404; bodies are strict (no mode switch exists)', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const auditor = await createStaff(t.app, q.org, q.fid, 'auditor');
    expect((await getSms(q, counter.client.cookie ?? '')).status).toBe(200);
    expect(
      (await putSms(q, { enabled: true, daily_cap: 5 }, counter.client.cookie ?? '')).status,
    ).toBe(403);
    expect(
      (await putSms(q, { enabled: true, daily_cap: 5 }, auditor.client.cookie ?? '')).status,
    ).toBe(403);
    const other = await signupOrg(t.app, 'Other');
    expect((await getSms(q, other.admin.cookie ?? '')).status).toBe(404);
    expect(
      (await putSms(q, { enabled: true, daily_cap: 5 }, other.admin.cookie ?? '')).status,
    ).toBe(404);
    // the provider mode comes from the deployment only: the browser cannot send one
    expect((await putSms(q, { enabled: true, daily_cap: 5, mode: 'live' })).status).toBe(400);
    expect((await putSms(q, { enabled: true, daily_cap: 0 })).status).toBe(400);
    expect(
      (
        await inject('PUT', `/api/v1/facilities/${q.fid}/ussd`, {
          cookie: q.org.admin.cookie ?? '',
          body: { enabled: true, mode: 'live' },
        })
      ).status,
    ).toBe(400);
  });

  it('a deployment without SMS or USSD reports off; nothing claims to work', async () => {
    const q = await setupQueue(off.app, { counters: 1 });
    const s = await inject('GET', `/api/v1/facilities/${q.fid}/sms`, {
      app: off,
      cookie: q.org.admin.cookie ?? '',
    });
    expect(smsOf(s)).toMatchObject({ deployment_mode: 'off', deployment_available: false });
    const u = await inject('GET', `/api/v1/facilities/${q.fid}/ussd`, {
      app: off,
      cookie: q.org.admin.cookie ?? '',
    });
    expect(u.body['ussd']).toMatchObject({ deployment_mode: 'off', deployment_available: false });
  });
});

// ---------------------------------------------------------------------------------------------
describe('delayed enqueue (API hook)', () => {
  it('immediate by default: due at once, not skippable', async () => {
    const q = await smsQueue();
    const v = await joinWithSms(q);
    await callNext(q);
    expect(await outboxOf(v.ticketId)).toMatchObject({ delay: 0, skip: false, status: 'pending' });
  });

  it('with a delay: due after it (database time) and skippable; the call itself is unchanged', async () => {
    const q = await smsQueue();
    expect((await putSms(q, { enabled: true, daily_cap: 50, delay_seconds: 45 })).status).toBe(200);
    const v = await joinWithSms(q);
    const [before] = await t.db<
      { n: number }[]
    >`SELECT COUNT(*)::int AS n FROM queue_events WHERE queue_session_id = ${q.queueId}`;
    await callNext(q);
    expect(await outboxOf(v.ticketId)).toMatchObject({ delay: 45, skip: true, status: 'pending' });
    const [after] = await t.db<
      { n: number }[]
    >`SELECT COUNT(*)::int AS n FROM queue_events WHERE queue_session_id = ${q.queueId}`;
    expect((after?.n ?? 0) - (before?.n ?? 0)).toBe(1);
    const [tk] = await t.db<
      { state: string }[]
    >`SELECT state FROM tickets WHERE id = ${v.ticketId}`;
    expect(tk?.state).toBe('called');
  });

  it('a turn-alert TTL lowered after the facility saved its delay makes the hook send immediately; a delay still within the new bound is kept', async () => {
    // saved under TTL 120 s (bound 90 s)
    const tooLong = await smsQueue(2);
    expect(
      (await putSms(tooLong, { enabled: true, daily_cap: 50, delay_seconds: 80 })).status,
    ).toBe(200);
    const stillOk = await smsQueue();
    expect(
      (await putSms(stillOk, { enabled: true, daily_cap: 50, delay_seconds: 25 })).status,
    ).toBe(200);
    // the deployment restarts with TTL 60 s: bound 30 s (the hook is process-wide)
    const lowered = await createTestApp({ ...ON, TURN_ALERT_TTL_SECONDS: '60' });
    try {
      const a = await joinWithSms(tooLong);
      const seqA = await callNext(tooLong);
      expect(await outboxOf(a.ticketId)).toMatchObject({
        delay: 0,
        skip: false,
        status: 'pending',
      });
      const b = await joinWithSms(stillOk);
      const seqB = await callNext(stillOk);
      expect(await outboxOf(b.ticketId)).toMatchObject({
        delay: 25,
        skip: true,
        status: 'pending',
      });
      // the event-specific idempotency key is unchanged either way
      const keys = await t.db<{ dedup_key: string }[]>`
        SELECT o.dedup_key FROM notification_outbox o JOIN notifications n ON n.id = o.notification_id
         WHERE n.ticket_id IN (${a.ticketId}, ${b.ticketId}) AND n.channel = 'sms'
         ORDER BY o.dedup_key`;
      expect(keys.map((k) => k.dedup_key).sort()).toEqual(
        [
          `sms:ticket.called:${a.ticketId}:${seqA}`,
          `sms:ticket.called:${b.ticketId}:${seqB}`,
        ].sort(),
      );
    } finally {
      await lowered.close();
    }
    // closing that app hands the TTL back (120 s): the 80 s delay is honoured again
    const c = await joinWithSms(tooLong);
    await callNext(tooLong, 1);
    expect(await outboxOf(c.ticketId)).toMatchObject({ delay: 80, skip: true });
  });

  it('a later, stricter no-show policy makes the hook send immediately (never after a no-show)', async () => {
    const q = await smsQueue();
    expect((await putSms(q, { enabled: true, daily_cap: 50, delay_seconds: 80 })).status).toBe(200);
    await autoMiss(q, 60); // 80 s + margin no longer fits before the 60 s no-show
    const v = await joinWithSms(q);
    await callNext(q);
    expect(await outboxOf(v.ticketId)).toMatchObject({ delay: 0, skip: false });
  });
});

// ---------------------------------------------------------------------------------------------
describe('POST /tickets/:code/alerts/seen (in-app acknowledgement)', () => {
  it('the ticket’s token and its current call sequence record it once; repeats are no-ops; nothing in the queue changes', async () => {
    const q = await smsQueue();
    const v = await joinWithSms(q);
    const seq = await callNext(q);
    const url = `/api/v1/tickets/${v.code}/alerts/seen`;
    const events = async (): Promise<number> =>
      (
        await t.db<
          { n: number }[]
        >`SELECT COUNT(*)::int AS n FROM queue_events WHERE queue_session_id = ${q.queueId}`
      )[0]?.n ?? -1;
    const before = await events();
    for (let i = 0; i < 3; i++) {
      expect(
        (await inject('POST', url, { token: v.token, body: { event_sequence: seq } })).status,
      ).toBe(204);
    }
    const rows =
      await t.db`SELECT event_sequence FROM turn_alert_seen WHERE ticket_id = ${v.ticketId}`;
    expect(rows).toEqual([{ event_sequence: seq }]);
    expect(await events()).toBe(before);
    const [tk] = await t.db<
      { state: string }[]
    >`SELECT state FROM tickets WHERE id = ${v.ticketId}`;
    expect(tk?.state).toBe('called');
  });

  it('another sequence, a ticket not called, a missing or wrong token, a staff session or a missing CSRF header record nothing', async () => {
    const q = await smsQueue();
    const v = await joinWithSms(q);
    const url = `/api/v1/tickets/${v.code}/alerts/seen`;
    // waiting, not called
    expect(
      (await inject('POST', url, { token: v.token, body: { event_sequence: 1 } })).status,
    ).toBe(409);
    const seq = await callNext(q);
    expect(
      (await inject('POST', url, { token: v.token, body: { event_sequence: seq + 1 } })).status,
    ).toBe(409);
    expect((await inject('POST', url, { body: { event_sequence: seq } })).status).toBe(404);
    expect(
      (await inject('POST', url, { token: randomSecret(), body: { event_sequence: seq } })).status,
    ).toBe(404);
    expect(
      (
        await inject('POST', url, {
          cookie: q.org.admin.cookie ?? '',
          body: { event_sequence: seq },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await inject('POST', url, {
          token: v.token,
          body: { event_sequence: seq },
          headers: { 'x-qb-csrf': '' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await inject('POST', url, { token: v.token, body: { event_sequence: seq, extra: 1 } }))
        .status,
    ).toBe(400);
    expect(await t.db`SELECT 1 FROM turn_alert_seen WHERE ticket_id = ${v.ticketId}`).toHaveLength(
      0,
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('SMS monitoring', () => {
  const monitor = (q: QueueFixture, cookie: string, query = ''): Promise<Res> =>
    inject('GET', `/api/v1/facilities/${q.fid}/sms/monitor${query}`, { cookie });

  it('shows states exactly as recorded (sent ≠ delivered, receipts only), newest first, in bounded pages', async () => {
    const q = await smsQueue(3);
    const tickets = [];
    for (let i = 0; i < 3; i++) {
      tickets.push(await joinWithSms(q));
    }
    for (let i = 0; i < 3; i++) await callNext(q, i);
    // as the worker and a receipt would record them
    const [a, b] = tickets;
    const [na] = await t.db<{ id: string; dedup: string }[]>`
      SELECT n.id, o.dedup_key AS dedup FROM notifications n JOIN notification_outbox o ON o.notification_id = n.id WHERE n.ticket_id = ${a?.ticketId ?? ''}`;
    await t.db`UPDATE notifications SET status = 'sent', detail_code = 'accepted', provider = 'sandbox',
               provider_message_id = ${sandboxMessageId(na?.dedup ?? '')}, send_started_at = NOW() WHERE id = ${na?.id ?? ''}`;
    await t.db`UPDATE notification_outbox SET attempt_count = 1, processed_at = NOW() WHERE notification_id = ${na?.id ?? ''}`;
    const raw = JSON.stringify({
      kind: 'receipt',
      message_id: sandboxMessageId(na?.dedup ?? ''),
      status: 'delivered',
    });
    const hook = await t.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/sms/sandbox',
      headers: { 'content-type': 'application/json', ...signSmsWebhook(SMS_SECRET, raw) },
      payload: raw,
    });
    expect(hook.statusCode).toBe(200);
    await t.db`UPDATE notifications SET status = 'failed', detail_code = 'cap' WHERE ticket_id = ${b?.ticketId ?? ''} AND channel = 'sms'`;
    const page1 = await monitor(q, q.org.admin.cookie ?? '', '?limit=2');
    expect(page1.status).toBe(200);
    const m = page1.body['monitor'] as {
      rows: Record<string, unknown>[];
      next: string | null;
      last_24h: Record<string, number>;
    };
    expect(m.rows).toHaveLength(2);
    expect(m.next).toBeTruthy();
    expect(m.last_24h).toMatchObject({ delivered: 1, capped: 1, pending: 1, sent: 0, failed: 0 });
    const page2 = await monitor(
      q,
      q.org.admin.cookie ?? '',
      `?limit=2&before=${encodeURIComponent(m.next ?? '')}`,
    );
    const m2 = page2.body['monitor'] as { rows: Record<string, unknown>[]; next: string | null };
    expect(m2.rows).toHaveLength(1);
    expect(m2.next).toBeNull();
    const all = [...m.rows, ...m2.rows];
    const byCode = Object.fromEntries(all.map((r) => [r['ticket_code'], r]));
    expect(byCode[a?.code ?? '']).toMatchObject({
      status: 'delivered',
      detail_code: 'sandbox_receipt',
      provider_mode: 'sandbox',
      attempts: 1,
    });
    expect(byCode[b?.code ?? '']).toMatchObject({ status: 'failed', detail_code: 'cap' });
    expect(new Set(all.map((r) => r['ticket_code'])).size).toBe(3);
    // newest first
    const times = all.map((r) => String(r['created_at']));
    expect([...times].sort().reverse()).toEqual(times);
    // privacy: no number, hash, message text or internal id
    const dump = JSON.stringify([page1.body, page2.body]);
    expect(dump).not.toMatch(/\+?234\d{6,}|0803\d{7}/);
    expect(dump).not.toContain(a?.ticketId ?? 'x');
    expect(dump).not.toContain(na?.id ?? 'x');
    expect(dump).not.toMatch(/phone|hash|ciphertext|token/i);
  });

  it('is limited to operations roles, scoped to the facility and organization, with validated paging', async () => {
    const q = await smsQueue();
    await joinWithSms(q);
    await callNext(q);
    const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const auditor = await createStaff(t.app, q.org, q.fid, 'auditor');
    expect((await monitor(q, counter.client.cookie ?? '')).status).toBe(403);
    expect((await monitor(q, auditor.client.cookie ?? '')).status).toBe(200);
    const other = await signupOrg(t.app, 'Other');
    expect((await monitor(q, other.admin.cookie ?? '')).status).toBe(404);
    expect((await monitor(q, q.org.admin.cookie ?? '', '?limit=51')).status).toBe(400);
    expect((await monitor(q, q.org.admin.cookie ?? '', '?before=bm90LWEtY3Vyc29y')).status).toBe(
      400,
    );
    expect((await monitor(q, q.org.admin.cookie ?? '', '?extra=1')).status).toBe(400);
    // another facility of the same organization sees none of these rows
    const q2 = await setupQueue(t.app, { counters: 1, org: q.org });
    const empty = await monitor(q2, q.org.admin.cookie ?? '');
    expect((empty.body['monitor'] as { rows: unknown[] }).rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('USSD monitoring', () => {
  async function dial(session: string, msisdn: string, text: string): Promise<string> {
    const raw = JSON.stringify({ session_id: session, msisdn, text });
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/ussd/sandbox',
      headers: { 'content-type': 'application/json', ...signUssdWebhook(USSD_SECRET, raw) },
      payload: raw,
    });
    return r.body;
  }
  const monitor = (q: QueueFixture, cookie: string): Promise<Res> =>
    inject('GET', `/api/v1/facilities/${q.fid}/ussd/monitor`, { cookie });

  it('counts only what the sessions record: a join, a menu end, an expiry (never as a join), an active session; facility-scoped; nothing sensitive', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const set = await inject('PUT', `/api/v1/facilities/${q.fid}/ussd`, {
      cookie: q.org.admin.cookie ?? '',
      body: { enabled: true },
    });
    const code = String((set.body['ussd'] as { access_code: string }).access_code);
    const msisdn = (): string =>
      `+234803${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
    // a join
    const j = `sess_${randomBytes(6).toString('hex')}`;
    const p = msisdn();
    for (const text of ['', code, `${code}*1`, `${code}*1*1`, `${code}*1*1*1`])
      await dial(j, p, text);
    // a menu exit
    const x = `sess_${randomBytes(6).toString('hex')}`;
    const px = msisdn();
    for (const text of ['', code, `${code}*0`]) await dial(x, px, text);
    // an expiry: bound to the facility, then timed out
    const e = `sess_${randomBytes(6).toString('hex')}`;
    const pe = msisdn();
    for (const text of ['', code]) await dial(e, pe, text);
    await t.db`UPDATE ussd_sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE facility_id = ${q.fid} AND ended_at IS NULL`;
    // an active one
    const a = `sess_${randomBytes(6).toString('hex')}`;
    const pa = msisdn();
    for (const text of ['', code]) await dial(a, pa, text);
    const r = await monitor(q, q.org.admin.cookie ?? '');
    expect(r.status).toBe(200);
    expect(r.body['monitor']).toEqual({
      sessions: { active: 1, ended_by_menu: 2, expired: 1, out_of_step: 0, joined: 1 },
      tickets_today: 1,
    });
    // a late input on the expired session: still an expiry, still not a join
    await dial(e, pe, `${code}*1`);
    const r2 = await monitor(q, q.org.admin.cookie ?? '');
    expect((r2.body['monitor'] as { sessions: Record<string, number> }).sessions).toMatchObject({
      expired: 1,
      ended_by_menu: 2,
      joined: 1,
    });
    const dump = JSON.stringify(r2.body);
    expect(dump).not.toContain(p.slice(-7));
    expect(dump).not.toContain(j);
    expect(dump).not.toMatch(/hash|state|screen|key/i);
    // another organization's facility counts none of these
    const other = await setupQueue(t.app, { counters: 1 });
    expect((await monitor(other, other.org.admin.cookie ?? '')).body['monitor']).toEqual({
      sessions: { active: 0, ended_by_menu: 0, expired: 0, out_of_step: 0, joined: 0 },
      tickets_today: 0,
    });
    expect((await monitor(q, other.org.admin.cookie ?? '')).status).toBe(404);
    const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    expect((await monitor(q, counter.client.cookie ?? '')).status).toBe(403);
  });
});
