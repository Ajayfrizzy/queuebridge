import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeliveryStatus, type SendMessageParams, type SendResult } from '@queuebridge/contracts';
import {
  SANDBOX_SMS_SCENARIOS,
  SandboxSmsAdapter,
  createContactCipher,
  type SmsAdapter,
} from '@queuebridge/channels';
import { processSmsAlerts, purgeSmsData } from './sms-alerts.js';
import { processTurnAlerts } from './turn-alerts.js';

/**
 * M6.1 SMS turn-alert delivery against REAL PostgreSQL (Group 10 sandbox contract through the
 * worker; Group 14 invariants for SMS: 14.4 idempotency and concurrency, 14.7 neutrality,
 * 14.11-style retention; REQ-F11.4, F11.5, F11.9, F11.10, F11.11). Own throwaway database with
 * every migration; rows are placed with SQL exactly as the API's hook writes them. The adapter
 * is the TEST-ONLY sandbox (no network) or an in-test double.
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
const DB_NAME = `qb_sms_${randomBytes(6).toString('hex')}`;
const KEY = 'c0ffee'.repeat(10) + 'c0ff';
const cipher = createContactCipher(KEY)!;
let admin: Sql;
let sql: Sql;

beforeAll(async () => {
  admin = postgres(URL_, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
  const u = new URL(URL_);
  u.pathname = `/${DB_NAME}`;
  sql = postgres(u.toString(), { max: 10, onnotice: () => undefined });
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
  contactId: string;
  callSeq: number;
  phone: string;
}

/**
 * A random Nigerian mobile number that the TEST-ONLY sandbox treats as an ordinary, accepted
 * number. The sandbox picks a simulated outcome from the last three digits
 * (`SANDBOX_SMS_SCENARIOS`: rejected, unavailable, transport error); a uniformly random number
 * hit one of them 3 times in 1,000 and made "sent" assertions fail intermittently (M7.2
 * investigation). Scenario numbers are only ever chosen explicitly by a test.
 */
function ordinaryPhone(): string {
  const scenarios = new Set<string>(Object.values(SANDBOX_SMS_SCENARIOS));
  for (;;) {
    const n = `+234803${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
    if (!scenarios.has(n.slice(-3))) return n;
  }
}
/** A called ticket (real committed call event + transition) with a consented SMS contact. */
async function calledWithContact(
  o: {
    phone?: string;
    facilityCap?: number;
    enabled?: boolean;
    facilityId?: string;
    orgId?: string;
  } = {},
): Promise<Fixture> {
  const tag = hex();
  let orgId = o.orgId ?? '';
  let facilityId = o.facilityId ?? '';
  if (!orgId) {
    const [org] = await sql<{ id: string }[]>`
      INSERT INTO organizations (name, slug) VALUES ('O', ${`o-${tag}`}) RETURNING id`;
    orgId = org?.id ?? '';
    const [fac] = await sql<{ id: string }[]>`
      INSERT INTO facilities (organization_id, name, slug, timezone) VALUES (${orgId}, 'F', ${`f-${tag}`}, 'UTC') RETURNING id`;
    facilityId = fac?.id ?? '';
    const [staff] = await sql<{ id: string }[]>`
      INSERT INTO staff_users (organization_id, email, password_hash, display_name)
      VALUES (${orgId}, ${`a-${tag}@example.test`}, 'x', 'A') RETURNING id`;
    await sql`
      INSERT INTO facility_sms_settings (facility_id, organization_id, enabled, daily_cap, updated_by)
      VALUES (${facilityId}, ${orgId}, ${o.enabled ?? true}, ${o.facilityCap ?? 1000}, ${staff?.id ?? ''})`;
  }
  const [svc] = await sql<{ id: string }[]>`
    INSERT INTO services (organization_id, facility_id, name) VALUES (${orgId}, ${facilityId}, ${`S-${tag}`}) RETURNING id`;
  const [ctr] = await sql<{ id: string }[]>`
    INSERT INTO counters (organization_id, facility_id, name) VALUES (${orgId}, ${facilityId}, ${`Counter 2 ${tag}`}) RETURNING id`;
  const [qs] = await sql<{ id: string }[]>`
    INSERT INTO queue_sessions (facility_id, organization_id, service_id, operational_date, state, revision, last_sequence)
    VALUES (${facilityId}, ${orgId}, ${svc?.id ?? ''}, CURRENT_DATE - ${day++}::int, 'open', 1, 1) RETURNING id`;
  const [tk] = await sql<{ id: string }[]>`
    INSERT INTO tickets (queue_session_id, organization_id, public_code, state, issued_sequence, current_counter_id)
    VALUES (${qs?.id ?? ''}, ${orgId}, 'A012', 'called', 1, ${ctr?.id ?? ''}) RETURNING id`;
  const [ev] = await sql<{ id: string }[]>`
    INSERT INTO queue_events (organization_id, queue_session_id, sequence, event_type, payload, prev_hash, event_hash)
    VALUES (${orgId}, ${qs?.id ?? ''}, 1, 'ticket.call_next', '{}', ${'0'.repeat(64)}, ${hex(32)}) RETURNING id`;
  await sql`
    INSERT INTO ticket_transitions (ticket_id, from_state, to_state, queue_event_id)
    VALUES (${tk?.id ?? ''}, 'waiting', 'called', ${ev?.id ?? ''})`;
  const phone = o.phone ?? ordinaryPhone();
  const [vc] = await sql<{ id: string }[]>`
    INSERT INTO visitor_contacts
      (organization_id, facility_id, ticket_id, phone_ciphertext, phone_hash, consent_at, consent_version, retention_until)
    VALUES (${orgId}, ${facilityId}, ${tk?.id ?? ''}, ${cipher.sealPhone(phone)}, ${cipher.phoneHash(phone)},
            NOW(), 'sms-consent-v1', NOW() + INTERVAL '168 hours')
    RETURNING id`;
  return {
    orgId,
    facilityId,
    sessionId: qs?.id ?? '',
    ticketId: tk?.id ?? '',
    counterId: ctr?.id ?? '',
    contactId: vc?.id ?? '',
    callSeq: 1,
    phone,
  };
}

/** What the API's SMS hook writes, placed `ageSeconds` in the past. */
async function enqueue(
  f: Fixture,
  ageSeconds = 0,
): Promise<{ outboxId: string; notificationId: string }> {
  const [n] = await sql<{ id: string }[]>`
    INSERT INTO notifications (organization_id, ticket_id, channel, template_key, status, visitor_contact_id, event_sequence, created_at)
    VALUES (${f.orgId}, ${f.ticketId}, 'sms', 'ticket.called', 'pending', ${f.contactId}, ${f.callSeq},
            NOW() - make_interval(secs => ${ageSeconds}))
    RETURNING id`;
  const [o] = await sql<{ id: string }[]>`
    INSERT INTO notification_outbox (notification_id, dedup_key, payload, created_at, next_attempt_at)
    VALUES (${n?.id ?? ''}, ${`sms:ticket.called:${f.ticketId}:${f.callSeq}`},
            ${sql.json({
              contact_id: f.contactId,
              ticket_id: f.ticketId,
              facility_id: f.facilityId,
              event_sequence: f.callSeq,
              counter_id: f.counterId,
            })},
            NOW() - make_interval(secs => ${ageSeconds}), NOW() - make_interval(secs => ${ageSeconds}))
    RETURNING id`;
  return { outboxId: o?.id ?? '', notificationId: n?.id ?? '' };
}

interface NotificationRow {
  status: string;
  detail_code: string | null;
  provider: string | null;
  provider_message_id: string | null;
  send_started_at: Date | null;
}
const notification = async (id: string): Promise<NotificationRow | undefined> =>
  (
    await sql<NotificationRow[]>`
    SELECT status, detail_code, provider, provider_message_id, send_started_at FROM notifications WHERE id = ${id}`
  )[0];
const outboxRow = async (
  id: string,
): Promise<{ processed: boolean; attempts: number } | undefined> =>
  (
    await sql<{ processed: boolean; attempts: number }[]>`
    SELECT (processed_at IS NOT NULL) AS processed, attempt_count AS attempts FROM notification_outbox WHERE id = ${id}`
  )[0];
const due = async (outboxId: string): Promise<void> => {
  await sql`UPDATE notification_outbox SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = ${outboxId}`;
};

let adapter: SandboxSmsAdapter;
let lines: string[];
const run = (a: SmsAdapter | null = adapter, cap = 1000): ReturnType<typeof processSmsAlerts> =>
  processSmsAlerts(sql, a, cipher, { dailyCap: cap, backoffSeconds: 1 });

beforeEach(async () => {
  lines = [];
  adapter = new SandboxSmsAdapter({ log: (l) => lines.push(l) });
  // keep earlier tests' rows out of the next claim
  await sql`UPDATE notification_outbox SET processed_at = NOW() WHERE processed_at IS NULL`;
  await sql`DELETE FROM sms_daily_usage`;
});

describe('sandbox send through the outbox (REQ-F11.4, F11.5, F11.6)', () => {
  it('a consented, called visitor gets exactly one [TEST] message; it is recorded `sent`, never `delivered`', async () => {
    const f = await calledWithContact();
    const e = await enqueue(f);
    const r = await run();
    expect(r).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
    const n = await notification(e.notificationId);
    expect(n).toMatchObject({ status: 'sent', detail_code: 'accepted', provider: 'sandbox' });
    expect(n?.provider_message_id).toMatch(/^sbx_[0-9a-f]{32}$/);
    expect(await outboxRow(e.outboxId)).toMatchObject({ processed: true, attempts: 1 });
    const sent = adapter.getSentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(f.phone);
    expect(sent[0]?.idempotency_key).toBe(`sms:ticket.called:${f.ticketId}:1`);
    expect(sent[0]?.text).toMatch(
      /^\[TEST\] QueueBridge: ticket A012, it is your turn\. Please go to Counter 2/,
    );
    // the delivery attempt row: provider and message id, no number, no text
    const [d] = await sql<Record<string, unknown>[]>`
      SELECT * FROM notification_deliveries WHERE notification_id = ${e.notificationId}`;
    expect(d).toMatchObject({
      provider: 'sandbox',
      receipt_status: 'sent',
      detail_code: 'accepted',
    });
    expect(JSON.stringify(d)).not.toContain(f.phone.slice(-7));
    // logs: [SANDBOX], no number, no text
    expect(lines.join('\n')).toContain('[SANDBOX]');
    expect(lines.join('\n')).not.toContain(f.phone.slice(-7));
    expect(lines.join('\n')).not.toContain('A012');
    // a second pass finds nothing to do
    expect((await run()).claimed).toBe(0);
    expect(adapter.getSentMessages()).toHaveLength(1);
  });

  it('an adapter that claims `delivered` on send is still recorded as `sent` (only a receipt delivers)', async () => {
    const liar: SmsAdapter = Object.assign(new SandboxSmsAdapter(), {
      sendMessage: async (): Promise<SendResult> => ({
        status: DeliveryStatus.DELIVERED,
        sandbox: true,
        provider_message_id: `sbx_${hex(16)}`,
      }),
    });
    const f = await calledWithContact();
    const e = await enqueue(f);
    await run(liar);
    expect((await notification(e.notificationId))?.status).toBe('sent');
  });

  it('two workers polling concurrently send each row once (SKIP LOCKED + guarded lease)', async () => {
    const rows = await Promise.all(
      Array.from({ length: 6 }, async () => enqueue(await calledWithContact())),
    );
    const calls: string[] = [];
    const counting: SmsAdapter = Object.assign(new SandboxSmsAdapter(), {
      sendMessage: async (p: SendMessageParams): Promise<SendResult> => {
        calls.push(p.idempotency_key);
        await new Promise((r) => setTimeout(r, 20));
        return {
          status: DeliveryStatus.SENT,
          sandbox: true,
          provider_message_id: `sbx_${hex(16)}`,
        };
      },
    });
    const [a, b] = await Promise.all([run(counting), run(counting)]);
    expect((a?.sent ?? 0) + (b?.sent ?? 0)).toBe(6);
    expect(new Set(calls).size).toBe(6);
    expect(calls).toHaveLength(6);
    for (const r of rows) expect((await notification(r.notificationId))?.status).toBe('sent');
  });
});

describe('at most once per key, retries and failures (REQ-F11.5)', () => {
  it('a crash between send and record is never resent: the reclaimed row is `unknown` / interrupted', async () => {
    const f = await calledWithContact();
    const e = await enqueue(f);
    // simulate: a previous worker marked the send and died before recording the outcome
    await sql`UPDATE notifications SET send_started_at = NOW(), provider = 'sandbox' WHERE id = ${e.notificationId}`;
    const r = await run();
    expect(r.unknown).toBe(1);
    expect(await notification(e.notificationId)).toMatchObject({
      status: 'unknown',
      detail_code: 'interrupted',
    });
    expect(adapter.getSentMessages()).toHaveLength(0);
  });

  it('"provider unavailable, not accepted" retries with backoff and stops at the attempt cap', async () => {
    const f = await calledWithContact({ phone: `+2348031234${SANDBOX_SMS_SCENARIOS.unavailable}` });
    const e = await enqueue(f);
    expect((await run()).retrying).toBe(1);
    let n = await notification(e.notificationId);
    expect(n?.status).toBe('pending');
    expect(n?.send_started_at).toBeNull(); // nothing was accepted: a retry may send
    for (let i = 0; i < 2; i++) {
      await due(e.outboxId);
      await run();
    }
    n = await notification(e.notificationId);
    expect(n).toMatchObject({ status: 'failed', detail_code: 'retries_exhausted' });
    expect(await outboxRow(e.outboxId)).toMatchObject({ processed: true, attempts: 3 });
    expect(adapter.getSentMessages()).toHaveLength(0);
  });

  it('a definitive rejection fails without retry; a transport error is `unknown` without retry', async () => {
    const r1 = await enqueue(
      await calledWithContact({ phone: `+2348031234${SANDBOX_SMS_SCENARIOS.rejected}` }),
    );
    const r2 = await enqueue(
      await calledWithContact({ phone: `+2348031234${SANDBOX_SMS_SCENARIOS.error}` }),
    );
    await run();
    expect(await notification(r1.notificationId)).toMatchObject({
      status: 'failed',
      detail_code: 'rejected',
    });
    expect(await notification(r2.notificationId)).toMatchObject({
      status: 'unknown',
      detail_code: 'error',
    });
    expect(await outboxRow(r2.outboxId)).toMatchObject({ processed: true });
  });

  it('an alert older than the TTL is closed `failed` / ttl_elapsed, never sent late', async () => {
    const e = await enqueue(await calledWithContact(), 500);
    await run();
    expect(await notification(e.notificationId)).toMatchObject({
      status: 'failed',
      detail_code: 'ttl_elapsed',
    });
    expect(adapter.getSentMessages()).toHaveLength(0);
  });

  it('a malformed outbox row is closed once as invalid_payload', async () => {
    const f = await calledWithContact();
    const e = await enqueue(f);
    await sql`UPDATE notification_outbox SET payload = '{"contact_id":"x"}' WHERE id = ${e.outboxId}`;
    await run();
    expect(await notification(e.notificationId)).toMatchObject({
      status: 'failed',
      detail_code: 'invalid_payload',
    });
  });

  it('a worker restart (fresh adapter, no memory) behaves the same: no duplicate send', async () => {
    const f = await calledWithContact();
    const e = await enqueue(f);
    await run();
    // a new process re-claims nothing (processed), and a forced re-claim finds the send marker
    await sql`UPDATE notification_outbox SET processed_at = NULL, next_attempt_at = NOW() WHERE id = ${e.outboxId}`;
    const fresh = new SandboxSmsAdapter();
    await run(fresh);
    expect(fresh.getSentMessages()).toHaveLength(0);
    expect((await notification(e.notificationId))?.status).toBe('unknown');
  });
});

describe('consent, opt-out and relevance are re-checked at send time (REQ-F11.9)', () => {
  it('opted out before the send: suppressed, nothing sent, number already erased', async () => {
    const f = await calledWithContact();
    const e = await enqueue(f);
    await sql`
      UPDATE visitor_contacts SET opted_out_at = NOW(), opt_out_source = 'visitor', phone_ciphertext = NULL, phone_hash = NULL
       WHERE id = ${f.contactId}`;
    await run();
    expect(await notification(e.notificationId)).toMatchObject({
      status: 'suppressed',
      detail_code: 'opted_out',
    });
    expect(adapter.getSentMessages()).toHaveLength(0);
  });

  it('an opt-out racing the send: whichever commits first wins, never both a send after opt-out', async () => {
    for (let i = 0; i < 10; i++) {
      const f = await calledWithContact();
      const e = await enqueue(f);
      const sends: number[] = [];
      const timed: SmsAdapter = Object.assign(new SandboxSmsAdapter(), {
        sendMessage: async (): Promise<SendResult> => {
          sends.push(Date.now());
          return {
            status: DeliveryStatus.SENT,
            sandbox: true,
            provider_message_id: `sbx_${hex(16)}`,
          };
        },
      });
      const [, optOut] = await Promise.all([
        run(timed),
        sql<{ at: Date }[]>`
          UPDATE visitor_contacts SET opted_out_at = clock_timestamp(), opt_out_source = 'visitor',
                 phone_ciphertext = NULL, phone_hash = NULL
           WHERE id = ${f.contactId} RETURNING opted_out_at AS at`,
      ]);
      const n = await notification(e.notificationId);
      if (n?.status === 'sent') {
        // the send began (marker committed) before the opt-out committed
        expect(n.send_started_at!.getTime()).toBeLessThanOrEqual(optOut[0]!.at.getTime());
      } else {
        expect(n).toMatchObject({ status: 'suppressed', detail_code: 'opted_out' });
        expect(sends).toHaveLength(0);
      }
    }
  });

  it.each([
    [
      'the ticket left `called`',
      "UPDATE tickets SET state = 'serving' WHERE id = $1",
      'ticket_changed',
    ],
    [
      'the facility switched SMS off',
      'UPDATE facility_sms_settings SET enabled = FALSE WHERE facility_id = (SELECT qs.facility_id FROM tickets t JOIN queue_sessions qs ON qs.id = t.queue_session_id WHERE t.id = $1)',
      'sms_disabled',
    ],
    [
      'the number was erased (visit ended)',
      'UPDATE visitor_contacts SET phone_ciphertext = NULL, phone_hash = NULL, erased_at = NOW() WHERE ticket_id = $1',
      'contact_removed',
    ],
  ])('%s → suppressed (%s)', async (_n, stmt, detail) => {
    const f = await calledWithContact();
    const e = await enqueue(f);
    await sql.unsafe(stmt, [f.ticketId]);
    await run();
    expect(await notification(e.notificationId)).toMatchObject({
      status: 'suppressed',
      detail_code: detail,
    });
    expect(adapter.getSentMessages()).toHaveLength(0);
  });

  it('no SMS adapter (off, unknown provider, production sandbox): rows past the TTL close as failed / sms_unavailable', async () => {
    const e1 = await enqueue(await calledWithContact(), 500);
    const e2 = await enqueue(await calledWithContact(), 0);
    const r = await processSmsAlerts(sql, null, cipher, { dailyCap: 1000 });
    expect(r.failed).toBe(1);
    expect(await notification(e1.notificationId)).toMatchObject({
      status: 'failed',
      detail_code: 'sms_unavailable',
    });
    expect((await notification(e2.notificationId))?.status).toBe('pending');
  });
});

describe('hard spending caps (REQ-F11.11)', () => {
  it('the global cap: exactly `cap` messages, the rest `failed` / cap, nothing held for later', async () => {
    const rows = await Promise.all(
      Array.from({ length: 5 }, async () => enqueue(await calledWithContact())),
    );
    const r = await run(adapter, 3);
    expect(r).toMatchObject({ sent: 3, capped: 2 });
    const states = await Promise.all(rows.map((x) => notification(x.notificationId)));
    expect(states.filter((s) => s?.status === 'sent')).toHaveLength(3);
    expect(states.filter((s) => s?.status === 'failed' && s.detail_code === 'cap')).toHaveLength(2);
    for (const x of rows) expect((await outboxRow(x.outboxId))?.processed).toBe(true);
    const [u] = await sql<{ sends: number }[]>`
      SELECT sends FROM sms_daily_usage WHERE scope = 'global' AND mode = 'sandbox'`;
    expect(u?.sends).toBe(3);
  });

  it('the global cap holds across concurrent workers (atomic reservation)', async () => {
    await Promise.all(Array.from({ length: 12 }, async () => enqueue(await calledWithContact())));
    const results = await Promise.all([run(adapter, 5), run(adapter, 5), run(adapter, 5)]);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(5);
    expect(results.reduce((n, r) => n + r.capped, 0)).toBe(7);
    expect(adapter.getSentMessages()).toHaveLength(5);
  });

  it('the facility cap stops one facility without consuming the global budget for the refused message', async () => {
    const first = await calledWithContact({ facilityCap: 2 });
    const same = { orgId: first.orgId, facilityId: first.facilityId };
    const rows = [await enqueue(first)];
    for (let i = 0; i < 3; i++) rows.push(await enqueue(await calledWithContact(same)));
    const other = await enqueue(await calledWithContact());
    const r = await run(adapter, 100);
    expect(r).toMatchObject({ sent: 3, capped: 2 });
    expect((await notification(other.notificationId))?.status).toBe('sent');
    const usage = await sql<
      { scope: string; sends: number }[]
    >`SELECT scope, sends FROM sms_daily_usage ORDER BY scope`;
    expect(usage.find((u) => u.scope === 'global')?.sends).toBe(3); // the refused two were rolled back
    expect(usage.find((u) => u.scope === first.facilityId)?.sends).toBe(2);
  });

  it('a cap of 0 (the default) sends nothing', async () => {
    const e = await enqueue(await calledWithContact());
    await run(adapter, 0);
    expect(await notification(e.notificationId)).toMatchObject({
      status: 'failed',
      detail_code: 'cap',
    });
    expect(adapter.getSentMessages()).toHaveLength(0);
  });

  it('sandbox sends are counted apart from live (never a financial charge)', async () => {
    await enqueue(await calledWithContact());
    await run();
    const rows = await sql<{ mode: string }[]>`SELECT DISTINCT mode FROM sms_daily_usage`;
    expect(rows.map((r) => r.mode)).toEqual(['sandbox']);
  });
});

describe('channel independence and queue neutrality (REQ-F11.10; Group 14.7 for SMS)', () => {
  it('no SMS outcome changes the ticket, the session or the event chain', async () => {
    const fs = await Promise.all([
      calledWithContact(),
      calledWithContact({ phone: `+2348031234${SANDBOX_SMS_SCENARIOS.rejected}` }),
      calledWithContact({ phone: `+2348031234${SANDBOX_SMS_SCENARIOS.error}` }),
      calledWithContact({ phone: `+2348031234${SANDBOX_SMS_SCENARIOS.unavailable}` }),
    ]);
    for (const f of fs) await enqueue(f);
    const snapshot = async (): Promise<unknown> =>
      sql`SELECT t.id, t.state, t.updated_at, qs.revision, qs.last_sequence,
                 (SELECT COUNT(*)::int FROM queue_events e WHERE e.queue_session_id = qs.id) AS events
            FROM tickets t JOIN queue_sessions qs ON qs.id = t.queue_session_id
           WHERE t.id = ANY(${fs.map((f) => f.ticketId)}::uuid[]) ORDER BY t.id`;
    const before = await snapshot();
    await run();
    await run(adapter, 0);
    expect(await snapshot()).toEqual(before);
    for (const f of fs) {
      const [m] =
        await sql`SELECT 1 FROM ticket_transitions WHERE ticket_id = ${f.ticketId} AND to_state = 'missed'`;
      expect(m).toBeUndefined();
    }
  });

  it('the push sender ignores SMS rows and the SMS sender ignores push rows', async () => {
    const f = await calledWithContact();
    const e = await enqueue(f);
    const push = await processTurnAlerts(sql, null, null, { ttlSeconds: 120 });
    expect(push.claimed).toBe(0);
    expect((await notification(e.notificationId))?.status).toBe('pending');
    const r = await run();
    expect(r.sent).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// M6.3 optional delay: "send SMS only if the in-app alert was not seen within N seconds"
// ---------------------------------------------------------------------------------------------
describe('delayed SMS and the in-app "seen" acknowledgement (M6.3)', () => {
  /** What the API hook writes for a delayed alert: skip_if_seen, due `dueInSeconds` from now. */
  async function enqueueDelayed(
    f: Fixture,
    dueInSeconds: number,
  ): Promise<{ outboxId: string; notificationId: string }> {
    const e = await enqueue(f);
    await sql`
      UPDATE notification_outbox
         SET payload = payload || '{"skip_if_seen": true}'::jsonb,
             next_attempt_at = NOW() + make_interval(secs => ${dueInSeconds})
       WHERE id = ${e.outboxId}`;
    return e;
  }
  const seen = async (f: Fixture, sequence = f.callSeq): Promise<void> => {
    await sql`
      INSERT INTO turn_alert_seen (ticket_id, organization_id, event_sequence)
      VALUES (${f.ticketId}, ${f.orgId}, ${sequence}) ON CONFLICT DO NOTHING`;
  };
  const used = async (): Promise<number> =>
    (await sql<{ n: number }[]>`SELECT COALESCE(SUM(sends), 0)::int AS n FROM sms_daily_usage`)[0]
      ?.n ?? -1;

  it('immediate mode is unchanged: an alert without the delay flag is sent even if the page saw the alert', async () => {
    const f = await calledWithContact();
    const e = await enqueue(f);
    await seen(f);
    await run();
    expect((await notification(e.notificationId))?.status).toBe('sent');
    expect(adapter.getSentMessages()).toHaveLength(1);
  });

  it('a delayed alert is not picked up before it is due (database time)', async () => {
    const f = await calledWithContact();
    const e = await enqueueDelayed(f, 60);
    expect((await run()).claimed).toBe(0);
    expect(await notification(e.notificationId)).toMatchObject({
      status: 'pending',
      send_started_at: null,
    });
    expect(await outboxRow(e.outboxId)).toMatchObject({ processed: false, attempts: 0 });
  });

  it('seen before it is due: suppressed as alert_seen, nothing sent, no cap used', async () => {
    const f = await calledWithContact();
    const e = await enqueueDelayed(f, 0);
    await seen(f);
    const r = await run();
    expect(r).toMatchObject({ claimed: 1, suppressed: 1, sent: 0 });
    expect(await notification(e.notificationId)).toMatchObject({
      status: 'suppressed',
      detail_code: 'alert_seen',
      send_started_at: null,
    });
    expect(adapter.getSentMessages()).toHaveLength(0);
    expect(await used()).toBe(0);
  });

  it('not seen by the time it is due: sent through every normal check', async () => {
    const f = await calledWithContact();
    const e = await enqueueDelayed(f, 0);
    await run();
    expect((await notification(e.notificationId))?.status).toBe('sent');
    expect(adapter.getSentMessages()).toHaveLength(1);
  });

  it('a seen mark for another call event cannot suppress this one', async () => {
    const f = await calledWithContact();
    const e = await enqueueDelayed(f, 0);
    await seen(f, f.callSeq + 5);
    await run();
    expect((await notification(e.notificationId))?.status).toBe('sent');
  });

  it('opt-out wins over everything (checked before the seen mark)', async () => {
    const f = await calledWithContact();
    const e = await enqueueDelayed(f, 0);
    await seen(f);
    await sql`
      UPDATE visitor_contacts SET opted_out_at = NOW(), opt_out_source = 'visitor',
             phone_ciphertext = NULL, phone_hash = NULL WHERE id = ${f.contactId}`;
    await run();
    expect(await notification(e.notificationId)).toMatchObject({
      status: 'suppressed',
      detail_code: 'opted_out',
    });
  });

  it('a ticket no longer called (served, or missed) is suppressed as before; the delay never changes ticket state', async () => {
    const f = await calledWithContact();
    const e = await enqueueDelayed(f, 0);
    await sql`UPDATE tickets SET state = 'serving' WHERE id = ${f.ticketId}`;
    await run();
    expect(await notification(e.notificationId)).toMatchObject({
      status: 'suppressed',
      detail_code: 'ticket_changed',
    });
    const [t] = await sql<{ state: string }[]>`SELECT state FROM tickets WHERE id = ${f.ticketId}`;
    expect(t?.state).toBe('serving');
  });

  it('a seen mark that arrives while the send is in progress cannot undo it', async () => {
    const f = await calledWithContact();
    const e = await enqueueDelayed(f, 0);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let entered: () => void = () => undefined;
    const inSend = new Promise<void>((r) => (entered = r));
    const slow: SmsAdapter = Object.assign(new SandboxSmsAdapter(), {
      sendMessage: async (params: SendMessageParams): Promise<SendResult> => {
        entered();
        await gate;
        return new SandboxSmsAdapter().sendMessage(params);
      },
    });
    const pass = run(slow);
    await inSend; // the send marker is committed before the provider call
    await seen(f);
    release();
    await pass;
    expect(await notification(e.notificationId)).toMatchObject({
      status: 'sent',
      detail_code: 'accepted',
    });
    // a later pass changes nothing
    expect((await run()).claimed).toBe(0);
    expect((await notification(e.notificationId))?.status).toBe('sent');
  });

  it('a seen mark holding the contact lock makes the worker wait, then skip (exact order, no double outcome)', async () => {
    const f = await calledWithContact();
    const e = await enqueueDelayed(f, 0);
    const u = new URL(URL_);
    u.pathname = `/${DB_NAME}`;
    const holder = postgres(u.toString(), { max: 1, onnotice: () => undefined });
    let commit: () => void = () => undefined;
    const committed = new Promise<void>((r) => (commit = r));
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((r) => (locked = r));
    try {
      // the API's acknowledgement: contact row lock, then the insert, committed later
      const ack = holder.begin(async (tx) => {
        await tx`SELECT id FROM visitor_contacts WHERE ticket_id = ${f.ticketId} FOR UPDATE`;
        await tx`INSERT INTO turn_alert_seen (ticket_id, organization_id, event_sequence)
                 VALUES (${f.ticketId}, ${f.orgId}, ${f.callSeq})`;
        locked();
        await committed;
      });
      await isLocked;
      const pass = run();
      // wait (on database state, not a timer) until the worker is blocked on that row lock
      await expect
        .poll(
          async () =>
            (
              await sql<{ n: number }[]>`
                SELECT COUNT(*)::int AS n FROM pg_stat_activity
                 WHERE datname = ${DB_NAME} AND wait_event_type = 'Lock'`
            )[0]?.n,
        )
        .toBeGreaterThanOrEqual(1);
      commit();
      await ack;
      await pass;
      expect(await notification(e.notificationId)).toMatchObject({
        status: 'suppressed',
        detail_code: 'alert_seen',
      });
      expect(adapter.getSentMessages()).toHaveLength(0);
      expect(await used()).toBe(0);
    } finally {
      commit();
      await holder.end({ timeout: 5 });
    }
  });

  it('crash after the send started: never resent, and a later seen mark cannot relabel it', async () => {
    const f = await calledWithContact();
    const e = await enqueueDelayed(f, 0);
    // a previous worker committed the send marker and died before recording the result
    await sql`UPDATE notifications SET send_started_at = NOW(), provider = 'sandbox' WHERE id = ${e.notificationId}`;
    await seen(f);
    await run();
    expect(await notification(e.notificationId)).toMatchObject({
      status: 'unknown',
      detail_code: 'interrupted',
    });
    expect(adapter.getSentMessages()).toHaveLength(0);
  });

  it('two workers on a due delayed alert send it once; caps stay atomic', async () => {
    const f = await calledWithContact();
    const e = await enqueueDelayed(f, 0);
    const second = new SandboxSmsAdapter({ log: () => undefined });
    await Promise.all([run(), run(second)]);
    expect(adapter.getSentMessages().length + second.getSentMessages().length).toBe(1);
    expect((await notification(e.notificationId))?.status).toBe('sent');
    const [g] = await sql<
      { sends: number }[]
    >`SELECT sends FROM sms_daily_usage WHERE scope = 'global'`;
    expect(g?.sends).toBe(1);
  });

  it('seen marks are removed after 24 hours by the retention job', async () => {
    const f = await calledWithContact();
    await seen(f);
    await sql`UPDATE turn_alert_seen SET seen_at = NOW() - INTERVAL '25 hours' WHERE ticket_id = ${f.ticketId}`;
    const r = await purgeSmsData(sql);
    expect(r.seenDeleted).toBeGreaterThanOrEqual(1);
    const left = await sql`SELECT 1 FROM turn_alert_seen WHERE ticket_id = ${f.ticketId}`;
    expect(left).toHaveLength(0);
  });
});

describe('only the approved trigger is ever sent (M6.1 pre-PR review)', () => {
  it('a row for an inactive template (nearing, delayed, missed, joined) is closed without sending', async () => {
    for (const template of ['ticket.nearing', 'ticket.delayed', 'ticket.missed', 'ticket.joined']) {
      const f = await calledWithContact();
      const row = await enqueue(f);
      await sql`UPDATE notifications SET template_key = ${template} WHERE id = ${row.notificationId}`;
      lines = [];
      await run();
      expect(await notification(row.notificationId)).toMatchObject({
        status: 'failed',
        detail_code: 'invalid_payload',
        send_started_at: null,
      });
      expect(lines.filter((l) => l.includes('accepted'))).toEqual([]);
    }
  });
});

describe('SMS data retention (design §13.2)', () => {
  it('erases the number when the visit ends, deletes the row at retention_until, and purges old rows', async () => {
    const ended = await calledWithContact();
    await sql`UPDATE tickets SET state = 'completed' WHERE id = ${ended.ticketId}`;
    const active = await calledWithContact();
    const expired = await calledWithContact();
    await sql`UPDATE visitor_contacts SET retention_until = NOW() - INTERVAL '1 minute' WHERE id = ${expired.contactId}`;
    const old = await enqueue(await calledWithContact());
    await sql`UPDATE notifications SET created_at = NOW() - INTERVAL '31 days' WHERE id = ${old.notificationId}`;
    await sql`INSERT INTO sms_webhook_nonces (provider, nonce, received_at) VALUES ('sandbox', ${hex(12)}, NOW() - INTERVAL '25 hours')`;
    const r = await purgeSmsData(sql);
    expect(r.erased).toBeGreaterThanOrEqual(1);
    expect(r.contactsDeleted).toBeGreaterThanOrEqual(1);
    expect(r.notificationsDeleted).toBeGreaterThanOrEqual(1);
    expect(r.noncesDeleted).toBeGreaterThanOrEqual(1);
    const rows = await sql<{ id: string; ct: boolean; hash: boolean; erased: boolean }[]>`
      SELECT id, (phone_ciphertext IS NOT NULL) AS ct, (phone_hash IS NOT NULL) AS hash, (erased_at IS NOT NULL) AS erased
        FROM visitor_contacts WHERE id = ANY(${[ended.contactId, active.contactId, expired.contactId]}::uuid[])`;
    expect(rows.find((x) => x.id === ended.contactId)).toMatchObject({
      ct: false,
      hash: false,
      erased: true,
    });
    expect(rows.find((x) => x.id === active.contactId)).toMatchObject({
      ct: true,
      hash: true,
      erased: false,
    });
    expect(rows.find((x) => x.id === expired.contactId)).toBeUndefined();
    // idempotent
    const again = await purgeSmsData(sql);
    expect(
      again.erased + again.contactsDeleted + again.notificationsDeleted + again.noncesDeleted,
    ).toBe(0);
  });

  // M6.1 pre-PR review (2026-11-20): the 24-hour row deletion could remove an active visit's
  // consent record (and with it the number) before the ticket ended. The row now lives as long
  // as its number; the number goes when the visit ends; 7 days after joining is a backstop only.
  const state = async (contactId: string): Promise<{ ct: boolean; erased: boolean } | undefined> =>
    (
      await sql<{ ct: boolean; erased: boolean }[]>`
        SELECT (phone_ciphertext IS NOT NULL AND phone_hash IS NOT NULL) AS ct, (erased_at IS NOT NULL) AS erased
          FROM visitor_contacts WHERE id = ${contactId}`
    )[0];
  /** Joined `hours` ago (consent and the 7-day backstop shifted back with it). */
  const joinedHoursAgo = async (f: Fixture, hours: number): Promise<void> => {
    await sql`
      UPDATE visitor_contacts
         SET consent_at = NOW() - make_interval(hours => ${hours}),
             retention_until = NOW() - make_interval(hours => ${hours}) + INTERVAL '168 hours'
       WHERE id = ${f.contactId}`;
  };

  it('an extended visit keeps its number and consent record past 24 hours in every active state', async () => {
    const fixtures: Fixture[] = [];
    for (const st of ['waiting', 'called', 'serving', 'paused']) {
      const f = await calledWithContact();
      await sql`UPDATE tickets SET state = ${st} WHERE id = ${f.ticketId}`;
      await joinedHoursAgo(f, 30);
      fixtures.push(f);
    }
    // missed, still inside its grace window (it can return to the queue)
    const graced = await calledWithContact();
    await sql`UPDATE tickets SET state = 'missed', missed_at = NOW() - INTERVAL '10 seconds' WHERE id = ${graced.ticketId}`;
    await joinedHoursAgo(graced, 30);
    fixtures.push(graced);
    // an unfinished queue running for days: still within the backstop
    const long = await calledWithContact();
    await sql`UPDATE tickets SET state = 'waiting' WHERE id = ${long.ticketId}`;
    await joinedHoursAgo(long, 6 * 24);
    fixtures.push(long);
    await purgeSmsData(sql);
    await purgeSmsData(sql);
    for (const f of fixtures) expect(await state(f.contactId)).toEqual({ ct: true, erased: false });
    // and the alert still goes out for such a visit
    const sent = await enqueue(fixtures[1] as Fixture);
    await run();
    expect((await notification(sent.notificationId))?.status).toBe('sent');
  });

  it('transfer: the contact follows the destination ticket and keeps its number; one left behind is erased', async () => {
    const moved = await calledWithContact();
    const dest = await calledWithContact({ orgId: moved.orgId, facilityId: moved.facilityId });
    // as the API's transfer hook does: source transferred, contact re-bound to the destination
    await sql`DELETE FROM visitor_contacts WHERE id = ${dest.contactId}`;
    await sql`UPDATE tickets SET state = 'transferred' WHERE id = ${moved.ticketId}`;
    await sql`UPDATE tickets SET state = 'waiting' WHERE id = ${dest.ticketId}`;
    await sql`UPDATE visitor_contacts SET ticket_id = ${dest.ticketId} WHERE id = ${moved.contactId}`;
    const left = await calledWithContact();
    await sql`UPDATE tickets SET state = 'transferred' WHERE id = ${left.ticketId}`;
    await purgeSmsData(sql);
    expect(await state(moved.contactId)).toEqual({ ct: true, erased: false });
    expect(await state(left.contactId)).toEqual({ ct: false, erased: true });
  });

  it('completion and session close erase at once; the record without a number goes 24 hours later, not before', async () => {
    const done = await calledWithContact();
    await sql`UPDATE tickets SET state = 'completed' WHERE id = ${done.ticketId}`;
    const closed = await calledWithContact();
    await sql`UPDATE queue_sessions SET state = 'closed' WHERE id = ${closed.sessionId}`;
    const lapsed = await calledWithContact();
    await sql`UPDATE tickets SET state = 'missed', missed_at = NOW() - INTERVAL '1 hour' WHERE id = ${lapsed.ticketId}`;
    await purgeSmsData(sql);
    for (const f of [done, closed, lapsed]) {
      expect(await state(f.contactId)).toEqual({ ct: false, erased: true });
    }
    await sql`UPDATE visitor_contacts SET erased_at = NOW() - INTERVAL '23 hours' WHERE id = ${done.contactId}`;
    await purgeSmsData(sql);
    expect(await state(done.contactId)).toBeDefined();
    await sql`UPDATE visitor_contacts SET erased_at = NOW() - INTERVAL '25 hours' WHERE id = ${done.contactId}`;
    await purgeSmsData(sql);
    expect(await state(done.contactId)).toBeUndefined();
  });

  it('opt-out: the number is gone at once (API); the opt-out record is kept 24 hours, then deleted', async () => {
    const f = await calledWithContact();
    await joinedHoursAgo(f, 2);
    // as the API's opt-out does
    await sql`
      UPDATE visitor_contacts SET opted_out_at = NOW(), opt_out_source = 'visitor',
             phone_ciphertext = NULL, phone_hash = NULL WHERE id = ${f.contactId}`;
    await purgeSmsData(sql);
    expect(await state(f.contactId)).toEqual({ ct: false, erased: false });
    await sql`UPDATE visitor_contacts SET opted_out_at = NOW() - INTERVAL '25 hours' WHERE id = ${f.contactId}`;
    await purgeSmsData(sql);
    expect(await state(f.contactId)).toBeUndefined();
  });

  it('backstop: a session nobody closed loses the number 7 days after joining, then the record', async () => {
    const f = await calledWithContact();
    await sql`UPDATE tickets SET state = 'waiting' WHERE id = ${f.ticketId}`;
    await joinedHoursAgo(f, 7 * 24 + 1);
    const r = await purgeSmsData(sql);
    expect(r.erased).toBeGreaterThanOrEqual(1);
    expect(await state(f.contactId)).toBeUndefined();
    // a call after that sends nothing: the contact is gone
    expect((await purgeSmsData(sql)).erased).toBe(0);
  });

  it('the database refuses a number without consent, and a number on an opted-out contact', async () => {
    const f = await calledWithContact();
    await expect(
      sql`UPDATE visitor_contacts SET consent_at = NULL WHERE id = ${f.contactId}`,
    ).rejects.toThrow(/visitor_contacts_consent_chk/);
    await expect(
      sql`UPDATE visitor_contacts SET opted_out_at = NOW(), opt_out_source = 'staff' WHERE id = ${f.contactId}`,
    ).rejects.toThrow(/visitor_contacts_erased_chk/);
  });

  it('the stored number is ciphertext only (no digits of the number appear in any SMS table)', async () => {
    const f = await calledWithContact();
    await enqueue(f);
    await run();
    const digits = f.phone.slice(-7);
    for (const table of [
      'visitor_contacts',
      'notifications',
      'notification_outbox',
      'notification_deliveries',
      'sms_daily_usage',
    ]) {
      const rows = await sql.unsafe(`SELECT * FROM ${table}`);
      expect(JSON.stringify(rows), table).not.toContain(digits);
    }
  });
});
