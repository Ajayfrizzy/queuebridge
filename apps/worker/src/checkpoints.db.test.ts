import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkpointMessage,
  checkpointRoot,
  computeEventHash,
  genesisHash,
  verifyCheckpoints,
} from '@queuebridge/domain';
import {
  assertQueueBridgeDatabase,
  REQUIRED_MIGRATION,
  runCheckpointJob,
  sha256Hex,
  signCheckpoint,
  type CheckpointJobOptions,
} from './checkpoints.js';

/**
 * Audit checkpoint job against REAL PostgreSQL (testing Group 9).
 * Tamper scenarios use a throwaway database: they must disable append-only triggers, which would
 * otherwise affect tests running in parallel on the shared test database.
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
const KEY = 'test-audit-signing-key-at-least-32-characters';
const OPTS: CheckpointJobOptions = {
  keyId: 'test-key-1',
  key: KEY,
  minEvents: 5,
  maxAgeMs: 3_600_000,
};

let shared: Sql;
beforeAll(() => {
  shared = postgres(URL_, { max: 4, onnotice: () => undefined });
});
afterAll(async () => {
  await shared.end({ timeout: 5 });
});

async function isolated<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  const name = `qb_iso_${randomBytes(6).toString('hex')}`;
  const admin = postgres(URL_, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const u = new URL(URL_);
  u.pathname = `/${name}`;
  const sql = postgres(u.toString(), { max: 2, onnotice: () => undefined });
  try {
    for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql')).sort()) {
      await sql.unsafe(await readFile(join(MIGRATIONS, f), 'utf8'));
    }
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
}

/** A queue session with `n` correctly hash-chained events (built with the shared primitives). */
async function seedSession(
  sql: Sql,
  n: number,
  opts: { state?: 'open' | 'closed'; ageMs?: number } = {},
): Promise<{ sessionId: string; orgId: string }> {
  const tag = randomBytes(5).toString('hex');
  const [org] = await sql<
    { id: string }[]
  >`INSERT INTO organizations (name, slug) VALUES ('O', ${`o-${tag}`}) RETURNING id`;
  const orgId = org?.id ?? '';
  const [fac] = await sql<{ id: string }[]>`
    INSERT INTO facilities (organization_id, name, slug, timezone) VALUES (${orgId}, 'F', ${`f-${tag}`}, 'UTC') RETURNING id`;
  const [svc] = await sql<{ id: string }[]>`
    INSERT INTO services (organization_id, facility_id, name) VALUES (${orgId}, ${fac?.id ?? ''}, 'S') RETURNING id`;
  const [qs] = await sql<{ id: string }[]>`
    INSERT INTO queue_sessions (facility_id, organization_id, service_id, operational_date, state, revision, last_sequence)
    VALUES (${fac?.id ?? ''}, ${orgId}, ${svc?.id ?? ''}, CURRENT_DATE - ${Math.floor(Math.random() * 100000)}::int,
            ${opts.state ?? 'open'}, ${n}, ${n}) RETURNING id`;
  const sessionId = qs?.id ?? '';
  let prev = genesisHash(sha256Hex);
  const base = Date.now() - (opts.ageMs ?? 0);
  for (let i = 1; i <= n; i++) {
    const body = {
      organization_id: orgId,
      queue_session_id: sessionId,
      sequence: i,
      event_type: i === 1 ? 'queue.open' : 'ticket.create',
      actor_id: null,
      operation_id: null,
      payload: { n: i },
      committed_at: new Date(base + i).toISOString(),
    };
    const hash = computeEventHash(sha256Hex, prev, body);
    await sql`
      INSERT INTO queue_events (organization_id, queue_session_id, sequence, event_type, actor_id, operation_id,
                                payload, prev_hash, event_hash, committed_at)
      VALUES (${orgId}, ${sessionId}, ${i}, ${body.event_type}, NULL, NULL, ${sql.json(body.payload)},
              ${prev}, ${hash}, ${body.committed_at})`;
    prev = hash;
  }
  return { sessionId, orgId };
}

async function appendValid(
  sql: Sql,
  sessionId: string,
  orgId: string,
  count: number,
): Promise<void> {
  const [last] = await sql<{ sequence: number; event_hash: string }[]>`
    SELECT sequence, event_hash FROM queue_events WHERE queue_session_id = ${sessionId} ORDER BY sequence DESC LIMIT 1`;
  let prev = last?.event_hash ?? genesisHash(sha256Hex);
  let seq = last?.sequence ?? 0;
  for (let i = 0; i < count; i++) {
    seq++;
    const body = {
      organization_id: orgId,
      queue_session_id: sessionId,
      sequence: seq,
      event_type: 'ticket.create',
      actor_id: null,
      operation_id: null,
      payload: { n: seq },
      committed_at: new Date().toISOString(),
    };
    const hash = computeEventHash(sha256Hex, prev, body);
    await sql`
      INSERT INTO queue_events (organization_id, queue_session_id, sequence, event_type, payload, prev_hash, event_hash, committed_at)
      VALUES (${orgId}, ${sessionId}, ${seq}, 'ticket.create', ${sql.json(body.payload)}, ${prev}, ${hash}, ${body.committed_at})`;
    prev = hash;
  }
  await sql`UPDATE queue_sessions SET last_sequence = ${seq}, revision = ${seq} WHERE id = ${sessionId}`;
}

const checkpoints = (
  sql: Sql,
  sessionId: string,
): Promise<
  {
    from_sequence: number;
    to_sequence: number;
    root_hash: string;
    head_hash: string;
    key_id: string;
    signature: string;
  }[]
> =>
  sql`SELECT from_sequence, to_sequence, root_hash, head_hash, key_id, signature FROM audit_checkpoints
       WHERE queue_session_id = ${sessionId} ORDER BY from_sequence`;

describe('database guard: the worker only runs against a migrated QueueBridge database', () => {
  it('refuses a database of another project (no QueueBridge tables) and writes nothing to it', async () => {
    const name = `qb_foreign_${randomBytes(6).toString('hex')}`;
    const admin = postgres(URL_, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const u = new URL(URL_);
    u.pathname = `/${name}`;
    const foreign = postgres(u.toString(), { max: 1, onnotice: () => undefined });
    try {
      await foreign`CREATE TABLE app_users (id int)`; // someone else's schema
      await expect(assertQueueBridgeDatabase(foreign)).rejects.toThrow(
        /is not a QueueBridge database/,
      );
      const tables = await foreign<{ t: string }[]>`
        SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'`;
      expect(tables.map((r) => r.t)).toEqual(['app_users']);
    } finally {
      await foreign.end({ timeout: 5 });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end({ timeout: 5 });
    }
  });

  it('refuses a QueueBridge database that has not applied the M4 migration, then accepts it', async () => {
    await isolated(async (sql) => {
      await sql`CREATE TABLE _migrations (id SERIAL PRIMARY KEY, filename TEXT NOT NULL UNIQUE)`;
      await sql`INSERT INTO _migrations (filename) VALUES ('0005_continuity_engine.sql')`;
      await expect(assertQueueBridgeDatabase(sql)).rejects.toThrow(
        new RegExp(`has not applied ${REQUIRED_MIGRATION}`),
      );
      await sql`INSERT INTO _migrations (filename) VALUES (${REQUIRED_MIGRATION})`;
      await expect(assertQueueBridgeDatabase(sql)).resolves.toMatchObject({
        latest_migration: REQUIRED_MIGRATION,
      });
    });
  });

  it('accepts the migrated test database', async () => {
    await expect(assertQueueBridgeDatabase(shared)).resolves.toMatchObject({
      database: new URL(URL_).pathname.slice(1),
    });
  });
});

describe('checkpoint signature construction', () => {
  it('matches the fixed test vector the API audit test also asserts (cross-app compatibility)', () => {
    const msg = checkpointMessage({
      queue_session_id: 'q',
      from_sequence: 1,
      to_sequence: 2,
      root_hash: 'r',
      head_hash: 'h',
    });
    expect(msg).toBe('queuebridge:v1:checkpoint|q|1|2|r|h');
    expect(signCheckpoint('k'.repeat(32), msg)).toBe(
      '6e553bfb1e12bf859edcea4457cbfd45848378c5d30e56549b0375ec2124a8f3',
    );
  });
});

describe('checkpoint job — happy path', () => {
  it('signs a verified range whose root hash PostgreSQL can recompute without application code', async () => {
    const { sessionId } = await seedSession(shared, 8);
    const r = await runCheckpointJob(shared, { ...OPTS, onlySessionId: sessionId });
    expect(r.checkpointed).toEqual([
      { queue_session_id: sessionId, from_sequence: 1, to_sequence: 8 },
    ]);
    const [cp] = await checkpoints(shared, sessionId);
    // Independent recomputation in SQL (no QueueBridge code involved)
    const [sqlRoot] = await shared<{ root: string }[]>`
      SELECT encode(sha256(convert_to(string_agg(event_hash, '' ORDER BY sequence), 'UTF8')), 'hex') AS root
        FROM queue_events WHERE queue_session_id = ${sessionId} AND sequence BETWEEN 1 AND 8`;
    expect(cp?.root_hash).toBe(sqlRoot?.root);
    // The signature covers session, range, root and head
    expect(cp?.signature).toBe(
      signCheckpoint(
        KEY,
        checkpointMessage({
          queue_session_id: sessionId,
          from_sequence: 1,
          to_sequence: 8,
          root_hash: cp?.root_hash ?? '',
          head_hash: cp?.head_hash ?? '',
        }),
      ),
    );
    expect(cp?.key_id).toBe('test-key-1');
  });

  it('is idempotent, then extends with a contiguous next range', async () => {
    const { sessionId, orgId } = await seedSession(shared, 6);
    await runCheckpointJob(shared, { ...OPTS, onlySessionId: sessionId });
    const again = await runCheckpointJob(shared, { ...OPTS, onlySessionId: sessionId });
    expect(again.checkpointed).toEqual([]);
    await appendValid(shared, sessionId, orgId, 5);
    const next = await runCheckpointJob(shared, { ...OPTS, onlySessionId: sessionId });
    expect(next.checkpointed).toEqual([
      { queue_session_id: sessionId, from_sequence: 7, to_sequence: 11 },
    ]);
    const rows = await checkpoints(shared, sessionId);
    const [events] = [
      await shared<
        { sequence: number; event_hash: string }[]
      >`SELECT sequence, event_hash FROM queue_events WHERE queue_session_id = ${sessionId} ORDER BY sequence`,
    ];
    expect(rows[1]?.root_hash).toBe(
      checkpointRoot(
        sha256Hex,
        events.slice(6).map((e) => e.event_hash),
      ),
    );
  });

  it('defers a small, recent range; checkpoints it once it is old enough or the session is closed', async () => {
    const young = await seedSession(shared, 2);
    expect(
      (await runCheckpointJob(shared, { ...OPTS, onlySessionId: young.sessionId })).deferred,
    ).toBe(1);
    expect(await checkpoints(shared, young.sessionId)).toHaveLength(0);
    const old = await seedSession(shared, 2, { ageMs: 2 * 3_600_000 });
    expect(
      (await runCheckpointJob(shared, { ...OPTS, onlySessionId: old.sessionId })).checkpointed,
    ).toHaveLength(1);
    const closed = await seedSession(shared, 2, { state: 'closed' });
    expect(
      (await runCheckpointJob(shared, { ...OPTS, onlySessionId: closed.sessionId })).checkpointed,
    ).toHaveLength(1);
  });

  it('two workers running at once write exactly one checkpoint for a range', async () => {
    const { sessionId } = await seedSession(shared, 7);
    const [a, b, c] = await Promise.all([
      runCheckpointJob(shared, { ...OPTS, onlySessionId: sessionId }),
      runCheckpointJob(shared, { ...OPTS, onlySessionId: sessionId }),
      runCheckpointJob(shared, { ...OPTS, onlySessionId: sessionId }),
    ]);
    expect([a, b, c].flatMap((r) => r.checkpointed)).toHaveLength(1);
    expect(await checkpoints(shared, sessionId)).toHaveLength(1);
  });

  it('checkpoints and alerts are append-only (UPDATE, DELETE and TRUNCATE are refused)', async () => {
    const { sessionId } = await seedSession(shared, 5);
    await runCheckpointJob(shared, { ...OPTS, onlySessionId: sessionId });
    await expect(
      shared`UPDATE audit_checkpoints SET root_hash = ${'0'.repeat(64)} WHERE queue_session_id = ${sessionId}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      shared`DELETE FROM audit_checkpoints WHERE queue_session_id = ${sessionId}`,
    ).rejects.toThrow(/append-only/);
    // A row must exist: row-level triggers do not fire for statements that match nothing
    const [owner] = await shared<{ organization_id: string }[]>`
      SELECT organization_id FROM queue_sessions WHERE id = ${sessionId}`;
    await shared`
      INSERT INTO audit_integrity_alerts (organization_id, queue_session_id, kind, at_sequence, reason)
      VALUES (${owner?.organization_id ?? ''}, ${sessionId}, 'chain', 1, 'append-only probe')`;
    await expect(
      shared`UPDATE audit_integrity_alerts SET reason = 'cleared' WHERE queue_session_id = ${sessionId}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      shared`DELETE FROM audit_integrity_alerts WHERE queue_session_id = ${sessionId}`,
    ).rejects.toThrow(/append-only/);
    await isolated(async (sql) => {
      await expect(sql`TRUNCATE audit_checkpoints`).rejects.toThrow(/append-only/);
      await expect(sql`TRUNCATE audit_integrity_alerts`).rejects.toThrow(/append-only/);
      await expect(sql`TRUNCATE queue_events CASCADE`).rejects.toThrow(/append-only/);
      await expect(sql`TRUNCATE service_policy_versions CASCADE`).rejects.toThrow(/append-only/);
      await expect(sql`TRUNCATE priority_overrides`).rejects.toThrow(/append-only/);
    });
  });
});

describe('checkpoint job — tampering is never signed (isolated database)', () => {
  it('one session failing (database error) never starves the sessions after it', async () => {
    await isolated(async (sql) => {
      const first = await seedSession(sql, 6);
      const second = await seedSession(sql, 6);
      // `first` is processed first (oldest updated_at), and every write for it fails
      await sql`UPDATE queue_sessions SET updated_at = NOW() - INTERVAL '1 hour' WHERE id = ${first.sessionId}`;
      await sql.unsafe(`
        CREATE FUNCTION qb_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated storage failure'; END $$;
        CREATE TRIGGER qb_test_fail BEFORE INSERT ON audit_checkpoints FOR EACH ROW
          WHEN (NEW.queue_session_id = '${first.sessionId}') EXECUTE FUNCTION qb_test_fail();`);
      const r = await runCheckpointJob(sql, OPTS);
      expect(r.errors).toEqual([
        { queue_session_id: first.sessionId, error: 'simulated storage failure' },
      ]);
      expect(r.checkpointed.map((x) => x.queue_session_id)).toEqual([second.sessionId]);
      const rows = await sql<{ queue_session_id: string }[]>`
        SELECT queue_session_id FROM audit_checkpoints`;
      expect(rows.map((x) => x.queue_session_id)).toEqual([second.sessionId]); // nothing signed for `first`
      // once the failure is gone, the next run catches up
      await sql.unsafe('DROP TRIGGER qb_test_fail ON audit_checkpoints');
      const again = await runCheckpointJob(sql, OPTS);
      expect(again.errors).toEqual([]);
      expect(again.checkpointed.map((x) => x.queue_session_id)).toEqual([first.sessionId]);
    });
  });

  it('a modified event: no checkpoint, an append-only alert at the right sequence, and the session stays blocked', async () => {
    await isolated(async (sql) => {
      const { sessionId } = await seedSession(sql, 10);
      await sql`ALTER TABLE queue_events DISABLE TRIGGER queue_events_append_only`;
      await sql`UPDATE queue_events SET payload = '{"n": 999}' WHERE queue_session_id = ${sessionId} AND sequence = 6`;
      await sql`ALTER TABLE queue_events ENABLE TRIGGER queue_events_append_only`;
      const r = await runCheckpointJob(sql, { ...OPTS, onlySessionId: sessionId });
      expect(r.checkpointed).toEqual([]);
      expect(r.alerts).toEqual([
        {
          queue_session_id: sessionId,
          kind: 'chain',
          at_sequence: 6,
          reason: 'event_hash mismatch',
        },
      ]);
      expect(await checkpoints(sql, sessionId)).toHaveLength(0);
      // The alert persists and the session is not checkpointed on later runs
      const later = await runCheckpointJob(sql, { ...OPTS, onlySessionId: sessionId });
      expect(later.examined).toBe(0);
      expect(
        await sql`SELECT 1 FROM audit_integrity_alerts WHERE queue_session_id = ${sessionId}`,
      ).toHaveLength(1);
    });
  });

  it('a deleted event and a rewritten checkpoint are both detected', async () => {
    await isolated(async (sql) => {
      const del = await seedSession(sql, 8);
      await sql`ALTER TABLE queue_events DISABLE TRIGGER queue_events_append_only`;
      await sql`DELETE FROM queue_events WHERE queue_session_id = ${del.sessionId} AND sequence = 4`;
      await sql`ALTER TABLE queue_events ENABLE TRIGGER queue_events_append_only`;
      const r1 = await runCheckpointJob(sql, { ...OPTS, onlySessionId: del.sessionId });
      expect(r1.alerts[0]).toMatchObject({ kind: 'chain', at_sequence: 4 });

      const cp = await seedSession(sql, 6);
      await runCheckpointJob(sql, { ...OPTS, onlySessionId: cp.sessionId });
      await appendValid(sql, cp.sessionId, cp.orgId, 6);
      await sql`ALTER TABLE audit_checkpoints DISABLE TRIGGER audit_checkpoints_append_only`;
      await sql`UPDATE audit_checkpoints SET signature = ${'a'.repeat(64)} WHERE queue_session_id = ${cp.sessionId}`;
      await sql`ALTER TABLE audit_checkpoints ENABLE TRIGGER audit_checkpoints_append_only`;
      const r2 = await runCheckpointJob(sql, { ...OPTS, onlySessionId: cp.sessionId });
      expect(r2.checkpointed).toEqual([]);
      expect(r2.alerts[0]).toMatchObject({
        kind: 'checkpoint',
        at_sequence: 1,
        reason: 'checkpoint 1-6: signature mismatch',
      });
    });
  });

  it('a consistent forgery (event AND later hashes rewritten) is still caught by the signed checkpoint', async () => {
    await isolated(async (sql) => {
      const { sessionId } = await seedSession(sql, 6);
      await runCheckpointJob(sql, { ...OPTS, onlySessionId: sessionId });
      // Attacker rewrites event 3 and re-chains every later event so the hash chain verifies again
      const rows = await sql<
        {
          sequence: number;
          organization_id: string;
          event_type: string;
          payload: Record<string, unknown>;
          committed_at: Date;
        }[]
      >`
        SELECT sequence, organization_id, event_type, payload, committed_at FROM queue_events WHERE queue_session_id = ${sessionId} ORDER BY sequence`;
      await sql`ALTER TABLE queue_events DISABLE TRIGGER queue_events_append_only`;
      let prev = genesisHash(sha256Hex);
      for (const r of rows) {
        const payload = r.sequence === 3 ? { n: 'forged' } : r.payload;
        const body = {
          organization_id: r.organization_id,
          queue_session_id: sessionId,
          sequence: r.sequence,
          event_type: r.event_type,
          actor_id: null,
          operation_id: null,
          payload,
          committed_at: r.committed_at.toISOString(),
        };
        const hash = computeEventHash(sha256Hex, prev, body);
        await sql`UPDATE queue_events SET payload = ${sql.json(payload as never)}, prev_hash = ${prev}, event_hash = ${hash}
                   WHERE queue_session_id = ${sessionId} AND sequence = ${r.sequence}`;
        prev = hash;
      }
      await sql`ALTER TABLE queue_events ENABLE TRIGGER queue_events_append_only`;
      const events = (
        await sql<
          {
            organization_id: string;
            queue_session_id: string;
            sequence: number;
            event_type: string;
            actor_id: string | null;
            operation_id: string | null;
            payload: Record<string, unknown>;
            prev_hash: string;
            event_hash: string;
            committed_at: Date;
          }[]
        >`
        SELECT organization_id, queue_session_id, sequence, event_type, actor_id, operation_id, payload, prev_hash, event_hash, committed_at
          FROM queue_events WHERE queue_session_id = ${sessionId} ORDER BY sequence`
      ).map((e) => ({ ...e, committed_at: e.committed_at.toISOString() }));
      const cps = await checkpoints(sql, sessionId);
      const result = verifyCheckpoints(sha256Hex, events, cps, sessionId, (m, c) =>
        c.key_id === OPTS.keyId ? signCheckpoint(KEY, m) === c.signature : null,
      );
      expect(result.results[0]).toMatchObject({ status: 'invalid', reason: 'root_hash mismatch' });
    });
  });
});
