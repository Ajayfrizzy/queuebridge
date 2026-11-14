/**
 * QueueBridge database identity guard (fail-closed).
 *
 * Every schema-changing script (migrate, reset) and the seed script inspect the target database
 * BEFORE changing anything and proceed only when it is positively identified:
 *
 *   empty        no user objects at all → may be initialized as QueueBridge
 *   queuebridge  identity marker + consistent migration history → may be migrated
 *   legacy       no marker yet (databases created before the marker existed), but a migration
 *                history that is a consistent prefix of THIS checkout's migrations and whose
 *                sentinel tables exist → identified; the marker is recorded on first migrate
 *   foreign      user objects, but no QueueBridge marker and no QueueBridge history → REJECT
 *   inconsistent marker or history present but contradictory → REJECT (never auto-repaired)
 *
 * Identity never depends on the port, host or database name. Nothing here repairs a schema.
 */

import { readdir } from 'node:fs/promises';

export const PROJECT_ID = 'queuebridge';
export const MARKER_TABLE = '_queuebridge_identity';
export const HISTORY_TABLE = '_migrations';
/** Serializes migrate / reset / test setup against the same database. */
export const LOCK_KEY = 'queuebridge:migrations';

/**
 * Objects each migration creates (`table` or `table.column`) that must exist once it is recorded
 * as applied. A history claiming a migration whose sentinels are missing is inconsistent (e.g. a
 * `_migrations` table copied from elsewhere, or a migration that was rolled back by hand).
 */
export const SENTINELS = {
  '0001_initial_schema.sql': [
    'organizations',
    'facilities',
    'services',
    'queue_sessions',
    'queue_events',
    'tickets',
  ],
  '0002_append_only_trigger.sql': [],
  '0003_tenancy_roles_invitations.sql': ['staff_invitations', 'admin_events'],
  '0004_queue_core.sql': ['tickets.joined_at', 'services.ticket_prefix'],
  '0005_continuity_engine.sql': ['devices.last_seen_at'],
  '0006_fairness_routing_audit.sql': [
    'service_policy_versions',
    'audit_integrity_alerts',
    'tickets.wait_since',
    'counters.availability',
  ],
  '0007_ticket_recovery.sql': [
    'ticket_recovery_proofs',
    'ticket_recovery_grants',
    'recovery_throttle',
    'auto_miss_sweeps',
    'ticket_recovery_credentials.revoked_at',
  ],
  '0008_device_health.sql': ['health_alerts', 'health_evaluations', 'devices.failure_streak'],
};

/** Migration files of this checkout, in apply order. */
export async function listMigrationFiles(dir) {
  return (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
}

const SYSTEM_SCHEMAS = `('pg_catalog', 'information_schema', 'pg_toast')`;

async function relationExists(sql, name) {
  const [r] = await sql`SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS ok`;
  return Boolean(r?.ok);
}

/** `table` or `table.column` in the public schema. */
async function sentinelExists(sql, sentinel) {
  const [table, column] = sentinel.split('.');
  if (!column) return relationExists(sql, table);
  const [r] = await sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = ${table}
                      AND column_name = ${column}) AS ok`;
  return Boolean(r?.ok);
}

/**
 * Inspect a database without changing it.
 * @param {import('postgres').Sql} sql
 * @param {string[]} files migration files of this checkout, sorted
 * @returns {Promise<{kind: 'empty'|'queuebridge'|'legacy'|'foreign'|'inconsistent', database: string,
 *   applied: string[], pending: string[], reasons: string[]}>}
 */
export async function inspectDatabase(sql, files) {
  const [{ database }] = await sql`SELECT current_database() AS database`;
  const [{ objects }] = await sql.unsafe(`
    SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname NOT IN ${SYSTEM_SCHEMAS} AND n.nspname NOT LIKE 'pg_temp%'
               AND n.nspname NOT LIKE 'pg_toast_temp%')
         + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname NOT IN ${SYSTEM_SCHEMAS})
         + (SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql') AS objects`);
  const result = (kind, reasons, applied = []) => ({
    kind,
    database,
    applied,
    pending: files.filter((f) => !applied.includes(f)),
    reasons,
  });

  if (Number(objects) === 0) return result('empty', []);

  const hasMarker = await relationExists(sql, MARKER_TABLE);
  const hasHistory = await relationExists(sql, HISTORY_TABLE);

  let markerProject = null;
  if (hasMarker) {
    const rows = await sql.unsafe(`SELECT project FROM ${MARKER_TABLE}`);
    if (rows.length !== 1) {
      return result('inconsistent', [
        `${MARKER_TABLE} must hold exactly one row (has ${rows.length})`,
      ]);
    }
    markerProject = rows[0].project;
    if (markerProject !== PROJECT_ID) {
      return result('foreign', [`identity marker names project "${markerProject}"`]);
    }
  }

  if (!hasHistory) {
    return hasMarker
      ? result('inconsistent', [`identity marker present but ${HISTORY_TABLE} is missing`])
      : result('foreign', [
          'database has objects but no QueueBridge identity marker or migration history',
        ]);
  }

  const cols = await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${HISTORY_TABLE}`;
  if (!cols.some((c) => c.column_name === 'filename')) {
    return hasMarker
      ? result('inconsistent', [`${HISTORY_TABLE} has no "filename" column`])
      : result('foreign', [`${HISTORY_TABLE} exists but is not a QueueBridge migration history`]);
  }

  const applied = (await sql.unsafe(`SELECT filename FROM ${HISTORY_TABLE} ORDER BY filename`)).map(
    (r) => r.filename,
  );
  const known = applied.filter((f) => files.includes(f));
  const unknown = applied.filter((f) => !files.includes(f));
  if (!hasMarker && known.length === 0) {
    return result('foreign', [
      applied.length === 0
        ? `${HISTORY_TABLE} is empty but the database has other objects`
        : `${HISTORY_TABLE} lists no QueueBridge migration`,
    ]);
  }

  const reasons = [];
  if (unknown.length > 0) {
    reasons.push(`history lists migrations not in this checkout: ${unknown.join(', ')}`);
  }
  // Applied migrations must be exactly the first N files: no gaps, no out-of-order application
  const expectedPrefix = files.slice(0, known.length);
  if (known.join('|') !== expectedPrefix.join('|')) {
    const missing = expectedPrefix.filter((f) => !known.includes(f));
    reasons.push(`history has gaps (not applied, but later ones are: ${missing.join(', ')})`);
  }
  for (const f of known) {
    for (const t of SENTINELS[f] ?? []) {
      if (!(await sentinelExists(sql, t)))
        reasons.push(`${f} is recorded as applied but "${t}" is missing`);
    }
  }
  if (hasMarker && known.length === 0) {
    // An initialization that stopped before the first migration: only the bookkeeping may exist
    const [{ n }] = await sql.unsafe(`
      SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'f', 'p')
         AND c.relname NOT IN ('${MARKER_TABLE}', '${HISTORY_TABLE}')`);
    if (Number(n) > 0) reasons.push('no migration recorded, but the database already has tables');
  }
  if (reasons.length > 0) return result('inconsistent', reasons, known);
  return result(hasMarker ? 'queuebridge' : 'legacy', [], known);
}

/** Human-readable refusal; never includes connection details or credentials. */
export function refusal(inspection) {
  const lines = [
    `Refusing to modify database "${inspection.database}": ${
      inspection.kind === 'foreign'
        ? 'it is not identified as a QueueBridge database'
        : 'its QueueBridge identity or migration history is inconsistent'
    }.`,
    ...inspection.reasons.map((r) => `  - ${r}`),
    'Check DATABASE_URL. Nothing was changed. The database is never repaired automatically.',
  ];
  return lines.join('\n');
}

/** Record the identity marker (empty or legacy databases only; called under the lock). */
export async function recordIdentity(sql, how) {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (
      project        TEXT PRIMARY KEY CHECK (project = '${PROJECT_ID}'),
      recorded_how   TEXT NOT NULL CHECK (recorded_how IN ('initialized', 'adopted')),
      recorded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await sql.unsafe(
    `INSERT INTO ${MARKER_TABLE} (project, recorded_how) VALUES ('${PROJECT_ID}', $1)
     ON CONFLICT (project) DO NOTHING`,
    [how],
  );
}

/**
 * Apply pending migrations with the guard. Each migration and its history row commit together.
 * @param {import('postgres').Sql} sql a connection with max: 1 (the advisory lock is per session)
 * @param {{ dir: string, log?: (line: string) => void }} opts
 * @returns {Promise<{ kind: string, applied: string[] }>}
 */
export async function migrateDatabase(sql, { dir, log = () => undefined }) {
  const files = await listMigrationFiles(dir);
  await sql`SELECT pg_advisory_lock(hashtext(${LOCK_KEY}))`;
  try {
    const inspection = await inspectDatabase(sql, files);
    if (inspection.kind === 'foreign' || inspection.kind === 'inconsistent') {
      const err = new Error(refusal(inspection));
      err.code = 'QB_DB_IDENTITY';
      err.inspection = inspection;
      throw err;
    }
    log(
      `Database "${inspection.database}": ${
        {
          empty: 'empty — initializing as QueueBridge',
          legacy: 'QueueBridge (history verified; recording identity marker)',
          queuebridge: 'QueueBridge (identity and history verified)',
        }[inspection.kind]
      }`,
    );
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await sql.begin(async (tx) => {
      if (inspection.kind !== 'queuebridge') {
        await recordIdentity(tx, inspection.kind === 'empty' ? 'initialized' : 'adopted');
      }
      await tx.unsafe(`
        CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
          id          SERIAL PRIMARY KEY,
          filename    TEXT NOT NULL UNIQUE,
          applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    });
    for (const file of files) {
      if (inspection.applied.includes(file)) {
        log(`  SKIP  ${file} (already applied)`);
      }
    }
    const applied = [];
    for (const file of inspection.pending) {
      log(`  APPLY ${file}`);
      const content = await readFile(join(dir, file), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(content);
        await tx.unsafe(`INSERT INTO ${HISTORY_TABLE} (filename) VALUES ($1)`, [file]);
      });
      applied.push(file);
    }
    return { kind: inspection.kind, applied };
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext(${LOCK_KEY}))`.catch(() => undefined);
  }
}

/** Seed/reset precondition: an identified QueueBridge database (optionally fully migrated). */
export async function assertQueueBridge(
  sql,
  dir,
  { requireFullyMigrated = false, allowEmpty = false } = {},
) {
  const files = await listMigrationFiles(dir);
  const inspection = await inspectDatabase(sql, files);
  if (inspection.kind === 'empty' && allowEmpty) return inspection;
  if (inspection.kind !== 'queuebridge' && inspection.kind !== 'legacy') {
    const err = new Error(
      inspection.kind === 'empty'
        ? `Database "${inspection.database}" is empty: run pnpm db:migrate first.`
        : refusal(inspection),
    );
    err.code = 'QB_DB_IDENTITY';
    err.inspection = inspection;
    throw err;
  }
  if (requireFullyMigrated && inspection.pending.length > 0) {
    const err = new Error(
      `Database "${inspection.database}" has pending migrations (${inspection.pending.join(', ')}): run pnpm db:migrate first.`,
    );
    err.code = 'QB_DB_IDENTITY';
    throw err;
  }
  return inspection;
}
