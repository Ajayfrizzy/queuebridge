#!/usr/bin/env node
/**
 * QueueBridge migration runner.
 * Applies all migrations in infra/migrations/ in filename order, tracked in `_migrations`.
 * Idempotent: skips already-applied migrations. Each migration commits with its history row.
 *
 * Fail-closed identity guard (infra/scripts/db-identity.js): before ANY schema change the target
 * is inspected; only an empty database or an identified QueueBridge database with a consistent
 * history is migrated. Foreign, unidentified or inconsistent databases are refused unchanged.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node infra/scripts/migrate.js
 *   or via: pnpm db:migrate
 *   --check   inspect and report only (no changes)
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { inspectDatabase, listMigrationFiles, migrateDatabase, refusal } from './db-identity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    if (process.argv.includes('--check')) {
      const i = await inspectDatabase(sql, await listMigrationFiles(MIGRATIONS_DIR));
      console.log(`Database "${i.database}": ${i.kind}`);
      if (i.kind === 'foreign' || i.kind === 'inconsistent') {
        console.error(refusal(i));
        process.exitCode = 1;
        return;
      }
      console.log(`  applied: ${i.applied.length} · pending: ${i.pending.join(', ') || 'none'}`);
      return;
    }
    const r = await migrateDatabase(sql, { dir: MIGRATIONS_DIR, log: (l) => console.log(l) });
    console.log(
      r.applied.length === 0
        ? 'No new migrations to apply.'
        : `Applied ${r.applied.length} migration(s).`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err.code === 'QB_DB_IDENTITY' ? err.message : `Migration failed: ${err.message}`);
  process.exit(1);
});
