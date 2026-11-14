import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import postgres, { type Sql } from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import {
  inspectDatabase,
  listMigrationFiles,
  migrateDatabase,
} from '../../../infra/scripts/db-identity.js';

/**
 * Migration identity guard (fail-closed) against REAL PostgreSQL. Every case uses its own
 * throwaway database, so foreign / broken schemas never touch the shared test database.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DIR = join(ROOT, 'infra', 'migrations');
const BASE = process.env['TEST_DATABASE_URL'] ?? '';
const run = promisify(execFile);
const created: string[] = [];

const admin = postgres(BASE, { max: 1, onnotice: () => undefined });
afterAll(async () => {
  for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end({ timeout: 5 });
});

async function freshDb(): Promise<{ url: string; sql: Sql }> {
  const name = `qb_guard_${randomBytes(6).toString('hex')}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  created.push(name);
  const u = new URL(BASE);
  u.pathname = `/${name}`;
  return { url: u.toString(), sql: postgres(u.toString(), { max: 1, onnotice: () => undefined }) };
}

/** Everything a schema change could alter: relations, columns, functions, extensions. */
async function schemaSnapshot(sql: Sql): Promise<string> {
  const rows = await sql<{ x: string }[]>`
    SELECT n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' ||
           COALESCE((SELECT string_agg(a.attname, ',' ORDER BY a.attnum) FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '') AS x
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%'
    UNION ALL SELECT 'fn:' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    UNION ALL SELECT 'ext:' || extname FROM pg_extension
    ORDER BY 1`;
  return rows.map((r) => r.x).join('\n');
}

/** A database migrated by the PRE-guard runner: raw files + `_migrations`, no identity marker. */
async function legacyDb(upTo: number): Promise<{ url: string; sql: Sql }> {
  const db = await freshDb();
  await db.sql`CREATE TABLE _migrations (id SERIAL PRIMARY KEY, filename TEXT NOT NULL UNIQUE,
                                         applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  for (const f of (await listMigrationFiles(DIR)).slice(0, upTo)) {
    await db.sql.unsafe(await readFile(join(DIR, f), 'utf8'));
    await db.sql`INSERT INTO _migrations (filename) VALUES (${f})`;
  }
  return db;
}

async function cli(
  script: string,
  url: string,
  args: string[] = [],
): Promise<{ code: number; out: string }> {
  try {
    const r = await run(process.execPath, [join(ROOT, 'infra', 'scripts', script), ...args], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: url, NODE_ENV: 'development' },
    });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

const files = await listMigrationFiles(DIR);

describe('empty database → initialized as QueueBridge', () => {
  it('applies every migration, records the identity marker, and is idempotent', async () => {
    const { url, sql } = await freshDb();
    try {
      expect((await inspectDatabase(sql, files)).kind).toBe('empty');
      const first = await cli('migrate.js', url);
      expect(first.code).toBe(0);
      expect(first.out).toMatch(/empty — initializing as QueueBridge/);
      expect(first.out).toContain(`Applied ${files.length} migration(s).`);
      const [marker] = await sql<{ project: string; recorded_how: string }[]>`
        SELECT project, recorded_how FROM _queuebridge_identity`;
      expect(marker).toEqual({ project: 'queuebridge', recorded_how: 'initialized' });
      expect(
        (await sql<{ filename: string }[]>`SELECT filename FROM _migrations ORDER BY filename`).map(
          (r) => r.filename,
        ),
      ).toEqual(files);
      const second = await cli('migrate.js', url);
      expect(second.code).toBe(0);
      expect(second.out).toMatch(/identity and history verified/);
      expect(second.out).toContain('No new migrations to apply.');
      // seed accepts it (twice — idempotent)
      expect((await cli('seed.js', url)).code).toBe(0);
      expect((await cli('seed.js', url)).code).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('existing QueueBridge database with valid history → migrated', () => {
  it('a pre-guard database at 0005 (like the local dev database) gets 0006 onwards and its identity marker', async () => {
    const { url, sql } = await legacyDb(5);
    // Every migration after 0005 is pending (0006 fairness, 0007 recovery, …)
    const after5 = files.slice(5);
    expect(after5[0]).toBe('0006_fairness_routing_audit.sql');
    expect(after5).toContain('0007_ticket_recovery.sql');
    expect(after5).toContain('0008_device_health.sql');
    try {
      const before = await inspectDatabase(sql, files);
      expect(before).toMatchObject({ kind: 'legacy', pending: after5 });
      const check = await cli('migrate.js', url, ['--check']);
      expect(check.code).toBe(0);
      expect(check.out).toContain(`pending: ${after5.join(', ')}`);
      expect(await inspectDatabase(sql, files)).toEqual(before); // --check changed nothing
      const r = await cli('migrate.js', url);
      expect(r.code).toBe(0);
      for (const f of after5) expect(r.out).toContain(`APPLY ${f}`);
      expect(r.out).toContain(`Applied ${after5.length} migration(s).`);
      const [marker] = await sql<
        { recorded_how: string }[]
      >`SELECT recorded_how FROM _queuebridge_identity`;
      expect(marker?.recorded_how).toBe('adopted');
      expect(await inspectDatabase(sql, files)).toMatchObject({ kind: 'queuebridge', pending: [] });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('a marked database with pending migrations is migrated through the library API too', async () => {
    const { sql } = await legacyDb(3);
    try {
      await migrateDatabase(sql, { dir: DIR }); // adopts + applies 0004 onwards
      expect(await inspectDatabase(sql, files)).toMatchObject({ kind: 'queuebridge', pending: [] });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('foreign or unidentified database → rejected before any schema change', () => {
  const cases: [string, (sql: Sql) => Promise<unknown>][] = [
    [
      'another application’s tables',
      (sql) =>
        sql`CREATE TABLE users (id serial PRIMARY KEY, email text); CREATE TABLE orders (id int)`.simple(),
    ],
    [
      'another project’s _migrations history (same table name, other files)',
      (sql) =>
        sql`CREATE TABLE _migrations (id serial PRIMARY KEY, filename text UNIQUE, applied_at timestamptz);
            INSERT INTO _migrations (filename) VALUES ('001_create_users.sql'), ('002_add_orders.sql');
            CREATE TABLE users (id int)`.simple(),
    ],
    [
      'a _migrations table of a different shape',
      (sql) => sql`CREATE TABLE _migrations (version bigint PRIMARY KEY, dirty boolean)`.simple(),
    ],
    [
      'an identity marker naming another project',
      (sql) =>
        sql`CREATE TABLE _queuebridge_identity (project text PRIMARY KEY, recorded_how text, recorded_at timestamptz);
            INSERT INTO _queuebridge_identity VALUES ('avroqen', 'initialized', now())`.simple(),
    ],
    [
      'only a function in another schema',
      (sql) =>
        sql`CREATE SCHEMA app; CREATE FUNCTION app.f() RETURNS int LANGUAGE sql AS 'SELECT 1'`.simple(),
    ],
  ];

  it.each(cases)('%s', async (_name, setup) => {
    const { url, sql } = await freshDb();
    try {
      await setup(sql);
      const before = await schemaSnapshot(sql);
      expect(['foreign']).toContain((await inspectDatabase(sql, files)).kind);
      for (const script of ['migrate.js', 'seed.js', 'reset.js']) {
        const r = await cli(script, url);
        expect(r.code, script).toBe(1);
        expect(r.out, script).toMatch(
          /Refusing to modify database "qb_guard_[0-9a-f]+": it is not identified as a QueueBridge database/,
        );
        expect(r.out, script).toContain('Nothing was changed');
        expect(r.out, script).not.toContain(new URL(BASE).password || '\u0000'); // no credentials echoed
      }
      expect(await schemaSnapshot(sql)).toBe(before); // not even a bookkeeping table was created
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('inconsistent migration history → fails safely, never repaired', () => {
  const cases: [string, () => Promise<{ url: string; sql: Sql }>, RegExp][] = [
    [
      'a gap (0003 recorded, 0002 not)',
      async () => {
        const db = await legacyDb(3);
        await db.sql`DELETE FROM _migrations WHERE filename = '0002_append_only_trigger.sql'`;
        return db;
      },
      /history has gaps \(not applied, but later ones are: 0002_append_only_trigger\.sql\)/,
    ],
    [
      'a migration this checkout does not have (database from a newer branch)',
      async () => {
        const db = await legacyDb(6);
        await db.sql`INSERT INTO _migrations (filename) VALUES ('0099_future_feature.sql')`;
        return db;
      },
      /not in this checkout: 0099_future_feature\.sql/,
    ],
    [
      'history claims 0006 but its objects are missing',
      async () => {
        const db = await legacyDb(5);
        await db.sql`INSERT INTO _migrations (filename) VALUES ('0006_fairness_routing_audit.sql')`;
        return db;
      },
      /0006_fairness_routing_audit\.sql is recorded as applied but "service_policy_versions" is missing/,
    ],
    [
      'identity marker present but no history',
      async () => {
        const db = await freshDb();
        await db.sql`CREATE TABLE _queuebridge_identity (project text PRIMARY KEY, recorded_how text, recorded_at timestamptz);
                     INSERT INTO _queuebridge_identity VALUES ('queuebridge', 'initialized', now())`.simple();
        return db;
      },
      /identity marker present but _migrations is missing/,
    ],
    [
      'identity marker and empty history, but tables already exist',
      async () => {
        const db = await freshDb();
        await db.sql`CREATE TABLE _queuebridge_identity (project text PRIMARY KEY, recorded_how text, recorded_at timestamptz);
                     INSERT INTO _queuebridge_identity VALUES ('queuebridge', 'initialized', now());
                     CREATE TABLE _migrations (id serial PRIMARY KEY, filename text UNIQUE, applied_at timestamptz);
                     CREATE TABLE organizations (id int)`.simple();
        return db;
      },
      /no migration recorded, but the database already has tables/,
    ],
  ];

  it.each(cases)('%s', async (_name, make, reason) => {
    const { url, sql } = await make();
    try {
      const before = await schemaSnapshot(sql);
      const history = await sql`SELECT filename FROM _migrations ORDER BY 1`.catch(() => []);
      const i = await inspectDatabase(sql, files);
      expect(i.kind).toBe('inconsistent');
      const r = await cli('migrate.js', url);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/identity or migration history is inconsistent/);
      expect(r.out).toMatch(reason);
      expect((await cli('reset.js', url)).code).toBe(1); // a broken history is never "fixed" by a reset either
      expect(await schemaSnapshot(sql)).toBe(before);
      expect(await sql`SELECT filename FROM _migrations ORDER BY 1`.catch(() => [])).toEqual(
        history,
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('concurrent runners', () => {
  it('two migrate runs on an empty database at once: one initializes, the other then finds nothing to do', async () => {
    const { url, sql } = await freshDb();
    try {
      const [a, b] = await Promise.all([cli('migrate.js', url), cli('migrate.js', url)]);
      expect([a.code, b.code]).toEqual([0, 0]);
      const outs = [a.out, b.out];
      expect(outs.filter((o) => o.includes(`Applied ${files.length} migration(s).`))).toHaveLength(
        1,
      );
      expect(outs.filter((o) => o.includes('No new migrations to apply.'))).toHaveLength(1);
      const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM _migrations`;
      expect(row?.n).toBe(files.length);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
