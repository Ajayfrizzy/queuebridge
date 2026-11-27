import { randomBytes, randomInt } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueAction, uuidv7 } from '@queuebridge/contracts';
import { generateVapidKeys } from '@queuebridge/channels';
import { buildApp } from './app.js';
import { createDb } from './db.js';
import {
  TEST_ORIGIN,
  assertEventLogIntact,
  assignCoordinator,
  createStaff,
  createTestApp,
  failoverCoordinator,
  queueCommand,
  setupContinuity,
  setupQueue,
  snapshot,
  syncBatch,
  testEnv,
  ticketStatus,
  visitorJoin,
  type QueueFixture,
  type TestApp,
  type TestClient,
} from './testing/harness.js';

/**
 * M5 cross-feature journeys on real PostgreSQL (M5 final integration). Each test crosses at
 * least two M5 feature groups (recovery F4, turn alerts F14, continuity/fencing M3, device
 * health F9) and checks that their invariants still hold together: credentials and push follow
 * each other, only server-committed calls alert, fencing stays authoritative, nothing here
 * changes queue order, and every staff endpoint stays tenant- and role-scoped.
 */
const VAPID = generateVapidKeys();
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ VAPID_PUBLIC_KEY: VAPID.publicKey });
});
afterAll(async () => {
  await t.close();
});

const freshIp = (): string => `10.${randomInt(1, 255)}.${randomInt(0, 255)}.${randomInt(1, 255)}`;
interface Res<T = Record<string, unknown>> {
  status: number;
  body: T;
}
async function call<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  o: { token?: string; body?: unknown; ip?: string } = {},
): Promise<Res<T>> {
  const res = await t.app.inject({
    method,
    url,
    remoteAddress: o.ip ?? '127.0.0.1',
    headers: {
      origin: TEST_ORIGIN,
      'x-qb-csrf': '1',
      ...(o.token ? { 'x-qb-ticket-token': o.token } : {}),
    },
    ...(o.body !== undefined ? { payload: o.body as object } : {}),
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as T };
}

interface Visitor {
  code: string;
  token: string;
  key: string;
  ticketId: string;
}
async function join(q: QueueFixture): Promise<Visitor> {
  const j = await visitorJoin(t.app, q.queueId);
  const tk = j.body.ticket!;
  const [row] = await t.db<{ id: string }[]>`
    SELECT id FROM tickets WHERE queue_session_id = ${q.queueId} AND public_code = ${tk.public_code}`;
  return {
    code: tk.public_code,
    token: tk.status_token,
    key: tk.recovery_key ?? '',
    ticketId: row?.id ?? '',
  };
}
const recover = (
  body: Record<string, unknown>,
): Promise<Res<{ ticket?: { status_token: string } }>> =>
  call('POST', '/api/v1/tickets/recover', { body, ip: freshIp() });
const withKey = (q: QueueFixture, code: string, key: string): Record<string, unknown> => ({
  org_slug: q.org.slug,
  facility_slug: q.facilitySlug,
  ticket_code: code,
  recovery_key: key,
});
const canRead = async (code: string, token: string): Promise<boolean> =>
  (await ticketStatus(t.app, code, token)).status === 200;
const b64u = (n: number): string => randomBytes(n).toString('base64url');
/** One browser = one push endpoint; returns the subscription reference. */
async function subscribe(code: string, token: string): Promise<Res> {
  return call('POST', `/api/v1/tickets/${code}/push-subscription`, {
    token,
    body: {
      endpoint: `https://fcm.googleapis.com/fcm/send/${b64u(24)}`,
      keys: {
        p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'),
        auth: b64u(16),
      },
    },
  });
}
const ref = (r: Res): string => String(r.body['subscription_ref']);
const outboxSubscriptions = async (ticketId: string): Promise<string[]> =>
  (
    await t.db<{ s: string }[]>`
      SELECT n.push_subscription_id::text AS s FROM notifications n
        JOIN notification_outbox o ON o.notification_id = n.id
       WHERE n.ticket_id = ${ticketId} AND n.channel = 'web_push' ORDER BY 1`
  ).map((r) => r.s);
const subscriptionState = async (id: string): Promise<string | null> => {
  const [row] = await t.db<{ r: string | null }[]>`
    SELECT revoke_reason AS r FROM push_subscriptions WHERE id = ${id}`;
  return row ? row.r : 'missing';
};
const callNext = (q: QueueFixture, counter = 0): ReturnType<typeof queueCommand> =>
  queueCommand(q.org.admin, q.queueId, {
    action: 'ticket.call_next',
    counter_id: q.counterIds[counter],
  });
async function eventTypes(queueId: string): Promise<string[]> {
  return (
    await t.db<{ e: string }[]>`
      SELECT event_type AS e FROM queue_events WHERE queue_session_id = ${queueId} ORDER BY sequence`
  ).map((r) => r.e);
}

describe('M5 journey: recovery, key rotation and push follow the credentials', () => {
  it('a second device recovers; the key is rotated; sign-out-others ends the other devices AND their push; the call alerts only the survivor', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const typesBefore = await eventTypes(q.queueId);
    // device B recovers with the key, device A keeps its join token
    const b = await recover(withKey(q, v.code, v.key));
    expect(b.status).toBe(200);
    const tokenB = b.body.ticket?.status_token ?? '';
    const subA = ref(await subscribe(v.code, v.token));
    const subB = ref(await subscribe(v.code, tokenB));
    // device A rotates the key: the old key stops working at once, the new one works
    const rotated = await call<{ recovery_key: string }>(
      'POST',
      `/api/v1/tickets/${v.code}/recovery-key`,
      { token: v.token, body: {} },
    );
    expect(rotated.status).toBe(200);
    expect((await recover(withKey(q, v.code, v.key))).status).toBe(404);
    const c = await recover(withKey(q, v.code, rotated.body.recovery_key));
    expect(c.status).toBe(200);
    const tokenC = c.body.ticket?.status_token ?? '';
    // A signs every other device out: B and C lose the ticket and B's push ends with it
    const out = await call<{ revoked_tokens: number }>(
      'POST',
      `/api/v1/tickets/${v.code}/sessions/revoke-others`,
      { token: v.token, body: {} },
    );
    expect(out.status).toBe(200);
    expect(out.body.revoked_tokens).toBe(2);
    expect(await canRead(v.code, tokenB)).toBe(false);
    expect(await canRead(v.code, tokenC)).toBe(false);
    expect(await canRead(v.code, v.token)).toBe(true);
    expect(await subscriptionState(subB)).toBe('credentials_revoked');
    expect(await subscriptionState(subA)).toBeNull();
    // a signed-out device can neither re-subscribe, acknowledge nor turn push off
    expect((await subscribe(v.code, tokenB)).status).toBe(404);
    expect(
      (
        await call('POST', `/api/v1/tickets/${v.code}/alerts/ack`, {
          token: tokenB,
          body: { subscription_ref: subA, event_sequence: 1 },
        })
      ).status,
    ).toBe(404);
    // the committed call alerts only the surviving device
    expect((await callNext(q)).body.outcome?.disposition).toBe('committed');
    expect(await outboxSubscriptions(v.ticketId)).toEqual([subA]);
    // recovery, rotation and sign-out appended no queue event (only the call did)
    expect(await eventTypes(q.queueId)).toEqual([...typesBefore, 'ticket.call_next']);
    await assertEventLogIntact(t.db, q.queueId);
  });
});

describe('M5 journey: staff-assisted recovery with a separate approver, then the turn alert', () => {
  async function assist(c: TestClient, q: QueueFixture, ticketId: string): Promise<Res> {
    return c.post(`/api/v1/queues/${q.queueId}/tickets/${ticketId}/recovery/assist`, {
      reason_code: 'lost_device',
      account_matches: true,
      asked_before_revealing: true,
    }) as unknown as Promise<Res>;
  }
  it('the requester cannot approve; a supervisor approves; the grant opens the ticket on the new device, which subscribes and is alerted; audit names both people and holds no secret', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await join(q);
    const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const sup = await createStaff(t.app, q.org, q.fid, 'supervisor');
    const a = await assist(counter.client, q, v.ticketId);
    expect(a.body['outcome']).toBe('approval_required');
    const grant = String(a.body['grant']);
    const requestId = String(a.body['request_id']);
    const approveUrl = `/api/v1/queues/${q.queueId}/tickets/${v.ticketId}/recovery/approve`;
    expect((await counter.client.post(approveUrl, { request_id: requestId })).status).toBe(403);
    expect((await recover({ grant })).status).toBe(404); // not before approval
    expect((await sup.client.post(approveUrl, { request_id: requestId })).status).toBe(200);
    const redeemed = await recover({ grant });
    expect(redeemed.status).toBe(200);
    const tokenD = redeemed.body.ticket?.status_token ?? '';
    // the rightful holder's original device is told that access was granted elsewhere
    const s = await ticketStatus(t.app, v.code, v.token);
    expect(
      (s.body.status?.['recovery'] as { access_granted_elsewhere_at: string | null })
        .access_granted_elsewhere_at,
    ).not.toBeNull();
    // the new device opts in to push and is alerted by the committed call
    const subD = ref(await subscribe(v.code, tokenD));
    await callNext(q);
    expect(await outboxSubscriptions(v.ticketId)).toEqual([subD]);
    // audit: both people, the reason and the factor; no grant, key or token anywhere in it
    const audit = await t.db<{ event_type: string; actor_id: string | null; details: unknown }[]>`
      SELECT event_type, actor_id, details FROM admin_events
       WHERE target_id = ${v.ticketId} AND event_type LIKE 'ticket_recovery.%' ORDER BY created_at`;
    const types = audit.map((x) => x.event_type);
    expect(types).toEqual(
      expect.arrayContaining(['ticket_recovery.assist', 'ticket_recovery.approved']),
    );
    expect(audit.find((x) => x.event_type === 'ticket_recovery.assist')?.actor_id).toBe(
      counter.userId,
    );
    expect(audit.find((x) => x.event_type === 'ticket_recovery.approved')?.actor_id).toBe(
      sup.userId,
    );
    const text = JSON.stringify(audit);
    for (const secret of [grant, tokenD, v.token, v.key]) expect(text).not.toContain(secret);
    await assertEventLogIntact(t.db, q.queueId);
  });
});

describe('M5 journey: offline coordinator, explicit failover, fencing and alerts', () => {
  it('the new coordinator’s synced call alerts; the fenced old coordinator’s call is held for review and alerts nobody; dismissing it alerts nobody; failed push changes nothing', async () => {
    const f = await setupContinuity(t.app, { counters: 2 });
    const v1 = await join(f);
    const v2 = await join(f);
    const sub1 = ref(await subscribe(v1.code, v1.token));
    const sub2 = ref(await subscribe(v2.code, v2.token));
    // the counter tablet coordinates (epoch 1) and records a call while offline
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const token1 = await f.authorityFor(f.counter);
    const base1 = (await snapshot(f.counter.client, f.queueId, f.counter.deviceId)).body.snapshot
      .revision;
    const staleCall = f.cmd(
      f.counter,
      QueueAction.TICKET_CALL_NEXT,
      { counter_id: f.counterIds[0], ticket_id: v1.ticketId },
      { epoch: 1, baseRevision: base1 },
    );
    expect(await outboxSubscriptions(v1.ticketId)).toEqual([]); // nothing reached the server
    // the supervisor cannot reach the tablet: explicit failover to their own device (epoch 2)
    expect(
      (await failoverCoordinator(f.supervisor.client, f.queueId, f.supervisor.deviceId)).status,
    ).toBe(200);
    const token2 = await f.authorityFor(f.supervisor);
    const base2 = (await snapshot(f.supervisor.client, f.queueId, f.supervisor.deviceId)).body
      .snapshot.revision;
    const r2 = await syncBatch(
      f.supervisor.client,
      [
        f.cmd(
          f.supervisor,
          QueueAction.TICKET_CALL_NEXT,
          // the new coordinator calls the same visitor (the head of the queue) at another counter
          { counter_id: f.counterIds[1], ticket_id: v1.ticketId },
          { epoch: 2, baseRevision: base2 },
        ),
      ],
      [token2],
    );
    expect(r2.body.results[0]?.disposition).toBe('committed');
    expect(await outboxSubscriptions(v1.ticketId)).toEqual([sub1]);
    // the old tablet reconnects: fenced, held for supervisor review, and nobody is alerted
    const r1 = await syncBatch(f.counter.client, [staleCall], [token1]);
    expect(r1.body.results[0]?.disposition).toBe('needs_review');
    expect(r1.body.results[0]?.reason_code).toBe('stale_epoch');
    expect(await outboxSubscriptions(v1.ticketId)).toEqual([sub1]); // no second alert
    expect(await outboxSubscriptions(v2.ticketId)).toEqual([]);
    const opId = String(staleCall['operation_id']);
    const dismissed = await f.supervisor.client.post(`/api/v1/sync/conflicts/${opId}/resolve`, {
      resolution: 'dismiss',
      reason_code: 'duplicate_of_online_action',
    });
    expect(dismissed.status).toBe(200);
    expect(await outboxSubscriptions(v1.ticketId)).toEqual([sub1]);
    expect(await outboxSubscriptions(v2.ticketId)).toEqual([]);
    const [w] = await t.db<
      { state: string }[]
    >`SELECT state FROM tickets WHERE id = ${v2.ticketId}`;
    expect(w?.state).toBe('waiting');
    // the alert to v1 fails (as a dead push service would make it): the queue does not care
    await t.db`UPDATE notifications SET status = 'failed', detail_code = 'retries_exhausted' WHERE push_subscription_id = ${sub1}`;
    const serve = await syncBatch(
      f.supervisor.client,
      [
        f.cmd(
          f.supervisor,
          QueueAction.TICKET_SERVE,
          { ticket_id: v1.ticketId },
          {
            epoch: 2,
            baseRevision: (await snapshot(f.supervisor.client, f.queueId, f.supervisor.deviceId))
              .body.snapshot.revision,
          },
        ),
      ],
      [token2],
    );
    expect(serve.body.results[0]?.disposition).toBe('committed');
    const types = await assertEventLogIntact(t.db, f.queueId);
    expect(types.filter((x) => x === 'ticket.miss')).toEqual([]);
    expect(types.filter((x) => x === 'ticket.call_next')).toHaveLength(1);
    void sub2;
  });
});

describe('M5 isolation: tenants and roles across the M5 staff and visitor endpoints', () => {
  it('another organization gets 404 everywhere; auditors read but never act; counter staff cannot approve or acknowledge', async () => {
    const a = await setupQueue(t.app, { counters: 1 });
    const b = await setupQueue(t.app, { counters: 1 });
    const v = await join(a);
    const foreign = await join(b);
    const subA = ref(await subscribe(v.code, v.token));
    await callNext(a);
    // another organization's admin
    for (const url of [
      `/api/v1/queues/${a.queueId}/alerts`,
      `/api/v1/facilities/${a.fid}/operations/health`,
      `/api/v1/queues/${a.queueId}/recovery/requests`,
    ]) {
      expect((await b.org.admin.get(url)).status, url).toBe(404);
    }
    // another organization's visitor token cannot touch this ticket's push, even with its ref
    expect(
      (
        await call('DELETE', `/api/v1/tickets/${v.code}/push-subscription`, {
          token: foreign.token,
          body: { subscription_ref: subA },
        })
      ).status,
    ).toBe(404);
    expect(await subscriptionState(subA)).toBeNull();
    // roles inside the organization
    const auditor = await createStaff(t.app, a.org, a.fid, 'auditor');
    const counter = await createStaff(t.app, a.org, a.fid, 'staff_counter');
    const reception = await createStaff(t.app, a.org, a.fid, 'staff_reception');
    for (const who of [auditor, counter, reception]) {
      expect((await who.client.get(`/api/v1/queues/${a.queueId}/alerts`)).status).toBe(200);
    }
    expect((await auditor.client.get(`/api/v1/facilities/${a.fid}/operations/health`)).status).toBe(
      200,
    );
    for (const who of [counter, reception]) {
      expect((await who.client.get(`/api/v1/facilities/${a.fid}/operations/health`)).status).toBe(
        403,
      );
    }
    // auditors never act: no assisted recovery, no command
    expect(
      (
        await auditor.client.post(
          `/api/v1/queues/${a.queueId}/tickets/${v.ticketId}/recovery/assist`,
          { reason_code: 'other', account_matches: true, asked_before_revealing: true },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await auditor.client.post(`/api/v1/queues/${a.queueId}/commands`, {
          operation_id: uuidv7(),
          action: 'ticket.call_next',
          counter_id: a.counterIds[0],
        })
      ).status,
    ).toBe(403);
    // acknowledging a health alert needs QUEUE_MANAGE (any id: refused before lookup)
    const ack = await counter.client.post(
      `/api/v1/facilities/${a.fid}/health/alerts/${uuidv7()}/acknowledge`,
      {},
    );
    expect(ack.status).toBe(403);
  });
});

describe('M5 recovery races (8.R7 additions)', () => {
  it('recovery racing "sign out other devices": no revived token, no lost update, never above the cap', async () => {
    for (let round = 0; round < 10; round++) {
      const q = await setupQueue(t.app, { counters: 1 });
      const v = await join(q);
      const earlier = await recover(withKey(q, v.code, v.key)); // a device already signed in
      const tokenB = earlier.body.ticket?.status_token ?? '';
      const [rec, out] = await Promise.all([
        recover(withKey(q, v.code, v.key)),
        call<{ revoked_tokens: number }>(
          'POST',
          `/api/v1/tickets/${v.code}/sessions/revoke-others`,
          {
            token: v.token,
            body: {},
          },
        ),
      ]);
      expect(out.status).toBe(200);
      expect([200, 404]).toContain(rec.status);
      // the caller's device survives; the earlier device never comes back
      expect(await canRead(v.code, v.token)).toBe(true);
      expect(await canRead(v.code, tokenB)).toBe(false);
      const [{ n } = { n: -1 }] = await t.db<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM ticket_recovery_credentials
         WHERE ticket_id = ${v.ticketId} AND revoked_at IS NULL AND expires_at > NOW()`;
      expect(n).toBeLessThanOrEqual(3);
      // the racing recovery's token is either revoked (it lost) or works (it came after), and the
      // database says the same thing as the status endpoint
      if (rec.status === 200) {
        const token = rec.body.ticket?.status_token ?? '';
        const works = await canRead(v.code, token);
        expect(n).toBe(works ? 2 : 1);
      } else {
        expect(n).toBe(1);
      }
    }
  });

  it('recovery racing ticket completion: once completed, nothing recovers it and recovery changed no queue state', async () => {
    for (let round = 0; round < 10; round++) {
      const q = await setupQueue(t.app, { counters: 1 });
      const v = await join(q);
      await callNext(q);
      await queueCommand(q.org.admin, q.queueId, { action: 'ticket.serve', ticket_id: v.ticketId });
      const [rec, done] = await Promise.all([
        recover(withKey(q, v.code, v.key)),
        queueCommand(q.org.admin, q.queueId, { action: 'ticket.complete', ticket_id: v.ticketId }),
      ]);
      expect(done.body.outcome?.disposition).toBe('committed');
      expect([200, 404]).toContain(rec.status);
      const [tk] = await t.db<
        { state: string }[]
      >`SELECT state FROM tickets WHERE id = ${v.ticketId}`;
      expect(tk?.state).toBe('completed');
      expect((await recover(withKey(q, v.code, v.key))).status).toBe(404);
      const types = await assertEventLogIntact(t.db, q.queueId);
      expect(types.filter((x) => x.startsWith('ticket.')).at(-1)).toBe('ticket.complete');
    }
  });
});

describe('M5 secrets never reach the logs (8.R11, 14.5)', () => {
  it('at trace level, a full recovery + assisted recovery + push journey logs no key, grant, token, endpoint or push key', async () => {
    const lines: string[] = [];
    const secrets: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, done): void {
        lines.push(chunk.toString());
        done();
      },
    });
    const env = testEnv({ VAPID_PUBLIC_KEY: VAPID.publicKey, LOG_LEVEL: 'trace' });
    const db = createDb(env);
    const app = await buildApp(env, { db, logStream: stream });
    await app.ready();
    const send = async <T = Record<string, unknown>>(
      method: 'POST' | 'DELETE' | 'GET',
      url: string,
      o: { token?: string; body?: unknown } = {},
    ): Promise<Res<T>> => {
      const r = await app.inject({
        method,
        url,
        remoteAddress: freshIp(),
        headers: {
          origin: TEST_ORIGIN,
          'x-qb-csrf': '1',
          ...(o.token ? { 'x-qb-ticket-token': o.token } : {}),
        },
        ...(o.body !== undefined ? { payload: o.body as object } : {}),
      });
      return { status: r.statusCode, body: (r.body ? JSON.parse(r.body) : {}) as T };
    };
    try {
      const q = await setupQueue(app, { counters: 1 });
      const j = await visitorJoin(app, q.queueId);
      const tk = j.body.ticket!;
      secrets.push(tk.status_token, tk.recovery_key ?? '');
      const endpoint = `https://fcm.googleapis.com/fcm/send/${b64u(24)}`;
      const keys = {
        p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'),
        auth: b64u(16),
      };
      secrets.push(endpoint, keys.p256dh, keys.auth);
      const rec = await send<{ ticket?: { status_token: string } }>(
        'POST',
        '/api/v1/tickets/recover',
        {
          body: withKey(q, tk.public_code, tk.recovery_key ?? ''),
        },
      );
      secrets.push(rec.body.ticket?.status_token ?? '');
      await send('POST', '/api/v1/tickets/recover', {
        body: withKey(q, tk.public_code, 'A'.repeat(32)),
      });
      const rot = await send<{ recovery_key: string }>(
        'POST',
        `/api/v1/tickets/${tk.public_code}/recovery-key`,
        { token: tk.status_token, body: {} },
      );
      secrets.push(rot.body.recovery_key);
      const sub = await send('POST', `/api/v1/tickets/${tk.public_code}/push-subscription`, {
        token: tk.status_token,
        body: { endpoint, keys },
      });
      expect(sub.status).toBe(201);
      const [row] = await db<{ id: string }[]>`
        SELECT id FROM tickets WHERE queue_session_id = ${q.queueId} AND public_code = ${tk.public_code}`;
      const counter = await createStaff(app, q.org, q.fid, 'staff_counter');
      const sup = await createStaff(app, q.org, q.fid, 'supervisor');
      const a = await counter.client.post<{ grant: string; request_id: string }>(
        `/api/v1/queues/${q.queueId}/tickets/${row?.id ?? ''}/recovery/assist`,
        { reason_code: 'lost_device', account_matches: true, asked_before_revealing: true },
      );
      secrets.push(a.body.grant);
      await sup.client.post(
        `/api/v1/queues/${q.queueId}/tickets/${row?.id ?? ''}/recovery/approve`,
        {
          request_id: a.body.request_id,
        },
      );
      const g = await send<{ ticket?: { status_token: string } }>(
        'POST',
        '/api/v1/tickets/recover',
        {
          body: { grant: a.body.grant },
        },
      );
      secrets.push(g.body.ticket?.status_token ?? '');
      await queueCommand(q.org.admin, q.queueId, {
        action: 'ticket.call_next',
        counter_id: q.counterIds[0],
      });
      const [n] = await db<{ seq: number }[]>`
        SELECT event_sequence AS seq FROM notifications WHERE push_subscription_id = ${String(sub.body['subscription_ref'])}`;
      await send('POST', `/api/v1/tickets/${tk.public_code}/alerts/ack`, {
        token: tk.status_token,
        body: { subscription_ref: sub.body['subscription_ref'], event_sequence: n?.seq ?? 1 },
      });
      await send('DELETE', `/api/v1/tickets/${tk.public_code}/push-subscription`, {
        token: tk.status_token,
        body: { subscription_ref: sub.body['subscription_ref'] },
      });
    } finally {
      await app.close();
      await db.end({ timeout: 5 });
    }
    const log = lines.join('');
    expect(lines.length).toBeGreaterThan(20); // trace logging really ran
    const checked = secrets.filter((x) => x.length >= 16);
    expect(checked.length).toBeGreaterThanOrEqual(9); // keys, grant, tokens, endpoint, push keys
    for (const secret of checked) {
      expect(log.includes(secret), 'a secret reached the log').toBe(false);
    }
  });
});

describe('M5 recovery throttling across API instances (operational check)', () => {
  it('parallel wrong guesses from one source, split over two instances, are counted exactly and limited once', async () => {
    const second = await createTestApp();
    try {
      const q = await setupQueue(t.app, { counters: 1 });
      const v = await join(q);
      const ip = freshIp();
      const guess = (app: TestApp): Promise<number> =>
        app.app
          .inject({
            method: 'POST',
            url: '/api/v1/tickets/recover',
            remoteAddress: ip,
            headers: { origin: TEST_ORIGIN, 'x-qb-csrf': '1' },
            payload: withKey(q, v.code, randomBytes(20).toString('hex').slice(0, 32).toUpperCase()),
          })
          .then((r) => r.statusCode);
      const statuses = await Promise.all(
        Array.from({ length: 24 }, (_, i) => guess(i % 2 ? second : t)),
      );
      // L2: at most 5 failures for this ticket from this source, whichever instance answered
      expect(statuses.filter((s) => s === 404).length).toBeLessThanOrEqual(5);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(19);
      // and the rightful holder on a clean source is still let in (no lock-out)
      expect((await recover(withKey(q, v.code, v.key))).status).toBe(200);
    } finally {
      await second.close();
    }
  });
});
