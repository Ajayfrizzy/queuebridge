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
