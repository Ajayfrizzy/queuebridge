import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeUssdSessions } from './ussd-retention.js';
/**
 * M6.2 USSD session retention on real PostgreSQL (own throwaway database, every migration).
 * Rows are placed with SQL as the API writes them.
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
const DB_NAME = `qb_ussd_${randomBytes(6).toString('hex')}`;
let admin: Sql;
let sql: Sql;
beforeAll(async () => {
  admin = postgres(URL_, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
  const u = new URL(URL_);
  u.pathname = `/${DB_NAME}`;
  sql = postgres(u.toString(), { max: 4, onnotice: () => undefined });
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql')).sort()) {
    await sql.unsafe(await readFile(join(MIGRATIONS, f), 'utf8'));
  }
});
afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin?.end({ timeout: 5 });
});
async function session(expiredSecondsAgo: number): Promise<string> {
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO ussd_sessions (provider_session_key_hash, msisdn_hash, state, step, last_text_hash, last_response_ct, expires_at, joined_at)
    VALUES (${randomBytes(32).toString('hex')}, ${randomBytes(32).toString('hex')},
            ${sql.json({ screen: 'main' })}, 3, 'h', 'sealed-screen',
            NOW() - make_interval(secs => ${expiredSecondsAgo}), NOW() - make_interval(secs => ${expiredSecondsAgo + 5}))
    RETURNING id`;
  return r?.id ?? '';
}
const row = async (id: string): Promise<{ ct: string | null; state: unknown } | undefined> =>
  (
    await sql<
      { ct: string | null; state: unknown }[]
    >`SELECT last_response_ct AS ct, state FROM ussd_sessions WHERE id = ${id}`
  )[0];

describe('USSD session retention', () => {
  it('keeps live and just-expired sessions; clears the encrypted screen after 10 minutes; deletes after 1 hour; idempotent', async () => {
    const live = await session(-120); // expires in 2 minutes
    const recent = await session(60);
    const stale = await session(15 * 60);
    const old = await session(61 * 60);
    const r = await purgeUssdSessions(sql);
    // the hour-old row is cleared, then deleted, in the same pass
    expect(r).toEqual({ cleared: 2, deleted: 1 });
    expect(await row(live)).toMatchObject({ ct: 'sealed-screen' });
    expect(await row(recent)).toMatchObject({ ct: 'sealed-screen' });
    expect(await row(stale)).toEqual({ ct: null, state: {} });
    expect(await row(old)).toBeUndefined();
    expect(await purgeUssdSessions(sql)).toEqual({ cleared: 0, deleted: 0 });
  });
  it('the database keeps a session’s facility and organization together', async () => {
    await expect(
      sql`INSERT INTO ussd_sessions (provider_session_key_hash, facility_id, expires_at)
          VALUES ('x', gen_random_uuid(), NOW())`,
    ).rejects.toThrow(/ussd_sessions_scope_pair_chk/);
  });
});
