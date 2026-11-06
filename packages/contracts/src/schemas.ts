import { z } from 'zod';
import {
  CommandDisposition,
  DeliveryStatus,
  NotificationChannel,
  PriorityClass,
  QueueAction,
  QueueSessionState,
  Role,
  SyncStatus,
  TicketState,
} from './enums.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** UUID v7 pattern — time-ordered UUIDs for operation IDs and entity PKs. */
const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const UuidV7Schema = z.string().regex(uuidV7Pattern, 'Must be a UUID v7 (time-ordered)');

/** Generic UUID (v4 or v7) */
export const UuidSchema = z.string().uuid();

/** ISO 8601 datetime string */
export const IsoDateTimeSchema = z.string().datetime({ offset: true });

// ---------------------------------------------------------------------------
// Command envelope — sent by every client command (online and offline)
// ---------------------------------------------------------------------------

/**
 * Offline/online command envelope.
 * Client timestamps are diagnostic only — server never uses them for ordering.
 * Authorization identity is derived from the authenticated session, not the payload.
 */
export const CommandEnvelopeSchema = z.object({
  /** UUID v7 — deduplication key: (organization_id, operation_id) */
  operation_id: UuidV7Schema,
  organization_id: UuidSchema,
  facility_id: UuidSchema,
  queue_session_id: UuidSchema,
  device_id: UuidSchema,
  /** Actor derived server-side from session; included here as a diagnostic hint only */
  actor_id: UuidSchema,
  /** Coordinator epoch from the device's signed authorization */
  coordinator_epoch: z.number().int().nonnegative(),
  /** Queue session revision the client believes is current */
  base_revision: z.number().int().nonnegative(),
  /** Client-side sequence within this device's current batch */
  client_sequence: z.number().int().nonnegative(),
  action: z.nativeEnum(QueueAction),
  payload: z.record(z.string(), z.unknown()),
  /** Diagnostic only — never used for global ordering */
  created_at_client: IsoDateTimeSchema,
  schema_version: z.literal(1),
});

export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Sync batch
// ---------------------------------------------------------------------------

export const SyncBatchRequestSchema = z.object({
  commands: z.array(CommandEnvelopeSchema).min(1).max(100),
});
export type SyncBatchRequest = z.infer<typeof SyncBatchRequestSchema>;

export const CommandResultSchema = z.object({
  operation_id: UuidSchema,
  client_sequence: z.number().int().nonnegative(),
  disposition: z.nativeEnum(CommandDisposition),
  /** Server revision after this command was applied (only set for committed) */
  server_revision: z.number().int().nonnegative().optional(),
  /** Server sequence assigned (only set for committed) */
  server_sequence: z.number().int().nonnegative().optional(),
  /** Temporary ticket ref → final public code mapping (for ticket.create) */
  ticket_mapping: z
    .object({
      temporary_ref: z.string(),
      public_code: z.string(),
    })
    .optional(),
  rejection_reason: z.string().optional(),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

export const SyncBatchResponseSchema = z.object({
  results: z.array(CommandResultSchema),
  queue_session_revision: z.number().int().nonnegative(),
  processed_at: IsoDateTimeSchema,
});
export type SyncBatchResponse = z.infer<typeof SyncBatchResponseSchema>;

// ---------------------------------------------------------------------------
// Ticket
// ---------------------------------------------------------------------------

export const TicketSchema = z.object({
  id: UuidSchema,
  queue_session_id: UuidSchema,
  public_code: z.string().min(1).max(20),
  /** Set while provisional — cleared after server confirms */
  provisional_source_op_id: UuidV7Schema.nullable(),
  state: z.nativeEnum(TicketState),
  priority_class: z.nativeEnum(PriorityClass),
  issued_sequence: z.number().int().nonnegative(),
  current_counter_id: UuidSchema.nullable(),
  version: z.number().int().nonnegative(),
  sync_status: z.nativeEnum(SyncStatus),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type Ticket = z.infer<typeof TicketSchema>;

// ---------------------------------------------------------------------------
// Queue session
// ---------------------------------------------------------------------------

export const QueueSessionSchema = z.object({
  id: UuidSchema,
  facility_id: UuidSchema,
  service_id: UuidSchema,
  operational_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  state: z.nativeEnum(QueueSessionState),
  revision: z.number().int().nonnegative(),
  last_sequence: z.number().int().nonnegative(),
  coordinator_epoch: z.number().int().nonnegative(),
  coordinator_device_id: UuidSchema.nullable(),
  created_at: IsoDateTimeSchema,
});
export type QueueSession = z.infer<typeof QueueSessionSchema>;

// ---------------------------------------------------------------------------
// Queue event (append-only)
// ---------------------------------------------------------------------------

export const QueueEventSchema = z.object({
  id: UuidSchema,
  organization_id: UuidSchema,
  queue_session_id: UuidSchema,
  /** Monotonically increasing, unique per queue session */
  sequence: z.number().int().positive(),
  actor_id: UuidSchema.nullable(),
  operation_id: UuidV7Schema.nullable(),
  event_type: z.nativeEnum(QueueAction),
  payload: z.record(z.string(), z.unknown()),
  /** SHA-256 hash of previous event (genesis: SHA-256 of domain separator) */
  prev_hash: z.string().length(64),
  /** SHA-256 hash: domain_separator || queue_session_id || sequence || prev_hash || canonical_json */
  event_hash: z.string().length(64),
  committed_at: IsoDateTimeSchema,
});
export type QueueEvent = z.infer<typeof QueueEventSchema>;

// ---------------------------------------------------------------------------
// Audit checkpoint
// ---------------------------------------------------------------------------

export const AuditCheckpointSchema = z.object({
  id: UuidSchema,
  queue_session_id: UuidSchema,
  from_sequence: z.number().int().positive(),
  to_sequence: z.number().int().positive(),
  /** SHA-256 of all event hashes in range concatenated */
  root_hash: z.string().length(64),
  /** Identifies the signing key; key itself is never stored here */
  key_id: z.string().min(1),
  /** Signature over root_hash using key_id */
  signature: z.string().min(1),
  created_at: IsoDateTimeSchema,
});
export type AuditCheckpoint = z.infer<typeof AuditCheckpointSchema>;

// ---------------------------------------------------------------------------
// Wait-time estimate
// ---------------------------------------------------------------------------

export const WaitEstimateSchema = z.object({
  low_seconds: z.number().int().nonnegative(),
  high_seconds: z.number().int().nonnegative(),
  confidence: z.enum(['high', 'medium', 'low', 'insufficient_data']),
  /** Human-readable factors driving this estimate */
  factors: z.array(z.string()),
  calculated_at: IsoDateTimeSchema,
  sample_size: z.number().int().nonnegative(),
});
export type WaitEstimate = z.infer<typeof WaitEstimateSchema>;

// ---------------------------------------------------------------------------
// API error (RFC 9457 problem detail)
// ---------------------------------------------------------------------------

export const ApiErrorSchema = z.object({
  type: z.string().url().optional(),
  title: z.string().min(1),
  status: z.number().int().min(100).max(599),
  detail: z.string().optional(),
  /** Correlation ID / trace ID */
  instance: z.string().optional(),
  /** Whether the caller should retry */
  retryable: z.boolean().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------------------
// Channel / notification schemas
// ---------------------------------------------------------------------------

export const SendMessageParamsSchema = z.object({
  to: z.string().min(1),
  template_key: z.string().min(1),
  params: z.record(z.string(), z.string()),
  idempotency_key: z.string().min(1),
  /** True if this is a sandbox/test send — never make real network calls in this mode */
  sandbox: z.boolean(),
});
export type SendMessageParams = z.infer<typeof SendMessageParamsSchema>;

export const SendResultSchema = z.object({
  provider_message_id: z.string().optional(),
  status: z.nativeEnum(DeliveryStatus),
  sandbox: z.boolean(),
});
export type SendResult = z.infer<typeof SendResultSchema>;

export const DeliveryReceiptSchema = z.object({
  provider_message_id: z.string().min(1),
  status: z.nativeEnum(DeliveryStatus),
  raw_status: z.string().optional(),
  recorded_at: IsoDateTimeSchema,
});
export type DeliveryReceipt = z.infer<typeof DeliveryReceiptSchema>;

export const InboundMessageSchema = z.object({
  from: z.string().min(1),
  body: z.string(),
  provider_message_id: z.string().min(1),
  received_at: IsoDateTimeSchema,
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export const UssdSessionParamsSchema = z.object({
  /** Hashed provider session key — never store raw */
  session_key_hash: z.string().min(1),
  /** Subscriber MSISDN */
  msisdn: z.string().min(1),
  /** User's menu input (empty for first request) */
  input: z.string(),
  facility_id: UuidSchema.optional(),
  /** Current USSD session state stored server-side */
  session_state: z.record(z.string(), z.unknown()).optional(),
});
export type UssdSessionParams = z.infer<typeof UssdSessionParamsSchema>;

export const UssdResponseSchema = z.object({
  /** Text to display to the user */
  message: z.string().max(182),
  /** Whether the session should continue (CON) or end (END) */
  action: z.enum(['CON', 'END']),
  /** Updated session state to persist server-side */
  next_state: z.record(z.string(), z.unknown()).optional(),
});
export type UssdResponse = z.infer<typeof UssdResponseSchema>;

// ---------------------------------------------------------------------------
// Coordinator authorization token (issued by supervisor)
// ---------------------------------------------------------------------------

export const CoordinatorAuthSchema = z.object({
  device_id: UuidSchema,
  facility_id: UuidSchema,
  queue_session_id: UuidSchema,
  /** Monotonically increasing per queue session — fences stale coordinators */
  epoch: z.number().int().positive(),
  allowed_actions: z.array(z.nativeEnum(QueueAction)),
  issued_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
  /** Role that issued this authorization */
  issued_by_role: z.enum([Role.SUPERVISOR, Role.FACILITY_ADMIN]),
  issued_by_actor_id: UuidSchema,
});
export type CoordinatorAuth = z.infer<typeof CoordinatorAuthSchema>;

// ---------------------------------------------------------------------------
// Notification channel configuration (per facility)
// ---------------------------------------------------------------------------

export const ChannelConfigSchema = z.object({
  facility_id: UuidSchema,
  channel: z.nativeEnum(NotificationChannel),
  enabled: z.boolean(),
  /** 'sandbox' means test mode — must be labeled clearly in UI and logs */
  mode: z.enum(['sandbox', 'live']),
  provider: z.string().optional(),
});
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
