import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { migrateDatabase } from '../../../../infra/scripts/db-identity.js';

/**
 * Apply all migrations to the test database once, exactly like `pnpm db:migrate`: same identity
 * guard, same history, same advisory lock (the API and worker suites may start at once).
 */
export default async function setup(): Promise<void> {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  const dir = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'infra',
    'migrations',
  );
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await migrateDatabase(sql, { dir });
  } finally {
    await sql.end();
  }
}
