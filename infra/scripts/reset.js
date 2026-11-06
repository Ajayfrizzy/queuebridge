#!/usr/bin/env node
/**
 * QueueBridge database reset (DEVELOPMENT ONLY).
 * Drops and recreates the public schema, then re-runs migrations.
 *
 * WARNING: destroys all data. Never run in production.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node infra/scripts/reset.js
 *   or via: pnpm db:reset
 */

import { execSync } from 'node:child_process';
import postgres from 'postgres';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  if (process.env.NODE_ENV === 'production') {
    console.error('ERROR: db:reset must never be run in production');
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    console.log('Dropping public schema...');
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    console.log('Schema reset.');
  } finally {
    await sql.end();
  }

  console.log('Running migrations...');
  execSync('node infra/scripts/migrate.js', {
    stdio: 'inherit',
    env: { ...process.env },
  });
}

main().catch((err) => {
  console.error('Reset failed:', err.message);
  process.exit(1);
});
