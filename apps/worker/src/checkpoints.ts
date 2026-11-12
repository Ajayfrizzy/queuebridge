import { createHash, createHmac } from 'node:crypto';
import {
  checkpointMessage,
  checkpointRoot,
  verifyChain,
  verifyCheckpoints,
  type CheckpointRecord,
  type Sha256Hex,
  type StoredEvent,
} from '@queuebridge/domain';
import {
  AUDIT_KEY_FINGERPRINT_LENGTH,
  AUDIT_KEY_FINGERPRINT_MESSAGE,
} from '@queuebridge/contracts';
import type { Sql, TransactionSql } from 'postgres';

/**
 * Audit checkpoint job (REQ-F8.3, ADR-010).
 *
 * For each queue session with events beyond its last checkpoint, the worker:
 *  1. takes a per-session advisory lock (several workers never checkpoint the same range);
 *  2. VERIFIES the complete hash chain and every existing checkpoint first — a broken chain is
 *     never signed: an append-only `audit_integrity_alerts` row is written instead and the session
 *     is skipped until a human investigates;
 *  3. signs `root_hash = SHA256(event_hash[from]‖…‖event_hash[to])` together with the session id,
 *     range and head hash (HMAC-SHA256, key id recorded, key never stored).
 * The root hash is recomputable without application code (see packages/domain/src/audit.ts).
 */

export const sha256Hex: Sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** HMAC-SHA256 over the checkpoint message (the API verifies with the same construction). */
export const signCheckpoint = (key: string, message: string): string =>
  createHmac('sha256', key).update(message, 'utf8').digest('hex');

/** Non-reversible key identifier (same construction as the API) for comparing startup logs. */
export const auditKeyFingerprint = (key: string): string =>
  signCheckpoint(key, AUDIT_KEY_FINGERPRINT_MESSAGE).slice(0, AUDIT_KEY_FINGERPRINT_LENGTH);

/** The migration that created the tables this job reads and writes. */
export const REQUIRED_MIGRATION = '0006_fairness_routing_audit.sql';

/**
 * Refuse to run against anything that is not a migrated QueueBridge database (e.g. another
 * project's database reached through a mistyped DATABASE_URL). Read-only: it writes nothing.
 */
export async function assertQueueBridgeDatabase(
  sql: Sql,
): Promise<{ database: string; latest_migration: string }> {
  const [meta] = await sql<
    { database: string; has_migrations: boolean; has_checkpoints: boolean }[]
  >`
    SELECT current_database() AS database,
           to_regclass('public._migrations') IS NOT NULL AS has_migrations,
           to_regclass('public.audit_checkpoints') IS NOT NULL
             AND to_regclass('public.queue_events') IS NOT NULL
             AND to_regclass('public.audit_integrity_alerts') IS NOT NULL AS has_checkpoints`;
  if (!meta?.has_migrations || !meta.has_checkpoints) {
    throw new Error(
      `Database "${meta?.database ?? '?'}" is not a QueueBridge database with the M4 audit tables. ` +
        'Check DATABASE_URL; the worker writes nothing elsewhere.',
    );
  }
  const [m] = await sql<{ applied: boolean; latest: string | null }[]>`
    SELECT bool_or(filename = ${REQUIRED_MIGRATION}) AS applied, MAX(filename) AS latest
      FROM _migrations`;
  if (!m?.applied) {
    throw new Error(
      `Database "${meta.database}" has not applied ${REQUIRED_MIGRATION}. Run pnpm db:migrate first.`,
    );
  }
  return { database: meta.database, latest_migration: m.latest ?? '' };
}

export interface CheckpointJobOptions {
  keyId: string;
  key: string;
  minEvents: number;
  maxAgeMs: number;
  /** Sessions examined per run */
  batchSize?: number;
  /** Restrict to one session (tests, manual runs) */
  onlySessionId?: string;
}

export interface CheckpointJobReport {
  examined: number;
  /** Sessions whose run failed (rolled back, nothing signed); the job carried on with the rest */
  errors: { queue_session_id: string; error: string }[];
  checkpointed: { queue_session_id: string; from_sequence: number; to_sequence: number }[];
  alerts: {
    queue_session_id: string;
    kind: 'chain' | 'checkpoint';
    at_sequence: number | null;
    reason: string;
  }[];
  deferred: number;
}

interface Candidate {
  id: string;
  organization_id: string;
  state: string;
  last_sequence: number;
  covered: number;
}

export async function runCheckpointJob(
  sql: Sql,
  opts: CheckpointJobOptions,
): Promise<CheckpointJobReport> {
  const report: CheckpointJobReport = {
    examined: 0,
    checkpointed: [],
    alerts: [],
    deferred: 0,
    errors: [],
  };
  const candidates = await sql<Candidate[]>`
    SELECT qs.id, qs.organization_id, qs.state, qs.last_sequence,
           COALESCE((SELECT MAX(c.to_sequence) FROM audit_checkpoints c WHERE c.queue_session_id = qs.id), 0)::int AS covered
      FROM queue_sessions qs
     WHERE qs.last_sequence > 0
       ${opts.onlySessionId ? sql`AND qs.id = ${opts.onlySessionId}` : sql``}
       AND qs.last_sequence > COALESCE((SELECT MAX(c.to_sequence) FROM audit_checkpoints c WHERE c.queue_session_id = qs.id), 0)
       AND NOT EXISTS (SELECT 1 FROM audit_integrity_alerts a WHERE a.queue_session_id = qs.id)
     ORDER BY qs.updated_at
     LIMIT ${opts.batchSize ?? 50}`;

  for (const c of candidates) {
    report.examined++;
    // One session's failure (rolled back on its own) must never starve the sessions after it:
    // record it and continue. Nothing is signed for a failed session.
    try {
      await sql.begin(async (tx) => {
        const lock = await tx<
          { ok: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(hashtextextended(${c.id}::text, 7)) AS ok`;
        if (!lock[0]?.ok) {
          report.deferred++;
          return;
        }
        await checkpointSession(tx, c, opts, report);
      });
    } catch (err) {
      report.errors.push({
        queue_session_id: c.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}

async function checkpointSession(
  tx: TransactionSql,
  c: Candidate,
  opts: CheckpointJobOptions,
  report: CheckpointJobReport,
): Promise<void> {
  const rows = await tx<(Omit<StoredEvent, 'committed_at'> & { committed_at: Date })[]>`
    SELECT organization_id, queue_session_id, sequence, event_type, actor_id, operation_id,
           payload, prev_hash, event_hash, committed_at
      FROM queue_events WHERE queue_session_id = ${c.id} ORDER BY sequence`;
  const events: StoredEvent[] = rows.map((r) => ({
    ...r,
    committed_at: r.committed_at.toISOString(),
  }));
  const existing = await tx<CheckpointRecord[]>`
    SELECT from_sequence, to_sequence, root_hash, head_hash, key_id, signature
      FROM audit_checkpoints WHERE queue_session_id = ${c.id} ORDER BY from_sequence`;
  const covered = existing.reduce((m, x) => Math.max(m, x.to_sequence), 0);
  const last = events.length;
  if (last <= covered) return;

  const alert = async (
    kind: 'chain' | 'checkpoint',
    at: number | null,
    reason: string,
  ): Promise<void> => {
    await tx`
      INSERT INTO audit_integrity_alerts (organization_id, queue_session_id, kind, at_sequence, reason)
      VALUES (${c.organization_id}, ${c.id}, ${kind}, ${at}, ${reason})
      ON CONFLICT DO NOTHING`;
    report.alerts.push({ queue_session_id: c.id, kind, at_sequence: at, reason });
  };

  // 1. Never sign a log that does not verify from genesis
  const chain = verifyChain(sha256Hex, events);
  if (!chain.valid) {
    await alert('chain', chain.broken_at_sequence, chain.reason);
    return;
  }
  if (last !== c.last_sequence && last < c.last_sequence) {
    await alert('chain', last + 1, 'events missing below the recorded session sequence');
    return;
  }
  // 2. ...nor extend checkpoints that no longer match it
  const prior = verifyCheckpoints(sha256Hex, events, existing, c.id, (message, cp) =>
    cp.key_id === opts.keyId ? signCheckpoint(opts.key, message) === cp.signature : null,
  );
  const bad = prior.results.find((r) => r.status === 'invalid');
  if (bad && bad.status === 'invalid') {
    await alert(
      'checkpoint',
      bad.from_sequence,
      `checkpoint ${bad.from_sequence}-${bad.to_sequence}: ${bad.reason}`,
    );
    return;
  }

  // 3. Is it time? Enough events, old enough, or the session is closed
  const pending = events.slice(covered);
  const oldest = pending[0] ? Date.parse(pending[0].committed_at) : Date.now();
  const due =
    pending.length >= opts.minEvents ||
    Date.now() - oldest >= opts.maxAgeMs ||
    c.state === 'closed';
  if (!due) {
    report.deferred++;
    return;
  }

  const from = covered + 1;
  const to = last;
  const hashes = pending.map((e) => e.event_hash);
  const root = checkpointRoot(sha256Hex, hashes);
  const head = hashes[hashes.length - 1] as string;
  const signature = signCheckpoint(
    opts.key,
    checkpointMessage({
      queue_session_id: c.id,
      from_sequence: from,
      to_sequence: to,
      root_hash: root,
      head_hash: head,
    }),
  );
  await tx`
    INSERT INTO audit_checkpoints
      (queue_session_id, organization_id, from_sequence, to_sequence, root_hash, head_hash, key_id, signature, algorithm)
    VALUES (${c.id}, ${c.organization_id}, ${from}, ${to}, ${root}, ${head}, ${opts.keyId}, ${signature}, 'hmac-sha256')`;
  report.checkpointed.push({ queue_session_id: c.id, from_sequence: from, to_sequence: to });
}
