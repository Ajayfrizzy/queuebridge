import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QueueAction, uuidv7 } from '@queuebridge/contracts';
import { generateVapidKeys } from '@queuebridge/channels';
import { setTurnAlertFaultForTests, turnAlertEnqueueErrors } from './queue/turn-alerts.js';
import {
  TEST_ORIGIN,
  assertEventLogIntact,
  assignCoordinator,
  createStaff,
  createTestApp,
  queueCommand,
  setupContinuity,
  setupQueue,
  snapshot,
  syncBatch,
  ticketStatus,
  visitorJoin,
  type QueueFixture,
  type TestApp,
} from './testing/harness.js';

/**
 * M5.4 Smart Turn Alerts through the API on real PostgreSQL (testing steering Group 14: 14.2,
 * 14.3, 14.4, 14.5, 14.7, 14.11, 14.12, 14.13 server side). The worker that SENDS is tested in
 * apps/worker; here: committed-only triggering, one entry per device, savepoint isolation,
 * subscription rules, identity, acknowledgement, revocation and tenancy.
 */

const VAPID = generateVapidKeys();
let t: TestApp;
let off: TestApp; // the same database, with Web Push NOT configured
beforeAll(async () => {
  t = await createTestApp({ VAPID_PUBLIC_KEY: VAPID.publicKey });
  off = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await off.close();
});
afterEach(() => setTurnAlertFaultForTests(null));

// ---------------------------------------------------------------------------------------------

interface Visitor {
  code: string;
  token: string;
  ticketId: string;
}
async function join(q: QueueFixture, app = t): Promise<Visitor> {
  const j = await visitorJoin(app.app, q.queueId);
  const code = j.body.ticket?.public_code ?? '';
  const [row] = await t.db<{ id: string }[]>`
    SELECT id FROM tickets WHERE queue_session_id = ${q.queueId} AND public_code = ${code}`;
  return { code, token: j.body.ticket?.status_token ?? '', ticketId: row?.id ?? '' };
}
const b64u = (n: number): string => randomBytes(n).toString('base64url');
const pushKeys = (): { p256dh: string; auth: string } => ({
  p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'),
  auth: b64u(16),
});
const endpoint = (): string => `https://fcm.googleapis.com/fcm/send/${b64u(24)}`;

interface Res {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}
async function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  o: { token?: string; body?: unknown; app?: TestApp; csrf?: boolean } = {},
): Promise<Res> {
  const res = await (o.app ?? t).app.inject({
    method,
    url,
    headers: {
      origin: TEST_ORIGIN,
      ...(o.csrf === false ? {} : { 'x-qb-csrf': '1' }),
      ...(o.token ? { 'x-qb-ticket-token': o.token } : {}),
    },
    ...(o.body !== undefined ? { payload: o.body as object } : {}),
  });
  return {
    status: res.statusCode,
    body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {},
    raw: res.body,
  };
}
const subscribe = (v: Visitor, ep = endpoint(), keys = pushKeys(), app = t): Promise<Res> =>
  call('POST', `/api/v1/tickets/${v.code}/push-subscription`, {
    token: v.token,
    body: { endpoint: ep, keys },
    app,
  });
const unsubscribe = (v: Visitor, ref: string): Promise<Res> =>
  call('DELETE', `/api/v1/tickets/${v.code}/push-subscription`, {
    token: v.token,
    body: { subscription_ref: ref },
  });
const ack = (v: Visitor, ref: string, seq: number): Promise<Res> =>
  call('POST', `/api/v1/tickets/${v.code}/alerts/ack`, {
    token: v.token,
    body: { subscription_ref: ref, event_sequence: seq },
  });

interface OutboxRow {
  dedup_key: string;
  payload: Record<string, unknown>;
  notification_id: string;
  status: string;
  channel: string;
  push_subscription_id: string;
  event_sequence: number;
}
const outbox = (ticketId: string): Promise<OutboxRow[]> =>
  t.db<OutboxRow[]>`
    SELECT o.dedup_key, o.payload, o.notification_id, n.status, n.channel, n.push_subscription_id, n.event_sequence
      FROM notification_outbox o JOIN notifications n ON n.id = o.notification_id
     WHERE n.ticket_id = ${ticketId} ORDER BY o.dedup_key`;
const callNext = (q: QueueFixture, counter = 0): ReturnType<typeof queueCommand> =>
  queueCommand(q.org.admin, q.queueId, {
    action: 'ticket.call_next',
    counter_id: q.counterIds[counter],
  });

// ---------------------------------------------------------------------------------------------
// 14.2 — triggering and isolation
// ---------------------------------------------------------------------------------------------

describe('14.2 committed calls enqueue one alert per subscribed device', () => {
  it('three subscriptions → exactly three notification + outbox pairs with distinct per-device keys', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const refs: string[] = [];
    for (let i = 0; i < 3; i++) refs.push(String((await subscribe(v)).body['subscription_ref']));
    const c = await callNext(q);
    expect(c.body.outcome?.disposition).toBe('committed');
    const seq = c.body.outcome?.server_sequence ?? 0;
    const rows = await outbox(v.ticketId);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.dedup_key).sort()).toEqual(
      refs.map((r) => `web_push:ticket.called:${v.ticketId}:${seq}:${r}`).sort(),
    );
    expect(new Set(rows.map((r) => r.notification_id)).size).toBe(3);
    for (const r of rows) {
      expect(r).toMatchObject({ status: 'pending', channel: 'web_push', event_sequence: seq });
      expect(Object.keys(r.payload).sort()).toEqual([
        'counter_id',
        'event_sequence',
        'subscription_id',
        'ticket_id',
      ]);
    }
    await assertEventLogIntact(t.db, q.queueId);
  });

  it('a replayed command (duplicate disposition) adds nothing', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    await subscribe(v);
    const op = uuidv7();
    const body = { operation_id: op, action: 'ticket.call_next', counter_id: q.counterIds[0] };
    await q.org.admin.post(`/api/v1/queues/${q.queueId}/commands`, body);
    const replay = await q.org.admin.post<{ outcome: { disposition: string } }>(
      `/api/v1/queues/${q.queueId}/commands`,
      body,
    );
    expect(replay.body.outcome.disposition).toBe('duplicate');
    expect(await outbox(v.ticketId)).toHaveLength(1);
  });

  it('a forced conflict on ONE key skips only that device; the other two still get theirs', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const refs = [
      String((await subscribe(v)).body['subscription_ref']),
      String((await subscribe(v)).body['subscription_ref']),
      String((await subscribe(v)).body['subscription_ref']),
    ];
    const [s] = await t.db<
      { last_sequence: number }[]
    >`SELECT last_sequence FROM queue_sessions WHERE id = ${q.queueId}`;
    const nextSeq = (s?.last_sequence ?? 0) + 1;
    // someone already used device #2's key (as a replay would)
    const [n] = await t.db<{ id: string }[]>`
      INSERT INTO notifications (organization_id, ticket_id, channel, template_key, status)
      VALUES (${q.org.organizationId}, ${v.ticketId}, 'web_push', 'ticket.called', 'pending') RETURNING id`;
    await t.db`INSERT INTO notification_outbox (notification_id, dedup_key) VALUES (${n?.id ?? ''}, ${`web_push:ticket.called:${v.ticketId}:${nextSeq}:${refs[1]}`})`;
    const before = turnAlertEnqueueErrors();
    const c = await callNext(q);
    expect(c.body.outcome?.server_sequence).toBe(nextSeq);
    const rows = (await outbox(v.ticketId)).filter((r) => r.push_subscription_id);
    expect(rows.map((r) => r.push_subscription_id).sort()).toEqual([refs[0], refs[2]].sort());
    expect(turnAlertEnqueueErrors()).toBe(before); // a conflict is not an error
    // and no half pair (a notification without its outbox row) was left behind
    const [orphans] = await t.db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM notifications n
       WHERE n.ticket_id = ${v.ticketId} AND NOT EXISTS (SELECT 1 FROM notification_outbox o WHERE o.notification_id = n.id)`;
    expect(orphans?.n).toBe(0);
  });

  it('a deliberately failing alert helper (SQL error inside the savepoint) cannot fail the call', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    await subscribe(v);
    const [s] = await t.db<{ last_sequence: number; revision: number }[]>`
      SELECT last_sequence, revision FROM queue_sessions WHERE id = ${q.queueId}`;
    setTurnAlertFaultForTests(async (sp) => {
      await sp`SELECT 1 / 0`; // division_by_zero, a real database error
    });
    const before = turnAlertEnqueueErrors();
    const c = await callNext(q);
    expect(c.status).toBe(200);
    expect(c.body.outcome).toMatchObject({
      disposition: 'committed',
      server_sequence: (s?.last_sequence ?? 0) + 1,
    });
    expect(turnAlertEnqueueErrors()).toBe(before + 1);
    // supervisors see it, for this facility only
    const h = await q.org.admin.get<{ health: { turn_alerts: { enqueue_errors: number } } }>(
      `/api/v1/facilities/${q.fid}/operations/health`,
    );
    expect(h.body.health.turn_alerts.enqueue_errors).toBe(1);
    const other = await setupQueue(t.app, { counters: 1 });
    const h2 = await other.org.admin.get<{ health: { turn_alerts: { enqueue_errors: number } } }>(
      `/api/v1/facilities/${other.fid}/operations/health`,
    );
    expect(h2.body.health.turn_alerts.enqueue_errors).toBe(0);
    const [tk] = await t.db<
      { state: string }[]
    >`SELECT state FROM tickets WHERE id = ${v.ticketId}`;
    expect(tk?.state).toBe('called');
    expect(await outbox(v.ticketId)).toEqual([]);
    const types = await assertEventLogIntact(t.db, q.queueId);
    expect(types.at(-1)).toBe('ticket.call_next');
    // serving and completing still work afterwards
    expect(
      (
        await queueCommand(q.org.admin, q.queueId, {
          action: 'ticket.serve',
          ticket_id: v.ticketId,
        })
      ).status,
    ).toBe(200);
  });

  it('out-of-order call and a counter transfer of a called ticket alert; a serving transfer does not', async () => {
    const q = await setupQueue(t.app, { counters: 2 });
    const first = await join(q);
    const v = await join(q);
    await subscribe(v);
    const ooo = await q.org.admin.post<{
      outcome: { disposition: string; server_sequence: number };
    }>(`/api/v1/tickets/${v.ticketId}/call-out-of-order`, {
      operation_id: uuidv7(),
      counter_id: q.counterIds[0],
      reason_code: 'urgent_need',
      reason_text: 'Feeling unwell',
    });
    expect(ooo.body.outcome?.disposition).toBe('committed');
    const tr = await q.org.admin.post<{
      outcome: { disposition: string; server_sequence: number };
    }>(`/api/v1/tickets/${v.ticketId}/counter-transfer`, {
      operation_id: uuidv7(),
      to_counter_id: q.counterIds[1],
      reason_code: 'specialist_counter',
    });
    expect(tr.body.outcome?.disposition).toBe('committed');
    expect((await outbox(v.ticketId)).map((r) => r.event_sequence)).toEqual(
      [ooo.body.outcome?.server_sequence, tr.body.outcome?.server_sequence].sort(),
    );
    await queueCommand(q.org.admin, q.queueId, { action: 'ticket.serve', ticket_id: v.ticketId });
    await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.counter_transfer',
      ticket_id: v.ticketId,
      to_counter_id: q.counterIds[0],
      counter_reason_code: 'counter_closing',
    });
    expect(await outbox(v.ticketId)).toHaveLength(2);
    void first;
  });

  it('a subscription added after the call is not alerted for that call', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    await callNext(q);
    await subscribe(v);
    expect(await outbox(v.ticketId)).toEqual([]);
  });
});

describe('14.2 offline coordinators: alerts only when the server commits', () => {
  it('an offline call alerts only once its sync batch commits; a fenced (stale-epoch) call alerts nobody', async () => {
    const f = await setupContinuity(t.app, { counters: 1 });
    const v = await join(f);
    await subscribe(v);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const auth = await f.authorityFor(f.counter);
    const snap = await snapshot(f.counter.client, f.queueId, f.counter.deviceId);
    // nothing reaches the server while the coordinator works offline
    expect(await outbox(v.ticketId)).toEqual([]);
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
    const rows = await outbox(v.ticketId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_sequence).toBe(res.body.results[0]?.server_sequence);

    // a second visitor; a stale-epoch call from a fenced device is held for review, never applied
    const w = await join(f);
    await subscribe(w);
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
    expect(await outbox(w.ticketId)).toEqual([]);
    await assertEventLogIntact(t.db, f.queueId);
  });
});

describe('14.13 transfers re-bind subscriptions; identity is the subscription', () => {
  it('a service transfer keeps the same subscription_id on the destination ticket, which then alerts', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const dest = await setupQueue(t.app, {
      counters: 1,
      org: q.org,
      fid: q.fid,
      facilitySlug: q.facilitySlug,
    });
    const v = await join(q);
    const ref = String((await subscribe(v)).body['subscription_ref']);
    const tr = await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.transfer',
      ticket_id: v.ticketId,
      destination_service_id: dest.serviceId,
      reason_code: 'needs_other_service',
    });
    expect(tr.body.outcome?.disposition).toBe('committed');
    const destTicket = tr.body.outcome?.ticket_id ?? '';
    const [sub] = await t.db<
      { ticket_id: string; revoked_at: Date | null }[]
    >`SELECT ticket_id, revoked_at FROM push_subscriptions WHERE id = ${ref}`;
    expect(sub).toEqual({ ticket_id: destTicket, revoked_at: null });
    await callNext(dest);
    const rows = await outbox(destTicket);
    expect(rows.map((r) => r.push_subscription_id)).toEqual([ref]);
    // the visitor's token (bound to the original ticket) still reads the destination's status
    expect((await ticketStatus(t.app, tr.body.outcome?.public_code ?? '', v.token)).status).toBe(
      200,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 14.3 / 14.5 / 14.12 — subscription rules, security and defaults
// ---------------------------------------------------------------------------------------------

describe('14.3 / 14.12 subscriptions: capability, idempotency, cap and removal', () => {
  it('capability is live with VAPID, disabled without; subscribing is refused while disabled', async () => {
    const live = await call('GET', '/api/v1/push/capability');
    expect(live.body).toEqual({
      web_push: 'live',
      public_key: VAPID.publicKey,
      ttl_seconds: 120,
      max_subscriptions_per_ticket: 3,
    });
    const disabled = await call('GET', '/api/v1/push/capability', { app: off });
    expect(disabled.body).toEqual({
      web_push: 'disabled',
      ttl_seconds: 120,
      max_subscriptions_per_ticket: 3,
    });
    const q = await setupQueue(off.app, { counters: 1 });
    const v = await join(q, off);
    const r = await subscribe(v, endpoint(), pushKeys(), off);
    expect(r.status).toBe(503);
    expect(r.body['type']).toMatch(/push-disabled/);
  });

  it('idempotent per endpoint (same ref, 200); the 4th device is refused with 409 and a plain message', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const ep = endpoint();
    const a = await subscribe(v, ep);
    expect(a.status).toBe(201);
    const again = await subscribe(v, ep);
    expect(again.status).toBe(200);
    expect(again.body['subscription_ref']).toBe(a.body['subscription_ref']);
    expect((await subscribe(v)).status).toBe(201);
    expect((await subscribe(v)).status).toBe(201);
    const fourth = await subscribe(v);
    expect(fourth.status).toBe(409);
    expect(fourth.body['detail']).toBe(
      'Push is already on for 3 devices. Turn it off on one first.',
    );
    // nothing was evicted silently; turning one off makes room
    expect((await unsubscribe(v, String(a.body['subscription_ref']))).status).toBe(204);
    expect((await unsubscribe(v, String(a.body['subscription_ref']))).status).toBe(204); // idempotent
    expect((await subscribe(v)).status).toBe(201);
  });

  it('the cap holds under 8 concurrent subscribes from different devices', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const results = await Promise.all(Array.from({ length: 8 }, () => subscribe(v)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const [n] = await t.db<
      { n: number }[]
    >`SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE ticket_id = ${v.ticketId} AND revoked_at IS NULL`;
    expect(n?.n).toBe(3);
  });

  it('a subscription expires after 24 hours at the latest', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const r = await subscribe(v);
    const hours = (new Date(String(r.body['expires_at'])).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24.01);
  });

  it('an ended ticket cannot subscribe', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    await queueCommand(q.org.admin, q.queueId, { action: 'ticket.cancel', ticket_id: v.ticketId });
    const r = await subscribe(v);
    expect(r.status).toBe(409);
  });
});

describe('14.5 per-ticket subscription-change limit, shared by every API instance', () => {
  it('20 changes per minute per ticket across two API instances (also under a concurrent burst); turning off is never refused; the window self-expires', async () => {
    const second = await createTestApp({ VAPID_PUBLIC_KEY: VAPID.publicKey });
    try {
      const q = await setupQueue(t.app, { counters: 1 });
      const v = await join(q);
      const ep = endpoint();
      const keys = pushKeys();
      // alternate instances: the limit is one count in PostgreSQL, not one per process
      const codes: number[] = [];
      for (let i = 0; i < 20; i++)
        codes.push((await subscribe(v, ep, keys, i % 2 ? second : t)).status);
      expect(codes.every((c) => c === 200 || c === 201)).toBe(true);
      const refused = await subscribe(v, ep, keys, second);
      expect(refused.status).toBe(429);
      expect(refused.raw).not.toContain(ep);
      expect((await subscribe(v, ep, keys, t)).status).toBe(429);
      // a privacy action is never refused, even over the limit
      const ref = String(
        (
          await t.db<
            { id: string }[]
          >`SELECT id FROM push_subscriptions WHERE ticket_id = ${v.ticketId}`
        )[0]?.id,
      );
      expect((await unsubscribe(v, ref)).status).toBe(204);
      // the window expires by itself: no lock-out, nothing to unlock
      await t.db`UPDATE push_subscription_throttle SET window_started_at = NOW() - INTERVAL '61 seconds' WHERE ticket_id = ${v.ticketId}`;
      expect((await subscribe(v, ep, keys, second)).status).toBe(200);

      // a concurrent burst over both instances for a fresh ticket: exactly 20 accepted
      const w = await join(q);
      const burst = await Promise.all(
        Array.from({ length: 30 }, (_, i) => subscribe(w, ep, keys, i % 2 ? second : t)),
      );
      expect(burst.filter((r) => r.status === 429)).toHaveLength(10);
      expect(burst.filter((r) => r.status === 200 || r.status === 201)).toHaveLength(20);
      // the cap still holds: one browser endpoint = one subscription
      const [{ n } = { n: -1 }] = await t.db<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE ticket_id = ${w.ticketId}`;
      expect(n).toBe(1);
    } finally {
      await second.close();
    }
  });
});

describe('14.5 security, privacy and tenancy', () => {
  it('needs the status token, CSRF and strict input; refuses endpoints that are not push services (SSRF)', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const ok = { endpoint: endpoint(), keys: pushKeys() };
    expect(
      (await call('POST', `/api/v1/tickets/${v.code}/push-subscription`, { body: ok })).status,
    ).toBe(404);
    expect(
      (
        await call('POST', `/api/v1/tickets/${v.code}/push-subscription`, {
          body: ok,
          token: 'x'.repeat(43),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call('POST', `/api/v1/tickets/${v.code}/push-subscription`, {
          body: ok,
          token: v.token,
          csrf: false,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/api/v1/tickets/${v.code}/push-subscription`, {
          body: { ...ok, device: 'iPhone' },
          token: v.token,
        })
      ).status,
    ).toBe(400);
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://127.0.0.1/push',
      'https://internal.service.local/push',
      'https://fcm.googleapis.com.attacker.example/x',
      'https://user:pw@fcm.googleapis.com/x',
    ]) {
      const r = await subscribe(v, bad);
      expect(r.status, bad).toBe(400);
    }
    expect(
      await t.db`SELECT 1 FROM push_subscriptions WHERE ticket_id = ${v.ticketId}`,
    ).toHaveLength(0);
  });

  it('endpoints and keys are stored only as ciphertext and never returned; revoking erases them; the database refuses ciphertext on a revoked row', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const ep = endpoint();
    const keys = pushKeys();
    const r = await subscribe(v, ep, keys);
    expect(Object.keys(r.body).sort()).toEqual(['expires_at', 'subscription_ref']);
    expect(r.raw).not.toContain(ep);
    expect(r.raw).not.toContain(keys.auth);
    const [row] = await t.db<
      Record<string, unknown>[]
    >`SELECT * FROM push_subscriptions WHERE id = ${String(r.body['subscription_ref'])}`;
    const asText = JSON.stringify(row, (_k, val: unknown) =>
      Buffer.isBuffer(val) ? val.toString('latin1') : val,
    );
    expect(asText).not.toContain(ep);
    expect(asText).not.toContain(ep.split('/').pop() ?? '');
    expect(asText).not.toContain(keys.auth);
    expect(asText).not.toContain(keys.p256dh);
    // the ref/endpoint/keys never appear in queue events or audit records
    const elsewhere = JSON.stringify([
      await t.db`SELECT * FROM queue_events WHERE queue_session_id = ${q.queueId}`,
      await t.db`SELECT * FROM admin_events WHERE organization_id = ${q.org.organizationId}`,
    ]);
    expect(elsewhere).not.toContain(ep.split('/').pop() ?? '');
    // a revoked row cannot hold ciphertext
    await expect(
      t.db`UPDATE push_subscriptions SET revoked_at = NOW(), revoke_reason = 'visitor' WHERE id = ${String(r.body['subscription_ref'])}`,
    ).rejects.toThrow(/push_subscriptions_ciphertext_chk/);
    await unsubscribe(v, String(r.body['subscription_ref']));
    const [after] = await t.db<
      { endpoint_ct: Buffer | null; keys_ct: Buffer | null; revoke_reason: string }[]
    >`
      SELECT endpoint_ct, keys_ct, revoke_reason FROM push_subscriptions WHERE id = ${String(r.body['subscription_ref'])}`;
    expect(after).toEqual({ endpoint_ct: null, keys_ct: null, revoke_reason: 'visitor' });
  });

  it('another ticket’s ref, another tenant’s token, or a token for a different code: 404', async () => {
    const a = await setupQueue(t.app, { counters: 1 });
    const b = await setupQueue(t.app, { counters: 1 });
    const va = await join(a);
    const vb = await join(b);
    const refA = String((await subscribe(va)).body['subscription_ref']);
    expect((await unsubscribe(vb, refA)).status).toBe(404);
    expect((await ack(vb, refA, 1)).status).toBe(404);
    // vb's token used against va's code: 404 (and va's subscription untouched)
    expect(
      (
        await call('DELETE', `/api/v1/tickets/${va.code}/push-subscription`, {
          token: vb.token,
          body: { subscription_ref: refA },
        })
      ).status,
    ).toBe(404);
    const [s] = await t.db<
      { revoked_at: Date | null }[]
    >`SELECT revoked_at FROM push_subscriptions WHERE id = ${refA}`;
    expect(s?.revoked_at).toBeNull();
    // staff of another organization cannot read a queue's alert states
    expect((await b.org.admin.get(`/api/v1/queues/${a.queueId}/alerts`)).status).toBe(404);
  });
});

describe('14.4 honest states: only the page may confirm delivery', () => {
  it('ack turns sent into delivered with a client_ack record; it never upgrades failed or suppressed', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const ref = String((await subscribe(v)).body['subscription_ref']);
    const c = await callNext(q);
    const seq = c.body.outcome?.server_sequence ?? 0;
    await t.db`UPDATE notifications SET status = 'sent', detail_code = 'accepted' WHERE push_subscription_id = ${ref}`;
    expect((await ack(v, ref, seq + 99)).status).toBe(204); // wrong call: changes nothing
    let [n] = await t.db<
      { status: string; detail_code: string }[]
    >`SELECT status, detail_code FROM notifications WHERE push_subscription_id = ${ref}`;
    expect(n?.status).toBe('sent');
    expect((await ack(v, ref, seq)).status).toBe(204);
    [n] = await t.db<
      { status: string; detail_code: string }[]
    >`SELECT status, detail_code FROM notifications WHERE push_subscription_id = ${ref}`;
    expect(n).toEqual({ status: 'delivered', detail_code: 'client_ack' });
    const deliveries =
      await t.db`SELECT d.receipt_status, d.detail_code FROM notification_deliveries d JOIN notifications x ON x.id = d.notification_id WHERE x.push_subscription_id = ${ref}`;
    expect(deliveries).toEqual([{ receipt_status: 'delivered', detail_code: 'client_ack' }]);
    // failed and suppressed stay what they are
    for (const st of ['failed', 'suppressed']) {
      await t.db`UPDATE notifications SET status = ${st} WHERE push_subscription_id = ${ref}`;
      await ack(v, ref, seq);
      const [m] = await t.db<
        { status: string }[]
      >`SELECT status FROM notifications WHERE push_subscription_id = ${ref}`;
      expect(m?.status).toBe(st);
    }
  });

  it('staff see per-device states in plain codes for called tickets (and no device secrets)', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const ref = String((await subscribe(v)).body['subscription_ref']);
    await callNext(q);
    const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const r = await counter.client.get<{
      alerts: { public_code: string; devices: { subscription_ref: string; state: string }[] }[];
    }>(`/api/v1/queues/${q.queueId}/alerts`);
    expect(r.status).toBe(200);
    expect(r.body.alerts).toEqual([
      expect.objectContaining({
        public_code: v.code,
        devices: [expect.objectContaining({ subscription_ref: ref, state: 'pending' })],
      }),
    ]);
    expect(JSON.stringify(r.body)).not.toMatch(/fcm\.googleapis|endpoint|p256dh/);
  });
});

describe('14.11 revocation follows credentials', () => {
  it('"sign out other devices" ends the other devices’ push, keeps this one’s; staff revoke-all ends all', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const mine = String((await subscribe(v)).body['subscription_ref']);
    // a second device that recovered the ticket holds ITS OWN token and subscription
    const other = await t.db<{ id: string }[]>`
      INSERT INTO ticket_recovery_credentials (ticket_id, credential_hash, expires_at, source)
      VALUES (${v.ticketId}, ${randomBytes(32).toString('hex')}, NOW() + INTERVAL '1 day', 'recovery') RETURNING id`;
    const theirs = await t.db<{ id: string }[]>`
      INSERT INTO push_subscriptions (organization_id, facility_id, ticket_id, credential_id, endpoint_hash, endpoint_ct, keys_ct, expires_at)
      VALUES (${q.org.organizationId}, ${q.fid}, ${v.ticketId}, ${other[0]?.id ?? ''}, ${randomBytes(8).toString('hex')}, '\\x01', '\\x01', NOW() + INTERVAL '1 day')
      RETURNING id`;
    const so = await call('POST', `/api/v1/tickets/${v.code}/sessions/revoke-others`, {
      token: v.token,
      body: {},
    });
    expect(so.status).toBe(200);
    const state = async (
      id: string,
    ): Promise<{ revoke_reason: string | null; endpoint_ct: Buffer | null }> =>
      (
        await t.db<
          { revoke_reason: string | null; endpoint_ct: Buffer | null }[]
        >`SELECT revoke_reason, endpoint_ct FROM push_subscriptions WHERE id = ${id}`
      )[0]!;
    expect(await state(theirs[0]?.id ?? '')).toEqual({
      revoke_reason: 'credentials_revoked',
      endpoint_ct: null,
    });
    expect((await state(mine)).revoke_reason).toBeNull();
    // staff revoke-all
    const sup = await createStaff(t.app, q.org, q.fid, 'supervisor');
    const ra = await sup.client.post(
      `/api/v1/queues/${q.queueId}/tickets/${v.ticketId}/recovery/revoke-all`,
      { reason_code: 'lost_device' },
    );
    expect(ra.status).toBe(200);
    expect(await state(mine)).toEqual({ revoke_reason: 'credentials_revoked', endpoint_ct: null });
  });
});

describe('14.7 state neutrality and the dashboard', () => {
  it('turn-alert counters count outcomes; an expired subscription (gone) is not a pipeline failure', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const refs = [
      String((await subscribe(v)).body['subscription_ref']),
      String((await subscribe(v)).body['subscription_ref']),
      String((await subscribe(v)).body['subscription_ref']),
    ];
    await callNext(q);
    await t.db`UPDATE notifications SET status = 'sent', detail_code = 'accepted' WHERE push_subscription_id = ${refs[0] ?? ''}`;
    await t.db`UPDATE notifications SET status = 'failed', detail_code = 'gone' WHERE push_subscription_id = ${refs[1] ?? ''}`;
    await t.db`UPDATE notifications SET status = 'failed', detail_code = 'retries_exhausted' WHERE push_subscription_id = ${refs[2] ?? ''}`;
    const h = await q.org.admin.get<{
      health: { turn_alerts: Record<string, number>; counters: { turn_alert_failures_1h: number } };
    }>(`/api/v1/facilities/${q.fid}/operations/health`);
    expect(h.body.health.turn_alerts).toEqual({
      attempted: 3,
      sent: 1,
      delivered: 0,
      failed: 1,
      suppressed: 0,
      unknown: 0,
      enqueue_errors: 0,
    });
    expect(h.body.health.counters.turn_alert_failures_1h).toBe(1);
  });

  it('the dashboard names any setting where the worker differs from the API (thresholds, VAPID key)', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const read = async (): Promise<string[]> =>
      (
        await q.org.admin.get<{ health: { evaluation: { config_mismatch: string[] } } }>(
          `/api/v1/facilities/${q.fid}/operations/health`,
        )
      ).body.health.evaluation.config_mismatch;
    const save = await t.db<
      { worker_config: unknown }[]
    >`SELECT worker_config FROM health_evaluations WHERE id`;
    try {
      await t.db`INSERT INTO health_evaluations (id, last_evaluated_at) VALUES (TRUE, NOW()) ON CONFLICT (id) DO NOTHING`;
      await t.db`UPDATE health_evaluations SET worker_config = ${t.db.json({ DEVICE_STALE_AFTER_SECONDS: 900, COORDINATOR_EXPIRY_WARN_SECONDS: 300, CONFLICT_REVIEW_WARN_SECONDS: 900, HEALTH_EVALUATION_INTERVAL_SECONDS: 30, vapid_public_key: VAPID.publicKey })}`;
      expect(await read()).toEqual([]);
      await t.db`UPDATE health_evaluations SET worker_config = ${t.db.json({ DEVICE_STALE_AFTER_SECONDS: 600, COORDINATOR_EXPIRY_WARN_SECONDS: 300, CONFLICT_REVIEW_WARN_SECONDS: 900, HEALTH_EVALUATION_INTERVAL_SECONDS: 30, vapid_public_key: null })}`;
      expect(await read()).toEqual(['DEVICE_STALE_AFTER_SECONDS', 'VAPID_PUBLIC_KEY']);
      // the push time-to-live is shared too
      await t.db`UPDATE health_evaluations SET worker_config = ${t.db.json({ DEVICE_STALE_AFTER_SECONDS: 900, COORDINATOR_EXPIRY_WARN_SECONDS: 300, CONFLICT_REVIEW_WARN_SECONDS: 900, HEALTH_EVALUATION_INTERVAL_SECONDS: 30, TURN_ALERT_TTL_SECONDS: 600, vapid_public_key: VAPID.publicKey })}`;
      expect(await read()).toEqual(['TURN_ALERT_TTL_SECONDS']);
    } finally {
      await t.db`UPDATE health_evaluations SET worker_config = ${save[0]?.worker_config ? t.db.json(save[0].worker_config as never) : null}`;
    }
  });
});
