#!/usr/bin/env node
/**
 * QueueBridge migration runner.
 * Applies all migrations in infra/migrations/ in filename order.
 * Tracks applied migrations in a _migrations table.
 * Idempotent: skips already-applied migrations.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node infra/scripts/migrate.js
 *   or via: pnpm db:migrate
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    // Create migrations tracking table
    await sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        id          SERIAL PRIMARY KEY,
        filename    TEXT NOT NULL UNIQUE,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Get list of already-applied migrations
    const applied = await sql`SELECT filename FROM _migrations ORDER BY filename`;
    const appliedSet = new Set(applied.map((r) => r.filename));

    // Get all migration files, sorted by filename
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    let appliedCount = 0;
    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`  SKIP  ${file} (already applied)`);
        continue;
      }

      const filePath = join(MIGRATIONS_DIR, file);
      const sql_content = await readFile(filePath, 'utf8');

      console.log(`  APPLY ${file}`);
      await sql.unsafe(sql_content);
      await sql`INSERT INTO _migrations (filename) VALUES (${file})`;
      appliedCount++;
    }

    if (appliedCount === 0) {
      console.log('No new migrations to apply.');
    } else {
      console.log(`Applied ${appliedCount} migration(s).`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
