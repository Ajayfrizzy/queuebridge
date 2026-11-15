import {
  HEALTH_DEFAULTS,
  type AlertEvaluation,
  type DeviceHealth,
  type HealthAlert,
  type HealthAlertKind,
  type HealthSeverity,
  type OperationsHealth,
  type QueueHealth,
} from '@queuebridge/contracts';
import {
  coordinatorCondition,
  deviceHealthState as domainDeviceHealthState,
  type HealthThresholds,
} from '@queuebridge/domain';
import type { Db } from '../db.js';
import type { Env } from '../env.js';
import { coordinatorStatus } from './authority.js';
import { facilityEnqueueErrors } from './turn-alerts.js';

/** A device not heard from for this long is shown as offline (M3; unchanged). */
export const OFFLINE_AFTER_SECONDS = HEALTH_DEFAULTS.offlineAfterSeconds;

/** Server-side health thresholds from the environment (same variables as the worker). */
export interface HealthConfig extends HealthThresholds {
  conflictReviewWarnSeconds: number;
  evaluationIntervalSeconds: number;
  /** M5.4: the VAPID public key this API advertises (null when push is disabled) */
  vapidPublicKey?: string | null;
  /** M5.4: push time-to-live; the worker enforces it, the API reports it */
  turnAlertTtlSeconds?: number;
}
export function healthConfig(env: Env): HealthConfig {
  return {
    offlineAfterSeconds: OFFLINE_AFTER_SECONDS,
    deviceStaleAfterSeconds: env.DEVICE_STALE_AFTER_SECONDS,
    coordinatorExpiryWarnSeconds: env.COORDINATOR_EXPIRY_WARN_SECONDS,
    conflictReviewWarnSeconds: env.CONFLICT_REVIEW_WARN_SECONDS,
    evaluationIntervalSeconds: env.HEALTH_EVALUATION_INTERVAL_SECONDS,
    vapidPublicKey: env.VAPID_PUBLIC_KEY || null,
    turnAlertTtlSeconds: env.TURN_ALERT_TTL_SECONDS,
  };
}

/**
 * The worker's configuration, as it reported it with its last evaluation, compared with this
 * API's (REQ-F9.12 / M5.3 risk "thresholds must match"). Names only, never values of secrets:
 * the VAPID public key is public, and only equality is reported.
 */
export function configMismatch(
  worker: Record<string, unknown> | null | undefined,
  cfg: HealthConfig,
): string[] {
  if (!worker) return [];
  const out: string[] = [];
  const pairs: [string, number][] = [
    ['DEVICE_STALE_AFTER_SECONDS', cfg.deviceStaleAfterSeconds],
    ['COORDINATOR_EXPIRY_WARN_SECONDS', cfg.coordinatorExpiryWarnSeconds],
    ['CONFLICT_REVIEW_WARN_SECONDS', cfg.conflictReviewWarnSeconds],
    ['HEALTH_EVALUATION_INTERVAL_SECONDS', cfg.evaluationIntervalSeconds],
    ...(cfg.turnAlertTtlSeconds === undefined
      ? []
      : ([['TURN_ALERT_TTL_SECONDS', cfg.turnAlertTtlSeconds]] as [string, number][])),
  ];
  for (const [name, value] of pairs) {
    if (name in worker && worker[name] !== value) out.push(name);
  }
  if (
    'vapid_public_key' in worker &&
    (worker['vapid_public_key'] ?? null) !== (cfg.vapidPublicKey ?? null)
  ) {
    out.push('VAPID_PUBLIC_KEY');
  }
  return out;
}
export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  offlineAfterSeconds: OFFLINE_AFTER_SECONDS,
  deviceStaleAfterSeconds: HEALTH_DEFAULTS.deviceStaleAfterSeconds,
  coordinatorExpiryWarnSeconds: HEALTH_DEFAULTS.coordinatorExpiryWarnSeconds,
  conflictReviewWarnSeconds: HEALTH_DEFAULTS.conflictReviewWarnSeconds,
  evaluationIntervalSeconds: HEALTH_DEFAULTS.evaluationIntervalSeconds,
};

interface DeviceRow {
  id: string;
  label: string | null;
  owner_name: string;
  last_seen_at: Date | null;
  last_sync_at: Date | null;
  reported_pending_count: number;
  last_failure_code: string | null;
  failure_streak: number;
  revoked_at: Date | null;
  revoked_reason_code: string | null;
  needs_review_count: number;
  rejected_count: number;
}

interface QueueRow {
  id: string;
  service_name: string;
  state: string;
  revision: number;
  coordinator_epoch: number;
  coordinator_device_id: string | null;
  coordinator_granted_at: Date | null;
  coordinator_expires_at: Date | null;
  coordinator_allowed_actions: string[];
  coordinator_label: string | null;
  open_conflicts: number;
}

/** M3 signature kept; state now also distinguishes `stale` (thresholds default as before). */
export function deviceHealthState(
  d: Pick<
    DeviceRow,
    'revoked_at' | 'needs_review_count' | 'last_seen_at' | 'reported_pending_count'
  >,
  now: Date,
  t: HealthThresholds = DEFAULT_HEALTH_CONFIG,
): ReturnType<typeof domainDeviceHealthState> {
  return domainDeviceHealthState(d, now, t);
}

interface AlertRow {
  id: string;
  kind: HealthAlertKind;
  severity: HealthSeverity;
  subject_type: 'device' | 'queue' | 'facility';
  subject_id: string;
  subject_label: string | null;
  details: Record<string, number>;
  opened_at: Date;
  last_seen_at: Date;
  acknowledged_at: Date | null;
  acknowledged_by_name: string | null;
  resolved_at: Date | null;
}

export function toHealthAlert(a: AlertRow): HealthAlert {
  return {
    id: a.id,
    kind: a.kind,
    severity: a.severity,
    status: a.resolved_at ? 'resolved' : a.acknowledged_at ? 'acknowledged' : 'open',
    subject_type: a.subject_type,
    subject_id: a.subject_id,
    subject_label: a.subject_label,
    opened_at: a.opened_at.toISOString(),
    last_seen_at: a.last_seen_at.toISOString(),
    acknowledged_at: a.acknowledged_at?.toISOString() ?? null,
    acknowledged_by_name: a.acknowledged_by_name,
    resolved_at: a.resolved_at?.toISOString() ?? null,
    // counts only (the evaluator writes nothing else; filter defensively anyway)
    details: Object.fromEntries(
      Object.entries(a.details ?? {}).filter(([, v]) => typeof v === 'number'),
    ),
  };
}

/** Facility alerts: open and acknowledged, and those resolved in the last 24 hours. */
export async function facilityAlerts(
  db: Db,
  organizationId: string,
  facilityId: string,
): Promise<HealthAlert[]> {
  const rows = await db<AlertRow[]>`
    SELECT a.id, a.kind, a.severity, a.subject_type, a.subject_id, a.details, a.opened_at,
           a.last_seen_at, a.acknowledged_at, a.resolved_at, u.display_name AS acknowledged_by_name,
           CASE a.subject_type
             WHEN 'device' THEN (SELECT d.label FROM devices d WHERE d.id = a.subject_id)
             WHEN 'queue' THEN (SELECT s.name FROM queue_sessions qs JOIN services s ON s.id = qs.service_id
                                 WHERE qs.id = a.subject_id)
             ELSE (SELECT f.name FROM facilities f WHERE f.id = a.subject_id) END AS subject_label
      FROM health_alerts a
      LEFT JOIN staff_users u ON u.id = a.acknowledged_by
     WHERE a.organization_id = ${organizationId} AND a.facility_id = ${facilityId}
       AND (a.resolved_at IS NULL OR a.resolved_at > NOW() - INTERVAL '24 hours')
     ORDER BY (a.resolved_at IS NOT NULL),
              CASE a.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
              a.opened_at DESC
     LIMIT 200`;
  return rows.map(toHealthAlert);
}

export async function evaluationStatus(db: Db, cfg: HealthConfig): Promise<AlertEvaluation> {
  const [r] = await db<
    { last_evaluated_at: Date; paused: boolean; worker_config: Record<string, unknown> | null }[]
  >`
    SELECT last_evaluated_at, worker_config,
           last_evaluated_at < NOW() - make_interval(secs => ${3 * cfg.evaluationIntervalSeconds}) AS paused
      FROM health_evaluations WHERE id`;
  return {
    last_evaluated_at: r?.last_evaluated_at.toISOString() ?? null,
    paused: r ? r.paused : true,
    interval_seconds: cfg.evaluationIntervalSeconds,
    config_mismatch: configMismatch(r?.worker_config, cfg),
  };
}

/**
 * Connectivity and recovery dashboard data for a facility (F9). Server API health is a separate
 * signal (/health/ready); this reports what the SERVER knows about each device — and says so:
 * pending counts are reported by the devices, so they are approximate. States are computed here
 * on read (server time), so they are correct even when the alert worker is not running.
 */
export async function operationsHealth(
  db: Db,
  organizationId: string,
  facilityId: string,
  cfg: HealthConfig = DEFAULT_HEALTH_CONFIG,
): Promise<OperationsHealth> {
  // Server time from the database: the same clock the worker and every other check uses
  const [clock] = await db<{ now: Date }[]>`SELECT NOW() AS now`;
  const now = clock?.now ?? new Date();
  const devices = await db<DeviceRow[]>`
    SELECT d.id, d.label, u.display_name AS owner_name, d.last_seen_at, d.last_sync_at,
           d.reported_pending_count, d.last_failure_code, d.failure_streak, d.revoked_at,
           d.revoked_reason_code,
           (SELECT COUNT(*)::int FROM client_operations co
             WHERE co.device_id = d.id AND co.status = 'needs_review') AS needs_review_count,
           (SELECT COUNT(*)::int FROM client_operations co
             WHERE co.device_id = d.id AND co.status = 'rejected') AS rejected_count
      FROM devices d JOIN staff_users u ON u.id = d.staff_user_id
     WHERE d.organization_id = ${organizationId} AND d.facility_id = ${facilityId}
     ORDER BY (d.revoked_at IS NOT NULL), d.last_seen_at DESC NULLS LAST, d.created_at DESC
     LIMIT 200`;

  const queues = await db<QueueRow[]>`
    SELECT qs.id, s.name AS service_name, qs.state, qs.revision, qs.coordinator_epoch,
           qs.coordinator_device_id, qs.coordinator_granted_at, qs.coordinator_expires_at,
           qs.coordinator_allowed_actions, d.label AS coordinator_label,
           (SELECT COUNT(*)::int FROM client_operations co
             WHERE co.queue_session_id = qs.id AND co.status = 'needs_review') AS open_conflicts
      FROM queue_sessions qs
      JOIN services s ON s.id = qs.service_id
      JOIN facilities f ON f.id = qs.facility_id
      LEFT JOIN devices d ON d.id = qs.coordinator_device_id
     WHERE qs.organization_id = ${organizationId} AND qs.facility_id = ${facilityId}
       AND (qs.operational_date = (NOW() AT TIME ZONE f.timezone)::date
            OR qs.coordinator_device_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM client_operations co
                        WHERE co.queue_session_id = qs.id AND co.status = 'needs_review'))
     ORDER BY s.name, qs.operational_date DESC`;

  const queueHealth: QueueHealth[] = queues.map((q) => ({
    queue_id: q.id,
    service_name: q.service_name,
    state: q.state,
    revision: q.revision,
    coordinator: coordinatorStatus(q, q.coordinator_label, now),
    open_conflicts: q.open_conflicts,
  }));

  const deviceHealth: DeviceHealth[] = devices.map((d) => ({
    id: d.id,
    label: d.label,
    owner_name: d.owner_name,
    last_seen_at: d.last_seen_at?.toISOString() ?? null,
    last_sync_at: d.last_sync_at?.toISOString() ?? null,
    pending_count: d.reported_pending_count,
    needs_review_count: d.needs_review_count,
    rejected_count: d.rejected_count,
    health: deviceHealthState(d, now, cfg),
    last_failure_code: d.last_failure_code,
    failure_streak: d.failure_streak,
    revoked_at: d.revoked_at?.toISOString() ?? null,
    revoked_reason: d.revoked_at ? d.revoked_reason_code : null,
    coordinator_for: queues
      .filter((q) => q.coordinator_device_id === d.id && q.coordinator_expires_at)
      .map((q) => {
        const c = coordinatorCondition(q.coordinator_expires_at, now, cfg);
        return {
          queue_id: q.id,
          service_name: q.service_name,
          epoch: q.coordinator_epoch,
          expires_at: (q.coordinator_expires_at as Date).toISOString(),
          expired: c === 'expired',
          expiring: c === 'expiring',
        };
      }),
  }));

  const [counters] = await db<{ abuse: number }[]>`
    SELECT COUNT(*)::int AS abuse FROM admin_events
     WHERE organization_id = ${organizationId} AND facility_id = ${facilityId}
       AND event_type = 'ticket_recovery.abuse_detected'
       AND created_at > NOW() - INTERVAL '24 hours'`;
  const turnAlerts = await turnAlertCounters(db, organizationId, facilityId);

  return {
    server_time: now.toISOString(),
    offline_after_seconds: cfg.offlineAfterSeconds,
    stale_after_seconds: cfg.deviceStaleAfterSeconds,
    coordinator_expiry_warn_seconds: cfg.coordinatorExpiryWarnSeconds,
    devices: deviceHealth,
    queues: queueHealth,
    open_conflicts: queueHealth.reduce((n, q) => n + q.open_conflicts, 0),
    alerts: await facilityAlerts(db, organizationId, facilityId),
    evaluation: await evaluationStatus(db, cfg),
    counters: {
      recovery_abuse_24h: counters?.abuse ?? 0,
      turn_alert_failures_1h: turnAlerts.failed + turnAlerts.unknown,
    },
    turn_alerts: { ...turnAlerts, enqueue_errors: facilityEnqueueErrors(facilityId) },
  };
}

/**
 * Last-hour push turn-alert outcomes at a facility (counts only). A FAILURE here is a pipeline
 * problem: retries exhausted, TTL elapsed, rejected, or an unexpected error. An expired
 * subscription (`gone`, 404/410) is a normal end of a browser subscription, and a visitor who
 * refused permission or has no push support never creates a row at all, so neither counts.
 */
export async function turnAlertCounters(
  db: Db,
  organizationId: string,
  facilityId: string,
): Promise<{
  attempted: number;
  sent: number;
  delivered: number;
  failed: number;
  suppressed: number;
  unknown: number;
}> {
  const [r] = await db<
    {
      attempted: number;
      sent: number;
      delivered: number;
      failed: number;
      suppressed: number;
      unknown: number;
    }[]
  >`
    SELECT COUNT(*) FILTER (WHERE n.status <> 'pending')::int AS attempted,
           COUNT(*) FILTER (WHERE n.status = 'sent')::int AS sent,
           COUNT(*) FILTER (WHERE n.status = 'delivered')::int AS delivered,
           COUNT(*) FILTER (WHERE n.status = 'failed' AND n.detail_code IS DISTINCT FROM 'gone')::int AS failed,
           COUNT(*) FILTER (WHERE n.status = 'suppressed')::int AS suppressed,
           COUNT(*) FILTER (WHERE n.status = 'unknown')::int AS unknown
      FROM notifications n
      JOIN push_subscriptions ps ON ps.id = n.push_subscription_id
     WHERE n.organization_id = ${organizationId} AND ps.facility_id = ${facilityId}
       AND n.channel = 'web_push' AND n.updated_at > NOW() - INTERVAL '1 hour'`;
  return r ?? { attempted: 0, sent: 0, delivered: 0, failed: 0, suppressed: 0, unknown: 0 };
}
