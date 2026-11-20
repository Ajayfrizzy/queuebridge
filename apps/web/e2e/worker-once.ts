import postgres from 'postgres';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { e2eWorkerEnv } from './push-env.js';

/**
 * Runs the REAL worker once (`node worker.js --once`), as production cron-style runs do. Shared
 * by the specs that need it (device health, turn alerts).
 *
 * Diagnosable by design (checkpoint reliability gate, 2026-11-16): the worker's own deadline
 * (`WORKER_ONCE_TIMEOUT_MS`) is set BELOW this caller's kill time, so a run that does not finish
 * ends through the worker's bounded exit, which logs why, instead of being killed silently. On
 * any failure the error carries the duration and the worker's own log messages (message and
 * error fields only; the worker never logs secrets, and long tokens are masked anyway).
 * `QB_WORKER_TIMING_LOG=<file>` appends one line per run (label, duration, outcome) for
 * investigating slow runs; nothing is written without it.
 */
const WORKER = fileURLToPath(new URL('../../worker/dist/worker.js', import.meta.url));
const DB_URL = process.env['TEST_DATABASE_URL'] ?? '';
/** The worker's own bound; a normal run takes well under a second (measured: 0.4–0.8 s). */
const WORKER_DEADLINE_MS = 50_000;
/** Only reached if the worker's own bound fails (it should never be). */
const CALLER_KILL_MS = 60_000;

function messages(out: string): string {
  return out
    .split('\n')
    .flatMap((line) => {
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        const msg = typeof j['msg'] === 'string' ? j['msg'] : '';
        const err = typeof j['error'] === 'string' ? ` (${j['error']})` : '';
        return msg ? [`${msg}${err}`] : [];
      } catch {
        return [];
      }
    })
    .join(' | ')
    .replace(/postgres(ql)?:\/\/\S+/g, '<database url>')
    .replace(/[A-Za-z0-9_-]{24,}/g, '<masked>');
}

function record(label: string, ms: number, outcome: string): void {
  const file = process.env['QB_WORKER_TIMING_LOG'];
  if (file) appendFileSync(file, `${new Date().toISOString()} ${label} ${ms}ms ${outcome}\n`);
}

/**
 * The worker's alert batch: due rows of one channel are taken oldest first (`next_attempt_at`,
 * then id), at most this many per run (`batchSize` default in apps/worker turn-alerts.ts and
 * sms-alerts.ts).
 */
export const WORKER_ALERT_BATCH = 50;

/**
 * Runs the real worker as many times as are needed to reach the given outbox rows, no more.
 *
 * Why one run is not enough (stabilization, 2026-11-20): the shared test database can hold older
 * pending alert rows, because the API DB suites commit calls without running a worker. With more
 * than `WORKER_ALERT_BATCH` rows ahead, a single run took only older rows and left the test's own
 * row pending; reproduced deterministically for SMS (60 rows ahead) and for push (85 rows ahead,
 * `turn-alerts.spec.ts`). The rows ahead of the LAST target are counted once, before running, in
 * the claim's own order; rows created or re-leased later sort after it and concurrent workers
 * only shorten the line, so ceil((ahead + 1) / batch) runs always reach every target. If they do
 * not, the caller's outcome assertion fails: nothing is retried.
 */
export async function runWorkerUntilReached(
  label: string,
  channel: 'sms' | 'web_push',
  notificationIds: string[],
): Promise<void> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => undefined });
  let ahead = 0;
  try {
    const [row] = await sql<{ ahead: number }[]>`
      WITH last AS (
        SELECT o.next_attempt_at, o.id FROM notification_outbox o
         WHERE o.notification_id IN ${sql(notificationIds)} AND o.processed_at IS NULL
         ORDER BY o.next_attempt_at DESC, o.id DESC LIMIT 1)
      SELECT count(*)::int AS ahead
        FROM notification_outbox o JOIN notifications n ON n.id = o.notification_id, last
       WHERE n.channel = ${channel} AND o.processed_at IS NULL
         AND (o.next_attempt_at, o.id) < (last.next_attempt_at, last.id)`;
    ahead = row?.ahead ?? 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
  const runs = Math.ceil((ahead + 1) / WORKER_ALERT_BATCH);
  for (let i = 0; i < runs; i += 1) runWorkerOnce(label);
}

export function runWorkerOnce(label: string): void {
  const t0 = Date.now();
  try {
    execFileSync('node', [WORKER, '--once'], {
      env: {
        ...e2eWorkerEnv(DB_URL),
        LOG_LEVEL: 'info',
        WORKER_ONCE_TIMEOUT_MS: String(WORKER_DEADLINE_MS),
      },
      stdio: 'pipe',
      timeout: CALLER_KILL_MS,
    });
    record(label, Date.now() - t0, 'ok');
  } catch (e) {
    const ms = Date.now() - t0;
    const x = e as { stdout?: Buffer; stderr?: Buffer; code?: string; status?: number | null };
    const how = x.code ? `killed: ${x.code}` : `exit ${String(x.status)}`;
    const log = messages(`${String(x.stdout ?? '')}\n${String(x.stderr ?? '')}`);
    record(label, ms, `FAILED ${how}: ${log}`);
    throw new Error(`worker --once failed after ${ms} ms (${how}). Worker log: ${log || '(none)'}`);
  }
}
