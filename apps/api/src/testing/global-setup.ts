import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/** Apply all migrations to the test database once, in order, tracking them like db:migrate. */
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
    await sql`CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY, filename TEXT NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    const applied = new Set(
      (await sql<{ filename: string }[]>`SELECT filename FROM _migrations`).map((r) => r.filename),
    );
    for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      if (applied.has(file)) continue;
      await sql.unsafe(await readFile(join(dir, file), 'utf8'));
      await sql`INSERT INTO _migrations (filename) VALUES (${file})`;
    }
  } finally {
    await sql.end();
  }
}
