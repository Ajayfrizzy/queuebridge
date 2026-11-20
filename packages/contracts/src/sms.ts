import { z } from 'zod';
import { IsoDateTimeSchema } from './schemas.js';

/**
 * M6.1 SMS turn alerts (REQ-F11.1–F11.13, design §13, ADR-009, ADR-013).
 *
 * A phone number is optional at joining and is used only for the purpose the visitor agreed to
 * (`SMS_CONSENT_TEXT`). It is validated and normalized on the server, stored only as ciphertext,
 * and never appears in queue events, outbox payloads, logs, the browser outbox or local storage.
 */

/** Version of the consent text the visitor ticks (stored with the contact). */
export const SMS_CONSENT_VERSION = 'sms-consent-v1' as const;

/** Purpose statement shown next to the unticked consent box (design §13.2). */
export const SMS_CONSENT_TEXT =
  'Send me a text message when I am called. My number is used only for this ticket and is ' +
  'deleted when my visit ends. I can stop the messages at any time.';

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

/** Longest raw input accepted before normalization (spaces and separators included). */
export const PHONE_INPUT_MAX = 32;

/**
 * Normalize a phone number to E.164 (`+` and 8–15 digits), or `null` when it is not one.
 *
 * Accepted: international numbers starting with `+` or `00`, and Nigerian national mobile
 * numbers (`0` then 10 digits, prefix 70, 80, 81, 90 or 91) which become `+234…`. Spaces,
 * hyphens, dots and parentheses are ignored. Anything else (letters, short codes, a number
 * without a country) is refused rather than guessed.
 */
export function normalizePhoneNumber(input: string): string | null {
  if (typeof input !== 'string' || input.length > PHONE_INPUT_MAX) return null;
  const compact = input.trim().replace(/[\s().-]/g, '');
  let digits: string;
  if (/^\+\d+$/.test(compact)) digits = compact.slice(1);
  else if (/^00\d+$/.test(compact)) digits = compact.slice(2);
  else if (/^0(70|80|81|90|91)\d{8}$/.test(compact)) digits = `234${compact.slice(1)}`;
  else return null;
  // E.164: country code never starts with 0; 8–15 digits in total
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  // Nigerian numbers: +234 followed by a 10-digit national number without its leading 0
  if (digits.startsWith('234') && !/^234[7-9][01]\d{8}$/.test(digits)) return null;
  return `+${digits}`;
}

/** Last two digits only, for staff and visitor confirmation ("ending in 67"); never logged. */
export function phoneHint(e164: string): string {
  return e164.slice(-2);
}

/** Opt-in sent with a join request (separate from joining: the join never requires it). */
export const SmsJoinOptInSchema = z
  .object({
    phone: z.string().min(1).max(PHONE_INPUT_MAX),
    /** The visitor ticked the separate, initially unticked consent box */
    consent: z.literal(true),
    consent_version: z.literal(SMS_CONSENT_VERSION),
  })
  .strict();
export type SmsJoinOptIn = z.infer<typeof SmsJoinOptInSchema>;

/**
 * Result of the opt-in for this join: `on` (the alert will be attempted), `not_available` (SMS is
 * not offered for this facility now; the join itself succeeded), or `null` when none was asked.
 */
export const SmsJoinResultSchema = z.enum(['on', 'not_available']).nullable();
export type SmsJoinResult = z.infer<typeof SmsJoinResultSchema>;

/** What the visitor's ticket page shows: `on`, `off` (opted out) or `null` (no number given). */
export const SmsAlertStateSchema = z.enum(['on', 'off']).nullable();
export type SmsAlertState = z.infer<typeof SmsAlertStateSchema>;

// ---------------------------------------------------------------------------
// Templates (REQ-F11.1) and idempotency keys (REQ-F11.5, design §13.1)
// ---------------------------------------------------------------------------

/**
 * The five SMS notification types of REQ-F11.1. Only `ticket.called` is SENT in M6.1: the consent
 * text states that purpose (design §13.2), and the other four need their own consent wording and
 * trigger thresholds before they are enqueued (recorded as an open decision in the M6 evidence).
 */
export const SMS_TEMPLATES = [
  'ticket.joined',
  'ticket.nearing',
  'ticket.called',
  'ticket.delayed',
  'ticket.missed',
] as const;
export type SmsTemplate = (typeof SMS_TEMPLATES)[number];
export const SmsTemplateSchema = z.enum(SMS_TEMPLATES);
/** The SMS turn alert (REQ-F11.8). */
export const SMS_TURN_ALERT_TEMPLATE = 'ticket.called' as const satisfies SmsTemplate;
/**
 * The ONLY active SMS templates: the ones the approved consent text covers (`SMS_CONSENT_TEXT`
 * states this purpose). The API enqueues nothing else and the worker refuses to send anything
 * else.
 */
export const SMS_SENT_TEMPLATES: readonly SmsTemplate[] = [SMS_TURN_ALERT_TEMPLATE];
/**
 * Inactive definitions (wording only): never enqueued or sent. Activating one needs approved
 * purpose-specific consent wording and trigger rules first (open product decision, M6 evidence).
 */
export const SMS_INACTIVE_TEMPLATES: readonly SmsTemplate[] = SMS_TEMPLATES.filter(
  (t) => !SMS_SENT_TEMPLATES.includes(t),
);

/**
 * `sms:<template>:<ticket_id>:<event_sequence>`. A ticket has at most one consented contact, so
 * the key identifies one recipient (design §13.1); it is also the provider idempotency key.
 */
export function smsIdempotencyKey(
  template: SmsTemplate,
  ticketId: string,
  sequence: number,
): string {
  return `sms:${template}:${ticketId}:${sequence}`;
}

// ---------------------------------------------------------------------------
// Delivery states (design §12.6 vocabulary, shared with push)
// ---------------------------------------------------------------------------

/**
 * Outcome details recorded for SMS. `accepted` means the provider (or the sandbox) took the
 * message; it is never delivery. `delivered` is recorded only from an authenticated receipt.
 */
export const SMS_DETAIL_CODES = [
  'accepted',
  'receipt',
  'sandbox_receipt',
  'cap',
  'rejected',
  'retries_exhausted',
  'ttl_elapsed',
  'interrupted',
  'error',
  'invalid_payload',
  'ticket_changed',
  'opted_out',
  'contact_removed',
  'sms_disabled',
  'sms_unavailable',
] as const;
export type SmsDetailCode = (typeof SMS_DETAIL_CODES)[number];

/** Staff view of the SMS alert for a called ticket (no number, no message text). */
export const StaffSmsAlertSchema = z.object({
  state: z.enum(['pending', 'sent', 'delivered', 'failed', 'suppressed', 'unknown']),
  detail_code: z.string().nullable(),
  /** The message went through the TEST-ONLY sandbox: nothing reached a phone */
  sandbox: z.boolean(),
  updated_at: IsoDateTimeSchema,
});
export type StaffSmsAlert = z.infer<typeof StaffSmsAlertSchema>;

// ---------------------------------------------------------------------------
// Facility setting (API only in M6.1; the channel screen is M6.3)
// ---------------------------------------------------------------------------

export const SMS_FACILITY_CAP_MAX = 100_000;

export const FacilitySmsSettingsUpdateSchema = z
  .object({
    enabled: z.boolean(),
    /** Messages per UTC day for this facility; required (≥ 1) to turn SMS on */
    daily_cap: z.number().int().min(0).max(SMS_FACILITY_CAP_MAX),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.enabled && v.daily_cap < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['daily_cap'],
        message: 'a daily cap of at least 1 is required',
      });
    }
  });
export type FacilitySmsSettingsUpdate = z.infer<typeof FacilitySmsSettingsUpdateSchema>;

export const FacilitySmsSettingsSchema = z.object({
  enabled: z.boolean(),
  daily_cap: z.number().int().min(0),
  /** The deployment can send (sandbox or an approved live provider) */
  deployment_available: z.boolean(),
  /** `sandbox` (TEST-ONLY, no real messages) or `off`; `live` only with an approved provider */
  deployment_mode: z.enum(['off', 'sandbox', 'live']),
  /** Deployment-wide messages per UTC day (0 = sending off) */
  deployment_daily_cap: z.number().int().min(0),
  /** Messages handed to the provider today (UTC), in this deployment's mode */
  sent_today: z.object({ facility: z.number().int().min(0), deployment: z.number().int().min(0) }),
});
export type FacilitySmsSettings = z.infer<typeof FacilitySmsSettingsSchema>;
