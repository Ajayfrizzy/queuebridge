import { z } from 'zod';
import { OverrideReasonCodeSchema } from './admin.js';
import { PriorityClass } from './enums.js';
import { IsoDateTimeSchema, UuidSchema, UuidV7Schema } from './schemas.js';

/**
 * M4 — fairness, overrides, routing and audit DTOs.
 *
 * Free-text explanations are accepted ONLY on override requests and are stored only in the
 * access-controlled `priority_overrides` table; queue events carry their SHA-256, never the text.
 */

/** A supervisor's explanation for an override (REQ-F3.3, REQ-F5.5). Never shown publicly. */
export const OverrideReasonTextSchema = z
  .string()
  .trim()
  .min(5, 'Explain the override in at least 5 characters')
  .max(500);

// ---------------------------------------------------------------------------
// Priority override (supervisor)
// ---------------------------------------------------------------------------

export const PriorityOverrideRequestSchema = z
  .object({
    operation_id: UuidV7Schema,
    to_class: z.enum([PriorityClass.URGENT, PriorityClass.PRIORITY, PriorityClass.NORMAL]),
    reason_code: OverrideReasonCodeSchema,
    reason_text: OverrideReasonTextSchema,
  })
  .strict();
export type PriorityOverrideRequest = z.infer<typeof PriorityOverrideRequestSchema>;

// ---------------------------------------------------------------------------
// Routing override: call a specific ticket out of the published order (supervisor)
// ---------------------------------------------------------------------------

export const CallOutOfOrderRequestSchema = z
  .object({
    operation_id: UuidV7Schema,
    counter_id: UuidSchema,
    reason_code: OverrideReasonCodeSchema,
    reason_text: OverrideReasonTextSchema,
  })
  .strict();
export type CallOutOfOrderRequest = z.infer<typeof CallOutOfOrderRequestSchema>;

// ---------------------------------------------------------------------------
// Counter-to-counter transfer of a called/serving ticket (same service)
// ---------------------------------------------------------------------------

export const COUNTER_TRANSFER_REASONS = [
  'specialist_counter',
  'counter_closing',
  'visitor_request',
  'staff_judgement',
] as const;

export const CounterTransferRequestSchema = z
  .object({
    operation_id: UuidV7Schema,
    to_counter_id: UuidSchema,
    reason_code: z.enum(COUNTER_TRANSFER_REASONS),
  })
  .strict();
export type CounterTransferRequest = z.infer<typeof CounterTransferRequestSchema>;

// ---------------------------------------------------------------------------
// Counter availability (operational open/closed)
// ---------------------------------------------------------------------------

export const COUNTER_CLOSE_REASONS = [
  'break',
  'end_of_shift',
  'equipment_issue',
  'staff_reassigned',
  'other',
] as const;

export const CounterAvailabilityRequestSchema = z
  .object({
    availability: z.enum(['open', 'closed']),
    reason_code: z.enum(COUNTER_CLOSE_REASONS).optional(),
  })
  .strict()
  .refine((v) => v.availability === 'open' || v.reason_code !== undefined, {
    message: 'A reason is required to close a counter',
    path: ['reason_code'],
  });
export type CounterAvailabilityRequest = z.infer<typeof CounterAvailabilityRequestSchema>;

export const CounterAvailabilityResultSchema = z.object({
  counter_id: UuidSchema,
  availability: z.enum(['open', 'closed']),
  changed: z.boolean(),
  /** Called tickets returned to the head of their queue because the counter closed */
  released: z.array(z.object({ queue_id: UuidSchema, public_code: z.string() })),
  /** Services that now have no active, open counter */
  services_without_open_counter: z.array(z.object({ service_id: UuidSchema, name: z.string() })),
});
export type CounterAvailabilityResult = z.infer<typeof CounterAvailabilityResultSchema>;

// ---------------------------------------------------------------------------
// Policy history
// ---------------------------------------------------------------------------

export const PolicyVersionSchema = z.object({
  version: z.string(),
  version_number: z.number().int().positive(),
  policy: z.record(z.string(), z.unknown()),
  created_by_name: z.string().nullable(),
  created_at: IsoDateTimeSchema,
});
export type PolicyVersion = z.infer<typeof PolicyVersionSchema>;

// ---------------------------------------------------------------------------
// Audit view, export and verification (REQ-F8.3, F8.5, F8.6, F8.7)
// ---------------------------------------------------------------------------

export const AuditEventSchema = z.object({
  sequence: z.number().int().positive(),
  event_type: z.string(),
  committed_at: IsoDateTimeSchema,
  actor_id: UuidSchema.nullable(),
  /** Display name for the authenticated audit view; null in exports (redacted) */
  actor_name: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  prev_hash: z.string(),
  event_hash: z.string(),
  /** Override details (reason text only in the authenticated view; hash only in exports) */
  override: z
    .object({
      kind: z.enum(['priority', 'routing']),
      reason_code: z.string(),
      reason_text: z.string().nullable(),
      reason_text_sha256: z.string(),
      policy_version: z.string(),
    })
    .nullable(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuditPageSchema = z.object({
  queue_id: UuidSchema,
  service_name: z.string(),
  operational_date: z.string(),
  last_sequence: z.number().int().nonnegative(),
  events: z.array(AuditEventSchema),
  next_after_sequence: z.number().int().nonnegative().nullable(),
  summary: z.object({
    priority_overrides: z.number().int().nonnegative(),
    routing_overrides: z.number().int().nonnegative(),
    transfers: z.number().int().nonnegative(),
    sync_conflicts: z.number().int().nonnegative(),
  }),
});
export type AuditPage = z.infer<typeof AuditPageSchema>;

export const VerificationStatusSchema = z.enum(['verified', 'failed', 'incomplete']);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export const AuditVerificationSchema = z.object({
  queue_id: UuidSchema,
  /**
   * verified: nothing failed and every check that can be made was made (events after the last
   * signed checkpoint and pre-M4 calls without routing data are reported as counts, not hidden) ·
   * failed: at least one check failed ·
   * incomplete: no check failed but at least one could not be performed (never shown as success)
   */
  status: VerificationStatusSchema,
  verified_at: IsoDateTimeSchema,
  chain: z.object({
    valid: z.boolean(),
    events_checked: z.number().int().nonnegative(),
    head_hash: z.string().nullable(),
    broken_at_sequence: z.number().int().positive().nullable(),
    reason: z.string().nullable(),
  }),
  checkpoints: z.object({
    total: z.number().int().nonnegative(),
    valid: z.number().int().nonnegative(),
    invalid: z.array(
      z.object({
        from_sequence: z.number().int(),
        to_sequence: z.number().int(),
        reason: z.string(),
      }),
    ),
    unverifiable: z.number().int().nonnegative(),
    covered_to_sequence: z.number().int().nonnegative(),
    uncheckpointed_events: z.number().int().nonnegative(),
  }),
  replay: z.object({
    valid: z.boolean(),
    decisions_verified: z.number().int().nonnegative(),
    decisions_not_replayable: z.number().int().nonnegative(),
    mismatches: z.array(z.object({ sequence: z.number().int(), reason: z.string() })),
    error: z.string().nullable(),
  }),
  alerts: z.array(
    z.object({
      kind: z.string(),
      at_sequence: z.number().int().nullable(),
      reason: z.string(),
      detected_at: IsoDateTimeSchema,
    }),
  ),
  problems: z.array(z.string()),
});
export type AuditVerification = z.infer<typeof AuditVerificationSchema>;
