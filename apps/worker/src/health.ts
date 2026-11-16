import type postgres from 'postgres';
import { ALERT_SEVERITY, HEALTH_DEFAULTS } from '@queuebridge/contracts';
import { CLEAR_EVALUATIONS_TO_RESOLVE } from '@queuebridge/domain';

/**
 * M5.3 automatic device-health evaluation (REQ-F9.7, F9.9, F9.12; design §17.4–§17.5, §17.11).
 *
 * OBSERVES ONLY. It reads devices, queue sessions, tickets, operations, admin events and
 * notifications with plain SELECTs (no row locks) and writes exactly two tables:
 * `health_alerts` and `health_evaluations`. It never assigns, fails over, renews or revokes a
 * coordinator or a device, and never touches queue sessions, tickets, events or devices
 * (ADR-006 single-coordinator authority unchanged; Group 6 fencing tests stay as they are).
 *
 *  - One open alert per (facility, kind, subject): enforced by a unique partial index, so
 *    concurrent evaluators (several worker instances) cannot create duplicates.
 *  - Damping: an alert resolves only after its condition was absent in TWO evaluations.
 *  - A subject that is gone (device revoked, queue closed) resolves at once.
 *  - All times are database server time; device clocks are never used.
 *  - One transaction: if anything fails, nothing changes (no spurious resolve) and the error is
 *    the caller's to log.
 *  - Logs (by the caller) carry counts only.
 */
export interface HealthEvaluationOptions {
  offlineAfterSeconds?: number;
  deviceStaleAfterSeconds?: number;
  coordinatorExpiryWarnSeconds?: number;
  conflictReviewWarnSeconds?: number;
  recoveryAbuseWindowSeconds?: number;
  alertPipelineFailureThreshold?: number;
  syncFailureStreak?: number;
  /**
   * Default true: skip this pass if another evaluator is running (try-lock, never waits). The
   * unique index guarantees deduplication either way; tests turn this off to prove it.
   */
  exclusive?: boolean;
  /**
   * With `exclusive`: wait for a running evaluation to finish, then evaluate, instead of
   * skipping. Used by `--once`, which must guarantee that one evaluation really happened.
   */
  waitForLock?: boolean;
  /**
   * Upper bound (ms) on any lock wait (default 30 000); any single statement is bounded at twice that.
   * A stuck or slow evaluation therefore fails, rolls back and is retried next interval: it can
   * never hold the evaluation lock, or keep `--once` waiting, indefinitely.
   */
  timeoutMs?: number;
  /** M5.4: non-secret configuration recorded with the evaluation (the API compares it) */
  workerConfig?: Record<string, string | number | null>;
}

export interface HealthEvaluationResult {
  skipped: boolean;
  /** Conditions currently present */
  present: number;
  opened: number;
  resolved: number;
  /** Facilities whose alert set changed (a change signal was sent for each) */
  changedFacilities: number;
}

/** Channel for "this facility's alerts changed" (payload: `{"f": facility id}`; no data). */
export const HEALTH_CHANNEL = 'qb_health_events';
/** Fixed advisory-lock key for "an evaluation is running" (try-lock only; never blocks). */
const EVALUATION_LOCK_KEY = 0x71_62_68_65_61_6c_74_68n; // "qbhealth"

export async function evaluateDeviceHealth(
  sql: postgres.Sql,
  opts: HealthEvaluationOptions = {},
): Promise<HealthEvaluationResult> {
  const o = {
    offline: opts.offlineAfterSeconds ?? HEALTH_DEFAULTS.offlineAfterSeconds,
    stale: opts.deviceStaleAfterSeconds ?? HEALTH_DEFAULTS.deviceStaleAfterSeconds,
    warn: opts.coordinatorExpiryWarnSeconds ?? HEALTH_DEFAULTS.coordinatorExpiryWarnSeconds,
    conflicts: opts.conflictReviewWarnSeconds ?? HEALTH_DEFAULTS.conflictReviewWarnSeconds,
    abuse: opts.recoveryAbuseWindowSeconds ?? HEALTH_DEFAULTS.recoveryAbuseWindowSeconds,
    pipeline: opts.alertPipelineFailureThreshold ?? HEALTH_DEFAULTS.alertPipelineFailureThreshold,
    streak: opts.syncFailureStreak ?? HEALTH_DEFAULTS.syncFailureStreak,
  };
  const timeout = Math.max(100, Math.floor(opts.timeoutMs ?? 30_000));
  return sql.begin(async (tx) => {
    // Bounded: a lock wait or statement beyond `timeout` aborts this transaction (nothing changes)
    await tx.unsafe(`SET LOCAL lock_timeout = '${timeout}ms'`);
    // (the statement bound is wider so that a plain lock wait reports as a lock timeout)
    await tx.unsafe(`SET LOCAL statement_timeout = '${2 * timeout}ms'`);
    if (opts.exclusive !== false && opts.waitForLock) {
      await tx`SELECT pg_advisory_xact_lock(${EVALUATION_LOCK_KEY.toString()}::bigint)`;
    } else if (opts.exclusive !== false) {
      const [got] = await tx<{ ok: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${EVALUATION_LOCK_KEY.toString()}::bigint) AS ok`;
      if (!got?.ok) {
        return { skipped: true, present: 0, opened: 0, resolved: 0, changedFacilities: 0 };
      }
    }

    // 1. Every condition present now, upserted. NOW() is the transaction start, identical in
    //    every statement below: rows confirmed in THIS pass have last_seen_at = NOW().
    const upserted = await tx<{ facility_id: string; inserted: boolean }[]>`
      WITH c (organization_id, facility_id, kind, subject_type, subject_id, details) AS (
        -- coordinator_offline: the assigned coordinator is offline or stale while its queue has
        -- waiting or called tickets
        SELECT qs.organization_id, qs.facility_id, 'coordinator_offline', 'queue', qs.id,
               jsonb_build_object('waiting', w.waiting, 'called', w.called)
          FROM queue_sessions qs
          JOIN devices d ON d.id = qs.coordinator_device_id
          CROSS JOIN LATERAL (
            SELECT COUNT(*) FILTER (WHERE t.state = 'waiting')::int AS waiting,
                   COUNT(*) FILTER (WHERE t.state = 'called')::int AS called
              FROM tickets t WHERE t.queue_session_id = qs.id AND t.state IN ('waiting', 'called')) w
         WHERE qs.coordinator_device_id IS NOT NULL
           AND (d.last_seen_at IS NULL OR d.last_seen_at < NOW() - make_interval(secs => ${o.offline}))
           AND w.waiting + w.called > 0
        UNION ALL
        -- coordinator_expiring: authorization ends within the warning window
        SELECT qs.organization_id, qs.facility_id, 'coordinator_expiring', 'queue', qs.id,
               jsonb_build_object('seconds_left',
                 GREATEST(0, EXTRACT(EPOCH FROM qs.coordinator_expires_at - NOW()))::int)
          FROM queue_sessions qs
         WHERE qs.coordinator_device_id IS NOT NULL
           AND qs.coordinator_expires_at > NOW()
           AND qs.coordinator_expires_at <= NOW() + make_interval(secs => ${o.warn})
        UNION ALL
        -- coordinator_expired: the device is still the assigned coordinator after expiry
        SELECT qs.organization_id, qs.facility_id, 'coordinator_expired', 'queue', qs.id,
               jsonb_build_object('seconds_ago',
                 GREATEST(0, EXTRACT(EPOCH FROM NOW() - qs.coordinator_expires_at))::int)
          FROM queue_sessions qs
         WHERE qs.coordinator_device_id IS NOT NULL AND qs.coordinator_expires_at <= NOW()
        UNION ALL
        -- device_stale_pending: a stale device reported unsent actions
        SELECT d.organization_id, d.facility_id, 'device_stale_pending', 'device', d.id,
               jsonb_build_object('pending', d.reported_pending_count)
          FROM devices d
         WHERE d.revoked_at IS NULL AND d.reported_pending_count > 0
           AND (d.last_seen_at IS NULL OR d.last_seen_at < NOW() - make_interval(secs => ${o.stale}))
        UNION ALL
        -- sync_failing: the same failure code reported 3 times in a row
        SELECT d.organization_id, d.facility_id, 'sync_failing', 'device', d.id,
               jsonb_build_object('reports', d.failure_streak)
          FROM devices d
         WHERE d.revoked_at IS NULL AND d.failure_streak >= ${o.streak}
        UNION ALL
        -- conflicts_unreviewed: operations waiting for a supervisor beyond the threshold
        SELECT qs.organization_id, qs.facility_id, 'conflicts_unreviewed', 'queue', qs.id,
               jsonb_build_object('conflicts', COUNT(*)::int)
          FROM client_operations co JOIN queue_sessions qs ON qs.id = co.queue_session_id
         WHERE co.status = 'needs_review'
           AND co.created_at < NOW() - make_interval(secs => ${o.conflicts})
         GROUP BY qs.organization_id, qs.facility_id, qs.id
        UNION ALL
        -- recovery_abuse: an aggregate recovery limit (L3/L4) was crossed recently
        SELECT ae.organization_id, ae.facility_id, 'recovery_abuse', 'facility', ae.facility_id,
               jsonb_build_object('signals', COUNT(*)::int)
          FROM admin_events ae
         WHERE ae.event_type = 'ticket_recovery.abuse_detected' AND ae.facility_id IS NOT NULL
           AND ae.created_at > NOW() - make_interval(secs => ${o.abuse})
         GROUP BY ae.organization_id, ae.facility_id
        UNION ALL
        -- alert_pipeline_failing: many failed turn alerts in the last hour. A failure is a
        -- pipeline problem (retries exhausted, TTL elapsed, rejected, unexpected error); an
        -- expired browser subscription (detail 'gone') is normal and does not count, and a
        -- visitor who refused permission or has no push support never creates a row at all.
        SELECT n.organization_id, qs.facility_id, 'alert_pipeline_failing', 'facility', qs.facility_id,
               jsonb_build_object('failed', COUNT(*)::int)
          FROM notifications n
          JOIN tickets t ON t.id = n.ticket_id
          JOIN queue_sessions qs ON qs.id = t.queue_session_id
         WHERE ((n.status = 'failed' AND n.detail_code IS DISTINCT FROM 'gone') OR n.status = 'unknown')
           AND n.updated_at > NOW() - INTERVAL '1 hour'
         GROUP BY n.organization_id, qs.facility_id
        HAVING COUNT(*) >= ${o.pipeline}
      )
      INSERT INTO health_alerts
        (organization_id, facility_id, kind, severity, subject_type, subject_id, details)
      SELECT c.organization_id, c.facility_id, c.kind, (${tx.json({ ...ALERT_SEVERITY })}::jsonb ->> c.kind),
             c.subject_type, c.subject_id, c.details
        FROM c
      ON CONFLICT (facility_id, kind, subject_id) WHERE resolved_at IS NULL
      DO UPDATE SET last_seen_at = NOW(), clear_count = 0, details = EXCLUDED.details
      RETURNING facility_id, (xmax = 0) AS inserted`;

    // 2. A subject that no longer exists or no longer applies (revoked device, closed queue)
    //    resolves at once; the condition can never come back for it.
    const gone = await tx<{ facility_id: string }[]>`
      UPDATE health_alerts a
         SET resolved_at = NOW(), resolved_reason = 'subject_gone'
       WHERE a.resolved_at IS NULL AND a.last_seen_at < NOW()
         AND ((a.subject_type = 'device' AND NOT EXISTS (
                SELECT 1 FROM devices d WHERE d.id = a.subject_id AND d.revoked_at IS NULL))
           OR (a.subject_type = 'queue' AND NOT EXISTS (
                SELECT 1 FROM queue_sessions qs WHERE qs.id = a.subject_id AND qs.state <> 'closed')))
      RETURNING a.facility_id`;

    // 3. Damping: count consecutive clear evaluations; resolve at CLEAR_EVALUATIONS_TO_RESOLVE
    const cleared = await tx<{ facility_id: string; resolved: boolean }[]>`
      UPDATE health_alerts a
         SET clear_count = a.clear_count + 1,
             resolved_at = CASE WHEN a.clear_count + 1 >= ${CLEAR_EVALUATIONS_TO_RESOLVE} THEN NOW() END,
             resolved_reason = CASE WHEN a.clear_count + 1 >= ${CLEAR_EVALUATIONS_TO_RESOLVE}
                                    THEN 'condition_cleared' END
       WHERE a.resolved_at IS NULL AND a.last_seen_at < NOW()
      RETURNING a.facility_id, (a.resolved_at IS NOT NULL) AS resolved`;

    await tx`
      INSERT INTO health_evaluations (id, last_evaluated_at, worker_config)
      VALUES (TRUE, NOW(), ${opts.workerConfig ? tx.json(opts.workerConfig) : null})
      ON CONFLICT (id) DO UPDATE SET
        last_evaluated_at = GREATEST(health_evaluations.last_evaluated_at, NOW()),
        worker_config = COALESCE(EXCLUDED.worker_config, health_evaluations.worker_config)`;

    const changed = new Set<string>([
      ...upserted.filter((r) => r.inserted).map((r) => r.facility_id),
      ...gone.map((r) => r.facility_id),
      ...cleared.filter((r) => r.resolved).map((r) => r.facility_id),
    ]);
    for (const f of changed) {
      // Delivered only if this transaction commits; carries no data, only "refresh"
      await tx`SELECT pg_notify(${HEALTH_CHANNEL}, ${JSON.stringify({ f })})`;
    }
    return {
      skipped: false,
      present: upserted.length,
      opened: upserted.filter((r) => r.inserted).length,
      resolved: gone.length + cleared.filter((r) => r.resolved).length,
      changedFacilities: changed.size,
    };
  });
}

/** Resolved alerts are deleted after 30 days (REQ-F9.13). Bounded and idempotent. */
export async function runHealthRetention(
  sql: postgres.Sql,
  opts: { batch?: number; days?: number } = {},
): Promise<number> {
  const r = await sql`
    DELETE FROM health_alerts WHERE id IN (
      SELECT id FROM health_alerts
       WHERE resolved_at IS NOT NULL
         AND resolved_at < NOW() - make_interval(days => ${opts.days ?? HEALTH_DEFAULTS.resolvedRetentionDays})
       LIMIT ${opts.batch ?? 1000})`;
  return r.count;
}
