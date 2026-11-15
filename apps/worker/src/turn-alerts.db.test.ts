import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { turnAlertTopic, uuidv7 } from '@queuebridge/contracts';
import {
  SandboxPushTransport,
  createSubscriptionCipher,
  type PushSendOptions,
  type PushSendResult,
  type PushTarget,
  type PushTransport,
} from '@queuebridge/channels';
import { evaluateDeviceHealth } from './health.js';
import { processTurnAlerts, purgeAlertData } from './turn-alerts.js';

/**
 * M5.4 turn-alert delivery against REAL PostgreSQL (testing steering 14.2 isolation, 14.4,
 * 14.5 payload, 14.6 sandbox, 14.7 neutrality, 14.11 retention, 14.12 defaults). Own throwaway
 * database with every migration; rows are placed with SQL so ages, states and sequences are
 * exact. The transport is the TEST-ONLY sandbox (no network) or an in-test double.
 */

const URL_ = process.env['TEST_DATABASE_URL'] ?? '';
const MIGRATIONS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'infra',
  'migrations',
);
const DB_NAME = `qb_alerts_${randomBytes(6).toString('hex')}`;
const KEY = 'c0ffee'.repeat(10) + 'c0ff';
const cipher = createSubscriptionCipher(KEY)!;
let admin: Sql;
let sql: Sql;
let dbUrl = '';
beforeAll(async () => {
  admin = postgres(URL_, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
  const u = new URL(URL_);
  u.pathname = `/${DB_NAME}`;
  dbUrl = u.toString();
  sql = postgres(dbUrl, { max: 6, onnotice: () => undefined });
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql')).sort()) {
    await sql.unsafe(await readFile(join(MIGRATIONS, f), 'utf8'));
  }
});
afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin?.end({ timeout: 5 });
});

const hex = (n = 4): string => randomBytes(n).toString('hex');
let day = 1;

interface Fixture {
  orgId: string;
  facilityId: string;
  sessionId: string;
  ticketId: string;
  counterId: string;
  callSeq: number;
  code: string;
}

/** A called ticket with a real committed call (event + transition), at a named counter. */
async function calledTicket(state = 'called'): Promise<Fixture> {
  const tag = hex();
  const [org] = await sql<
    { id: string }[]
  >`INSERT INTO organizations (name, slug) VALUES ('O', ${`o-${tag}`}) RETURNING id`;
  const orgId = org?.id ?? '';
  const [fac] = await sql<{ id: string }[]>`
    INSERT INTO facilities (organization_id, name, slug, timezone) VALUES (${orgId}, 'F', ${`f-${tag}`}, 'UTC') RETURNING id`;
  const facilityId = fac?.id ?? '';
  const [svc] = await sql<{ id: string }[]>`
    INSERT INTO services (organization_id, facility_id, name) VALUES (${orgId}, ${facilityId}, 'S') RETURNING id`;
  const [ctr] = await sql<{ id: string }[]>`
    INSERT INTO counters (organization_id, facility_id, name) VALUES (${orgId}, ${facilityId}, 'Counter 2') RETURNING id`;
  const [qs] = await sql<{ id: string }[]>`
    INSERT INTO queue_sessions (facility_id, organization_id, service_id, operational_date, state, revision, last_sequence)
    VALUES (${facilityId}, ${orgId}, ${svc?.id ?? ''}, CURRENT_DATE - ${day++}::int, 'open', 1, 1) RETURNING id`;
  const [tk] = await sql<{ id: string }[]>`
    INSERT INTO tickets (queue_session_id, organization_id, public_code, state, issued_sequence, current_counter_id)
    VALUES (${qs?.id ?? ''}, ${orgId}, 'A012', ${state}, 1, ${ctr?.id ?? ''}) RETURNING id`;
  const [ev] = await sql<{ id: string }[]>`
    INSERT INTO queue_events (organization_id, queue_session_id, sequence, event_type, payload, prev_hash, event_hash)
    VALUES (${orgId}, ${qs?.id ?? ''}, 1, 'ticket.call_next', '{}', ${'0'.repeat(64)}, ${hex(32)}) RETURNING id`;
  await sql`
    INSERT INTO ticket_transitions (ticket_id, from_state, to_state, queue_event_id)
    VALUES (${tk?.id ?? ''}, 'waiting', 'called', ${ev?.id ?? ''})`;
  return {
    orgId,
    facilityId,
    sessionId: qs?.id ?? '',
    ticketId: tk?.id ?? '',
    counterId: ctr?.id ?? '',
    callSeq: 1,
    code: 'A012',
  };
}

async function subscription(f: Fixture, path = `/ok/${hex()}`): Promise<string> {
  const [cr] = await sql<{ id: string }[]>`
    INSERT INTO ticket_recovery_credentials (ticket_id, credential_hash, expires_at, source)
    VALUES (${f.ticketId}, ${hex(32)}, NOW() + INTERVAL '1 day', 'join') RETURNING id`;
  const endpoint = `https://push.sandbox.test${path}`;
  const [s] = await sql<{ id: string }[]>`
    INSERT INTO push_subscriptions (organization_id, facility_id, ticket_id, credential_id, endpoint_hash, endpoint_ct, keys_ct, expires_at)
    VALUES (${f.orgId}, ${f.facilityId}, ${f.ticketId}, ${cr?.id ?? ''}, ${hex(16)},
            ${cipher.seal(endpoint)}, ${cipher.seal(JSON.stringify({ p256dh: 'BPk', auth: 'au' }))}, NOW() + INTERVAL '1 day')
    RETURNING id`;
  return s?.id ?? '';
}

/** What the API's enqueue writes (one pair per device), placed `ageSeconds` in the past. */
async function enqueue(
  f: Fixture,
  sub: string,
  ageSeconds = 0,
  seq = f.callSeq,
): Promise<{ outboxId: string; notificationId: string }> {
  // Database time, as the API's enqueue uses: the Node clock can run ahead of PostgreSQL's NOW()
  // by milliseconds, which made a fresh row "not yet due" intermittently.
  const [{ at } = { at: new Date(0) }] = await sql<{ at: Date }[]>`
    SELECT NOW() - make_interval(secs => ${ageSeconds}) AS at`;
  const [n] = await sql<{ id: string }[]>`
    INSERT INTO notifications (organization_id, ticket_id, channel, template_key, status, push_subscription_id, event_sequence, created_at, updated_at)
    VALUES (${f.orgId}, ${f.ticketId}, 'web_push', 'ticket.called', 'pending', ${sub}, ${seq}, ${at}, ${at}) RETURNING id`;
  const [o] = await sql<{ id: string }[]>`
    INSERT INTO notification_outbox (notification_id, dedup_key, payload, created_at, next_attempt_at)
    VALUES (${n?.id ?? ''}, ${`web_push:ticket.called:${f.ticketId}:${seq}:${sub}`},
            ${sql.json({ subscription_id: sub, event_sequence: seq, ticket_id: f.ticketId, counter_id: f.counterId })},
            ${at}, ${at}) RETURNING id`;
  return { outboxId: o?.id ?? '', notificationId: n?.id ?? '' };
}

const state = async (
  notificationId: string,
): Promise<{ status: string; detail_code: string | null }> =>
  (
    await sql<
      { status: string; detail_code: string | null }[]
    >`SELECT status, detail_code FROM notifications WHERE id = ${notificationId}`
  )[0]!;
const outboxRow = async (
  id: string,
): Promise<{ attempt_count: number; processed: boolean; next_in: number }> =>
  (
    await sql<{ attempt_count: number; processed: boolean; next_in: number }[]>`
      SELECT attempt_count, processed_at IS NOT NULL AS processed,
             EXTRACT(EPOCH FROM next_attempt_at - NOW())::float AS next_in
        FROM notification_outbox WHERE id = ${id}`
  )[0]!;

// ---------------------------------------------------------------------------------------------

describe('14.4 / 14.5 sending: honest states and a minimal payload', () => {
  it('accepted → sent/accepted (never delivered); payload has exactly the 8 public fields; Topic is the subscription', async () => {
    const f = await calledTicket();
    const sub = await subscription(f);
    const { notificationId, outboxId } = await enqueue(f, sub);
    const sandbox = new SandboxPushTransport();
    const r = await processTurnAlerts(sql, sandbox, cipher);
    expect(r).toMatchObject({ claimed: 1, sent: 1 });
    expect(await state(notificationId)).toEqual({ status: 'sent', detail_code: 'accepted' });
    expect((await outboxRow(outboxId)).processed).toBe(true);
    const [sent] = sandbox.sent;
    const payload = JSON.parse(sent?.payload ?? '{}') as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      'code',
      'counter',
      'ref',
      'rp',
      'seq',
      'ts',
      'type',
      'v',
    ]);
    expect(payload).toMatchObject({
      v: 2,
      type: 'ticket.called',
      ref: sub,
      code: 'A012',
      counter: 'Counter 2',
      seq: 1,
    });
    expect(String(payload['rp'])).toMatch(/^\/recover\/o-[0-9a-f]+\/f-[0-9a-f]+\/A012$/);
    // no internal id other than the subscription reference, no endpoint, no credential
    const asText = sent?.payload ?? '';
    for (const forbidden of [
      f.ticketId,
      f.sessionId,
      f.orgId,
      f.facilityId,
      f.counterId,
      'push.sandbox.test',
      'credential',
      'token',
    ]) {
      expect(asText).not.toContain(forbidden);
    }
    expect(sent?.topic).toBe(turnAlertTopic(sub));
    expect(sent?.topic).toMatch(/^[0-9a-f]{32}$/);
    expect(sent?.urgency).toBe('high');
    expect(sent?.ttlSeconds).toBeLessThanOrEqual(120);
    const deliveries =
      await sql`SELECT receipt_status, detail_code FROM notification_deliveries WHERE notification_id = ${notificationId}`;
    expect(deliveries).toEqual([{ receipt_status: 'sent', detail_code: 'accepted' }]);
  });

  it('stale alerts are suppressed at send time: not called, re-called, moved counter, revoked or signed-out device', async () => {
    const cases: [string, (f: Fixture, sub: string) => Promise<unknown>, string][] = [
      [
        'released to waiting',
        (f) => sql`UPDATE tickets SET state = 'waiting' WHERE id = ${f.ticketId}`,
        'ticket_changed',
      ],
      [
        'completed',
        (f) => sql`UPDATE tickets SET state = 'completed' WHERE id = ${f.ticketId}`,
        'ticket_changed',
      ],
      [
        'moved to another counter',
        async (f) => {
          const [c] = await sql<
            { id: string }[]
          >`INSERT INTO counters (organization_id, facility_id, name) VALUES (${f.orgId}, ${f.facilityId}, 'Other') RETURNING id`;
          await sql`UPDATE tickets SET current_counter_id = ${c?.id ?? ''} WHERE id = ${f.ticketId}`;
        },
        'ticket_changed',
      ],
      [
        're-called (newer call sequence)',
        async (f) => {
          const [ev] = await sql<{ id: string }[]>`
          INSERT INTO queue_events (organization_id, queue_session_id, sequence, event_type, payload, prev_hash, event_hash)
          VALUES (${f.orgId}, ${f.sessionId}, 2, 'ticket.counter_transfer', '{}', ${'0'.repeat(64)}, ${hex(32)}) RETURNING id`;
          await sql`INSERT INTO ticket_transitions (ticket_id, from_state, to_state, queue_event_id) VALUES (${f.ticketId}, 'called', 'called', ${ev?.id ?? ''})`;
        },
        'ticket_changed',
      ],
      [
        'subscription turned off',
        (_f, sub) =>
          sql`UPDATE push_subscriptions SET revoked_at = NOW(), revoke_reason = 'visitor', endpoint_ct = NULL, keys_ct = NULL WHERE id = ${sub}`,
        'subscription_revoked',
      ],
      [
        'its status token was revoked',
        (_f, sub) =>
          sql`UPDATE ticket_recovery_credentials SET revoked_at = NOW(), revoked_reason = 'signed_out_elsewhere' WHERE id = (SELECT credential_id FROM push_subscriptions WHERE id = ${sub})`,
        'subscription_revoked',
      ],
      [
        'subscription expired',
        (_f, sub) =>
          sql`UPDATE push_subscriptions SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ${sub}`,
        'subscription_revoked',
      ],
    ];
    for (const [label, change, detail] of cases) {
      const f = await calledTicket();
      const sub = await subscription(f);
      const { notificationId } = await enqueue(f, sub);
      await change(f, sub);
      const sandbox = new SandboxPushTransport();
      await processTurnAlerts(sql, sandbox, cipher);
      expect(await state(notificationId), label).toEqual({
        status: 'suppressed',
        detail_code: detail,
      });
      expect(sandbox.sent, label).toEqual([]);
    }
  });

  it('404/410 revokes THAT subscription only and erases its secrets; the other device is still sent', async () => {
    const f = await calledTicket();
    const goneSub = await subscription(f, `/gone/${hex()}`);
    const okSub = await subscription(f);
    const gone = await enqueue(f, goneSub);
    const ok = await enqueue(f, okSub);
    await processTurnAlerts(sql, new SandboxPushTransport(), cipher);
    expect(await state(gone.notificationId)).toEqual({ status: 'failed', detail_code: 'gone' });
    expect(await state(ok.notificationId)).toEqual({ status: 'sent', detail_code: 'accepted' });
    const subs = await sql<
      { id: string; revoke_reason: string | null; endpoint_ct: Buffer | null }[]
    >`
      SELECT id, revoke_reason, endpoint_ct FROM push_subscriptions WHERE ticket_id = ${f.ticketId} ORDER BY revoke_reason NULLS LAST`;
    expect(subs.find((s) => s.id === goneSub)).toMatchObject({
      revoke_reason: 'gone',
      endpoint_ct: null,
    });
    expect(subs.find((s) => s.id === okSub)?.revoke_reason).toBeNull();
  });

  it('a definitive rejection is failed; a transport crash is unknown; neither is retried', async () => {
    const f = await calledTicket();
    const rej = await enqueue(f, await subscription(f, `/reject/${hex()}`));
    const crash = await enqueue(f, await subscription(f, `/throw/${hex()}`));
    await processTurnAlerts(sql, new SandboxPushTransport(), cipher);
    expect(await state(rej.notificationId)).toEqual({ status: 'failed', detail_code: 'rejected' });
    expect(await state(crash.notificationId)).toEqual({ status: 'unknown', detail_code: 'error' });
    expect((await outboxRow(rej.outboxId)).processed).toBe(true);
    expect((await outboxRow(crash.outboxId)).processed).toBe(true);
  });
});

describe('14.4 / 14.12 retries: bounded, backed off, inside the 120 s TTL', () => {
  it('5xx retries with backoff, at most 3 attempts, then failed/retries_exhausted', async () => {
    const f = await calledTicket();
    const { notificationId, outboxId } = await enqueue(f, await subscription(f, `/retry/${hex()}`));
    const sandbox = new SandboxPushTransport();
    for (let attemptNo = 1; attemptNo <= 3; attemptNo++) {
      await processTurnAlerts(sql, sandbox, cipher, { backoffSeconds: 1 });
      const o = await outboxRow(outboxId);
      expect(o.attempt_count).toBe(attemptNo);
      if (attemptNo < 3) {
        expect(o.processed).toBe(false);
        expect(o.next_in).toBeGreaterThan(0); // backed off, not immediately due
        expect((await state(notificationId)).status).toBe('pending');
        await sql`UPDATE notification_outbox SET next_attempt_at = NOW() WHERE id = ${outboxId}`;
      }
    }
    expect(await state(notificationId)).toEqual({
      status: 'failed',
      detail_code: 'retries_exhausted',
    });
    expect(sandbox.sent).toHaveLength(3);
    // nothing more happens to a finished row
    await processTurnAlerts(sql, sandbox, cipher);
    expect(sandbox.sent).toHaveLength(3);
  });

  it('an alert older than its TTL is never sent; a retry that would land after the TTL fails instead', async () => {
    const f = await calledTicket();
    const old = await enqueue(f, await subscription(f), 121);
    const sandbox = new SandboxPushTransport();
    await processTurnAlerts(sql, sandbox, cipher);
    expect(await state(old.notificationId)).toEqual({
      status: 'failed',
      detail_code: 'ttl_elapsed',
    });
    expect(sandbox.sent).toEqual([]);
    const g = await calledTicket();
    const late = await enqueue(g, await subscription(g, `/retry/${hex()}`), 110);
    await processTurnAlerts(sql, sandbox, cipher, { backoffSeconds: 20 });
    expect(await state(late.notificationId)).toEqual({
      status: 'failed',
      detail_code: 'ttl_elapsed',
    });
  });

  it('the remaining TTL is passed to the push service', async () => {
    const f = await calledTicket();
    await enqueue(f, await subscription(f), 60);
    const sandbox = new SandboxPushTransport();
    await processTurnAlerts(sql, sandbox, cipher);
    expect(sandbox.sent[0]?.ttlSeconds).toBeGreaterThan(50);
    expect(sandbox.sent[0]?.ttlSeconds).toBeLessThanOrEqual(60);
  });
});

describe('14.4 concurrency, leases and crashes', () => {
  it('6 workers on separate connections: every row is claimed once and sent once', async () => {
    const f = await calledTicket();
    const rows: string[] = [];
    for (let i = 0; i < 30; i++) {
      const g = i % 3 === 0 ? f : await calledTicket();
      rows.push((await enqueue(g, await subscription(g))).notificationId);
    }
    const pools = Array.from({ length: 6 }, () =>
      postgres(dbUrl, { max: 2, onnotice: () => undefined }),
    );
    const transports = pools.map(() => new SandboxPushTransport());
    try {
      const results = await Promise.all(
        pools.map((p, i) => processTurnAlerts(p, transports[i] ?? null, cipher, { batchSize: 7 })),
      );
      // more passes until everything is done (batches are bounded)
      for (let pass = 0; pass < 5; pass++) {
        await Promise.all(
          pools.map((p, i) =>
            processTurnAlerts(p, transports[i] ?? null, cipher, { batchSize: 7 }),
          ),
        );
      }
      void results;
    } finally {
      await Promise.all(pools.map((p) => p.end({ timeout: 5 })));
    }
    const topics = transports.flatMap((t) => t.sent.map((s) => s.topic));
    for (const id of rows) expect((await state(id)).status).toBe('sent');
    // exactly one send per row (each row has its own subscription, so its own topic)
    expect(topics.length).toBeGreaterThanOrEqual(rows.length);
    const sentForOurRows = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM notification_deliveries WHERE notification_id = ANY(${rows}::uuid[])`;
    expect(sentForOurRows[0]?.n).toBe(rows.length);
    expect(new Set(topics).size).toBe(topics.length);
  });

  /** A transport that blocks inside `send` until released, then answers `result`. */
  function gated(result: PushSendResult): {
    transport: PushTransport;
    entered: Promise<void>;
    release: () => void;
    topics: string[];
  } {
    let enter: () => void = () => undefined;
    let open: () => void = () => undefined;
    const entered = new Promise<void>((r) => (enter = r));
    const gate = new Promise<void>((r) => (open = r));
    const topics: string[] = [];
    return {
      entered,
      release: () => open(),
      topics,
      transport: {
        name: 'sandbox',
        send: async (_t: PushTarget, _p: string, o: PushSendOptions): Promise<PushSendResult> => {
          topics.push(o.topic);
          enter();
          await gate;
          return result;
        },
      },
    };
  }
  /** The lease of the current claim has run out (what a crashed or stalled worker leaves). */
  const expireLease = (outboxId: string): Promise<unknown> =>
    sql`UPDATE notification_outbox SET next_attempt_at = NOW() WHERE id = ${outboxId}`;

  it('a stalled worker’s row is claimable after its lease; its late result cannot overwrite the newer attempt (both orders)', async () => {
    for (const order of ['newer finishes first', 'stale finishes first'] as const) {
      const f = await calledTicket();
      const sub = await subscription(f);
      const { notificationId, outboxId } = await enqueue(f, sub);
      // worker A claims attempt 1 and stalls inside the push service call
      const a = gated({ kind: 'rejected', status: 400 });
      const runA = processTurnAlerts(sql, a.transport, cipher);
      await a.entered;
      expect((await outboxRow(outboxId)).attempt_count, order).toBe(1);
      // its lease runs out; worker B claims attempt 2 and is sending
      await expireLease(outboxId);
      const b = gated({ kind: 'accepted', status: 201 });
      const runB = processTurnAlerts(sql, b.transport, cipher);
      await b.entered;
      expect((await outboxRow(outboxId)).attempt_count, order).toBe(2);
      if (order === 'newer finishes first') {
        b.release();
        await runB;
        a.release();
        await runA;
      } else {
        // A's stale "rejected" arrives while B still owns the row: it must change nothing
        a.release();
        await runA;
        expect(await state(notificationId), order).toEqual({
          status: 'pending',
          detail_code: null,
        });
        expect((await outboxRow(outboxId)).processed, order).toBe(false);
        b.release();
        await runB;
      }
      // only the newest attempt's outcome is recorded, once
      expect(await state(notificationId), order).toEqual({
        status: 'sent',
        detail_code: 'accepted',
      });
      const d =
        await sql`SELECT receipt_status FROM notification_deliveries WHERE notification_id = ${notificationId}`;
      expect(d, order).toEqual([{ receipt_status: 'sent' }]);
      // at-least-once WITH COLLAPSE: both reached the push service with the same Topic
      expect([...a.topics, ...b.topics], order).toEqual([turnAlertTopic(sub), turnAlertTopic(sub)]);
    }
  });

  it('a long batch that outlived its lease skips a row another worker re-claimed: no second send', async () => {
    const f = await calledTicket();
    const first = await enqueue(f, await subscription(f));
    const second = await enqueue(f, await subscription(f));
    // worker A claims both rows and works one at a time; it stalls on the first
    const a = gated({ kind: 'accepted', status: 201 });
    const runA = processTurnAlerts(sql, a.transport, cipher, { batchSize: 2, concurrency: 1 });
    await a.entered;
    // meanwhile the second row's lease runs out and worker B sends it
    await expireLease(second.outboxId);
    const sandbox = new SandboxPushTransport();
    const b = await processTurnAlerts(sql, sandbox, cipher);
    expect(b).toMatchObject({ claimed: 1, sent: 1 });
    a.release();
    const ra = await runA;
    // A sent only the first row and skipped the second without sending or recording anything
    expect(ra).toMatchObject({ claimed: 2, sent: 1, superseded: 1 });
    expect(a.topics).toHaveLength(1);
    expect(sandbox.sent).toHaveLength(1);
    expect(await state(first.notificationId)).toEqual({ status: 'sent', detail_code: 'accepted' });
    expect(await state(second.notificationId)).toEqual({ status: 'sent', detail_code: 'accepted' });
    const d =
      await sql`SELECT COUNT(*)::int AS n FROM notification_deliveries WHERE notification_id = ${second.notificationId}`;
    expect(d).toEqual([{ n: 1 }]);
  });

  it('a subscription whose status token was deleted by retention is never sent and is revoked', async () => {
    const f = await calledTicket();
    const sub = await subscription(f);
    const { notificationId } = await enqueue(f, sub);
    await sql`DELETE FROM ticket_recovery_credentials WHERE id = (SELECT credential_id FROM push_subscriptions WHERE id = ${sub})`;
    const sandbox = new SandboxPushTransport();
    await processTurnAlerts(sql, sandbox, cipher);
    expect(sandbox.sent).toEqual([]);
    expect(await state(notificationId)).toEqual({
      status: 'suppressed',
      detail_code: 'subscription_revoked',
    });
    await purgeAlertData(sql);
    const [row] = await sql<{ reason: string; ct: Buffer | null }[]>`
      SELECT revoke_reason AS reason, endpoint_ct AS ct FROM push_subscriptions WHERE id = ${sub}`;
    expect(row).toEqual({ reason: 'credentials_revoked', ct: null });
  });

  it('crash loops are bounded: a row already claimed 3 times fails instead of being sent again', async () => {
    const f = await calledTicket();
    const { notificationId, outboxId } = await enqueue(f, await subscription(f));
    await sql`UPDATE notification_outbox SET attempt_count = 3 WHERE id = ${outboxId}`;
    const sandbox = new SandboxPushTransport();
    await processTurnAlerts(sql, sandbox, cipher);
    expect(await state(notificationId)).toEqual({
      status: 'failed',
      detail_code: 'retries_exhausted',
    });
    expect(sandbox.sent).toEqual([]);
  });

  it('a first-party ack that arrives while the worker is sending is never downgraded to sent', async () => {
    const f = await calledTicket();
    const { notificationId, outboxId } = await enqueue(
      f,
      await subscription(f, `/slow/400/${hex()}`),
    );
    const run = processTurnAlerts(sql, new SandboxPushTransport(), cipher);
    await expect.poll(async () => (await outboxRow(outboxId)).attempt_count).toBe(1);
    await sql`UPDATE notifications SET status = 'delivered', detail_code = 'client_ack' WHERE id = ${notificationId}`;
    await run;
    expect(await state(notificationId)).toEqual({ status: 'delivered', detail_code: 'client_ack' });
  });

  it('without a configured transport nothing is sent; rows past the TTL are closed as failed, not left pending', async () => {
    const f = await calledTicket();
    const fresh = await enqueue(f, await subscription(f));
    const old = await enqueue(f, await subscription(f), 200);
    await processTurnAlerts(sql, null, cipher);
    expect((await state(fresh.notificationId)).status).toBe('pending');
    expect(await state(old.notificationId)).toEqual({
      status: 'failed',
      detail_code: 'ttl_elapsed',
    });
  });
});

describe('14.7 the worker never touches queue state', () => {
  it('every outcome leaves tickets, sessions, events and transitions byte-for-byte unchanged', async () => {
    const f = await calledTicket();
    for (const path of ['/ok/', '/gone/', '/retry/', '/reject/', '/throw/']) {
      await enqueue(f, await subscription(f, `${path}${hex()}`));
    }
    const snap = async (): Promise<string> =>
      JSON.stringify([
        await sql`SELECT row_to_json(t)::text FROM tickets t WHERE id = ${f.ticketId}`,
        await sql`SELECT row_to_json(q)::text FROM queue_sessions q WHERE id = ${f.sessionId}`,
        await sql`SELECT row_to_json(e)::text FROM queue_events e WHERE queue_session_id = ${f.sessionId}`,
        await sql`SELECT row_to_json(x)::text FROM ticket_transitions x WHERE ticket_id = ${f.ticketId}`,
      ]);
    const before = await snap();
    for (let i = 0; i < 3; i++) {
      await processTurnAlerts(sql, new SandboxPushTransport(), cipher, { backoffSeconds: 1 });
      await sql`UPDATE notification_outbox SET next_attempt_at = NOW() WHERE processed_at IS NULL`;
    }
    expect(await snap()).toBe(before);
    expect(
      await sql`SELECT 1 FROM queue_events WHERE queue_session_id = ${f.sessionId} AND event_type = 'ticket.miss'`,
    ).toHaveLength(0);
  });
});

describe('8.D / 14.2 device health: real pipeline failures raise the alert, expired subscriptions do not', () => {
  it('10 failed (not gone) or unknown deliveries in an hour → alert_pipeline_failing; 20 gone → nothing', async () => {
    const quiet = await calledTicket();
    for (let i = 0; i < 20; i++) await enqueue(quiet, await subscription(quiet, `/gone/${hex()}`));
    const noisy = await calledTicket();
    for (let i = 0; i < 6; i++) await enqueue(noisy, await subscription(noisy, `/reject/${hex()}`));
    for (let i = 0; i < 4; i++) await enqueue(noisy, await subscription(noisy, `/throw/${hex()}`));
    await processTurnAlerts(sql, new SandboxPushTransport(), cipher, { batchSize: 100 });
    await evaluateDeviceHealth(sql, { waitForLock: true });
    const alerts = await sql<
      { facility_id: string; kind: string; details: Record<string, number> }[]
    >`
      SELECT facility_id, kind, details FROM health_alerts
       WHERE kind = 'alert_pipeline_failing' AND resolved_at IS NULL AND facility_id IN (${quiet.facilityId}, ${noisy.facilityId})`;
    expect(alerts).toEqual([
      { facility_id: noisy.facilityId, kind: 'alert_pipeline_failing', details: { failed: 10 } },
    ]);
  });
});

describe('14.11 retention and revocation (design §12.13)', () => {
  it('revokes for every documented reason, erases ciphertext, deletes tombstones after 24 h and rows after 30 days; idempotent', async () => {
    const reasons: Record<string, (f: Fixture, sub: string) => Promise<unknown>> = {
      ticket_ended: (f) => sql`UPDATE tickets SET state = 'completed' WHERE id = ${f.ticketId}`,
      session_closed: (f) =>
        sql`UPDATE queue_sessions SET state = 'closed' WHERE id = ${f.sessionId}`,
      credentials_revoked: (_f, sub) =>
        sql`UPDATE ticket_recovery_credentials SET revoked_at = NOW(), revoked_reason = 'staff_revoked' WHERE id = (SELECT credential_id FROM push_subscriptions WHERE id = ${sub})`,
      expired: (_f, sub) =>
        sql`UPDATE push_subscriptions SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${sub}`,
    };
    const subs: Record<string, string> = {};
    for (const [reason, change] of Object.entries(reasons)) {
      const f = await calledTicket('waiting');
      subs[reason] = await subscription(f);
      await change(f, subs[reason] ?? '');
    }
    // missed beyond the grace window (default 300 s) also ends it; inside the window it stays
    const m = await calledTicket('missed');
    const missedOld = await subscription(m);
    await sql`UPDATE tickets SET missed_at = NOW() - INTERVAL '10 minutes' WHERE id = ${m.ticketId}`;
    const m2 = await calledTicket('missed');
    const missedNew = await subscription(m2);
    await sql`UPDATE tickets SET missed_at = NOW() - INTERVAL '1 minute' WHERE id = ${m2.ticketId}`;
    const live = await subscription(await calledTicket('waiting'));

    await purgeAlertData(sql);
    const rows = await sql<
      {
        id: string;
        revoke_reason: string | null;
        endpoint_ct: Buffer | null;
        keys_ct: Buffer | null;
      }[]
    >`
      SELECT id, revoke_reason, endpoint_ct, keys_ct FROM push_subscriptions WHERE id = ANY(${[...Object.values(subs), missedOld, missedNew, live]}::uuid[])`;
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    for (const [reason, id] of Object.entries(subs)) {
      expect(by[id], reason).toMatchObject({
        revoke_reason: reason,
        endpoint_ct: null,
        keys_ct: null,
      });
    }
    expect(by[missedOld]).toMatchObject({ revoke_reason: 'ticket_ended', endpoint_ct: null });
    expect(by[missedNew]?.revoke_reason).toBeNull();
    expect(by[live]?.revoke_reason).toBeNull();

    // tombstones go after 24 hours; notification rows (and their outbox) after 30 days
    await sql`UPDATE push_subscriptions SET revoked_at = NOW() - INTERVAL '25 hours' WHERE id = ${subs['expired'] ?? ''}`;
    const f = await calledTicket();
    const oldN = await enqueue(f, await subscription(f));
    await sql`UPDATE notifications SET created_at = NOW() - INTERVAL '31 days' WHERE id = ${oldN.notificationId}`;
    // throttle windows: an old one goes, a current one stays
    await sql`INSERT INTO push_subscription_throttle (ticket_id, window_started_at, changes) VALUES (${f.ticketId}, NOW() - INTERVAL '2 hours', 5)`;
    const g = await calledTicket();
    await sql`INSERT INTO push_subscription_throttle (ticket_id, window_started_at, changes) VALUES (${g.ticketId}, NOW(), 5)`;
    await purgeAlertData(sql);
    expect(
      await sql`SELECT ticket_id FROM push_subscription_throttle WHERE ticket_id = ANY(${[f.ticketId, g.ticketId]}::uuid[])`,
    ).toEqual([{ ticket_id: g.ticketId }]);
    expect(
      await sql`SELECT 1 FROM push_subscriptions WHERE id = ${subs['expired'] ?? ''}`,
    ).toHaveLength(0);
    expect(
      await sql`SELECT 1 FROM push_subscriptions WHERE id = ${subs['ticket_ended'] ?? ''}`,
    ).toHaveLength(1);
    expect(await sql`SELECT 1 FROM notifications WHERE id = ${oldN.notificationId}`).toHaveLength(
      0,
    );
    expect(await sql`SELECT 1 FROM notification_outbox WHERE id = ${oldN.outboxId}`).toHaveLength(
      0,
    );
    const again = await purgeAlertData(sql);
    const second = await purgeAlertData(sql);
    expect(second).toEqual({
      revoked: 0,
      tombstonesDeleted: 0,
      notificationsDeleted: 0,
      throttleDeleted: 0,
    });
    void again;
  });

  it('no code path other than the send step reads the ciphertext (static check)', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(here, 'turn-alerts.ts'), 'utf8');
    expect(src.match(/cipher\.open\(/g)).toHaveLength(2); // endpoint and keys, in `attempt` only
    // The API only seals (subscribe) and clears (revoke) ciphertext. It never opens it and never
    // selects or returns it: scan every non-test API source file.
    const apiRoot = join(here, '..', '..', 'api', 'src');
    const files = (await readdir(apiRoot, { recursive: true })).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const text = await readFile(join(apiRoot, f), 'utf8');
      expect(text, f).not.toMatch(/\.open\(/);
      // Each SQL template literal: a SELECT or RETURNING list must not name the ciphertext columns.
      for (const stmt of text.match(/`[^`]*`/g) ?? []) {
        expect(stmt, f).not.toMatch(/(SELECT|RETURNING)\b[^;]*?\b(endpoint_ct|keys_ct)\b(?!\s*=)/i);
      }
    }
    void uuidv7;
  });
});
