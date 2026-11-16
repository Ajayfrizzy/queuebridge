import { z } from 'zod';
import { SlugSchema } from './admin.js';
import { SecretTokenSchema, TicketCodeSchema } from './queue.js';
import { UuidV7Schema } from './schemas.js';

/**
 * M5.1 secure ticket recovery (REQ-F4.7–F4.15, design §15, ADR-015).
 *
 * Three different things identify or unlock a ticket, and they must never be confused:
 *  - the PUBLIC ticket code (`A012`): shown on boards and called aloud. An identifier, never a
 *    credential;
 *  - the STATUS TOKEN (256-bit): the bearer credential a device holds to read its ticket;
 *  - the RECOVERY KEY (160-bit, at least 128 required): issued once, privately, at join. Only
 *    exchangeable, together with the facility and ticket code, for a new status token.
 */

/** Crockford base32: digits and letters without I, L, O, U (unambiguous when read or spoken). */
export const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Entropy of a recovery key and of a staff grant. Never below the 128-bit project minimum. */
export const RECOVERY_KEY_BITS = 160;
/** 160 bits / 5 bits per base32 character. */
export const RECOVERY_KEY_LENGTH = RECOVERY_KEY_BITS / 5;
/** Characters per printed group: `XXXX-XXXX-…` (8 groups). */
export const RECOVERY_KEY_GROUP = 4;

/** Encode exactly 20 random bytes as 32 Crockford base32 characters (no padding). */
export function encodeRecoveryKey(bytes: Uint8Array): string {
  if (bytes.length * 8 !== RECOVERY_KEY_BITS) {
    throw new Error(`recovery key needs exactly ${RECOVERY_KEY_BITS / 8} random bytes`);
  }
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += RECOVERY_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}

/**
 * Normalize what a person typed, pasted or dictated: case-insensitive, spaces and hyphens
 * ignored, and the visually ambiguous characters folded (`I`/`L` → `1`, `O` → `0`). Returns the
 * canonical 32-character key, or null when it cannot be one (wrong length or a character that is
 * not in the alphabet, e.g. `U`). Normalization never weakens the key: it only maps inputs that
 * were unambiguous to begin with.
 */
export function normalizeRecoveryKey(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (s.length !== RECOVERY_KEY_LENGTH) return null;
  for (const ch of s) if (!RECOVERY_ALPHABET.includes(ch)) return null;
  return s;
}

/** `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX` for display, print and dictation. */
export function formatRecoveryKey(key: string): string {
  const groups: string[] = [];
  for (let i = 0; i < key.length; i += RECOVERY_KEY_GROUP) {
    groups.push(key.slice(i, i + RECOVERY_KEY_GROUP));
  }
  return groups.join('-');
}

/** A canonical recovery key or staff grant as it travels in a request body. */
export const RecoverySecretSchema = z
  .string()
  .length(RECOVERY_KEY_LENGTH)
  .regex(/^[0-9A-HJKMNP-TV-Z]+$/, 'Invalid recovery key format');

// ---------------------------------------------------------------------------
// Visitor recovery
// ---------------------------------------------------------------------------

/**
 * POST /tickets/recover. Either the recovery key with the PUBLIC identifiers of the ticket, or a
 * single-use grant from the staff procedure. Raw key input is accepted (and normalized by the
 * server) so that a typed key with spaces or hyphens works; its length is bounded.
 */
export const RecoverWithKeyRequestSchema = z
  .object({
    org_slug: SlugSchema,
    facility_slug: SlugSchema,
    ticket_code: TicketCodeSchema,
    recovery_key: z.string().min(1).max(80),
  })
  .strict();
export const RecoverWithGrantRequestSchema = z
  .object({ grant: z.string().min(1).max(80) })
  .strict();
export const RecoverTicketRequestSchema = z.union([
  RecoverWithKeyRequestSchema,
  RecoverWithGrantRequestSchema,
]);
export type RecoverTicketRequest = z.infer<typeof RecoverTicketRequestSchema>;

export const RecoveredTicketSchema = z.object({
  public_code: TicketCodeSchema,
  /** Shown once to the recovering device. Stored server-side only as a hash. */
  status_token: SecretTokenSchema,
  status_path: z.string(),
  service_name: z.string(),
  facility_name: z.string(),
});
export type RecoveredTicket = z.infer<typeof RecoveredTicketSchema>;

export const RecoveryKeyResponseSchema = z.object({
  recovery_key: RecoverySecretSchema,
  recovery_path: z.string(),
});
export type RecoveryKeyResponse = z.infer<typeof RecoveryKeyResponseSchema>;

export const RevokeOtherDevicesResponseSchema = z.object({
  revoked_tokens: z.number().int().nonnegative(),
  /** A new key (the old one stops working); null when recovery is not configured */
  recovery_key: RecoverySecretSchema.nullable(),
  recovery_path: z.string(),
});
export type RevokeOtherDevicesResponse = z.infer<typeof RevokeOtherDevicesResponseSchema>;

export const RejoinRequestSchema = z.object({ operation_id: UuidV7Schema }).strict();
export type RejoinRequest = z.infer<typeof RejoinRequestSchema>;

// ---------------------------------------------------------------------------
// Staff-assisted recovery (design §15.5a): a restricted procedure
// ---------------------------------------------------------------------------

export const RecoveryReasonCodeSchema = z.enum([
  'lost_device',
  'cleared_browser',
  'no_smartphone',
  'other',
]);
export type RecoveryReasonCode = z.infer<typeof RecoveryReasonCodeSchema>;

/**
 * The staff member records the outcome of the verification questions. Physical presence and the
 * public ticket code are NOT factors and cannot be submitted as such. `account_matches` is the
 * basic factor: the visitor stated the service and approximate join time (within 10 minutes)
 * BEFORE seeing them, and they match the ticket. The server-checked contact factor arrives with
 * M6 (consented contact data) and is not accepted yet.
 */
export const RecoveryAssistRequestSchema = z
  .object({
    reason_code: RecoveryReasonCodeSchema,
    account_matches: z.boolean(),
    /** The staff member confirms they asked the questions before revealing any detail */
    asked_before_revealing: z.literal(true),
  })
  .strict();
export type RecoveryAssistRequest = z.infer<typeof RecoveryAssistRequestSchema>;

export const RecoveryAssistResponseSchema = z.discriminatedUnion('outcome', [
  /** No verified factor: restricted assistance only, no credential of any kind is created */
  z.object({ outcome: z.literal('restricted_assistance') }),
  /** Basic factor: a second person must approve before the grant can be redeemed */
  z.object({
    outcome: z.literal('approval_required'),
    request_id: z.string().uuid(),
    /** Single-use, 10 minutes, unusable until approved. Shown to the visitor's device as a QR */
    grant: RecoverySecretSchema,
    expires_at: z.string(),
  }),
]);
export type RecoveryAssistResponse = z.infer<typeof RecoveryAssistResponseSchema>;

export const RecoveryApproveRequestSchema = z.object({ request_id: z.string().uuid() }).strict();
export type RecoveryApproveRequest = z.infer<typeof RecoveryApproveRequestSchema>;

export const RecoveryRevokeAllRequestSchema = z
  .object({ reason_code: z.enum(['lost_device', 'stolen_device', 'visitor_request', 'other']) })
  .strict();
export type RecoveryRevokeAllRequest = z.infer<typeof RecoveryRevokeAllRequestSchema>;

export const RecoveryRequestStatusSchema = z.enum(['pending', 'approved', 'redeemed', 'expired']);
export type RecoveryRequestStatus = z.infer<typeof RecoveryRequestStatusSchema>;

/** A pending staff recovery request as shown to possible approvers (no secret, no PII). */
export const RecoveryRequestSummarySchema = z.object({
  request_id: z.string().uuid(),
  ticket_id: z.string().uuid(),
  public_code: z.string(),
  service_name: z.string(),
  reason_code: RecoveryReasonCodeSchema,
  requested_by_name: z.string(),
  requested_by_me: z.boolean(),
  status: RecoveryRequestStatusSchema,
  created_at: z.string(),
  expires_at: z.string(),
});
export type RecoveryRequestSummary = z.infer<typeof RecoveryRequestSummarySchema>;

// ---------------------------------------------------------------------------
// Recovery activity audit view (design §15.9a; ADR-015 amendment 1). Read-only. Never carries a
// key, grant, token, hash, link, staff email or staff id.
// ---------------------------------------------------------------------------

export const RecoveryAuditQuerySchema = z
  .object({
    /** Opaque cursor: `next_after` of the previous page */
    after: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type RecoveryAuditQuery = z.infer<typeof RecoveryAuditQuerySchema>;

export const RecoveryAuditKindSchema = z.enum([
  'request', // staff asked for a grant (basic assurance, approval required)
  'restricted_assistance', // staff could not verify the visitor: no credential
  'approval', // a different supervisor or admin approved a request
  'recovered', // the visitor's device opened the ticket (key or staff grant)
  'key_regenerated', // the visitor made a new recovery key
  'sessions_revoked', // the visitor signed out their other devices
  'access_ended', // staff ended access on all of the ticket's devices
  'abuse_detected', // many failed attempts for this ticket
]);
export type RecoveryAuditKind = z.infer<typeof RecoveryAuditKindSchema>;

export const RecoveryAuditActorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('staff'),
    /** The account's CURRENT display name, resolved from the event's immutable actor id */
    name: z.string(),
    account_status: z.enum(['active', 'inactive', 'suspended']),
  }),
  z.object({ kind: z.literal('visitor_device') }),
  z.object({ kind: z.literal('system') }),
  /** The event has no recorded actor: shown as such, never guessed */
  z.object({ kind: z.literal('not_recorded') }),
]);
export type RecoveryAuditActor = z.infer<typeof RecoveryAuditActorSchema>;

export const RecoveryAuditEntrySchema = z.object({
  at: z.string().datetime(),
  ticket_code: z.string(),
  kind: RecoveryAuditKindSchema,
  performed_by: RecoveryAuditActorSchema,
  reason_code: RecoveryReasonCodeSchema.nullable(),
  assurance: z.enum(['basic']).nullable(),
  method: z.enum(['recovery_key', 'staff_grant']).nullable(),
  /** Number of devices whose access ended, where the event recorded it */
  revoked_devices: z.number().int().nonnegative().nullable(),
});
export type RecoveryAuditEntry = z.infer<typeof RecoveryAuditEntrySchema>;

export const RecoveryAuditPageSchema = z.object({
  entries: z.array(RecoveryAuditEntrySchema),
  /** Pass as `after` for the next page; null on the last page */
  next_after: z.string().uuid().nullable(),
});
export type RecoveryAuditPage = z.infer<typeof RecoveryAuditPageSchema>;

// ---------------------------------------------------------------------------
// Service policy fields (versioned with the policy, ADR-012)
// ---------------------------------------------------------------------------

export const RejoinPolicySchema = z.enum(['staff_resume', 'self_resume']);
export type RejoinPolicy = z.infer<typeof RejoinPolicySchema>;

/** Automatic no-show: off by default; when on, the call-response time must be given explicitly. */
export const AutoMissPolicySchema = z
  .object({
    enabled: z.boolean(),
    after_seconds: z.number().int().min(60).max(3600).optional(),
  })
  .strict()
  .refine((v) => !v.enabled || v.after_seconds !== undefined, {
    message: 'Enter the number of seconds before an unanswered call is marked missed',
    path: ['after_seconds'],
  });
export type AutoMissPolicy = z.infer<typeof AutoMissPolicySchema>;

/** Recovery-related policy values with their defaults (policies stored before M5.1 lack them). */
export interface RecoveryPolicy {
  rejoin_policy: RejoinPolicy;
  auto_miss: { enabled: boolean; after_seconds: number | null };
  staff_recovery: boolean;
}
export function recoveryPolicyOf(policy: {
  rejoin_policy?: RejoinPolicy | undefined;
  auto_miss?: { enabled: boolean; after_seconds?: number | undefined } | undefined;
  staff_recovery?: boolean | undefined;
}): RecoveryPolicy {
  const am = policy.auto_miss;
  return {
    rejoin_policy: policy.rejoin_policy ?? 'staff_resume',
    auto_miss:
      am && am.enabled && typeof am.after_seconds === 'number'
        ? { enabled: true, after_seconds: am.after_seconds }
        : { enabled: false, after_seconds: null },
    staff_recovery: policy.staff_recovery ?? true,
  };
}
