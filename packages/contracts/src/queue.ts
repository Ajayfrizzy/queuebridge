import { z } from 'zod';
import { PriorityClass, QueueAction, QueueSessionState, TicketState } from './enums.js';
import { UuidSchema, UuidV7Schema, WaitEstimateSchema } from './schemas.js';

/**
 * M2 — online queue core DTOs.
 *
 * Request schemas are strict: tenant, actor and role are never accepted from the client.
 * Responses to visitors and public displays never include internal UUIDs of tickets,
 * staff or counters, and never include personal data.
 */

/** 256-bit URL-safe secret (base64url, 43 chars) — ticket status tokens and join proofs. */
export const SecretTokenSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid token format');

export const TicketCodeSchema = z
  .string()
  .min(2)
  .max(8)
  .regex(/^[A-Z]{1,3}[0-9]{3,4}$/, 'Invalid ticket code');

// ---------------------------------------------------------------------------
// Queue sessions
// ---------------------------------------------------------------------------

export const OpenQueueSessionRequestSchema = z.object({ service_id: UuidSchema }).strict();
export type OpenQueueSessionRequest = z.infer<typeof OpenQueueSessionRequestSchema>;

/** Online commands accepted by POST /queues/:id/commands (M2 scope). */
export const OnlineQueueActionSchema = z.enum([
  QueueAction.TICKET_CALL_NEXT,
  QueueAction.TICKET_SERVE,
  QueueAction.TICKET_COMPLETE,
  QueueAction.TICKET_PAUSE,
  QueueAction.TICKET_RESUME,
  QueueAction.TICKET_MISS,
  QueueAction.TICKET_CANCEL,
  QueueAction.TICKET_TRANSFER,
  QueueAction.QUEUE_OPEN,
  QueueAction.QUEUE_PAUSE,
  QueueAction.QUEUE_CLOSE,
]);
export type OnlineQueueAction = z.infer<typeof OnlineQueueActionSchema>;

export const QueueCommandRequestSchema = z
  .object({
    /** UUID v7 — idempotency key, deduplicated by (organization_id, operation_id) */
    operation_id: UuidV7Schema,
    action: OnlineQueueActionSchema,
    /** Target ticket (all ticket actions except call_next) */
    ticket_id: UuidSchema.optional(),
    /** Counter performing the action (required for call_next) */
    counter_id: UuidSchema.optional(),
    /** Destination service for ticket.transfer */
    destination_service_id: UuidSchema.optional(),
    /** Optional optimistic-concurrency check against the session revision */
    expected_revision: z.number().int().nonnegative().optional(),
    /**
     * Transfer reason. A fixed code, never free text: queue_events.payload must not carry
     * personal data, and free text cannot be guaranteed PII-free.
     */
    reason_code: z
      .enum(['wrong_service', 'needs_other_service', 'visitor_request', 'staff_judgement'])
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ticketActions: string[] = [
      QueueAction.TICKET_SERVE,
      QueueAction.TICKET_COMPLETE,
      QueueAction.TICKET_PAUSE,
      QueueAction.TICKET_RESUME,
      QueueAction.TICKET_MISS,
      QueueAction.TICKET_CANCEL,
      QueueAction.TICKET_TRANSFER,
    ];
    if (ticketActions.includes(v.action) && !v.ticket_id) {
      ctx.addIssue({ code: 'custom', path: ['ticket_id'], message: 'ticket_id is required' });
    }
    if (v.action === QueueAction.TICKET_CALL_NEXT && !v.counter_id) {
      ctx.addIssue({ code: 'custom', path: ['counter_id'], message: 'counter_id is required' });
    }
    if (v.action === QueueAction.TICKET_TRANSFER) {
      if (!v.destination_service_id) {
        ctx.addIssue({
          code: 'custom',
          path: ['destination_service_id'],
          message: 'destination_service_id is required',
        });
      }
      if (!v.reason_code) {
        ctx.addIssue({
          code: 'custom',
          path: ['reason_code'],
          message: 'A transfer reason is required',
        });
      }
    }
  });
export type QueueCommandRequest = z.infer<typeof QueueCommandRequestSchema>;

/**
 * Every action that can appear in a command outcome: the online command vocabulary plus the M4
 * supervisor/routing actions, which have their own dedicated endpoints.
 */
export const QueueCommandActionSchema = z.enum([
  ...OnlineQueueActionSchema.options,
  QueueAction.TICKET_PRIORITY_OVERRIDE,
  QueueAction.TICKET_CALL_SPECIFIC,
  QueueAction.TICKET_COUNTER_TRANSFER,
]);
export type QueueCommandAction = z.infer<typeof QueueCommandActionSchema>;

export const CommandOutcomeSchema = z.object({
  disposition: z.enum(['committed', 'duplicate', 'rejected']),
  operation_id: UuidSchema,
  action: QueueCommandActionSchema,
  server_revision: z.number().int().nonnegative(),
  server_sequence: z.number().int().nonnegative().nullable(),
  ticket_id: UuidSchema.nullable(),
  public_code: z.string().nullable(),
  /** Machine-readable reason for rejected commands */
  reason_code: z.string().nullable(),
  message: z.string().nullable(),
});
export type CommandOutcome = z.infer<typeof CommandOutcomeSchema>;

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

export const JoinQueueRequestSchema = z
  .object({
    /** UUID v7 generated and persisted by the client before sending (idempotency key) */
    operation_id: UuidV7Schema,
    /**
     * Client-generated 256-bit secret, persisted with operation_id. Only its hash is stored.
     * A retry after a lost response must present the same proof to recover the ticket.
     */
    join_proof: SecretTokenSchema,
  })
  .strict();
export type JoinQueueRequest = z.infer<typeof JoinQueueRequestSchema>;

export const WalkInRequestSchema = z.object({ operation_id: UuidV7Schema }).strict();
export type WalkInRequest = z.infer<typeof WalkInRequestSchema>;

export const JoinQueueResponseSchema = z.object({
  disposition: z.enum(['committed', 'duplicate']),
  public_code: TicketCodeSchema,
  /** Shown once. Holder can view this ticket's status. Stored server-side only as a hash. */
  status_token: SecretTokenSchema,
  status_path: z.string(),
  service_name: z.string(),
  facility_name: z.string(),
});
export type JoinQueueResponse = z.infer<typeof JoinQueueResponseSchema>;

// ---------------------------------------------------------------------------
// Visitor ticket status (token-protected, no internal IDs, no PII)
// ---------------------------------------------------------------------------

export const TicketStatusSchema = z.object({
  public_code: z.string(),
  facility_name: z.string(),
  service_name: z.string(),
  state: z.nativeEnum(TicketState),
  /** Always 'committed': visitor views only show server-confirmed state (REQ-F1.8) */
  sync_status: z.literal('committed'),
  queue_state: z.nativeEnum(QueueSessionState),
  /** Tickets ahead in the published order; null unless waiting */
  position: z.number().int().nonnegative().nullable(),
  counter_name: z.string().nullable(),
  joined_at: z.string(),
  updated_at: z.string(),
  status_message: z.string(),
  policy_summary: z.string(),
  estimate: WaitEstimateSchema.nullable(),
  /** Present when the visitor's original ticket was transferred */
  transferred_from_code: z.string().nullable(),
  revision: z.number().int().nonnegative(),
});
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

// ---------------------------------------------------------------------------
// Public facility catalog and display board
// ---------------------------------------------------------------------------

export const PublicQueueSchema = z.object({
  /** Queue session id (needed to join) */
  queue_id: UuidSchema,
  service_name: z.string(),
  description: z.string().nullable(),
  state: z.nativeEnum(QueueSessionState),
  waiting_count: z.number().int().nonnegative(),
  policy_summary: z.string(),
  estimate: WaitEstimateSchema.nullable(),
  accepting_visitors: z.boolean(),
});
export type PublicQueue = z.infer<typeof PublicQueueSchema>;

export const PublicFacilitySchema = z.object({
  organization_name: z.string(),
  facility_name: z.string(),
  queues: z.array(PublicQueueSchema),
});
export type PublicFacility = z.infer<typeof PublicFacilitySchema>;

/** Display board: ticket codes and counter names only (security steering). */
export const BoardSchema = z.object({
  facility_name: z.string(),
  updated_at: z.string(),
  services: z.array(
    z.object({
      service_name: z.string(),
      state: z.nativeEnum(QueueSessionState),
      now_calling: z.array(
        z.object({
          public_code: z.string(),
          counter_name: z.string(),
          state: z.enum([TicketState.CALLED, TicketState.SERVING]),
        }),
      ),
      next_codes: z.array(z.string()),
      waiting_count: z.number().int().nonnegative(),
    }),
  ),
});
export type Board = z.infer<typeof BoardSchema>;

// ---------------------------------------------------------------------------
// Staff queue view
// ---------------------------------------------------------------------------

export const StaffTicketSchema = z.object({
  id: UuidSchema,
  public_code: z.string(),
  state: z.nativeEnum(TicketState),
  priority_class: z.nativeEnum(PriorityClass),
  issued_sequence: z.number().int(),
  position: z.number().int().nonnegative().nullable(),
  counter_id: UuidSchema.nullable(),
  counter_name: z.string().nullable(),
  channel: z.enum(['web', 'staff', 'transfer']),
  joined_at: z.string(),
  /** The instant this ticket's place in line is measured from (waiting age) */
  wait_since: z.string(),
  called_at: z.string().nullable(),
  transferred_from_code: z.string().nullable(),
});
export type StaffTicket = z.infer<typeof StaffTicketSchema>;

export const StaffQueueSchema = z.object({
  id: UuidSchema,
  facility_id: UuidSchema,
  service_id: UuidSchema,
  service_name: z.string(),
  operational_date: z.string(),
  state: z.nativeEnum(QueueSessionState),
  revision: z.number().int().nonnegative(),
  last_sequence: z.number().int().nonnegative(),
  policy_summary: z.string(),
  tickets: z.array(StaffTicketSchema),
  counters: z.array(
    z.object({
      id: UuidSchema,
      name: z.string(),
      active: z.boolean(),
      /** Operational availability: a closed counter receives no new assignments */
      availability: z.enum(['open', 'closed']),
      busy_with_code: z.string().nullable(),
    }),
  ),
  /** The policy snapshot in force (classes, override reasons, transfer placement) */
  policy: z.object({
    version: z.string(),
    priority_order: z.array(z.nativeEnum(PriorityClass)),
    override_reasons: z.array(z.string()),
    transfer_placement: z.enum(['by_original_join_time', 'end_of_queue']),
  }),
  /** True when no active, open counter can serve this service right now */
  no_open_counter: z.boolean(),
  transfer_targets: z.array(z.object({ service_id: UuidSchema, service_name: z.string() })),
  estimate_for_new_visitor: WaitEstimateSchema.nullable(),
});
export type StaffQueue = z.infer<typeof StaffQueueSchema>;

export const FacilityQueueSummarySchema = z.object({
  service_id: UuidSchema,
  service_name: z.string(),
  service_status: z.enum(['active', 'inactive']),
  queue_id: UuidSchema.nullable(),
  state: z.nativeEnum(QueueSessionState).nullable(),
  waiting_count: z.number().int().nonnegative(),
  operational_date: z.string(),
});
export type FacilityQueueSummary = z.infer<typeof FacilityQueueSummarySchema>;
