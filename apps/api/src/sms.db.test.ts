import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QueueAction, SMS_CONSENT_VERSION, randomSecret, uuidv7 } from '@queuebridge/contracts';
import { createContactCipher, sandboxMessageId, signSmsWebhook } from '@queuebridge/channels';
import { setSmsAlertFaultForTests, smsAlertEnqueueErrors } from './queue/sms-alerts.js';
import { setTurnAlertFaultForTests } from './queue/turn-alerts.js';
import {
  TEST_ORIGIN,
  TestClient,
  assertEventLogIntact,
  assignCoordinator,
  createStaff,
  createTestApp,
  queueCommand,
  setupContinuity,
  setupQueue,
  signupOrg,
  snapshot,
  syncBatch,
  ticketStatus,
  type QueueFixture,
  type TestApp,
} from './testing/harness.js';

/**
 * M6.1 SMS turn alerts through the API on real PostgreSQL (design §13; REQ-F11.2, F11.5,
 * F11.8–F11.13; Group 10 webhook security; Group 14 invariants for SMS). The worker that SENDS
 * is tested in apps/worker. Here: consent at joining, encrypted storage, committed-only
 * enqueue with savepoint isolation, opt-out, facility setting, webhook authentication, replay
 * defense, receipts, inbound STOP, tenancy, and that nothing here changes queue state.
 */

const SECRET = 'test-only-sms-webhook-secret-0123456789abcdef';
const SMS_ON = {
  SMS_PROVIDER: 'sandbox',
  SMS_DAILY_CAP: '100',
  SMS_WEBHOOK_SECRET: SECRET,
  // every test here turns SMS on from the same address; the limits themselves are tested below
  SMS_RATE_LIMIT_MAX: '1000',
  SMS_WEBHOOK_RATE_LIMIT_MAX: '10000',
};
const cipher = createContactCipher('7e57'.repeat(16))!;
let t: TestApp; // SMS sandbox on
let off: TestApp; // same database, SMS not configured (the production default)

beforeAll(async () => {
  t = await createTestApp(SMS_ON);
  off = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await off.close();
});
afterEach(() => {
  setSmsAlertFaultForTests(null);
  setTurnAlertFaultForTests(null);
});

interface Res {
  status: number;
  body: Record<string, unknown>;
}
async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  o: {
    token?: string;
    body?: unknown;
    app?: TestApp | undefined;
    headers?: Record<string, string>;
    raw?: string;
  } = {},
): Promise<Res> {
  const res = await (o.app ?? t).app.inject({
    method,
    url,
    headers: {
      origin: TEST_ORIGIN,
      'x-qb-csrf': '1',
      ...(o.raw !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(o.token ? { 'x-qb-ticket-token': o.token } : {}),
      ...(o.headers ?? {}),
    },
    ...(o.raw !== undefined
      ? { payload: o.raw }
      : o.body !== undefined
        ? { payload: o.body as object }
        : {}),
  });
  return {
    status: res.statusCode,
    body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {},
  };
}

async function enableSms(
  q: { org: QueueFixture['org']; fid: string },
  cap = 50,
  app = t,
): Promise<Res> {
  const r = await call('PUT', `/api/v1/facilities/${q.fid}/sms`, {
    app,
    body: { enabled: true, daily_cap: cap },
    headers: { cookie: q.org.admin.cookie ?? '' },
  });
  // setup must never fail silently (a refused setup would make "nothing sent" pass vacuously)
  expect(r.status).toBe(200);
  return r;
}

interface Visitor {
  code: string;
  token: string;
  ticketId: string;
  status: number;
  smsAlert: unknown;
}
async function join(
  q: QueueFixture,
  sms: Record<string, unknown> | undefined,
  o: { app?: TestApp; operationId?: string; proof?: string } = {},
): Promise<Visitor & { body: Record<string, unknown> }> {
  const r = await call('POST', `/api/v1/queues/${q.queueId}/join`, {
    app: o.app,
    body: {
      operation_id: o.operationId ?? uuidv7(),
      join_proof: o.proof ?? randomSecret(),
      ...(sms ? { sms } : {}),
    },
  });
  const ticket = (r.body['ticket'] ?? {}) as Record<string, unknown>;
  const code = String(ticket['public_code'] ?? '');
  const [row] = await t.db<{ id: string }[]>`
    SELECT id FROM tickets WHERE queue_session_id = ${q.queueId} AND public_code = ${code}`;
  return {
    status: r.status,
    body: r.body,
    code,
    token: String(ticket['status_token'] ?? ''),
    ticketId: row?.id ?? '',
    smsAlert: ticket['sms_alert'],
  };
}
const optIn = (phone = '0803 123 4567'): Record<string, unknown> => ({
  phone,
  consent: true,
  consent_version: SMS_CONSENT_VERSION,
});
const contact = async (ticketId: string): Promise<Record<string, unknown> | undefined> =>
  (
    await t.db<
      Record<string, unknown>[]
    >`SELECT * FROM visitor_contacts WHERE ticket_id = ${ticketId}`
  )[0];
const smsRows = (
  ticketId: string,
): Promise<
  { dedup_key: string; payload: Record<string, unknown>; status: string; event_sequence: number }[]
> =>
  t.db`
    SELECT o.dedup_key, o.payload, n.status, n.event_sequence
      FROM notification_outbox o JOIN notifications n ON n.id = o.notification_id
     WHERE n.ticket_id = ${ticketId} AND n.channel = 'sms' ORDER BY n.event_sequence`;
const callNext = (q: QueueFixture): ReturnType<typeof queueCommand> =>
  queueCommand(q.org.admin, q.queueId, { action: 'ticket.call_next', counter_id: q.counterIds[0] });
const eventCount = async (queueId: string): Promise<number> =>
  (
    await t.db<
      { n: number }[]
    >`SELECT COUNT(*)::int AS n FROM queue_events WHERE queue_session_id = ${queueId}`
  )[0]?.n ?? 0;

// ---------------------------------------------------------------------------------------------
describe('capability manifest and deployment (D1; design §13.3)', () => {
  it('sandbox with key and cap: sms_turn_alerts sandbox/available; the default deployment: sandbox/unavailable/not_configured', async () => {
    const on = await call('GET', '/api/v1/que/capabilities');
    expect((on.body['capabilities'] as Record<string, unknown>)['sms_turn_alerts']).toMatchObject({
      status: 'sandbox',
      availability: 'available',
    });
    const d = await call('GET', '/api/v1/que/capabilities', { app: off });
    expect((d.body['capabilities'] as Record<string, unknown>)['sms_turn_alerts']).toMatchObject({
      status: 'sandbox',
      availability: 'unavailable',
      unavailableReason: 'not_configured',
    });
    // never `live`: there is no live provider
    expect(JSON.stringify(on.body)).not.toMatch(/"sms_turn_alerts":\{"status":"live"/);
  });

  it('without the encryption key or with a cap of 0, SMS is not offered', async () => {
    for (const over of [{ CONTACT_ENCRYPTION_KEY: '' }, { SMS_DAILY_CAP: '0' }]) {
      const a = await createTestApp({ ...SMS_ON, ...over });
      const r = await call('GET', '/api/v1/que/capabilities', { app: a });
      expect(
        (r.body['capabilities'] as Record<string, Record<string, unknown>>)['sms_turn_alerts']?.[
          'availability'
        ],
      ).toBe('unavailable');
      await a.close();
    }
  });
});

describe('facility SMS setting (admin-only, audited, capped)', () => {
  it('off by default; turning it on needs FACILITY_CONFIGURE and a cap ≥ 1; one audit event per change', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const g = await q.org.admin.get<{ sms: Record<string, unknown> }>(
      `/api/v1/facilities/${q.fid}/sms`,
    );
    expect(g.body.sms).toMatchObject({
      enabled: false,
      daily_cap: 0,
      deployment_mode: 'sandbox',
      deployment_available: true,
    });
    const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    expect(
      (
        await counter.client.request('PUT', `/api/v1/facilities/${q.fid}/sms`, {
          enabled: true,
          daily_cap: 5,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await q.org.admin.request('PUT', `/api/v1/facilities/${q.fid}/sms`, {
          enabled: true,
          daily_cap: 0,
        })
      ).status,
    ).toBe(400);
    expect((await enableSms(q, 20)).status).toBe(200);
    expect((await enableSms(q, 20)).status).toBe(200); // no change: no event
    expect(
      (
        await q.org.admin.request('PUT', `/api/v1/facilities/${q.fid}/sms`, {
          enabled: true,
          daily_cap: 30,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await q.org.admin.request('PUT', `/api/v1/facilities/${q.fid}/sms`, {
          enabled: false,
          daily_cap: 30,
        })
      ).status,
    ).toBe(200);
    const ev = await t.db<{ event_type: string; details: Record<string, unknown> }[]>`
      SELECT event_type, details FROM admin_events WHERE facility_id = ${q.fid} AND event_type LIKE 'sms.%' ORDER BY created_at`;
    expect(ev.map((e) => e.event_type)).toEqual(['sms.enabled', 'sms.cap_changed', 'sms.disabled']);
    expect(ev[0]?.details).toMatchObject({
      daily_cap: 20,
      previous_daily_cap: 0,
      deployment_available: true,
    });
    // another organization: 404 for reading and changing
    const other = await signupOrg(t.app, 'Other SMS Org');
    expect((await other.admin.get(`/api/v1/facilities/${q.fid}/sms`)).status).toBe(404);
    expect(
      (
        await other.admin.request('PUT', `/api/v1/facilities/${q.fid}/sms`, {
          enabled: true,
          daily_cap: 5,
        })
      ).status,
    ).toBe(404);
  });

  it('the database refuses "on" without a cap', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await expect(
      t.db`INSERT INTO facility_sms_settings (facility_id, organization_id, enabled, daily_cap, updated_by)
           VALUES (${q.fid}, ${q.org.organizationId}, TRUE, 0, ${q.org.adminId})`,
    ).rejects.toThrow(/facility_sms_settings_cap_chk/);
  });
});

describe('consent at joining (REQ-F11.9; design §13.2)', () => {
  it('offered only where the facility turned SMS on and the deployment can send', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const pub = (app = t): Promise<Res> =>
      call('GET', `/api/v1/public/facilities/${q.org.slug}/${q.facilitySlug}`, { app });
    expect((await pub()).body['facility']).toMatchObject({ sms_alerts: null });
    await enableSms(q);
    expect((await pub()).body['facility']).toMatchObject({ sms_alerts: 'sandbox' });
    expect((await pub(off)).body['facility']).toMatchObject({ sms_alerts: null });
  });

  it('a join without a number is unchanged; with consent the number is stored encrypted with consent and retention', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await enableSms(q);
    const plain = await join(q, undefined);
    expect(plain.status).toBe(201);
    expect(plain.smsAlert).toBeNull();
    expect(await contact(plain.ticketId)).toBeUndefined();
    const v = await join(q, optIn('0803 123 4567'));
    expect(v.status).toBe(201);
    expect(v.smsAlert).toBe('on');
    const c = await contact(v.ticketId);
    expect(c).toMatchObject({
      consent_version: SMS_CONSENT_VERSION,
      opted_out_at: null,
      facility_id: q.fid,
    });
    expect(String(c?.['phone_ciphertext'])).not.toMatch(/803|1234567/);
    expect(cipher.openPhone(String(c?.['phone_ciphertext']))).toBe('+2348031234567');
    expect(c?.['phone_hash']).toBe(cipher.phoneHash('+2348031234567'));
    const retention =
      (c?.['retention_until'] as Date).getTime() - (c?.['consent_at'] as Date).getTime();
    // the 7-day backstop set on creation (normally the number goes when the visit ends)
    expect(Math.round(retention / 3_600_000)).toBe(168);
    // the visitor's status shows it
    expect((await ticketStatus(t.app, v.code, v.token)).body.status?.['sms_alert']).toBe('on');
    // the number never appears in events, operations, audit or the join response
    expect(JSON.stringify(v.body)).not.toMatch(/803|1234567/);
    for (const table of [
      'queue_events',
      'client_operations',
      'admin_events',
      'notifications',
      'notification_outbox',
    ]) {
      const rows = await t.db
        .unsafe(`SELECT * FROM ${table} WHERE organization_id = $1`, [q.org.organizationId])
        .catch(async () => t.db.unsafe(`SELECT * FROM ${table}`));
      expect(JSON.stringify(rows), table).not.toContain('1234567');
    }
  });

  it('consent must be explicit: unticked, missing or a stale consent version is refused (and nothing is created)', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await enableSms(q);
    const before = await eventCount(q.queueId);
    for (const sms of [
      { phone: '08031234567', consent: false, consent_version: SMS_CONSENT_VERSION },
      { phone: '08031234567', consent_version: SMS_CONSENT_VERSION },
      { phone: '08031234567', consent: true, consent_version: 'sms-consent-v0' },
    ]) {
      expect((await join(q, sms)).status).toBe(400);
    }
    expect(await eventCount(q.queueId)).toBe(before);
  });

  it('an invalid number is refused with a plain message before anything is created', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await enableSms(q);
    const before = await eventCount(q.queueId);
    const r = await join(q, optIn('12345'));
    expect(r.status).toBe(400);
    expect(String(r.body['detail'])).toMatch(/leave it out to join without text messages/);
    expect(await eventCount(q.queueId)).toBe(before);
  });

  it('SMS not offered (facility off or deployment off): the join succeeds and no number is kept', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const a = await join(q, optIn());
    expect(a.status).toBe(201);
    expect(a.smsAlert).toBe('not_available');
    expect(await contact(a.ticketId)).toBeUndefined();
    await enableSms(q);
    const b = await join(q, optIn(), { app: off });
    expect(b.status).toBe(201);
    expect(b.smsAlert).toBe('not_available');
    expect(await contact(b.ticketId)).toBeUndefined();
  });

  it('a replayed join keeps one contact (idempotent per ticket)', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await enableSms(q);
    const ids = { operationId: uuidv7(), proof: randomSecret() };
    const a = await join(q, optIn('08031234567'), ids);
    const b = await join(q, optIn('08099999999'), ids);
    expect(b.status).toBe(200);
    expect(b.code).toBe(a.code);
    expect(b.smsAlert).toBe('on');
    const rows = await t.db`SELECT * FROM visitor_contacts WHERE ticket_id = ${a.ticketId}`;
    expect(rows).toHaveLength(1);
    expect(cipher.openPhone(String(rows[0]?.['phone_ciphertext']))).toBe('+2348031234567');
  });
});

describe('committed calls enqueue one SMS (REQ-F11.8; design §13.1)', () => {
  it('one outbox row with the approved key and no number in the payload; repeat and replay add none; a re-call adds one', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await enableSms(q);
    const v = await join(q, optIn());
    const op = uuidv7();
    const body = { operation_id: op, action: 'ticket.call_next', counter_id: q.counterIds[0] };
    const c1 = await q.org.admin.post<{ outcome: { server_sequence: number } }>(
      `/api/v1/queues/${q.queueId}/commands`,
      body,
    );
    const seq = c1.body.outcome.server_sequence;
    let rows = await smsRows(v.ticketId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dedup_key: `sms:ticket.called:${v.ticketId}:${seq}`,
      status: 'pending',
      event_sequence: seq,
    });
    expect(Object.keys(rows[0]?.payload ?? {}).sort()).toEqual([
      'contact_id',
      'counter_id',
      'event_sequence',
      'facility_id',
      'skip_if_seen',
      'ticket_id',
    ]);
    // M6.3: no delay configured, so the alert is never skipped for a seen in-app alert
    expect(rows[0]?.payload['skip_if_seen']).toBe(false);
    expect(JSON.stringify(rows[0]?.payload)).not.toContain('1234567');
    // replaying the same command (duplicate disposition) enqueues nothing
    const replay = await q.org.admin.post<{ outcome: { disposition: string } }>(
      `/api/v1/queues/${q.queueId}/commands`,
      body,
    );
    expect(replay.body.outcome.disposition).toBe('duplicate');
    expect(await smsRows(v.ticketId)).toHaveLength(1);
    // recall then call again: a new committed call event, a new key
    await queueCommand(q.org.admin, q.queueId, {
      action: QueueAction.TICKET_RESUME,
      ticket_id: v.ticketId,
    });
    await callNext(q);
    rows = await smsRows(v.ticketId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.dedup_key)).size).toBe(2);
  });

  it('nothing is enqueued without a contact, after opt-out, or with the facility switched off', async () => {
    // One queue per case, and each call must really call THAT ticket (a busy counter would make
    // the "nothing enqueued" assertion pass for the wrong reason)
    const called = async (q: QueueFixture, ticketId: string): Promise<void> => {
      const c = await callNext(q);
      expect(c.body.outcome?.disposition).toBe('committed');
      expect(c.body.outcome?.ticket_id).toBe(ticketId);
    };
    const q1 = await setupQueue(t.app, { counters: 1 });
    await enableSms(q1);
    const none = await join(q1, undefined);
    await called(q1, none.ticketId);
    expect(await smsRows(none.ticketId)).toEqual([]);

    const q2 = await setupQueue(t.app, { counters: 1 });
    await enableSms(q2);
    const out = await join(q2, optIn());
    expect(
      (await call('POST', `/api/v1/tickets/${out.code}/sms/opt-out`, { token: out.token })).status,
    ).toBe(200);
    await called(q2, out.ticketId);
    expect(await smsRows(out.ticketId)).toEqual([]);

    const q3 = await setupQueue(t.app, { counters: 1 });
    await enableSms(q3);
    const later = await join(q3, optIn('08051234567'));
    await q3.org.admin.request('PUT', `/api/v1/facilities/${q3.fid}/sms`, {
      enabled: false,
      daily_cap: 50,
    });
    await called(q3, later.ticketId);
    expect(await smsRows(later.ticketId)).toEqual([]);

    // control: the same flow with SMS on and a contact does enqueue
    const q4 = await setupQueue(t.app, { counters: 1 });
    await enableSms(q4);
    const yes = await join(q4, optIn('08051234568'));
    await called(q4, yes.ticketId);
    expect(await smsRows(yes.ticketId)).toHaveLength(1);
  });
  it('a failing SMS hook (real SQL error in its savepoint) cannot fail the call, and push still enqueues', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await enableSms(q);
    const v = await join(q, optIn());
    setSmsAlertFaultForTests(async (sp) => {
      await sp`SELECT 1 / 0`;
    });
    const before = smsAlertEnqueueErrors();
    const c = await callNext(q);
    expect(c.status).toBe(200);
    expect(c.body.outcome?.disposition).toBe('committed');
    expect(smsAlertEnqueueErrors()).toBe(before + 1);
    expect(await smsRows(v.ticketId)).toEqual([]);
    const [tk] = await t.db<
      { state: string }[]
    >`SELECT state FROM tickets WHERE id = ${v.ticketId}`;
    expect(tk?.state).toBe('called');
    await assertEventLogIntact(t.db, q.queueId);
  });

  it('a failing push hook does not stop the SMS enqueue (independent channels)', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await enableSms(q);
    const v = await join(q, optIn());
    setTurnAlertFaultForTests(async (sp) => {
      await sp`SELECT 1 / 0`;
    });
    expect((await callNext(q)).status).toBe(200);
    expect(await smsRows(v.ticketId)).toHaveLength(1);
  });

  it('an offline call enqueues only once its sync batch commits; a fenced call enqueues nothing', async () => {
    const f = await setupContinuity(t.app, { counters: 1 });
    await enableSms({ org: f.org, fid: f.fid });
    const v = await join(f, optIn());
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const auth = await f.authorityFor(f.counter);
    const snap = await snapshot(f.counter.client, f.queueId, f.counter.deviceId);
    expect(await smsRows(v.ticketId)).toEqual([]);
    const res = await syncBatch(
      f.counter.client,
      [
        f.cmd(
          f.counter,
          QueueAction.TICKET_CALL_NEXT,
          { counter_id: f.counterIds[0], ticket_id: v.ticketId },
          { epoch: 1, baseRevision: snap.body.snapshot.revision },
        ),
      ],
      [auth],
    );
    expect(res.body.results[0]?.disposition).toBe('committed');
    const rows = await smsRows(v.ticketId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_sequence).toBe(res.body.results[0]?.server_sequence);
    const w = await join(f, optIn('08061234567'));
    const stale = await syncBatch(
      f.counter.client,
      [
        f.cmd(
          f.counter,
          QueueAction.TICKET_CALL_NEXT,
          { counter_id: f.counterIds[0], ticket_id: w.ticketId },
          { epoch: 0 },
        ),
      ],
      [auth],
    );
    expect(['rejected', 'needs_review']).toContain(stale.body.results[0]?.disposition);
    expect(await smsRows(w.ticketId)).toEqual([]);
  });

  it('a service transfer moves the contact to the destination ticket, which then alerts', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const dest = await setupQueue(t.app, {
      counters: 1,
      org: q.org,
      fid: q.fid,
      facilitySlug: q.facilitySlug,
    });
    await enableSms(q);
    const v = await join(q, optIn());
    const tr = await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.transfer',
      ticket_id: v.ticketId,
      destination_service_id: dest.serviceId,
      reason_code: 'needs_other_service',
    });
    const destTicket = tr.body.outcome?.ticket_id ?? '';
    expect(await contact(v.ticketId)).toBeUndefined();
    expect((await contact(destTicket))?.['phone_ciphertext']).toBeTruthy();
    await callNext(dest);
    expect(await smsRows(destTicket)).toHaveLength(1);
  });
});

describe('opt-out (REQ-F11.9)', () => {
  it('the visitor stops SMS from the ticket page: number erased at once, idempotent, token required', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await enableSms(q);
    const v = await join(q, optIn());
    expect(
      (await call('POST', `/api/v1/tickets/${v.code}/sms/opt-out`, { token: randomSecret() }))
        .status,
    ).toBe(404);
    const r = await call('POST', `/api/v1/tickets/${v.code}/sms/opt-out`, { token: v.token });
    expect(r).toEqual({ status: 200, body: { sms_alert: 'off' } });
    expect(await contact(v.ticketId)).toMatchObject({
      phone_ciphertext: null,
      phone_hash: null,
      opt_out_source: 'visitor',
    });
    expect(
      (await call('POST', `/api/v1/tickets/${v.code}/sms/opt-out`, { token: v.token })).body,
    ).toEqual({ sms_alert: 'off' });
    expect((await ticketStatus(t.app, v.code, v.token)).body.status?.['sms_alert']).toBe('off');
  });

  it('staff at the desk can stop SMS (WALK_IN roles), audited without the number; auditors and other tenants cannot', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await enableSms(q);
    const v = await join(q, optIn());
    const url = `/api/v1/queues/${q.queueId}/tickets/${v.ticketId}/sms/opt-out`;
    const auditor = await createStaff(t.app, q.org, q.fid, 'auditor');
    expect((await auditor.client.post(url, {})).status).toBe(403);
    const other = await signupOrg(t.app, 'Other Org SMS');
    expect((await other.admin.post(url, {})).status).toBe(404);
    const reception = await createStaff(t.app, q.org, q.fid, 'staff_reception');
    const r = await reception.client.post<{ sms_alert: string }>(url, {});
    expect(r.status).toBe(200);
    expect(r.body.sms_alert).toBe('off');
    const [ev] = await t.db<
      { event_type: string; target_id: string; details: unknown; actor_id: string }[]
    >`
      SELECT event_type, target_id, details, actor_id FROM admin_events WHERE event_type = 'sms.opted_out' AND target_id = ${v.ticketId}`;
    expect(ev).toMatchObject({
      event_type: 'sms.opted_out',
      actor_id: reception.userId,
      details: { source: 'staff' },
    });
    expect(JSON.stringify(ev)).not.toContain('1234567');
  });

  it('opting out changes no queue state', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await enableSms(q);
    const v = await join(q, optIn());
    const before = await eventCount(q.queueId);
    await call('POST', `/api/v1/tickets/${v.code}/sms/opt-out`, { token: v.token });
    expect(await eventCount(q.queueId)).toBe(before);
  });
});

describe('POST /webhooks/sms/:provider (signature, timestamp, replay, correlation)', () => {
  async function sentNotification(): Promise<{
    q: QueueFixture;
    v: Visitor;
    messageId: string;
    notificationId: string;
  }> {
    const q = await setupQueue(t.app, { counters: 1 });
    await enableSms(q);
    const v = await join(
      q,
      optIn(`0803${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`),
    );
    await callNext(q);
    const [n] = await t.db<{ id: string; dedup_key: string }[]>`
      SELECT n.id, o.dedup_key FROM notifications n JOIN notification_outbox o ON o.notification_id = n.id
       WHERE n.ticket_id = ${v.ticketId} AND n.channel = 'sms'`;
    const messageId = sandboxMessageId(n?.dedup_key ?? '');
    // as the worker records an accepted sandbox send
    await t.db`
      UPDATE notifications SET status = 'sent', detail_code = 'accepted', provider = 'sandbox',
             provider_message_id = ${messageId}, send_started_at = NOW() WHERE id = ${n?.id ?? ''}`;
    return { q, v, messageId, notificationId: n?.id ?? '' };
  }
  const hook = (
    body: unknown,
    o: { headers?: Record<string, string>; provider?: string; app?: TestApp; secret?: string } = {},
  ): Promise<Res> => {
    const raw = JSON.stringify(body);
    return call('POST', `/api/v1/webhooks/sms/${o.provider ?? 'sandbox'}`, {
      app: o.app,
      raw,
      headers: {
        'x-qb-csrf': '',
        origin: '',
        ...signSmsWebhook(o.secret ?? SECRET, raw),
        ...(o.headers ?? {}),
      },
    });
  };
  const status = async (
    id: string,
  ): Promise<{ status: string; detail_code: string | null } | undefined> =>
    (
      await t.db<
        { status: string; detail_code: string | null }[]
      >`SELECT status, detail_code FROM notifications WHERE id = ${id}`
    )[0];

  it('a signed sandbox receipt marks the message delivered (simulated) exactly once', async () => {
    const s = await sentNotification();
    const r = await hook({ kind: 'receipt', message_id: s.messageId, status: 'delivered' });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(await status(s.notificationId)).toEqual({
      status: 'delivered',
      detail_code: 'sandbox_receipt',
    });
    // the same receipt again (a new nonce): no change, no second delivery row
    await hook({ kind: 'receipt', message_id: s.messageId, status: 'delivered' });
    // a late failure never downgrades delivered
    await hook({ kind: 'receipt', message_id: s.messageId, status: 'failed' });
    expect((await status(s.notificationId))?.status).toBe('delivered');
    const d =
      await t.db`SELECT receipt_status FROM notification_deliveries WHERE notification_id = ${s.notificationId} AND receipt_status = 'delivered'`;
    expect(d).toHaveLength(1);
    // staff see it, labelled as sandbox
    await s.q.org.admin.get(`/api/v1/queues/${s.q.queueId}/alerts`).then((a) => {
      const alert = (a.body['alerts'] as Record<string, unknown>[]).find(
        (x) => x['ticket_id'] === s.v.ticketId,
      );
      expect(alert?.['sms']).toMatchObject({
        state: 'delivered',
        detail_code: 'sandbox_receipt',
        sandbox: true,
      });
      expect(alert?.['sms_active']).toBe(true);
    });
  });

  it('failed and unknown receipts follow the allowed transitions', async () => {
    const s = await sentNotification();
    await hook({ kind: 'receipt', message_id: s.messageId, status: 'unknown' });
    expect((await status(s.notificationId))?.status).toBe('unknown');
    await hook({ kind: 'receipt', message_id: s.messageId, status: 'failed' });
    expect((await status(s.notificationId))?.status).toBe('failed');
    await hook({ kind: 'receipt', message_id: s.messageId, status: 'delivered' });
    expect((await status(s.notificationId))?.status).toBe('delivered');
  });

  it('refuses a bad signature (401), a stale or future timestamp (401), and a replayed nonce (409)', async () => {
    const s = await sentNotification();
    const body = { kind: 'receipt', message_id: s.messageId, status: 'delivered' };
    expect((await hook(body, { secret: 'a-different-secret-of-at-least-32-chars!' })).status).toBe(
      401,
    );
    const raw = JSON.stringify(body);
    for (const ts of [Math.floor(Date.now() / 1000) - 600, Math.floor(Date.now() / 1000) + 600]) {
      const r = await call('POST', '/api/v1/webhooks/sms/sandbox', {
        raw,
        headers: signSmsWebhook(SECRET, raw, { timestamp: ts }),
      });
      expect(r.status).toBe(401);
    }
    // body changed after signing
    const signed = signSmsWebhook(SECRET, raw);
    const tampered = await call('POST', '/api/v1/webhooks/sms/sandbox', {
      raw: raw.replace('delivered', 'failed'),
      headers: signed,
    });
    expect(tampered.status).toBe(401);
    const once = signSmsWebhook(SECRET, raw);
    expect(
      (await call('POST', '/api/v1/webhooks/sms/sandbox', { raw, headers: once })).status,
    ).toBe(200);
    expect(
      (await call('POST', '/api/v1/webhooks/sms/sandbox', { raw, headers: once })).status,
    ).toBe(409);
  });

  it('refuses malformed requests (400) before checking the signature, and unknown events after it (422)', async () => {
    expect(
      (
        await call('POST', '/api/v1/webhooks/sms/sandbox', {
          raw: '{not json',
          headers: signSmsWebhook(SECRET, '{not json'),
        })
      ).status,
    ).toBe(400);
    const raw = JSON.stringify({ kind: 'receipt', message_id: 'sbx_x1234', status: 'delivered' });
    expect((await call('POST', '/api/v1/webhooks/sms/sandbox', { raw })).status).toBe(400); // no signature headers
    expect((await hook({ kind: 'promo', text: 'hi' })).status).toBe(422);
  });

  it('an unknown message id gives the same 200 (no existence oracle) and changes nothing', async () => {
    const r = await hook({ kind: 'receipt', message_id: 'sbx_doesnotexist', status: 'delivered' });
    expect(r).toEqual({ status: 200, body: { ok: true } });
  });

  it('provider isolation: another provider name, or a deployment without SMS, is 404', async () => {
    expect(
      (
        await hook(
          { kind: 'receipt', message_id: 'sbx_x1234', status: 'delivered' },
          { provider: 'termii' },
        )
      ).status,
    ).toBe(404);
    expect(
      (await hook({ kind: 'receipt', message_id: 'sbx_x1234', status: 'delivered' }, { app: off }))
        .status,
    ).toBe(404);
  });

  it('the webhook needs no browser CSRF header and ignores any session cookie', async () => {
    const s = await sentNotification();
    const raw = JSON.stringify({ kind: 'receipt', message_id: s.messageId, status: 'delivered' });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/sms/sandbox',
      headers: {
        'content-type': 'application/json',
        cookie: s.q.org.admin.cookie ?? '',
        ...signSmsWebhook(SECRET, raw),
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------------------------
  // Inbound STOP: tenant-scoped (M6.1 pre-PR review, 2026-11-20). Every tenant sends from one
  // deployment-wide sender, so the inbound message names no organization; the STOP applies only
  // to the single organization whose message this deployment handed to this provider for this
  // number during an active visit, and to nothing when that is ambiguous or absent.
  // Numbers are fresh per test: contacts persist in the shared test database across runs.
  // -------------------------------------------------------------------------------------------
  const freshPhone = (): { national: string; e164: string } => {
    const n = String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
    return { national: `0807${n}`, e164: `+234807${n}` };
  };
  /** A consented visitor of `q` with `phone`; `messaged`: called, and the send recorded as the worker does. */
  async function visitorWith(
    q: QueueFixture,
    phone: string,
    o: { messaged?: boolean; provider?: string } = {},
  ): Promise<Visitor> {
    const v = await join(q, optIn(phone));
    expect(v.status).toBe(201);
    if (o.messaged) {
      expect((await callNext(q)).status).toBe(200);
      const n = await t.db`
        UPDATE notifications SET status = 'sent', detail_code = 'accepted',
               provider = ${o.provider ?? 'sandbox'}, send_started_at = NOW()
         WHERE ticket_id = ${v.ticketId} AND channel = 'sms' RETURNING id`;
      expect(n.length).toBe(1);
    }
    return v;
  }
  async function smsQueue(): Promise<QueueFixture> {
    const q = await setupQueue(t.app, { counters: 1 });
    await enableSms(q);
    return q;
  }
  const stop = (from: string, body = 'STOP'): Promise<Res> =>
    hook({ kind: 'inbound', message_id: `in_${randomSecret().slice(0, 20)}`, from, body });
  const holdsNumber = async (v: Visitor): Promise<boolean> =>
    Boolean((await contact(v.ticketId))?.['phone_ciphertext']);

  it('STOP opts out only the organization that messaged the number; another tenant with the same number keeps it', async () => {
    const p = freshPhone();
    const qa = await smsQueue();
    const qb = await smsQueue(); // a different organization (setupQueue signs up a new one)
    expect(qb.org.organizationId).not.toBe(qa.org.organizationId);
    const aCalled = await visitorWith(qa, p.national, { messaged: true });
    const aWaiting = await visitorWith(qa, p.national); // same organization, not yet messaged
    const bWaiting = await visitorWith(qb, p.national); // other organization, same number
    const r = await stop(p.e164, 'Stop');
    expect(r).toEqual({ status: 200, body: { ok: true } });
    for (const v of [aCalled, aWaiting]) {
      expect(await contact(v.ticketId)).toMatchObject({
        opt_out_source: 'keyword',
        phone_ciphertext: null,
        phone_hash: null,
      });
    }
    expect(await holdsNumber(bWaiting)).toBe(true);
    expect((await contact(bWaiting.ticketId))?.['opted_out_at']).toBeNull();
    // other words are not STOP and change nothing
    const q = freshPhone();
    const c = await visitorWith(await smsQueue(), q.national, { messaged: true });
    await stop(q.e164, 'thanks');
    expect(await holdsNumber(c)).toBe(true);
  });

  it('ambiguous (two organizations messaged the number): nothing changes anywhere, same response', async () => {
    const p = freshPhone();
    const a = await visitorWith(await smsQueue(), p.national, { messaged: true });
    const b = await visitorWith(await smsQueue(), p.national, { messaged: true });
    expect(await stop(p.e164)).toEqual({ status: 200, body: { ok: true } });
    expect(await holdsNumber(a)).toBe(true);
    expect(await holdsNumber(b)).toBe(true);
    // the supported alternative still works per ticket (visitor page)
    const r = await call('POST', `/api/v1/tickets/${a.code}/sms/opt-out`, { token: a.token });
    expect(r.status).toBe(200);
    expect(await holdsNumber(a)).toBe(false);
    expect(await holdsNumber(b)).toBe(true);
  });

  it('no message sent to the number (or only through another provider): nothing changes', async () => {
    const p = freshPhone();
    const waiting = await visitorWith(await smsQueue(), p.national);
    expect(await stop(p.e164)).toEqual({ status: 200, body: { ok: true } });
    expect(await holdsNumber(waiting)).toBe(true);
    // a message handed to a different provider is not evidence for this provider's reply
    const q = freshPhone();
    const other = await visitorWith(await smsQueue(), q.national, {
      messaged: true,
      provider: 'other-provider',
    });
    await stop(q.e164);
    expect(await holdsNumber(other)).toBe(true);
    // a queued but never started send is not evidence either
    const r = freshPhone();
    const q3 = await smsQueue();
    const queued = await visitorWith(q3, r.national);
    expect((await callNext(q3)).status).toBe(200);
    await stop(r.e164);
    expect(await holdsNumber(queued)).toBe(true);
    // nor one the provider did not accept: waiting to retry (the worker clears the send marker
    // and keeps the provider) or definitively rejected (marker kept, `failed`)
    for (const [status, started] of [
      ['pending', false],
      ['failed', true],
    ] as const) {
      const ph = freshPhone();
      const v = await visitorWith(await smsQueue(), ph.national, { messaged: true });
      if (started) {
        await t.db`
          UPDATE notifications SET status = 'failed', detail_code = 'rejected'
           WHERE ticket_id = ${v.ticketId} AND channel = 'sms'`;
      } else {
        await t.db`
          UPDATE notifications SET status = ${status}, detail_code = NULL, send_started_at = NULL
           WHERE ticket_id = ${v.ticketId} AND channel = 'sms'`;
      }
      await stop(ph.e164);
      expect(await holdsNumber(v), status).toBe(true);
    }
  });

  it('abuse: forged, replayed, stale and wrong-provider STOPs change nothing; unknown numbers get the same answer', async () => {
    const p = freshPhone();
    const v = await visitorWith(await smsQueue(), p.national, { messaged: true });
    const body = { kind: 'inbound', message_id: 'in_abuse_0001', from: p.e164, body: 'STOP' };
    // forged: signed with a different secret
    expect((await hook(body, { secret: 'x'.repeat(48) })).status).toBe(401);
    // stale: a timestamp outside the window
    const raw = JSON.stringify(body);
    const stale = signSmsWebhook(SECRET, raw, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect((await hook(body, { headers: stale })).status).toBe(401);
    // another provider name is not a route
    expect((await hook(body, { provider: 'termii' })).status).toBe(404);
    expect(await holdsNumber(v)).toBe(true);
    // a valid STOP applies; replaying its exact request (same nonce) is refused
    const headers = signSmsWebhook(SECRET, raw);
    expect((await hook(body, { headers })).status).toBe(200);
    expect(await holdsNumber(v)).toBe(false);
    expect((await hook(body, { headers })).status).toBe(409);
    // a number with no contact at all: indistinguishable answer
    expect(await stop(freshPhone().e164)).toEqual({ status: 200, body: { ok: true } });
  });

  it('concurrent STOPs for one number apply once to one tenant and never spill into another', async () => {
    const p = freshPhone();
    const qa = await smsQueue();
    const a1 = await visitorWith(qa, p.national, { messaged: true });
    const a2 = await visitorWith(qa, p.national);
    const b = await visitorWith(await smsQueue(), p.national);
    const results = await Promise.all(Array.from({ length: 12 }, () => stop(p.e164)));
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(200));
    expect(await holdsNumber(a1)).toBe(false);
    expect(await holdsNumber(a2)).toBe(false);
    expect(await holdsNumber(b)).toBe(true);
    // applied once: a later STOP never re-stamps the opt-out (and still reaches nobody else)
    const before = [
      (await contact(a1.ticketId))?.['opted_out_at'],
      (await contact(a2.ticketId))?.['opted_out_at'],
    ];
    expect(before.every((d) => d instanceof Date)).toBe(true);
    await stop(p.e164);
    expect([
      (await contact(a1.ticketId))?.['opted_out_at'],
      (await contact(a2.ticketId))?.['opted_out_at'],
    ]).toEqual(before);
    expect(await holdsNumber(b)).toBe(true);
  });

  it('a STOP racing staff and visitor opt-outs ends with every targeted contact opted out exactly once', async () => {
    const p = freshPhone();
    const qa = await smsQueue();
    const a = await visitorWith(qa, p.national, { messaged: true });
    const staffUrl = `/api/v1/queues/${qa.queueId}/tickets/${a.ticketId}/sms/opt-out`;
    const [s1, s2, s3] = await Promise.all([
      stop(p.e164),
      call('POST', `/api/v1/tickets/${a.code}/sms/opt-out`, { token: a.token }),
      call('POST', staffUrl, { headers: { cookie: qa.org.admin.cookie ?? '' } }),
    ]);
    expect([s1.status, s2.status, s3.status]).toEqual([200, 200, 200]);
    const c = await contact(a.ticketId);
    expect(c?.['phone_ciphertext']).toBeNull();
    expect(['keyword', 'visitor', 'staff']).toContain(c?.['opt_out_source']);
    // at most one staff audit event (only if the staff opt-out was the one that applied)
    const audits = await t.db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM admin_events
       WHERE event_type = 'sms.opted_out' AND target_id = ${a.ticketId}`;
    expect(audits[0]?.n).toBe(c?.['opt_out_source'] === 'staff' ? 1 : 0);
  });

  it('webhooks change no queue state', async () => {
    const s = await sentNotification();
    const before = await eventCount(s.q.queueId);
    await hook({ kind: 'receipt', message_id: s.messageId, status: 'delivered' });
    await hook({ kind: 'inbound', message_id: 'in_00003', from: '+2348031234567', body: 'STOP' });
    expect(await eventCount(s.q.queueId)).toBe(before);
    const [tk] = await t.db<
      { state: string }[]
    >`SELECT state FROM tickets WHERE id = ${s.v.ticketId}`;
    expect(tk?.state).toBe('called');
  });
});

describe('rate limits on SMS routes', () => {
  it('opt-out and setting changes are limited per source; the webhook has its own limit', async () => {
    const small = await createTestApp({
      SMS_PROVIDER: 'sandbox',
      SMS_DAILY_CAP: '10',
      SMS_WEBHOOK_SECRET: SECRET,
      SMS_RATE_LIMIT_MAX: '2',
      SMS_WEBHOOK_RATE_LIMIT_MAX: '2',
    });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        statuses.push(
          (
            await call('POST', '/api/v1/tickets/A001/sms/opt-out', {
              app: small,
              token: randomSecret(),
            })
          ).status,
        );
      }
      expect(statuses).toEqual([404, 404, 429]);
      const raw = JSON.stringify({ kind: 'receipt', message_id: 'sbx_x1234', status: 'delivered' });
      const hooks: number[] = [];
      for (let i = 0; i < 3; i++) {
        hooks.push(
          (
            await call('POST', '/api/v1/webhooks/sms/sandbox', {
              app: small,
              raw,
              headers: signSmsWebhook(SECRET, raw),
            })
          ).status,
        );
      }
      expect(hooks).toEqual([200, 200, 429]);
    } finally {
      await small.close();
    }
  });
});

describe('staff alert view (REQ-F11.13: never "delivered" without a receipt)', () => {
  it('shows the SMS state as recorded, sandbox-labelled, with no number', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    await enableSms(q);
    const v = await join(q, optIn());
    await callNext(q);
    const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const a = await counter.client.get<{ alerts: Record<string, unknown>[] }>(
      `/api/v1/queues/${q.queueId}/alerts`,
    );
    const alert = a.body.alerts.find((x) => x['ticket_id'] === v.ticketId);
    expect(alert?.['sms']).toMatchObject({ state: 'pending', sandbox: true });
    expect(JSON.stringify(a.body)).not.toContain('1234567');
    const other = new TestClient(t.app);
    expect((await other.get(`/api/v1/queues/${q.queueId}/alerts`)).status).toBe(401);
  });
});
