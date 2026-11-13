import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRecoveryRetention } from './retention.js';

/**
 * M5.1 recovery-data retention against REAL PostgreSQL (testing steering 8.R10; design §15.14).
 * Rows are written directly with chosen timestamps (retention is about age, and the API cannot
 * produce day-old rows); the job under test is the real one the worker runs.
 *
 * The file runs in its own throwaway database with every migration applied: the job deletes
 * whatever is due, and on the shared test database it would (correctly) spend its bounded
 * batches on rows left by earlier runs and by parallel suites, making assertions about specific
 * rows depend on unrelated data.
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
const DB_NAME = `qb_ret_${randomBytes(6).toString('hex')}`;
let admin: Sql;
let sql: Sql;
beforeAll(async () => {
  admin = postgres(URL_, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
  const u = new URL(URL_);
  u.pathname = `/${DB_NAME}`;
  sql = postgres(u.toString(), { max: 3, onnotice: () => undefined });
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql')).sort()) {
    await sql.unsafe(await readFile(join(MIGRATIONS, f), 'utf8'));
  }
});
afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin?.end({ timeout: 5 });
});

const hex = (n = 32): string => randomBytes(n).toString('hex');
const ago = (hours: number): Date => new Date(Date.now() - hours * 3_600_000);

interface World {
  orgId: string;
  facilityId: string;
  sessionId: string;
  staffA: string;
  staffB: string;
  ticket: (
    state: string,
    opts?: { completedHoursAgo?: number; sessionId?: string },
  ) => Promise<string>;
  session: (state: 'open' | 'closed', updatedHoursAgo?: number) => Promise<string>;
}

async function world(): Promise<World> {
  const tag = hex(6);
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES ('Retention', ${`ret-${tag}`}) RETURNING id`;
  const orgId = org?.id ?? '';
  const [fac] = await sql<{ id: string }[]>`
    INSERT INTO facilities (organization_id, name, slug, timezone)
    VALUES (${orgId}, 'F', ${`f-${tag}`}, 'UTC') RETURNING id`;
  const facilityId = fac?.id ?? '';
  const [svc] = await sql<{ id: string }[]>`
    INSERT INTO services (organization_id, facility_id, name) VALUES (${orgId}, ${facilityId}, 'S') RETURNING id`;
  let day = Math.floor(Math.random() * 100_000);
  const session = async (state: 'open' | 'closed', updatedHoursAgo = 0): Promise<string> => {
    const [qs] = await sql<{ id: string }[]>`
      INSERT INTO queue_sessions (facility_id, organization_id, service_id, operational_date, state, updated_at)
      VALUES (${facilityId}, ${orgId}, ${svc?.id ?? ''}, CURRENT_DATE - ${day++}::int, ${state}, ${ago(updatedHoursAgo)})
      RETURNING id`;
    return qs?.id ?? '';
  };
  const sessionId = await session('open');
  let seq = 0;
  const ticket: World['ticket'] = async (state, opts = {}) => {
    seq += 1;
    const done = opts.completedHoursAgo === undefined ? null : ago(opts.completedHoursAgo);
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO tickets (queue_session_id, organization_id, public_code, state, issued_sequence,
                           completed_at, updated_at)
      VALUES (${opts.sessionId ?? sessionId}, ${orgId}, ${`R${String(seq).padStart(3, '0')}`}, ${state}, ${seq},
              ${done}, ${done ?? new Date()})
      RETURNING id`;
    return t?.id ?? '';
  };
  const staff = async (): Promise<string> => {
    const [s] = await sql<{ id: string }[]>`
      INSERT INTO staff_users (organization_id, email, password_hash, display_name)
      VALUES (${orgId}, ${`s-${hex(4)}@example.test`}, 'x', 'Staff') RETURNING id`;
    return s?.id ?? '';
  };
  return {
    orgId,
    facilityId,
    sessionId,
    staffA: await staff(),
    staffB: await staff(),
    ticket,
    session,
  };
}

const proof = (w: World, ticketId: string): Promise<unknown> =>
  sql`INSERT INTO ticket_recovery_proofs (ticket_id, organization_id, facility_id, key_hmac)
      VALUES (${ticketId}, ${w.orgId}, ${w.facilityId}, ${hex()})`;
const keyOf = async (ticketId: string): Promise<string | null | undefined> =>
  (
    await sql<
      { key_hmac: string | null }[]
    >`SELECT key_hmac FROM ticket_recovery_proofs WHERE ticket_id = ${ticketId}`
  )[0]?.key_hmac;

describe('8.R10 recovery-data retention', () => {
  it('status tokens: removed 24 h after expiry or revocation; live and recent ones stay', async () => {
    const w = await world();
    const tk = await w.ticket('waiting');
    const ins = async (
      expiresHoursAgo: number,
      revokedHoursAgo: number | null,
    ): Promise<string> => {
      const [r] = await sql<{ id: string }[]>`
        INSERT INTO ticket_recovery_credentials (ticket_id, credential_hash, expires_at, revoked_at, revoked_reason)
        VALUES (${tk}, ${hex()}, ${ago(expiresHoursAgo)},
                ${revokedHoursAgo === null ? null : ago(revokedHoursAgo)},
                ${revokedHoursAgo === null ? null : 'cap'})
        RETURNING id`;
      return r?.id ?? '';
    };
    const expiredOld = await ins(25, null);
    const expiredRecent = await ins(23, null);
    const revokedOld = await ins(-10, 25);
    const revokedRecent = await ins(-10, 2);
    const live = await ins(-10, null);
    await runRecoveryRetention(sql);
    const left = (
      await sql<
        { id: string }[]
      >`SELECT id FROM ticket_recovery_credentials WHERE ticket_id = ${tk}`
    ).map((r) => r.id);
    expect(left.sort()).toEqual([expiredRecent, revokedRecent, live].sort());
    expect(left).not.toContain(expiredOld);
    expect(left).not.toContain(revokedOld);
  });

  it('recovery key: removed 24 h after the visit ended; kept while it continues', async () => {
    const w = await world();
    const completedOld = await w.ticket('completed', { completedHoursAgo: 25 });
    const cancelledOld = await w.ticket('cancelled', { completedHoursAgo: 30 });
    const completedRecent = await w.ticket('completed', { completedHoursAgo: 3 });
    const waiting = await w.ticket('waiting');
    const missed = await w.ticket('missed');
    for (const id of [completedOld, cancelledOld, completedRecent, waiting, missed])
      await proof(w, id);
    await runRecoveryRetention(sql);
    expect(await keyOf(completedOld)).toBeNull();
    expect(await keyOf(cancelledOld)).toBeNull();
    for (const id of [completedRecent, waiting, missed])
      expect(await keyOf(id)).toMatch(/^[0-9a-f]{64}$/);
    // the proof row itself stays (without key material)
    expect(
      await sql`SELECT 1 FROM ticket_recovery_proofs WHERE ticket_id = ${completedOld}`,
    ).toHaveLength(1);
  });

  it('recovery key follows transfers: judged on the CURRENT ticket of the chain', async () => {
    const w = await world();
    // root → middle → current (still waiting): the visit continues, the key must stay
    const root = await w.ticket('transferred', { completedHoursAgo: 48 });
    const middle = await w.ticket('transferred', { completedHoursAgo: 40 });
    const current = await w.ticket('waiting');
    await sql`UPDATE tickets SET transferred_to_ticket_id = ${middle} WHERE id = ${root}`;
    await sql`UPDATE tickets SET transferred_to_ticket_id = ${current}, transferred_from_ticket_id = ${root} WHERE id = ${middle}`;
    await sql`UPDATE tickets SET transferred_from_ticket_id = ${middle} WHERE id = ${current}`;
    await proof(w, root);
    await runRecoveryRetention(sql);
    expect(await keyOf(root)).toMatch(/^[0-9a-f]{64}$/);
    // the visit ends at the destination more than 24 h ago: now the key goes
    await sql`UPDATE tickets SET state = 'completed', completed_at = ${ago(25)} WHERE id = ${current}`;
    await runRecoveryRetention(sql);
    expect(await keyOf(root)).toBeNull();
  });

  it('recovery key: removed 24 h after the queue session closed, even for a ticket left missed', async () => {
    const w = await world();
    const closedOld = await w.session('closed', 25);
    const closedRecent = await w.session('closed', 1);
    const a = await w.ticket('missed', { sessionId: closedOld });
    const b = await w.ticket('missed', { sessionId: closedRecent });
    await proof(w, a);
    await proof(w, b);
    await runRecoveryRetention(sql);
    expect(await keyOf(a)).toBeNull();
    expect(await keyOf(b)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('staff grants: removed 24 h after expiry, redemption or revocation; pending ones stay', async () => {
    const w = await world();
    const tk = await w.ticket('waiting');
    const ins = async (o: {
      expiresHoursAgo: number;
      redeemedHoursAgo?: number;
      revokedHoursAgo?: number;
    }): Promise<string> => {
      const approved = o.redeemedHoursAgo !== undefined;
      const [r] = await sql<{ id: string }[]>`
        INSERT INTO ticket_recovery_grants
          (ticket_id, organization_id, facility_id, grant_hmac, assurance, reason_code, created_by,
           approved_by, approved_at, expires_at, redeemed_at, revoked_at)
        VALUES (${tk}, ${w.orgId}, ${w.facilityId}, ${hex()}, 'basic', 'lost_device', ${w.staffA},
                ${approved ? w.staffB : null}, ${approved ? ago(48) : null}, ${ago(o.expiresHoursAgo)},
                ${o.redeemedHoursAgo === undefined ? null : ago(o.redeemedHoursAgo)},
                ${o.revokedHoursAgo === undefined ? null : ago(o.revokedHoursAgo)})
        RETURNING id`;
      return r?.id ?? '';
    };
    const expiredOld = await ins({ expiresHoursAgo: 25 });
    const redeemedOld = await ins({ expiresHoursAgo: -1, redeemedHoursAgo: 25 });
    const revokedOld = await ins({ expiresHoursAgo: -1, revokedHoursAgo: 26 });
    const expiredRecent = await ins({ expiresHoursAgo: 1 });
    const pending = await ins({ expiresHoursAgo: -0.1 });
    await runRecoveryRetention(sql);
    const left = (
      await sql<{ id: string }[]>`SELECT id FROM ticket_recovery_grants WHERE ticket_id = ${tk}`
    ).map((r) => r.id);
    expect(left.sort()).toEqual([expiredRecent, pending].sort());
    for (const id of [expiredOld, redeemedOld, revokedOld]) expect(left).not.toContain(id);
  });

  it('throttle windows: removed 24 h after the window started', async () => {
    const oldKey = hex();
    const recentKey = hex();
    await sql`
      INSERT INTO recovery_throttle (scope, key_hash, window_started_at, attempts, failures)
      VALUES ('source', ${oldKey}, ${ago(25)}, 3, 3), ('source', ${recentKey}, ${ago(1)}, 3, 3)`;
    await runRecoveryRetention(sql);
    const keys = (
      await sql<{ key_hash: string }[]>`
      SELECT key_hash FROM recovery_throttle WHERE key_hash IN (${oldKey}, ${recentKey})`
    ).map((r) => r.key_hash);
    expect(keys).toEqual([recentKey]);
  });

  it('is idempotent and bounded: a second pass removes nothing; batches drain a backlog', async () => {
    const w = await world();
    const tk = await w.ticket('waiting');
    for (let i = 0; i < 7; i++) {
      await sql`
        INSERT INTO ticket_recovery_credentials (ticket_id, credential_hash, expires_at)
        VALUES (${tk}, ${hex()}, ${ago(30)})`;
    }
    const count = async (): Promise<number> =>
      (
        await sql<
          { n: number }[]
        >`SELECT COUNT(*)::int AS n FROM ticket_recovery_credentials WHERE ticket_id = ${tk}`
      )[0]?.n ?? -1;
    // a pass never removes more than its batch per kind; repeated passes drain the backlog
    const first = await runRecoveryRetention(sql, { batch: 3 });
    expect(first.tokens).toBeLessThanOrEqual(3);
    let guard = 0;
    while ((await count()) > 0 && guard++ < 10) await runRecoveryRetention(sql, { batch: 3 });
    expect(await count()).toBe(0);
    // repeated passes leave rows that are not yet due exactly as they are
    await sql`
      INSERT INTO ticket_recovery_credentials (ticket_id, credential_hash, expires_at)
      VALUES (${tk}, ${hex()}, ${ago(23)})`;
    const snap = async (): Promise<unknown> =>
      sql`SELECT * FROM ticket_recovery_credentials WHERE ticket_id = ${tk} ORDER BY id`;
    await runRecoveryRetention(sql);
    const before = await snap();
    const second = await runRecoveryRetention(sql);
    expect(second).toEqual({ tokens: 0, keys: 0, grants: 0, throttle: 0 });
    expect(await snap()).toEqual(before);
    expect(await count()).toBe(1);
  });
});
