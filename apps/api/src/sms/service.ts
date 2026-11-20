import {
  createContactCipher,
  createSmsAdapter,
  isStopKeyword,
  type ContactCipher,
  type SmsAdapter,
} from '@queuebridge/channels';
import {
  DeliveryStatus,
  normalizePhoneNumber,
  type DeliveryReceipt,
  type FacilitySmsSettings,
  type SmsAlertState,
  type SmsJoinResult,
} from '@queuebridge/contracts';
import { recordAdminEvent } from '../admin-events.js';
import type { Db } from '../db.js';
import type { Env } from '../env.js';

/**
 * M6.1 SMS turn alerts, API side (design §13; REQ-F11.8–F11.13). The API stores the consented
 * contact, offers and applies opt-out, verifies and applies provider receipts and inbound STOP
 * replies, and reports settings. It never sends: the worker does (ADR-013).
 *
 * Privacy: the number is validated and normalized here, then exists only as ciphertext and a
 * keyed lookup hash in `visitor_contacts`. Nothing in this module logs, returns or audits a
 * number, a hash or a message text.
 */

/**
 * `retention_until`, set on creation: the hard upper bound for a contact row (7 days after
 * joining). It is a backstop for queue sessions nobody closed, never the normal path, and it is
 * far longer than any real visit, so it cannot cut an active visit's consent short. Normally the
 * number is erased as soon as the visit ends or the visitor opts out, and the row (consent and
 * opt-out record, no number) is deleted 24 hours later (worker `purgeSmsData`).
 */
export const SMS_CONTACT_MAX_RETENTION_HOURS = 168;

export interface SmsDeployment {
  mode: 'off' | 'sandbox';
  /** SMS can be offered: a provider, the contact cipher and a positive daily cap */
  available: boolean;
  adapter: SmsAdapter | null;
  cipher: ContactCipher | null;
  dailyCap: number;
}

export function smsDeployment(
  env: Pick<
    Env,
    'SMS_PROVIDER' | 'SMS_DAILY_CAP' | 'SMS_WEBHOOK_SECRET' | 'CONTACT_ENCRYPTION_KEY' | 'NODE_ENV'
  >,
): SmsDeployment {
  const cipher = createContactCipher(env.CONTACT_ENCRYPTION_KEY);
  // The env schema already refuses the sandbox in production; checked again here
  const mode = env.SMS_PROVIDER === 'sandbox' && env.NODE_ENV !== 'production' ? 'sandbox' : 'off';
  const adapter =
    mode === 'sandbox'
      ? createSmsAdapter(
          'sandbox',
          env.SMS_WEBHOOK_SECRET ? { webhookSecret: env.SMS_WEBHOOK_SECRET } : {},
        )
      : null;
  return {
    mode,
    available: adapter !== null && cipher !== null && env.SMS_DAILY_CAP > 0,
    adapter,
    cipher,
    dailyCap: env.SMS_DAILY_CAP,
  };
}

/** Whether SMS is offered for a facility now: the deployment can send AND the facility opted in. */
export async function facilitySmsOffered(
  db: Db,
  dep: SmsDeployment,
  organizationId: string,
  facilityId: string,
): Promise<boolean> {
  if (!dep.available) return false;
  const [s] = await db<{ enabled: boolean }[]>`
    SELECT enabled FROM facility_sms_settings
     WHERE facility_id = ${facilityId} AND organization_id = ${organizationId}`;
  return s?.enabled === true;
}

/**
 * Store the consented contact of a ticket that was just issued (or replayed). Runs after the
 * join committed, in its own statement, so the join never depends on it. Idempotent per ticket:
 * a replay keeps the first contact. Returns what the visitor is told.
 */
export async function saveJoinContact(
  db: Db,
  dep: SmsDeployment,
  input: {
    organizationId: string;
    queueId: string;
    publicCode: string;
    e164: string;
    consentVersion: string;
  },
): Promise<SmsJoinResult> {
  const cipher = dep.cipher;
  if (!cipher) return 'not_available';
  const [t] = await db<{ id: string; facility_id: string; state: string }[]>`
    SELECT t.id, qs.facility_id, t.state
      FROM tickets t JOIN queue_sessions qs ON qs.id = t.queue_session_id
     WHERE t.queue_session_id = ${input.queueId} AND t.public_code = ${input.publicCode}
       AND t.organization_id = ${input.organizationId}`;
  if (!t || t.state !== 'waiting') return 'not_available';
  if (!(await facilitySmsOffered(db, dep, input.organizationId, t.facility_id))) {
    return 'not_available';
  }
  const inserted = await db<{ id: string }[]>`
    INSERT INTO visitor_contacts
      (organization_id, facility_id, ticket_id, phone_ciphertext, phone_hash, consent_at,
       consent_version, retention_until)
    VALUES (${input.organizationId}, ${t.facility_id}, ${t.id}, ${cipher.sealPhone(input.e164)},
            ${cipher.phoneHash(input.e164)}, NOW(), ${input.consentVersion},
            NOW() + make_interval(hours => ${SMS_CONTACT_MAX_RETENTION_HOURS}))
    ON CONFLICT (ticket_id) WHERE ticket_id IS NOT NULL DO NOTHING
    RETURNING id`;
  if (inserted.length > 0) return 'on';
  // A replay of the same join: report the existing contact, never a second one
  return (await smsStateForTicket(db, input.organizationId, t.id)) === 'on'
    ? 'on'
    : 'not_available';
}

/** The visitor's SMS state for a ticket (by the current ticket id; contacts follow transfers). */
export async function smsStateForTicket(
  db: Db,
  organizationId: string,
  ticketId: string,
): Promise<SmsAlertState> {
  const [c] = await db<{ active: boolean; opted_out: boolean }[]>`
    SELECT (phone_ciphertext IS NOT NULL) AS active, (opted_out_at IS NOT NULL) AS opted_out
      FROM visitor_contacts WHERE ticket_id = ${ticketId} AND organization_id = ${organizationId}`;
  if (!c) return null;
  if (c.active) return 'on';
  return c.opted_out ? 'off' : null;
}

/**
 * Stop SMS for one ticket (visitor or staff). Erases the number and its lookup hash at once;
 * the worker re-checks the contact under a row lock before every send, so this takes effect
 * before any later send (design §13.2). Idempotent: returns whether anything changed.
 */
export async function optOutTicket(
  db: Db,
  input: {
    organizationId: string;
    facilityId: string;
    ticketId: string;
    source: 'visitor' | 'staff';
    actorId: string | null;
  },
): Promise<boolean> {
  return db.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      UPDATE visitor_contacts
         SET opted_out_at = NOW(), opt_out_source = ${input.source},
             phone_ciphertext = NULL, phone_hash = NULL
       WHERE ticket_id = ${input.ticketId} AND organization_id = ${input.organizationId}
         AND opted_out_at IS NULL AND erased_at IS NULL
      RETURNING id`;
    if (rows.length > 0 && input.source === 'staff') {
      await recordAdminEvent(tx, {
        organizationId: input.organizationId,
        facilityId: input.facilityId,
        actorId: input.actorId,
        eventType: 'sms.opted_out',
        targetType: 'ticket',
        targetId: input.ticketId,
        details: { source: 'staff' },
      });
    }
    return rows.length > 0;
  });
}

/**
 * An inbound reply. A STOP keyword opts out every active contact with that number (the sender is
 * the deployment's SMS identity, so the request applies to all of it). Returns counts only.
 */
/**
 * How an inbound STOP was attributed (logged as a code; never ids or numbers):
 * - `organization`: exactly one organization sent this number a message through this provider
 *   during an active visit; that organization's active contacts for the number are opted out.
 * - `ambiguous`: several organizations did (a shared sender cannot tell them apart); nothing is
 *   changed. The visitor stops messages on the ticket page, or staff do it at the desk.
 * - `no_message`: no organization sent this number anything during an active visit; nothing is
 *   changed (there is nothing the reply could refer to).
 * - `not_stop` / `unreadable`: not a STOP keyword, or no usable sender number.
 */
export type StopAttribution =
  | 'organization'
  | 'ambiguous'
  | 'no_message'
  | 'not_stop'
  | 'unreadable';
/**
 * An inbound reply from the provider webhook (already signature-, timestamp- and
 * replay-checked by the route). Tenant-scoped (M6.1 pre-PR review, 2026-11-20).
 *
 * The inbound message names the sender's number and our deployment-wide sender, never an
 * organization: every tenant sends from the same sender identity. The only safe evidence of
 * which organization a reply concerns is what this deployment actually handed to THIS provider
 * for THIS number during an active visit (`send_started_at` set and not `failed`: a message the
 * provider refused, or one waiting to retry after "not accepted", reached nobody). If that is
 * one organization,
 * the STOP applies to it alone; if it is several, or none, nothing is changed. A STOP never
 * touches another organization's contacts, and it is not a blocklist: a later join with the same
 * number is a new, explicit consent.
 *
 * Concurrency: one transaction; the candidate contacts are locked (FOR UPDATE, id order, the
 * same row lock the worker's send re-check takes FOR SHARE), so a STOP that commits first
 * always wins over a send that has not started, and two STOPs for one number apply once.
 */
export async function applyInboundMessage(
  db: Db,
  cipher: ContactCipher | null,
  provider: string,
  msg: { from: string; body: string },
): Promise<{ stop: boolean; optedOut: number; attribution: StopAttribution }> {
  if (!isStopKeyword(msg.body)) return { stop: false, optedOut: 0, attribution: 'not_stop' };
  const e164 = normalizePhoneNumber(msg.from);
  if (!cipher || !e164) return { stop: true, optedOut: 0, attribution: 'unreadable' };
  const hash = cipher.phoneHash(e164);
  return db.begin(async (tx) => {
    const active = await tx<{ id: string; organization_id: string }[]>`
      SELECT id, organization_id FROM visitor_contacts
       WHERE phone_hash = ${hash} AND opted_out_at IS NULL AND erased_at IS NULL
       ORDER BY id
         FOR UPDATE`;
    if (active.length === 0) return { stop: true, optedOut: 0, attribution: 'no_message' };
    const senders = await tx<{ organization_id: string }[]>`
      SELECT DISTINCT n.organization_id FROM notifications n
       WHERE n.channel = 'sms' AND n.provider = ${provider}
         AND n.send_started_at IS NOT NULL AND n.status <> 'failed'
         AND n.visitor_contact_id IN ${tx(active.map((a) => a.id))}`;
    if (senders.length === 0) return { stop: true, optedOut: 0, attribution: 'no_message' };
    if (senders.length > 1) return { stop: true, optedOut: 0, attribution: 'ambiguous' };
    const org = senders[0]?.organization_id ?? '';
    const ids = active.filter((a) => a.organization_id === org).map((a) => a.id);
    const rows = await tx<{ id: string }[]>`
      UPDATE visitor_contacts
         SET opted_out_at = NOW(), opt_out_source = 'keyword', phone_ciphertext = NULL, phone_hash = NULL
       WHERE id IN ${tx(ids)} AND organization_id = ${org}
         AND opted_out_at IS NULL AND erased_at IS NULL
      RETURNING id`;
    return { stop: true, optedOut: rows.length, attribution: 'organization' as const };
  });
}

/**
 * Apply an authenticated delivery receipt, idempotently. Correlation is by (provider, provider
 * message id) and only SMS notifications of that provider can match. Transitions:
 *   sent | unknown | failed → delivered        (the receipt is authoritative)
 *   sent | unknown          → failed
 *   sent                    → unknown
 * `delivered` is never downgraded; a receipt for a message never handed over (pending,
 * suppressed) or unknown here is ignored. A delivery row is written only when the state changes.
 */
export async function applyDeliveryReceipt(
  db: Db,
  provider: string,
  sandbox: boolean,
  receipt: DeliveryReceipt,
): Promise<'updated' | 'unchanged' | 'unknown_message'> {
  const to =
    receipt.status === DeliveryStatus.DELIVERED
      ? 'delivered'
      : receipt.status === DeliveryStatus.FAILED
        ? 'failed'
        : receipt.status === DeliveryStatus.UNKNOWN
          ? 'unknown'
          : null;
  if (!to) return 'unchanged';
  const from =
    to === 'delivered'
      ? ['sent', 'unknown', 'failed']
      : to === 'failed'
        ? ['sent', 'unknown']
        : ['sent'];
  const detail = to === 'delivered' ? (sandbox ? 'sandbox_receipt' : 'receipt') : 'receipt';
  return db.begin(async (tx) => {
    const [n] = await tx<{ id: string; status: string }[]>`
      SELECT id, status FROM notifications
       WHERE provider = ${provider} AND provider_message_id = ${receipt.provider_message_id}
         AND channel = 'sms'
       FOR UPDATE`;
    if (!n) return 'unknown_message';
    if (!from.includes(n.status)) return 'unchanged';
    await tx`
      UPDATE notifications SET status = ${to}, detail_code = ${detail}, updated_at = NOW()
       WHERE id = ${n.id}`;
    await tx`
      INSERT INTO notification_deliveries
        (notification_id, provider, provider_message_id, receipt_status, detail_code)
      VALUES (${n.id}, ${provider}, ${receipt.provider_message_id}, ${to}, ${detail})`;
    return 'updated';
  });
}

/** Today's (UTC) send counts in the deployment's mode. */
async function sentToday(
  db: Db,
  mode: 'sandbox' | 'live',
  facilityId: string,
): Promise<{ facility: number; deployment: number }> {
  const rows = await db<{ scope: string; sends: number }[]>`
    SELECT scope, sends FROM sms_daily_usage
     WHERE usage_date = (NOW() AT TIME ZONE 'UTC')::date AND mode = ${mode}
       AND scope IN ('global', ${facilityId})`;
  return {
    facility: rows.find((r) => r.scope === facilityId)?.sends ?? 0,
    deployment: rows.find((r) => r.scope === 'global')?.sends ?? 0,
  };
}

export async function facilitySmsSettings(
  db: Db,
  dep: SmsDeployment,
  organizationId: string,
  facilityId: string,
): Promise<FacilitySmsSettings> {
  const [s] = await db<{ enabled: boolean; daily_cap: number }[]>`
    SELECT enabled, daily_cap FROM facility_sms_settings
     WHERE facility_id = ${facilityId} AND organization_id = ${organizationId}`;
  return {
    enabled: s?.enabled ?? false,
    daily_cap: s?.daily_cap ?? 0,
    deployment_available: dep.available,
    deployment_mode: dep.mode,
    deployment_daily_cap: dep.dailyCap,
    sent_today: await sentToday(db, dep.mode === 'sandbox' ? 'sandbox' : 'live', facilityId),
  };
}

/** Change a facility's SMS setting; one audit event per real change (no number, no text). */
export async function updateFacilitySmsSettings(
  db: Db,
  input: {
    organizationId: string;
    facilityId: string;
    actorId: string;
    enabled: boolean;
    dailyCap: number;
    deploymentAvailable: boolean;
  },
): Promise<void> {
  await db.begin(async (tx) => {
    const [before] = await tx<{ enabled: boolean; daily_cap: number }[]>`
      SELECT enabled, daily_cap FROM facility_sms_settings
       WHERE facility_id = ${input.facilityId} AND organization_id = ${input.organizationId}
       FOR UPDATE`;
    await tx`
      INSERT INTO facility_sms_settings (facility_id, organization_id, enabled, daily_cap, updated_by, updated_at)
      VALUES (${input.facilityId}, ${input.organizationId}, ${input.enabled}, ${input.dailyCap},
              ${input.actorId}, NOW())
      ON CONFLICT (facility_id) DO UPDATE
        SET enabled = EXCLUDED.enabled, daily_cap = EXCLUDED.daily_cap,
            updated_by = EXCLUDED.updated_by, updated_at = NOW()`;
    const wasOn = before?.enabled ?? false;
    const oldCap = before?.daily_cap ?? 0;
    if (wasOn === input.enabled && oldCap === input.dailyCap) return;
    await recordAdminEvent(tx, {
      organizationId: input.organizationId,
      facilityId: input.facilityId,
      actorId: input.actorId,
      eventType:
        wasOn !== input.enabled
          ? input.enabled
            ? 'sms.enabled'
            : 'sms.disabled'
          : 'sms.cap_changed',
      targetType: 'facility',
      targetId: input.facilityId,
      details: {
        daily_cap: input.dailyCap,
        previous_daily_cap: oldCap,
        deployment_available: input.deploymentAvailable,
      },
    });
  });
}
