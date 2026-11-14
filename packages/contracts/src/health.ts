import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from './schemas.js';

/**
 * M5.3 device health and automatic in-product alerts (REQ-F9.6–F9.14, design §17).
 *
 * Health OBSERVES. Nothing here assigns, fails over, renews or revokes a coordinator or a
 * device: those stay explicit, audited supervisor actions (ADR-006).
 */

/** Accepted initial defaults (2026-11-12); every value is configurable per deployment. */
export const HEALTH_DEFAULTS = Object.freeze({
  /** No contact for this long: `offline` (unchanged from M3) */
  offlineAfterSeconds: 120,
  /** No contact for this long: `stale` */
  deviceStaleAfterSeconds: 900,
  /** Coordinator authorization ending within this window: `coordinator_expiring` */
  coordinatorExpiryWarnSeconds: 300,
  /** `needs_review` operations older than this: `conflicts_unreviewed` */
  conflictReviewWarnSeconds: 900,
  /** The worker evaluates this often; older than 3 intervals = "automatic alerts are paused" */
  evaluationIntervalSeconds: 30,
  /** The same failure code reported this many times in a row: `sync_failing` */
  syncFailureStreak: 3,
  /** Turn-alert failures in the last hour at or above this: `alert_pipeline_failing` */
  alertPipelineFailureThreshold: 10,
  /** A recovery-abuse signal stays relevant this long (the throttle window) */
  recoveryAbuseWindowSeconds: 900,
  /** Resolved alerts are deleted after this many days */
  resolvedRetentionDays: 30,
});

export const HEALTH_ALERT_KINDS = [
  'coordinator_offline',
  'coordinator_expiring',
  'coordinator_expired',
  'device_stale_pending',
  'sync_failing',
  'conflicts_unreviewed',
  'recovery_abuse',
  'alert_pipeline_failing',
] as const;
export type HealthAlertKind = (typeof HEALTH_ALERT_KINDS)[number];

export const HEALTH_SEVERITIES = ['high', 'medium', 'low'] as const;
export type HealthSeverity = (typeof HEALTH_SEVERITIES)[number];

/** Severity is a property of the kind (design §17.4), never chosen per alert. */
export const ALERT_SEVERITY: Readonly<Record<HealthAlertKind, HealthSeverity>> = Object.freeze({
  coordinator_offline: 'high',
  coordinator_expiring: 'medium',
  coordinator_expired: 'high',
  device_stale_pending: 'medium',
  sync_failing: 'medium',
  conflicts_unreviewed: 'medium',
  recovery_abuse: 'medium',
  alert_pipeline_failing: 'low',
});

/** What an alert is about: a device, a queue session, or the facility as a whole. */
export const ALERT_SUBJECT: Readonly<Record<HealthAlertKind, 'device' | 'queue' | 'facility'>> =
  Object.freeze({
    coordinator_offline: 'queue',
    coordinator_expiring: 'queue',
    coordinator_expired: 'queue',
    device_stale_pending: 'device',
    sync_failing: 'device',
    conflicts_unreviewed: 'queue',
    recovery_abuse: 'facility',
    alert_pipeline_failing: 'facility',
  });

export const HEALTH_ALERT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type HealthAlertStatus = (typeof HEALTH_ALERT_STATUSES)[number];

export const HealthAlertSchema = z.object({
  id: UuidSchema,
  kind: z.enum(HEALTH_ALERT_KINDS),
  severity: z.enum(HEALTH_SEVERITIES),
  status: z.enum(HEALTH_ALERT_STATUSES),
  subject_type: z.enum(['device', 'queue', 'facility']),
  subject_id: UuidSchema,
  /** Device label or service name (never a person's details) */
  subject_label: z.string().nullable(),
  opened_at: IsoDateTimeSchema,
  /** The condition was last confirmed at (server time) */
  last_seen_at: IsoDateTimeSchema,
  acknowledged_at: IsoDateTimeSchema.nullable(),
  acknowledged_by_name: z.string().nullable(),
  resolved_at: IsoDateTimeSchema.nullable(),
  /** Counts only (pending actions, conflicts, failures); never identifiers of people */
  details: z.record(z.string(), z.number()),
});
export type HealthAlert = z.infer<typeof HealthAlertSchema>;

export const AlertEvaluationSchema = z.object({
  /** Last completed worker evaluation (server time); null if it never ran */
  last_evaluated_at: IsoDateTimeSchema.nullable(),
  /** True when no evaluation happened for 3 intervals: stored alerts may lag reality */
  paused: z.boolean(),
  interval_seconds: z.number().int().positive(),
});
export type AlertEvaluation = z.infer<typeof AlertEvaluationSchema>;

/** Signed-in banner: open alerts the caller may see, across their facilities. */
export const AlertSummarySchema = z.object({
  open: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
  facilities: z.array(
    z.object({
      facility_id: UuidSchema,
      facility_name: z.string(),
      open: z.number().int().nonnegative(),
      high: z.number().int().nonnegative(),
    }),
  ),
});
export type AlertSummary = z.infer<typeof AlertSummarySchema>;

export const OWN_DEVICE_WARNINGS = [
  'coordinator_expiring',
  'coordinator_expired',
  'sync_failing',
] as const;
export type OwnDeviceWarningKind = (typeof OWN_DEVICE_WARNINGS)[number];

/** What a staff member sees about THEIR OWN device (computed on read, by server time). */
export const OwnDeviceHealthSchema = z.object({
  device_id: UuidSchema,
  server_time: IsoDateTimeSchema,
  warnings: z.array(
    z.object({
      kind: z.enum(OWN_DEVICE_WARNINGS),
      severity: z.enum(HEALTH_SEVERITIES),
      queue_id: UuidSchema.nullable(),
      service_name: z.string().nullable(),
      /** For coordinator warnings: when the authorization ends or ended */
      expires_at: IsoDateTimeSchema.nullable(),
    }),
  ),
});
export type OwnDeviceHealth = z.infer<typeof OwnDeviceHealthSchema>;
