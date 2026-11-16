import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from './schemas.js';

/**
 * M5.4 Smart Turn Alerts (REQ-F14, design §12, ADR-013).
 *
 * Identity: a push subscription's server-minted, random, NON-SECRET id is the
 * `subscription_id` / `subscription_ref` / `pushRef`. It grants nothing by itself: every
 * endpoint that accepts it also requires the ticket's status token. It is the only identifier
 * used in a notification tag, push Topic, click destination and deduplication key.
 *
 * Secrets: the push endpoint URL and its keys are capability material. They are accepted once,
 * stored encrypted, used only by the worker's send step, and never returned, logged or placed in
 * a payload, URL, tag or key.
 */

/** Accepted defaults (design §12.12); both are configurable per deployment. */
export const TURN_ALERT_DEFAULTS = Object.freeze({
  ttlSeconds: 120,
  maxSubscriptionsPerTicket: 3,
  maxAttempts: 3,
  /** a subscription lives at most as long as a status token */
  subscriptionLifetimeHours: 24,
});

export const TURN_ALERT_TEMPLATE = 'ticket.called' as const;

/** Honest per-device delivery states (design §12.6). `sent` never implies `delivered`. */
export const ALERT_DELIVERY_STATES = [
  'pending',
  'sent',
  'delivered',
  'failed',
  'suppressed',
  'unknown',
] as const;
export type AlertDeliveryState = (typeof ALERT_DELIVERY_STATES)[number];

export const ALERT_DETAIL_CODES = [
  'accepted',
  'client_ack',
  'gone',
  'ttl_elapsed',
  'retries_exhausted',
  'ticket_changed',
  'subscription_revoked',
  'error',
] as const;
export type AlertDetailCode = (typeof ALERT_DETAIL_CODES)[number];

export const PushCapabilitySchema = z.object({
  web_push: z.enum(['live', 'disabled']),
  /** VAPID application server key (base64url, public by definition); only when live */
  public_key: z.string().optional(),
  ttl_seconds: z.number().int().positive(),
  max_subscriptions_per_ticket: z.number().int().positive(),
});
export type PushCapability = z.infer<typeof PushCapabilitySchema>;

const b64url = z.string().regex(/^[A-Za-z0-9_-]+=*$/, 'Must be base64url');

/**
 * What `PushSubscription.toJSON()` gives the page. Strict: nothing else is accepted (no device
 * description, no user agent). The endpoint is validated further by the server (HTTPS, known
 * push-service host, no credentials or IP literals).
 */
export const PushSubscribeRequestSchema = z
  .object({
    endpoint: z.string().url().max(2048),
    expirationTime: z.number().nullable().optional(),
    keys: z
      .object({
        p256dh: b64url.min(80).max(100),
        auth: b64url.min(16).max(32),
      })
      .strict(),
  })
  .strict();
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequestSchema>;

export const PushSubscribeResponseSchema = z.object({
  subscription_ref: UuidSchema,
  expires_at: IsoDateTimeSchema,
});
export type PushSubscribeResponse = z.infer<typeof PushSubscribeResponseSchema>;

export const PushUnsubscribeRequestSchema = z.object({ subscription_ref: UuidSchema }).strict();
export type PushUnsubscribeRequest = z.infer<typeof PushUnsubscribeRequestSchema>;

/** First-party acknowledgement sent by the visitor's PAGE (it holds the status token). */
export const AlertAckRequestSchema = z
  .object({
    subscription_ref: UuidSchema,
    event_sequence: z.number().int().positive(),
  })
  .strict();
export type AlertAckRequest = z.infer<typeof AlertAckRequestSchema>;

/**
 * The push payload (v2). Exactly these fields: type, the non-secret reference, the public
 * ticket code, the counter label, the committed call sequence, a public recovery path and a
 * timestamp. Strict, so the worker cannot accidentally add anything else.
 */
export const TurnAlertPayloadSchema = z
  .object({
    v: z.literal(2),
    type: z.literal(TURN_ALERT_TEMPLATE),
    ref: UuidSchema,
    code: z.string().min(1).max(16),
    counter: z.string().max(120),
    seq: z.number().int().positive(),
    rp: z.string().regex(/^\/recover\/[^/?#]+\/[^/?#]+\/[^/?#]+$/),
    ts: IsoDateTimeSchema,
  })
  .strict();
export type TurnAlertPayload = z.infer<typeof TurnAlertPayloadSchema>;

/** Staff view of alerts for a called ticket (per device), in plain codes only. */
export const StaffTicketAlertsSchema = z.object({
  ticket_id: UuidSchema,
  public_code: z.string(),
  devices: z.array(
    z.object({
      subscription_ref: UuidSchema,
      state: z.enum(ALERT_DELIVERY_STATES),
      detail_code: z.string().nullable(),
      updated_at: IsoDateTimeSchema,
    }),
  ),
});
export type StaffTicketAlerts = z.infer<typeof StaffTicketAlertsSchema>;

/** Aggregate last-hour counters for a facility (no personal data). */
export const TurnAlertCountersSchema = z.object({
  attempted: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  suppressed: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  /**
   * Alert enqueue errors swallowed by the savepoint in the last hour at this facility, as seen by
   * the API instance that answered (in-process count; each instance counts its own).
   */
  enqueue_errors: z.number().int().nonnegative(),
});
export type TurnAlertCounters = z.infer<typeof TurnAlertCountersSchema>;

/** Notification tag and click destination: derived from the subscription, never the code alone. */
export const turnAlertTag = (ref: string): string => `qb-call-${ref}`;
export const turnAlertPath = (code: string, ref: string): string =>
  `/ticket/${encodeURIComponent(code)}?ref=${encodeURIComponent(ref)}`;
/** Push `Topic` header: the subscription id without hyphens (32 hex characters, non-secret). */
export const turnAlertTopic = (ref: string): string => ref.replace(/-/g, '');
