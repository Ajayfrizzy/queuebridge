import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';

export const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'infra',
  'migrations',
);

export async function migrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
}

export async function readMigration(file: string): Promise<string> {
  return readFile(join(MIGRATIONS_DIR, file), 'utf8');
}

/**
 * A brand-new, throwaway PostgreSQL database on the same server as TEST_DATABASE_URL.
 * DDL-heavy tests (migration idempotency) run here so their ACCESS EXCLUSIVE locks can never
 * deadlock with application transactions of tests running in parallel on the shared test DB.
 */
export async function withIsolatedDatabase<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  const name = `qb_iso_${randomBytes(6).toString('hex')}`;
  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const sql = postgres(target.toString(), { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
}
