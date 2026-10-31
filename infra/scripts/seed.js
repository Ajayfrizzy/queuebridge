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

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_FILE = join(__dirname, '..', 'seeds', 'dev_seed.sql');

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

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const content = await readFile(SEED_FILE, 'utf8');
    console.log('Applying dev seed data...');
    await sql.unsafe(content);
    console.log('Seed complete.');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
