import postgres from 'postgres';
import { assertQueueBridgeDatabase, auditKeyFingerprint, runCheckpointJob } from './checkpoints.js';
import { parseEnv } from './env.js';
import {
  DEFAULT_PUSH_HOSTS,
  SandboxPushTransport,
  WebPushTransport,
  createSubscriptionCipher,
  validatePushEndpoint,
  type PushTransport,
} from '@queuebridge/channels';
import { evaluateDeviceHealth, runHealthRetention } from './health.js';
import { processTurnAlerts, purgeAlertData } from './turn-alerts.js';
import { runRecoveryRetention } from './retention.js';

/**
 * QueueBridge worker.
 *
 * Jobs:
 * - audit checkpoints (M4): verify each session's hash chain and sign checkpoint ranges
 * - recovery-data retention (M5.1): expired/revoked credentials, ended tickets' keys, grants,
 *   throttle windows (counts are logged, never values)
 * - device-health evaluation (M5.3): observes devices and coordinators, raises and resolves
 *   in-product alerts; never changes authority, queues, tickets, events or devices
 * - notification outbox (M6): not implemented yet — SMS/USSD delivery is milestone M6
 *
 * Logs are structured JSON; they never contain event payloads, tokens or keys.
 */

/** `--once`: run every job a single time and exit (manual acceptance, cron-style runs). */
const ONCE = process.argv.includes('--once');

const env = parseEnv();
/**
 * Server-side guard: a transaction left open by a stalled client (lost network traffic, a hung
 * process) is ended by PostgreSQL after 60 s, so it cannot hold row or advisory locks
 * indefinitely (worker transactions take milliseconds).
 */
const sql = postgres(env.DATABASE_URL, {
  max: 2,
  onnotice: () => undefined,
  connection: { idle_in_transaction_session_timeout: 60_000 },
});
let running = true;

const log = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra: Record<string, unknown> = {},
): void => {
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...extra });
  if (level === 'error') console.error(line);
  else console.log(line);
};

const checkpointsEnabled = Boolean(env.AUDIT_SIGNING_KEY && env.AUDIT_SIGNING_KEY_ID);
if (checkpointsEnabled) {
  // The key itself is never logged; compare this fingerprint with the API's startup log
  log('info', 'Audit checkpoints enabled', {
    audit_key_id: env.AUDIT_SIGNING_KEY_ID,
    audit_key_fingerprint: auditKeyFingerprint(env.AUDIT_SIGNING_KEY as string),
  });
} else {
  log(
    'warn',
    'Audit checkpoints disabled: AUDIT_SIGNING_KEY and AUDIT_SIGNING_KEY_ID are required (no unsigned checkpoints are written)',
  );
}

// ---- M5.4 push transport (fails safe: a bad configuration disables push, never the worker) ----
function pushTransport(): PushTransport | null {
  const mode =
    env.PUSH_TRANSPORT ?? (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? 'web' : 'off');
  if (mode === 'off') return null;
  if (mode === 'sandbox') {
    if (env.NODE_ENV === 'production') {
      log('error', 'PUSH_TRANSPORT=sandbox is refused in production: push sending disabled');
      return null;
    }
    log('warn', '[SANDBOX] push transport: TEST-ONLY, nothing leaves this machine');
    return new SandboxPushTransport((line) => log('info', line));
  }
  try {
    const hosts = [...DEFAULT_PUSH_HOSTS, ...env.PUSH_ENDPOINT_HOSTS];
    return new WebPushTransport(
      {
        publicKey: env.VAPID_PUBLIC_KEY ?? '',
        privateKey: env.VAPID_PRIVATE_KEY ?? '',
        subject: env.VAPID_SUBJECT ?? '',
      },
      // re-checked on every send: a stored endpoint outside today's allow-list is never contacted
      { isAllowedEndpoint: (e) => validatePushEndpoint(e, hosts) },
    );
  } catch (err) {
    // the message names the variable, never contains key material
    log('error', 'Web Push disabled: invalid VAPID configuration', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
const transport = pushTransport();
const cipher = createSubscriptionCipher(env.CONTACT_ENCRYPTION_KEY);
if (transport && !cipher) {
  log('error', 'Web Push disabled: CONTACT_ENCRYPTION_KEY is required to open subscriptions');
}
log('info', 'Turn-alert push', {
  transport: transport && cipher ? transport.name : 'disabled',
  ttl_seconds: env.TURN_ALERT_TTL_SECONDS,
});

/** Non-secret configuration the API compares with its own (threshold drift, VAPID public key). */
const workerConfig = {
  DEVICE_STALE_AFTER_SECONDS: env.DEVICE_STALE_AFTER_SECONDS,
  COORDINATOR_EXPIRY_WARN_SECONDS: env.COORDINATOR_EXPIRY_WARN_SECONDS,
  CONFLICT_REVIEW_WARN_SECONDS: env.CONFLICT_REVIEW_WARN_SECONDS,
  HEALTH_EVALUATION_INTERVAL_SECONDS: env.HEALTH_EVALUATION_INTERVAL_SECONDS,
  TURN_ALERT_TTL_SECONDS: env.TURN_ALERT_TTL_SECONDS,
  // null when this worker cannot send: the API then warns that its advertised key is not served
  vapid_public_key: transport && cipher ? (env.VAPID_PUBLIC_KEY ?? null) : null,
};

let lastHealthEvaluation = 0;

async function runOnce(force = false): Promise<void> {
  // Device health first: alerts should not wait behind long housekeeping jobs
  const due = Date.now() - lastHealthEvaluation >= env.HEALTH_EVALUATION_INTERVAL_SECONDS * 1000;
  if (force || due) {
    try {
      const r = await evaluateDeviceHealth(sql, {
        deviceStaleAfterSeconds: env.DEVICE_STALE_AFTER_SECONDS,
        coordinatorExpiryWarnSeconds: env.COORDINATOR_EXPIRY_WARN_SECONDS,
        conflictReviewWarnSeconds: env.CONFLICT_REVIEW_WARN_SECONDS,
        // `--once` must really evaluate (wait for another instance instead of skipping)
        waitForLock: force,
        workerConfig,
      });
      lastHealthEvaluation = Date.now();
      if (r.opened + r.resolved > 0) log('info', 'Device health evaluated', { ...r });
    } catch (err) {
      // The previous alert state stays as it was (one transaction); queues are never affected
      log('error', 'Device health evaluation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Turn alerts: its own try/catch, so a push failure can never stop the jobs that follow
  try {
    const r = await processTurnAlerts(sql, transport && cipher ? transport : null, cipher, {
      ttlSeconds: env.TURN_ALERT_TTL_SECONDS,
    });
    if (r.claimed + r.failed > 0) log('info', 'Turn alerts processed', { ...r });
  } catch (err) {
    log('error', 'Turn-alert delivery failed (other jobs continue)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    const p = await purgeAlertData(sql);
    if (p.revoked + p.tombstonesDeleted + p.notificationsDeleted + p.throttleDeleted > 0)
      log('info', 'Turn-alert data retention', { ...p });
  } catch (err) {
    log('error', 'Turn-alert retention failed (other jobs continue)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    const removed = await runHealthRetention(sql);
    if (removed > 0) log('info', 'Resolved health alerts purged', { count: removed });
  } catch (err) {
    log('error', 'Health alert retention failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    const purged = await runRecoveryRetention(sql);
    if (purged.tokens + purged.keys + purged.grants + purged.throttle > 0) {
      log('info', 'Recovery data purged', { ...purged });
    }
  } catch (err) {
    // Retention is housekeeping: a failure never stops the checkpoint job
    log('error', 'Recovery retention failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (checkpointsEnabled) {
    const r = await runCheckpointJob(sql, {
      keyId: env.AUDIT_SIGNING_KEY_ID as string,
      key: env.AUDIT_SIGNING_KEY as string,
      minEvents: env.AUDIT_CHECKPOINT_MIN_EVENTS,
      maxAgeMs: env.AUDIT_CHECKPOINT_MAX_AGE_MS,
    });
    for (const a of r.alerts) {
      log('error', 'Audit integrity alert', {
        queue_session_id: a.queue_session_id,
        kind: a.kind,
        at_sequence: a.at_sequence,
        reason: a.reason,
      });
    }
    for (const e of r.errors) {
      log('error', 'Audit checkpoint failed for one session (others continued)', {
        queue_session_id: e.queue_session_id,
        error: e.error,
      });
    }
    if (r.checkpointed.length > 0)
      log('info', 'Audit checkpoints written', { count: r.checkpointed.length });
  }
}

async function main(): Promise<void> {
  // Fail fast (exit 1) on a database that is not a migrated QueueBridge database
  const db = await assertQueueBridgeDatabase(sql);
  log('info', 'Worker started', {
    database: db.database,
    latest_migration: db.latest_migration,
    poll_interval_ms: env.WORKER_POLL_INTERVAL_MS,
    mode: ONCE ? 'once' : 'loop',
  });
  if (ONCE) {
    try {
      await runOnce(true);
      log('info', 'Worker run complete');
    } catch (err) {
      log('error', 'Worker job error', { error: err instanceof Error ? err.message : String(err) });
      process.exitCode = 1;
    }
    await sql.end({ timeout: 5 });
    return;
  }
  while (running) {
    try {
      await runOnce();
    } catch (err) {
      log('error', 'Worker job error', { error: err instanceof Error ? err.message : String(err) });
    }
    await sleep(env.WORKER_POLL_INTERVAL_MS);
  }
  await sql.end({ timeout: 5 });
  log('info', 'Worker stopped');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `--once` is bounded: it exits with status 1 if the run has not finished within
 * WORKER_ONCE_TIMEOUT_MS (a stalled database connection must not hang its caller), and a stop
 * signal ends it at once (the transaction it may hold is rolled back by the server). The loop
 * mode keeps its graceful stop: it finishes the current pass, then exits.
 */
function stop(signal: string): void {
  if (!ONCE) {
    running = false;
    return;
  }
  log('error', 'Worker --once stopped by signal', { signal });
  process.exit(1);
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
if (ONCE) {
  setTimeout(() => {
    log('error', 'Worker --once did not finish in time: exiting', {
      timeout_ms: env.WORKER_ONCE_TIMEOUT_MS,
    });
    process.exit(1);
  }, env.WORKER_ONCE_TIMEOUT_MS).unref();
}

try {
  await main();
} catch (err) {
  log('error', 'Worker stopped: startup check failed', {
    error: err instanceof Error ? err.message : String(err),
  });
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exitCode = 1;
}
