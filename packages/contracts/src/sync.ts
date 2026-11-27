import { z } from 'zod';
import { CommandDisposition, QueueAction } from './enums.js';
import { AlertEvaluationSchema, HealthAlertSchema } from './health.js';
import { TurnAlertCountersSchema } from './push.js';
import { StaffQueueSchema } from './queue.js';
import { IsoDateTimeSchema, UuidSchema, UuidV7Schema } from './schemas.js';

/**
 * M3 — continuity engine DTOs: offline commands, devices, coordinator authority, snapshots,
 * conflict review and the connectivity dashboard.
 *
 * Nothing in these schemas carries visitor personal data. Tenant, actor and role are never
 * accepted from the client as authoritative: the server derives them from the session.
 */

// ---------------------------------------------------------------------------
// Offline command vocabulary
// ---------------------------------------------------------------------------

/** Actions a non-coordinator device may record offline: provisional ticket capture only. */
export const CAPTURE_ACTIONS = [QueueAction.TICKET_CREATE] as const;

/** Actions only the designated coordinator (valid epoch, valid authority) may record offline. */
export const ADVANCE_ACTIONS = [
  QueueAction.TICKET_CALL_NEXT,
  QueueAction.TICKET_SERVE,
  QueueAction.TICKET_COMPLETE,
  QueueAction.TICKET_MISS,
] as const;

export const OfflineActionSchema = z.enum([
  QueueAction.TICKET_CREATE,
  QueueAction.TICKET_CALL_NEXT,
  QueueAction.TICKET_SERVE,
  QueueAction.TICKET_COMPLETE,
  QueueAction.TICKET_MISS,
]);
export type OfflineAction = z.infer<typeof OfflineActionSchema>;

/** Events that change a ticket's progress (used to detect advancement by another authority). */
export const ADVANCEMENT_EVENT_TYPES: readonly string[] = [
  QueueAction.TICKET_CALL_NEXT,
  QueueAction.TICKET_CALL_SPECIFIC,
  QueueAction.TICKET_SERVE,
  QueueAction.TICKET_COMPLETE,
  QueueAction.TICKET_MISS,
  QueueAction.TICKET_PAUSE,
  QueueAction.TICKET_RESUME,
  QueueAction.TICKET_CANCEL,
  QueueAction.TICKET_TRANSFER,
  QueueAction.TICKET_PRIORITY_OVERRIDE,
];

export function isAdvanceAction(action: string): boolean {
  return (ADVANCE_ACTIONS as readonly string[]).includes(action);
}

/**
 * Temporary reference for a ticket captured offline, shown to staff (and written on paper for
 * the visitor) until the server assigns the confirmed public code. Never a ticket code.
 */
export const TemporaryRefSchema = z
  .string()
  .regex(/^P-[0-9A-F]{6}$/, 'Invalid temporary reference');
export type TemporaryRef = z.infer<typeof TemporaryRefSchema>;

/** Derive a temporary reference from a UUID v7 operation id (its random tail). */
export function temporaryRefFor(operationId: string): TemporaryRef {
  const tail = operationId.replace(/-/g, '').slice(-6).toUpperCase();
  return `P-${tail}`;
}

const ticketTarget = {
  ticket_id: UuidSchema.optional(),
  ticket_ref: TemporaryRefSchema.optional(),
};

const exactlyOneTarget = (v: { ticket_id?: unknown; ticket_ref?: unknown }): boolean =>
  (v.ticket_id === undefined) !== (v.ticket_ref === undefined);

export const OfflineCreatePayloadSchema = z.object({ temporary_ref: TemporaryRefSchema }).strict();
export const OfflineCallNextPayloadSchema = z
  .object({ counter_id: UuidSchema, ...ticketTarget })
  .strict()
  .refine((v) => v.ticket_id === undefined || v.ticket_ref === undefined, {
    message: 'Give a ticket id or a temporary reference, not both',
  });
export const OfflineTicketPayloadSchema = z
  .object(ticketTarget)
  .strict()
  .refine(exactlyOneTarget, { message: 'Give exactly one of ticket_id or ticket_ref' });

export type OfflineCreatePayload = z.infer<typeof OfflineCreatePayloadSchema>;
export type OfflineCallNextPayload = z.infer<typeof OfflineCallNextPayloadSchema>;
export type OfflineTicketPayload = z.infer<typeof OfflineTicketPayloadSchema>;

export type ParsedOfflinePayload =
  | { ok: true; action: typeof QueueAction.TICKET_CREATE; data: OfflineCreatePayload }
  | { ok: true; action: typeof QueueAction.TICKET_CALL_NEXT; data: OfflineCallNextPayload }
  | {
      ok: true;
      action:
        | typeof QueueAction.TICKET_SERVE
        | typeof QueueAction.TICKET_COMPLETE
        | typeof QueueAction.TICKET_MISS;
      data: OfflineTicketPayload;
    }
  | { ok: false; message: string };

/** Validate an offline command's payload against its action (strict: no extra fields). */
export function parseOfflinePayload(action: string, payload: unknown): ParsedOfflinePayload {
  const fail = (e: z.ZodError): ParsedOfflinePayload => ({
    ok: false,
    message: e.issues.map((i) => i.message).join('; '),
  });
  switch (action) {
    case QueueAction.TICKET_CREATE: {
      const r = OfflineCreatePayloadSchema.safeParse(payload);
      return r.success ? { ok: true, action, data: r.data } : fail(r.error);
    }
    case QueueAction.TICKET_CALL_NEXT: {
      const r = OfflineCallNextPayloadSchema.safeParse(payload);
      return r.success ? { ok: true, action, data: r.data } : fail(r.error);
    }
    case QueueAction.TICKET_SERVE:
    case QueueAction.TICKET_COMPLETE:
    case QueueAction.TICKET_MISS: {
      const r = OfflineTicketPayloadSchema.safeParse(payload);
      return r.success ? { ok: true, action, data: r.data } : fail(r.error);
    }
    default:
      return { ok: false, message: `Action '${action}' cannot be recorded offline` };
  }
}

// ---------------------------------------------------------------------------
// Batch transport (lenient: each command is validated individually so that one malformed
// command never discards the valid ones — Group 7)
// ---------------------------------------------------------------------------

export const SyncBatchTransportSchema = z
  .object({
    commands: z.array(z.unknown()).min(1).max(100),
    /**
     * Signed coordinator authority tokens the device holds (one per queue it advances).
     * Required for advancement commands: the token proves the server designated this device
     * at that epoch, so a fenced (stale-epoch) coordinator is recognised, not merely guessed.
     */
    authorities: z.array(z.string().max(4096)).max(20).optional(),
    /** Approximate number of unsent operations on the device (display only) */
    device_report: z.object({ pending_count: z.number().int().min(0).max(1_000_000) }).optional(),
  })
  .strict();
export type SyncBatchTransport = z.infer<typeof SyncBatchTransportSchema>;

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export const RegisterDeviceRequestSchema = z
  .object({
    facility_id: UuidSchema,
    label: z.string().trim().min(1).max(60).optional(),
  })
  .strict();
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequestSchema>;

export const DEVICE_FAILURE_CODES = ['storage_unavailable', 'sync_failed'] as const;

export const DeviceHeartbeatRequestSchema = z
  .object({
    pending_count: z.number().int().min(0).max(1_000_000),
    failure_code: z.enum(DEVICE_FAILURE_CODES).nullable().optional(),
  })
  .strict();
export type DeviceHeartbeatRequest = z.infer<typeof DeviceHeartbeatRequestSchema>;

export const DEVICE_REVOKE_REASONS = ['lost', 'stolen', 'retired', 'compromised', 'other'] as const;
export const RevokeDeviceRequestSchema = z
  .object({ reason_code: z.enum(DEVICE_REVOKE_REASONS) })
  .strict();
export type RevokeDeviceRequest = z.infer<typeof RevokeDeviceRequestSchema>;

export const DeviceSchema = z.object({
  id: UuidSchema,
  facility_id: UuidSchema,
  label: z.string().nullable(),
  created_at: IsoDateTimeSchema,
  revoked_at: IsoDateTimeSchema.nullable(),
});
export type Device = z.infer<typeof DeviceSchema>;

// ---------------------------------------------------------------------------
// Coordinator authority (ADR-006)
// ---------------------------------------------------------------------------

export const COORDINATOR_MIN_TTL_MINUTES = 5;
export const COORDINATOR_MAX_TTL_MINUTES = 720;
export const COORDINATOR_DEFAULT_TTL_MINUTES = 240;

const ttl = z
  .number()
  .int()
  .min(COORDINATOR_MIN_TTL_MINUTES)
  .max(COORDINATOR_MAX_TTL_MINUTES)
  .default(COORDINATOR_DEFAULT_TTL_MINUTES);

const coordinatorActions = z
  .array(z.enum(ADVANCE_ACTIONS))
  .min(1)
  .max(ADVANCE_ACTIONS.length)
  .optional();

export const AssignCoordinatorRequestSchema = z
  .object({
    operation_id: UuidV7Schema,
    device_id: UuidSchema,
    ttl_minutes: ttl,
    allowed_actions: coordinatorActions,
  })
  .strict();
export type AssignCoordinatorRequest = z.infer<typeof AssignCoordinatorRequestSchema>;

export const FAILOVER_REASONS = [
  'device_lost',
  'device_unreachable',
  'battery_failure',
  'planned_handover',
  'other',
] as const;
export const FailoverCoordinatorRequestSchema = z
  .object({
    operation_id: UuidV7Schema,
    device_id: UuidSchema,
    ttl_minutes: ttl,
    allowed_actions: coordinatorActions,
    reason_code: z.enum(FAILOVER_REASONS),
  })
  .strict();
export type FailoverCoordinatorRequest = z.infer<typeof FailoverCoordinatorRequestSchema>;

export const RenewCoordinatorRequestSchema = z
  .object({ operation_id: UuidV7Schema, ttl_minutes: ttl })
  .strict();
export type RenewCoordinatorRequest = z.infer<typeof RenewCoordinatorRequestSchema>;

export const REVOKE_COORDINATOR_REASONS = [
  'outage_over',
  'device_lost',
  'device_revoked',
  'no_longer_needed',
  'other',
] as const;
export const RevokeCoordinatorRequestSchema = z
  .object({ operation_id: UuidV7Schema, reason_code: z.enum(REVOKE_COORDINATOR_REASONS) })
  .strict();
export type RevokeCoordinatorRequest = z.infer<typeof RevokeCoordinatorRequestSchema>;

export const CoordinatorStatusSchema = z.object({
  /** Increments on every assignment, failover and revocation; 0 = never assigned */
  epoch: z.number().int().nonnegative(),
  device_id: UuidSchema.nullable(),
  device_label: z.string().nullable(),
  granted_at: IsoDateTimeSchema.nullable(),
  expires_at: IsoDateTimeSchema.nullable(),
  allowed_actions: z.array(z.string()),
  /** none: nobody holds authority · active: valid · expired: designated but past expiry */
  status: z.enum(['none', 'active', 'expired']),
});
export type CoordinatorStatus = z.infer<typeof CoordinatorStatusSchema>;

// ---------------------------------------------------------------------------
// Snapshot (GET /sync/queues/:id/snapshot)
// ---------------------------------------------------------------------------

export const SnapshotEventSchema = z.object({
  sequence: z.number().int().positive(),
  event_type: z.string(),
  /** Ids, codes and states only — queue_events never carry personal data */
  payload: z.record(z.string(), z.unknown()),
  committed_at: IsoDateTimeSchema,
});
export type SnapshotEvent = z.infer<typeof SnapshotEventSchema>;

export const SyncSnapshotSchema = z.object({
  queue: StaffQueueSchema,
  revision: z.number().int().nonnegative(),
  last_sequence: z.number().int().nonnegative(),
  events: z.array(SnapshotEventSchema),
  has_more_events: z.boolean(),
  coordinator: CoordinatorStatusSchema.extend({ is_this_device: z.boolean() }),
  /** Signed authority for the requesting device — present only if it is the active coordinator */
  authority: z.string().nullable(),
  open_conflicts: z.number().int().nonnegative(),
  /** Server clock at response time: lets the device compensate its own clock offset */
  server_time: IsoDateTimeSchema,
});
export type SyncSnapshot = z.infer<typeof SyncSnapshotSchema>;

// ---------------------------------------------------------------------------
// Conflict review
// ---------------------------------------------------------------------------

export const CONFLICT_RESOLUTION_REASONS = [
  'supervisor_accepted',
  'duplicate_of_online_action',
  'visitor_left',
  'data_entry_error',
  'policy_exception',
  'other',
] as const;

export const ResolveConflictRequestSchema = z
  .object({
    resolution: z.enum(['apply', 'dismiss']),
    reason_code: z.enum(CONFLICT_RESOLUTION_REASONS),
  })
  .strict();
export type ResolveConflictRequest = z.infer<typeof ResolveConflictRequestSchema>;

export const SyncConflictSchema = z.object({
  operation_id: UuidSchema,
  queue_id: UuidSchema,
  service_name: z.string(),
  action: z.string(),
  status: z.nativeEnum(CommandDisposition).or(z.literal('pending')),
  reason_code: z.string().nullable(),
  message: z.string().nullable(),
  device_id: UuidSchema.nullable(),
  device_label: z.string().nullable(),
  actor_name: z.string().nullable(),
  /** Diagnostic only — never used for ordering */
  client_created_at: z.string().nullable(),
  received_at: IsoDateTimeSchema,
  ticket_code: z.string().nullable(),
  temporary_ref: z.string().nullable(),
  resolution: z.enum(['applied', 'dismissed']).nullable(),
  resolution_reason_code: z.string().nullable(),
  resolved_by_name: z.string().nullable(),
  resolved_at: IsoDateTimeSchema.nullable(),
});
export type SyncConflict = z.infer<typeof SyncConflictSchema>;

// ---------------------------------------------------------------------------
// Connectivity and recovery dashboard (F9)
// ---------------------------------------------------------------------------

export const DEVICE_HEALTH_STATES = [
  'healthy',
  'pending',
  'offline',
  /** M5.3: no contact for the stale threshold (default 900 s); may be asleep, closed or lost */
  'stale',
  'needs_review',
  'revoked',
] as const;
export type DeviceHealthState = (typeof DEVICE_HEALTH_STATES)[number];

export const DeviceHealthSchema = z.object({
  id: UuidSchema,
  label: z.string().nullable(),
  owner_name: z.string(),
  last_seen_at: IsoDateTimeSchema.nullable(),
  last_sync_at: IsoDateTimeSchema.nullable(),
  /** Approximate: reported by the device, never authoritative */
  pending_count: z.number().int().nonnegative(),
  needs_review_count: z.number().int().nonnegative(),
  rejected_count: z.number().int().nonnegative(),
  health: z.enum(DEVICE_HEALTH_STATES),
  last_failure_code: z.string().nullable(),
  revoked_at: IsoDateTimeSchema.nullable(),
  /** M5.3: why it was revoked (for example `lost`); null while active */
  revoked_reason: z.string().nullable(),
  /** M5.3: the same failure code reported this many times in a row */
  failure_streak: z.number().int().nonnegative(),
  coordinator_for: z.array(
    z.object({
      queue_id: UuidSchema,
      service_name: z.string(),
      epoch: z.number().int().nonnegative(),
      expires_at: IsoDateTimeSchema,
      expired: z.boolean(),
      /** M5.3: ends within the warning window */
      expiring: z.boolean(),
    }),
  ),
});
export type DeviceHealth = z.infer<typeof DeviceHealthSchema>;

export const QueueHealthSchema = z.object({
  queue_id: UuidSchema,
  service_name: z.string(),
  state: z.string(),
  revision: z.number().int().nonnegative(),
  coordinator: CoordinatorStatusSchema,
  open_conflicts: z.number().int().nonnegative(),
});
export type QueueHealth = z.infer<typeof QueueHealthSchema>;

export const OperationsHealthSchema = z.object({
  server_time: IsoDateTimeSchema,
  /** A device not heard from for this long is shown as offline */
  offline_after_seconds: z.number().int().positive(),
  /** M5.3: a device not heard from for this long is shown as stale */
  stale_after_seconds: z.number().int().positive(),
  /** M5.3: coordinator authorization ending within this window is flagged */
  coordinator_expiry_warn_seconds: z.number().int().positive(),
  devices: z.array(DeviceHealthSchema),
  queues: z.array(QueueHealthSchema),
  open_conflicts: z.number().int().nonnegative(),
  /** M5.3: open and acknowledged alerts, plus those resolved in the last 24 hours */
  alerts: z.array(HealthAlertSchema),
  evaluation: AlertEvaluationSchema,
  /** M5.3 counters (server facts, counts only) */
  counters: z.object({
    /** Recovery-abuse signals at this facility in the last 24 hours */
    recovery_abuse_24h: z.number().int().nonnegative(),
    /** Failed turn alerts at this facility in the last hour (expired subscriptions excluded) */
    turn_alert_failures_1h: z.number().int().nonnegative(),
  }),
  /** M5.4: push turn-alert outcomes at this facility in the last hour */
  turn_alerts: TurnAlertCountersSchema,
});
export type OperationsHealth = z.infer<typeof OperationsHealthSchema>;
