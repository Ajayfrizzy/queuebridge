import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SANDBOX_SMS_SCENARIOS, createContactCipher } from '@queuebridge/channels';
/**
 * M6.1 pre-PR review (2026-11-20): the REAL worker startup path with SMS unavailable. Runs the
 * BUILT worker (`node dist/worker.js --once`, `pnpm build` first, as CI does) against its own
 * throwaway PostgreSQL database with every migration, and checks what the process does, not
 * what the environment parser returns:
 *  - production starts normally and runs its other jobs when SMS has no approved live provider
 *    (the default), when the sandbox is configured, and when an unknown provider is named;
 *  - none of those configurations hands anything to an adapter or reserves a daily-cap unit;
 *  - SMS_DAILY_CAP=0 prevents dispatch even with an adapter;
 *  - a control run (sandbox, development, cap > 0) sends, so the "nothing sent" checks above
 *    cannot pass vacuously.
 */
const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'worker.js');
const MIGRATIONS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'infra',
  'migrations',
);
const URL_ = process.env['TEST_DATABASE_URL'] ?? '';
const DB_NAME = `qb_smsstart_${randomBytes(6).toString('hex')}`;
const KEY = 'c0ffee'.repeat(10) + 'c0ff';
const cipher = createContactCipher(KEY)!;
/** TEST-ONLY audit key pair (production requires one; never a real secret). */
const PRODUCTION = {
  NODE_ENV: 'production',
  AUDIT_SIGNING_KEY_ID: 'test-only-key',
  AUDIT_SIGNING_KEY: 'test-audit-signing-key-at-least-32-characters',
};
let admin: Sql;
let sql: Sql;
let dbUrl = '';
beforeAll(async () => {
  admin = postgres(URL_, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
  const u = new URL(URL_);
  u.pathname = `/${DB_NAME}`;
  dbUrl = u.toString();
  sql = postgres(dbUrl, { max: 4, onnotice: () => undefined });
  const files = (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql')).sort();
  for (const f of files) await sql.unsafe(await readFile(join(MIGRATIONS, f), 'utf8'));
  // the worker's startup check reads the migration ledger (as `pnpm db:migrate` writes it)
  await sql.unsafe(
    'CREATE TABLE IF NOT EXISTS _migrations (id SERIAL PRIMARY KEY, filename TEXT NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
  );
  for (const f of files) {
    await sql`INSERT INTO _migrations (filename) VALUES (${f}) ON CONFLICT DO NOTHING`;
  }
});
afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin?.end({ timeout: 5 });
});
beforeEach(async () => {
  // each run sees only its own rows
  await sql`UPDATE notification_outbox SET processed_at = NOW() WHERE processed_at IS NULL`;
  await sql`DELETE FROM sms_daily_usage`;
});

const hex = (n = 4): string => randomBytes(n).toString('hex');
let day = 1;
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
/** A called ticket with a consented contact and the outbox row the API's hook writes. */
async function pendingSms(ageSeconds = 0): Promise<{ notificationId: string; outboxId: string }> {
  const tag = hex();
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES ('O', ${`o-${tag}`}) RETURNING id`;
  const orgId = org?.id ?? '';
  const [fac] = await sql<{ id: string }[]>`
    INSERT INTO facilities (organization_id, name, slug, timezone) VALUES (${orgId}, 'F', ${`f-${tag}`}, 'UTC') RETURNING id`;
  const facilityId = fac?.id ?? '';
  const [staff] = await sql<{ id: string }[]>`
    INSERT INTO staff_users (organization_id, email, password_hash, display_name)
    VALUES (${orgId}, ${`a-${tag}@example.test`}, 'x', 'A') RETURNING id`;
  await sql`
    INSERT INTO facility_sms_settings (facility_id, organization_id, enabled, daily_cap, updated_by)
    VALUES (${facilityId}, ${orgId}, TRUE, 1000, ${staff?.id ?? ''})`;
  const [svc] = await sql<{ id: string }[]>`
    INSERT INTO services (organization_id, facility_id, name) VALUES (${orgId}, ${facilityId}, ${`S-${tag}`}) RETURNING id`;
  const [ctr] = await sql<{ id: string }[]>`
    INSERT INTO counters (organization_id, facility_id, name) VALUES (${orgId}, ${facilityId}, ${`C-${tag}`}) RETURNING id`;
  const [qs] = await sql<{ id: string }[]>`
    INSERT INTO queue_sessions (facility_id, organization_id, service_id, operational_date, state, revision, last_sequence)
    VALUES (${facilityId}, ${orgId}, ${svc?.id ?? ''}, CURRENT_DATE - ${day++}::int, 'open', 1, 1) RETURNING id`;
  const [tk] = await sql<{ id: string }[]>`
    INSERT INTO tickets (queue_session_id, organization_id, public_code, state, issued_sequence, current_counter_id)
    VALUES (${qs?.id ?? ''}, ${orgId}, 'A001', 'called', 1, ${ctr?.id ?? ''}) RETURNING id`;
  const [ev] = await sql<{ id: string }[]>`
    INSERT INTO queue_events (organization_id, queue_session_id, sequence, event_type, payload, prev_hash, event_hash)
    VALUES (${orgId}, ${qs?.id ?? ''}, 1, 'ticket.call_next', '{}', ${'0'.repeat(64)}, ${hex(32)}) RETURNING id`;
  await sql`
    INSERT INTO ticket_transitions (ticket_id, from_state, to_state, queue_event_id)
    VALUES (${tk?.id ?? ''}, 'waiting', 'called', ${ev?.id ?? ''})`;
  const phone = ordinaryPhone();
  const [vc] = await sql<{ id: string }[]>`
    INSERT INTO visitor_contacts
      (organization_id, facility_id, ticket_id, phone_ciphertext, phone_hash, consent_at, consent_version, retention_until)
    VALUES (${orgId}, ${facilityId}, ${tk?.id ?? ''}, ${cipher.sealPhone(phone)}, ${cipher.phoneHash(phone)},
            NOW(), 'sms-consent-v1', NOW() + INTERVAL '168 hours')
    RETURNING id`;
  const [n] = await sql<{ id: string }[]>`
    INSERT INTO notifications (organization_id, ticket_id, channel, template_key, status, visitor_contact_id, event_sequence, created_at)
    VALUES (${orgId}, ${tk?.id ?? ''}, 'sms', 'ticket.called', 'pending', ${vc?.id ?? ''}, 1,
            NOW() - make_interval(secs => ${ageSeconds}))
    RETURNING id`;
  const [o] = await sql<{ id: string }[]>`
    INSERT INTO notification_outbox (notification_id, dedup_key, payload, created_at, next_attempt_at)
    VALUES (${n?.id ?? ''}, ${`sms:ticket.called:${tk?.id ?? ''}:1`},
            ${sql.json({
              contact_id: vc?.id ?? '',
              ticket_id: tk?.id ?? '',
              facility_id: facilityId,
              event_sequence: 1,
              counter_id: ctr?.id ?? '',
            })},
            NOW() - make_interval(secs => ${ageSeconds}), NOW() - make_interval(secs => ${ageSeconds}))
    RETURNING id`;
  return { notificationId: n?.id ?? '', outboxId: o?.id ?? '' };
}

interface Run {
  code: number | null;
  lines: Record<string, unknown>[];
  text: string;
}
/** The built worker, `--once`, with exactly this environment (no inherited variables). */
function worker(extra: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    // an empty value REMOVES the variable (e.g. to run without the contact key)
    const env: Record<string, string> = {
      PATH: process.env['PATH'] ?? '',
      DATABASE_URL: dbUrl,
      CONTACT_ENCRYPTION_KEY: KEY,
      LOG_LEVEL: 'info',
      WORKER_ONCE_TIMEOUT_MS: '30000',
      // keep the checkpoint job from acting on the synthetic events (it still runs)
      AUDIT_CHECKPOINT_MIN_EVENTS: '100000',
      AUDIT_CHECKPOINT_MAX_AGE_MS: '86400000',
      ...extra,
    };
    for (const k of Object.keys(env)) if (env[k] === '') delete env[k];
    const child = spawn(process.execPath, [WORKER, '--once'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (d: Buffer) => (text += d.toString()));
    child.stderr.on('data', (d: Buffer) => (text += d.toString()));
    const backstop = setTimeout(() => child.kill('SIGKILL'), 45_000);
    child.on('exit', (code) => {
      clearTimeout(backstop);
      const lines = text.split('\n').flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
      resolve({ code, lines, text });
    });
  });
}
const line = (r: Run, msg: string): Record<string, unknown> | undefined =>
  r.lines.find((l) => l['msg'] === msg);
const notification = async (
  id: string,
): Promise<{ status: string; detail_code: string | null; send_started_at: Date | null }> =>
  (
    await sql<{ status: string; detail_code: string | null; send_started_at: Date | null }[]>`
      SELECT status, detail_code, send_started_at FROM notifications WHERE id = ${id}`
  )[0] ?? { status: 'missing', detail_code: null, send_started_at: null };
const attempts = async (outboxId: string): Promise<number> =>
  (
    await sql<
      { n: number }[]
    >`SELECT attempt_count AS n FROM notification_outbox WHERE id = ${outboxId}`
  )[0]?.n ?? -1;
/** Daily-cap units reserved: deployment-wide only, or every scope (global and facility). */
const usage = async (scope: 'global' | 'all' = 'all'): Promise<number> =>
  (
    await sql<{ n: number }[]>`
      SELECT COALESCE(SUM(sends), 0)::int AS n FROM sms_daily_usage
       WHERE ${scope === 'global'} = FALSE OR scope = 'global'`
  )[0]?.n ?? -1;
const healthRun = async (): Promise<{ at: Date; cfg: Record<string, unknown> | null }> => {
  const [h] = await sql<{ at: Date; cfg: Record<string, unknown> | null }[]>`
    SELECT last_evaluated_at AS at, worker_config AS cfg FROM health_evaluations`;
  return h ?? { at: new Date(0), cfg: null };
};
/** Nothing was handed to an adapter, nothing was counted against a cap. */
async function nothingDispatched(r: Run, row: { notificationId: string }): Promise<void> {
  const n = await notification(row.notificationId);
  expect(n.send_started_at).toBeNull();
  expect(n.status).not.toBe('sent');
  expect(n.status).not.toBe('delivered');
  expect(await usage()).toBe(0);
  expect(r.text).not.toContain('SMS accepted');
}

describe('worker startup with SMS unavailable (real process, production configuration)', () => {
  it('default production configuration: starts, runs its other jobs, SMS explicitly off, nothing dispatched', async () => {
    const fresh = await pendingSms();
    const stale = await pendingSms(600); // older than the 120 s TTL
    const before = new Date();
    const r = await worker(PRODUCTION);
    expect(r.code, r.text).toBe(0);
    expect(line(r, 'Worker started')).toBeDefined();
    expect(line(r, 'Worker run complete')).toBeDefined();
    expect(line(r, 'SMS turn alerts')).toMatchObject({
      adapter: 'disabled',
      reason: 'off',
      sandbox: false,
    });
    // no SMS error and no sandbox at all in production by default
    expect(r.text).not.toContain('SANDBOX] SMS');
    expect(r.lines.filter((l) => l['level'] === 'error' && /SMS/.test(String(l['msg'])))).toEqual(
      [],
    );
    // the other jobs ran: device health evaluated and recorded this worker's configuration
    const h = await healthRun();
    expect(h.at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(h.cfg).toMatchObject({ SMS_PROVIDER: 'disabled', SMS_DAILY_CAP: 0 });
    expect(line(r, 'Audit checkpoints enabled')).toBeDefined();
    // the fresh alert is neither claimed nor sent; the stale one is closed honestly
    await nothingDispatched(r, fresh);
    expect(await notification(fresh.notificationId)).toMatchObject({ status: 'pending' });
    expect(await attempts(fresh.outboxId)).toBe(0);
    expect(await notification(stale.notificationId)).toMatchObject({
      status: 'failed',
      detail_code: 'sms_unavailable',
    });
  }, 60_000);

  it('the sandbox configured in production is refused: the worker still starts and runs, SMS disabled, nothing dispatched', async () => {
    const row = await pendingSms();
    const r = await worker({ ...PRODUCTION, SMS_PROVIDER: 'sandbox', SMS_DAILY_CAP: '1000' });
    expect(r.code, r.text).toBe(0);
    expect(
      line(r, 'SMS_PROVIDER=sandbox is refused in production: SMS sending disabled'),
    ).toMatchObject({ level: 'error' });
    expect(line(r, 'SMS turn alerts')).toMatchObject({
      adapter: 'disabled',
      reason: 'sandbox_refused_in_production',
    });
    expect(line(r, 'Worker run complete')).toBeDefined();
    expect(r.text).not.toContain('[SANDBOX] SMS adapter');
    await nothingDispatched(r, row);
    expect(await attempts(row.outboxId)).toBe(0);
    expect((await healthRun()).cfg).toMatchObject({ SMS_PROVIDER: 'disabled' });
  }, 60_000);

  it('an unknown or would-be live provider name disables SMS, never the worker', async () => {
    const row = await pendingSms();
    for (const provider of ['termii', 'live', 'twilio']) {
      const r = await worker({ ...PRODUCTION, SMS_PROVIDER: provider, SMS_DAILY_CAP: '1000' });
      expect(r.code, r.text).toBe(0);
      expect(line(r, 'SMS turn alerts')).toMatchObject({
        adapter: 'disabled',
        reason: 'unknown_provider',
      });
      expect(line(r, 'Worker run complete')).toBeDefined();
      await nothingDispatched(r, row);
    }
  }, 120_000);

  it('a missing contact key disables SMS (numbers cannot be read), never the worker', async () => {
    const row = await pendingSms();
    const r = await worker({
      NODE_ENV: 'development',
      SMS_PROVIDER: 'sandbox',
      SMS_DAILY_CAP: '1000',
      CONTACT_ENCRYPTION_KEY: '',
    });
    expect(r.code, r.text).toBe(0);
    expect(line(r, 'SMS turn alerts')).toMatchObject({
      adapter: 'disabled',
      reason: 'no_contact_key',
    });
    await nothingDispatched(r, row);
  }, 60_000);

  it('SMS_DAILY_CAP=0 prevents all dispatch even with an adapter', async () => {
    const rows = [await pendingSms(), await pendingSms()];
    const r = await worker({
      NODE_ENV: 'development',
      SMS_PROVIDER: 'sandbox',
      SMS_DAILY_CAP: '0',
    });
    expect(r.code, r.text).toBe(0);
    expect(line(r, 'SMS_DAILY_CAP is 0: no text message will be sent')).toBeDefined();
    for (const row of rows) {
      await nothingDispatched(r, row);
      expect(await notification(row.notificationId)).toMatchObject({
        status: 'failed',
        detail_code: 'cap',
      });
    }
  }, 60_000);

  it('control: the sandbox in development with a cap does send (the checks above are not vacuous)', async () => {
    const row = await pendingSms();
    const r = await worker({
      NODE_ENV: 'development',
      SMS_PROVIDER: 'sandbox',
      SMS_DAILY_CAP: '5',
    });
    expect(r.code, r.text).toBe(0);
    expect(line(r, 'SMS turn alerts')).toMatchObject({
      adapter: 'sandbox',
      reason: 'configured',
      sandbox: true,
    });
    const n = await notification(row.notificationId);
    expect(n.status).toBe('sent');
    expect(n.send_started_at).not.toBeNull();
    expect(await usage('global')).toBe(1);
    expect(await usage('all')).toBe(2); // the facility's unit too
    expect(r.text).toContain('SMS accepted');
  }, 60_000);
});
