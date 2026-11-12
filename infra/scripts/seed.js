#!/usr/bin/env node
/**
 * QueueBridge seed runner.
 * Applies infra/seeds/dev_seed.sql to the target database.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node infra/scripts/seed.js
 *   or via: pnpm db:seed
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { assertQueueBridge } from './db-identity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_FILE = join(__dirname, '..', 'seeds', 'dev_seed.sql');
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  if (process.env.NODE_ENV === 'production') {
    console.error('ERROR: seed.js must not be run in production');
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });

  try {
    // Seed data only into an identified, fully migrated QueueBridge database
    await assertQueueBridge(sql, MIGRATIONS_DIR, { requireFullyMigrated: true });
    const content = await readFile(SEED_FILE, 'utf8');
    console.log('Applying dev seed data...');
    await sql.unsafe(content);
    console.log('Seed complete.');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err.code === 'QB_DB_IDENTITY' ? err.message : `Seed failed: ${err.message}`);
  process.exit(1);
});
