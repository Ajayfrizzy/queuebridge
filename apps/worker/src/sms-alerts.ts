import type postgres from 'postgres';
import { type ContactCipher, type SmsAdapter } from '@queuebridge/channels';
import {
  DeliveryStatus,
  SMS_SENT_TEMPLATES,
  SMS_TURN_ALERT_TEMPLATE,
  type SmsDetailCode,
} from '@queuebridge/contracts';

/**
 * M6.1 SMS turn alerts, worker side (design §13; REQ-F11.4, F11.5, F11.10, F11.11).
 *
 * Same outbox pipeline as push (claim with FOR UPDATE SKIP LOCKED, lease, bounded attempts,
 * TTL, re-read at send time, honest outcome), with three SMS rules:
 *
 * 1. At most once per key (REQ-F11.5). `notifications.send_started_at` is committed BEFORE the
 *    message is handed to the provider. A row reclaimed after a crash with it set is recorded
 *    `unknown` / `interrupted` and is never sent again (a duplicate SMS costs money and confuses).
 *    Only an explicit "not accepted, retry is safe" answer clears it for a retry.
 * 2. Opt-out and caps are checked in the same short transaction, under a lock on the contact row,
 *    immediately before the send: an opt-out committed first always wins; the global and the
 *    facility daily caps are reserved atomically (both or neither) across concurrent workers.
 *    Beyond a cap the row is `failed` / `cap` and closed: nothing is held back for a later day.
 * 3. `sent` means accepted by the provider. `delivered` comes only from an authenticated receipt
 *    (API webhook), never from a send result, even if an adapter claims it.
 *
 * The worker never writes `tickets`, `queue_sessions` or `queue_events` (ADR-013), and no SMS
 * outcome changes a ticket. Logs carry counts and codes only: never a number or message text.
 */

export interface SmsAlertOptions {
  ttlSeconds?: number;
  maxAttempts?: number;
  leaseSeconds?: number;
  batchSize?: number;
  backoffSeconds?: number;
  concurrency?: number;
  /** Deployment-wide cap per UTC day in this adapter's mode (0 = send nothing). */
  dailyCap: number;
}

export interface SmsAlertResult {
  claimed: number;
  sent: number;
  failed: number;
  capped: number;
  suppressed: number;
  retrying: number;
  unknown: number;
  superseded: number;
  errors: number;
}

interface Claimed {
  id: string;
  notification_id: string;
  dedup_key: string;
  attempt_count: number;
  payload: Record<string, unknown>;
  age_seconds: number;
}

interface Payload {
  contact_id: string;
  ticket_id: string;
  facility_id: string;
  event_sequence: number;
  counter_id: string | null;
  /** M6.3: a delayed alert, to skip if the visitor's page presented the in-app alert first */
  skip_if_seen?: boolean;
}

type Outcome =
  | { status: 'sent'; detail: 'accepted'; provider: string; messageId: string | null }
  | {
      status: 'failed';
      detail: Extract<
        SmsDetailCode,
        | 'cap'
        | 'rejected'
        | 'retries_exhausted'
        | 'ttl_elapsed'
        | 'invalid_payload'
        | 'sms_unavailable'
      >;
    }
  | {
      status: 'suppressed';
      detail: Extract<
        SmsDetailCode,
        'ticket_changed' | 'opted_out' | 'contact_removed' | 'sms_disabled' | 'alert_seen'
      >;
    }
  | { status: 'unknown'; detail: Extract<SmsDetailCode, 'interrupted' | 'error'> }
  | { status: 'retry'; delaySeconds: number }
  | { status: 'superseded' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validPayload(p: Record<string, unknown>): p is Record<string, unknown> & Payload {
  return (
    typeof p['contact_id'] === 'string' &&
    UUID.test(p['contact_id']) &&
    typeof p['ticket_id'] === 'string' &&
    UUID.test(p['ticket_id']) &&
    typeof p['facility_id'] === 'string' &&
    UUID.test(p['facility_id']) &&
    Number.isInteger(p['event_sequence']) &&
    (p['counter_id'] === null ||
      (typeof p['counter_id'] === 'string' && UUID.test(p['counter_id']))) &&
    (p['skip_if_seen'] === undefined || typeof p['skip_if_seen'] === 'boolean')
  );
}

class CapReached extends Error {}
class Interrupted extends Error {}

export async function processSmsAlerts(
  sql: postgres.Sql,
  adapter: SmsAdapter | null,
  cipher: ContactCipher | null,
  opts: SmsAlertOptions,
): Promise<SmsAlertResult> {
  const ttl = opts.ttlSeconds ?? 120;
  const maxAttempts = opts.maxAttempts ?? 3;
  const lease = opts.leaseSeconds ?? 30;
  const result: SmsAlertResult = {
    claimed: 0,
    sent: 0,
    failed: 0,
    capped: 0,
    suppressed: 0,
    retrying: 0,
    unknown: 0,
    superseded: 0,
    errors: 0,
  };

  // No usable adapter here: nothing is sent. Rows past their TTL are closed honestly.
  if (!adapter || !cipher) {
    const expired = await sql<{ id: string }[]>`
      WITH x AS (
        UPDATE notification_outbox o SET processed_at = NOW()
          FROM notifications n
         WHERE n.id = o.notification_id AND n.channel = 'sms' AND o.processed_at IS NULL
           AND o.created_at < NOW() - make_interval(secs => ${ttl})
        RETURNING o.notification_id AS id)
      UPDATE notifications n SET status = 'failed', detail_code = 'sms_unavailable', updated_at = NOW()
        FROM x WHERE n.id = x.id AND n.status = 'pending'
      RETURNING n.id`;
    result.failed += expired.length;
    return result;
  }
  const mode = adapter.sandbox ? 'sandbox' : 'live';

  const claimed = await sql<Claimed[]>`
    WITH due AS (
      SELECT o.id FROM notification_outbox o
        JOIN notifications n ON n.id = o.notification_id
       WHERE o.processed_at IS NULL AND o.next_attempt_at <= NOW() AND n.channel = 'sms'
       ORDER BY o.next_attempt_at, o.id
       LIMIT ${opts.batchSize ?? 50}
       FOR UPDATE OF o SKIP LOCKED)
    UPDATE notification_outbox o
       SET attempt_count = o.attempt_count + 1,
           next_attempt_at = NOW() + make_interval(secs => ${lease})
      FROM due WHERE o.id = due.id
    RETURNING o.id, o.notification_id, o.dedup_key, o.attempt_count, o.payload,
              EXTRACT(EPOCH FROM NOW() - o.created_at)::float AS age_seconds`;
  result.claimed = claimed.length;

  const work = [...claimed];
  const runners = Array.from({ length: Math.min(opts.concurrency ?? 4, work.length) }, async () => {
    for (let row = work.shift(); row; row = work.shift()) {
      let outcome: Outcome;
      if (!validPayload(row.payload)) {
        outcome = { status: 'failed', detail: 'invalid_payload' };
      } else {
        try {
          outcome = await attempt(sql, adapter, cipher, row, row.payload, {
            ttl,
            maxAttempts,
            lease,
            backoff: opts.backoffSeconds ?? 5,
            dailyCap: opts.dailyCap,
            mode,
          });
        } catch {
          // Anything unexpected after the send may have started: honest "unknown", no retry
          outcome = { status: 'unknown', detail: 'error' };
        }
      }
      if (outcome.status === 'superseded') {
        result.superseded += 1;
        continue;
      }
      try {
        await finish(sql, row, outcome, adapter.provider);
      } catch {
        // Not recorded: retried after the lease (send_started_at, if set, prevents a resend)
        result.errors += 1;
        continue;
      }
      if (outcome.status === 'retry') result.retrying += 1;
      else if (outcome.status === 'failed' && outcome.detail === 'cap') result.capped += 1;
      else result[outcome.status] += 1;
    }
  });
  await Promise.all(runners);
  return result;
}

interface Context {
  ticket_state: string;
  current_counter_id: string | null;
  public_code: string;
  counter_name: string | null;
  call_sequence: number | null;
  sms_enabled: boolean | null;
  facility_cap: number | null;
  send_started_at: Date | null;
  template_key: string;
}

async function attempt(
  sql: postgres.Sql,
  adapter: SmsAdapter,
  cipher: ContactCipher,
  row: Claimed,
  p: Payload,
  o: {
    ttl: number;
    maxAttempts: number;
    lease: number;
    backoff: number;
    dailyCap: number;
    mode: 'sandbox' | 'live';
  },
): Promise<Outcome> {
  if (row.attempt_count > o.maxAttempts) return { status: 'failed', detail: 'retries_exhausted' };
  if (row.age_seconds >= o.ttl) return { status: 'failed', detail: 'ttl_elapsed' };
  // Re-read at send time (plain reads; no lock on queue tables)
  const [c] = await sql<Context[]>`
    SELECT t.state AS ticket_state, t.current_counter_id, t.public_code, cn.name AS counter_name,
           (SELECT e.sequence FROM ticket_transitions tt JOIN queue_events e ON e.id = tt.queue_event_id
             WHERE tt.ticket_id = t.id AND tt.to_state = 'called' ORDER BY e.sequence DESC LIMIT 1) AS call_sequence,
           fs.enabled AS sms_enabled, fs.daily_cap AS facility_cap, n.send_started_at,
           n.template_key
      FROM tickets t
      JOIN notifications n ON n.id = ${row.notification_id}
      LEFT JOIN counters cn ON cn.id = t.current_counter_id
      LEFT JOIN facility_sms_settings fs ON fs.facility_id = ${p.facility_id}
     WHERE t.id = ${p.ticket_id}`;
  if (!c) return { status: 'suppressed', detail: 'ticket_changed' };
  // Only templates the approved consent covers are ever sent (today: `ticket.called`). A row
  // for an inactive template is closed without sending, whatever wrote it.
  if (!(SMS_SENT_TEMPLATES as readonly string[]).includes(c.template_key)) {
    return { status: 'failed', detail: 'invalid_payload' };
  }
  // A previous attempt began handing this message over and never recorded the answer
  if (c.send_started_at) return { status: 'unknown', detail: 'interrupted' };
  if (
    c.ticket_state !== 'called' ||
    c.call_sequence !== p.event_sequence ||
    (p.counter_id !== null && c.current_counter_id !== p.counter_id)
  ) {
    return { status: 'suppressed', detail: 'ticket_changed' };
  }
  if (!c.sms_enabled) return { status: 'suppressed', detail: 'sms_disabled' };

  // One short transaction: still ours, contact still consented (row lock), caps, send marker
  let to: string;
  try {
    const reserved = await sql.begin(async (tx) => {
      const mine = await tx`
        UPDATE notification_outbox SET next_attempt_at = NOW() + make_interval(secs => ${o.lease})
         WHERE id = ${row.id} AND processed_at IS NULL AND attempt_count = ${row.attempt_count}
        RETURNING id`;
      if (mine.length === 0) return { kind: 'superseded' as const };
      const [contact] = await tx<
        { phone_ciphertext: string | null; opted_out: boolean; erased: boolean }[]
      >`
        SELECT phone_ciphertext, (opted_out_at IS NOT NULL) AS opted_out, (erased_at IS NOT NULL) AS erased
          FROM visitor_contacts
         WHERE id = ${p.contact_id} AND ticket_id = ${p.ticket_id}
         FOR SHARE`;
      if (!contact) return { kind: 'suppressed' as const, detail: 'contact_removed' as const };
      if (contact.opted_out) return { kind: 'suppressed' as const, detail: 'opted_out' as const };
      if (contact.erased || !contact.phone_ciphertext) {
        return { kind: 'suppressed' as const, detail: 'contact_removed' as const };
      }
      // M6.3 delayed alert: the visitor's page presented the in-app alert for THIS call event
      // before the send started (the acknowledgement is written under this same contact row
      // lock, so the order is exact). Skipped honestly, before any cap is reserved.
      if (p.skip_if_seen === true) {
        const seen = await tx`
          SELECT 1 FROM turn_alert_seen
           WHERE ticket_id = ${p.ticket_id} AND event_sequence = ${p.event_sequence}`;
        if (seen.length > 0) return { kind: 'suppressed' as const, detail: 'alert_seen' as const };
      }
      const phone = cipher.openPhone(contact.phone_ciphertext);
      const facilityCap = c.facility_cap ?? 0;
      if (o.dailyCap <= 0 || facilityCap <= 0) throw new CapReached();
      // Global first, then facility (one fixed order, so concurrent workers never deadlock)
      for (const [scope, cap] of [
        ['global', o.dailyCap],
        [p.facility_id, facilityCap],
      ] as const) {
        const ok = await tx`
          INSERT INTO sms_daily_usage (usage_date, mode, scope, sends)
          VALUES ((NOW() AT TIME ZONE 'UTC')::date, ${o.mode}, ${scope}, 1)
          ON CONFLICT (usage_date, mode, scope)
            DO UPDATE SET sends = sms_daily_usage.sends + 1 WHERE sms_daily_usage.sends < ${cap}
          RETURNING sends`;
        if (ok.length === 0) throw new CapReached();
      }
      const marked = await tx`
        UPDATE notifications SET send_started_at = NOW(), provider = ${adapter.provider}
         WHERE id = ${row.notification_id} AND send_started_at IS NULL
        RETURNING id`;
      if (marked.length === 0) throw new Interrupted();
      return { kind: 'send' as const, phone };
    });
    if (reserved.kind === 'superseded') return { status: 'superseded' };
    if (reserved.kind === 'suppressed') return { status: 'suppressed', detail: reserved.detail };
    to = reserved.phone;
  } catch (err) {
    if (err instanceof CapReached) return { status: 'failed', detail: 'cap' };
    if (err instanceof Interrupted) return { status: 'unknown', detail: 'interrupted' };
    throw err;
  }

  let res;
  try {
    res = await adapter.sendMessage({
      to,
      template_key: SMS_TURN_ALERT_TEMPLATE,
      params: { code: c.public_code, ...(c.counter_name ? { counter: c.counter_name } : {}) },
      idempotency_key: row.dedup_key,
      sandbox: adapter.sandbox,
    });
  } catch {
    // The provider may or may not have it: never resend
    return { status: 'unknown', detail: 'error' };
  }
  // Accepted. Even an adapter that says "delivered" here is recorded as sent (REQ-F11.4)
  if (res.status === DeliveryStatus.SENT || res.status === DeliveryStatus.DELIVERED) {
    return {
      status: 'sent',
      detail: 'accepted',
      provider: adapter.provider,
      messageId: res.provider_message_id ?? null,
    };
  }
  if (res.status === DeliveryStatus.FAILED && res.retryable === true) {
    if (row.attempt_count >= o.maxAttempts)
      return { status: 'failed', detail: 'retries_exhausted' };
    const delay = o.backoff * 2 ** (row.attempt_count - 1);
    if (row.age_seconds + delay >= o.ttl) return { status: 'failed', detail: 'ttl_elapsed' };
    return { status: 'retry', delaySeconds: delay };
  }
  if (res.status === DeliveryStatus.FAILED) return { status: 'failed', detail: 'rejected' };
  return { status: 'unknown', detail: 'error' };
}

async function finish(
  sql: postgres.Sql,
  row: Claimed,
  outcome: Exclude<Outcome, { status: 'superseded' }>,
  provider: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    if (outcome.status === 'retry') {
      const r = await tx`
        UPDATE notification_outbox
           SET next_attempt_at = NOW() + make_interval(secs => ${outcome.delaySeconds})
         WHERE id = ${row.id} AND processed_at IS NULL AND attempt_count = ${row.attempt_count}
        RETURNING id`;
      // The provider said it did not accept the message: a later attempt may send it
      if (r.length > 0) {
        await tx`UPDATE notifications SET send_started_at = NULL WHERE id = ${row.notification_id}`;
      }
      return;
    }
    const done = await tx`
      UPDATE notification_outbox SET processed_at = NOW()
       WHERE id = ${row.id} AND processed_at IS NULL AND attempt_count = ${row.attempt_count}
      RETURNING id`;
    if (done.length === 0) return;
    const messageId = outcome.status === 'sent' ? outcome.messageId : null;
    // `delivered` (from a receipt) is never downgraded
    await tx`
      UPDATE notifications
         SET status = ${outcome.status}, detail_code = ${outcome.detail}, updated_at = NOW(),
             provider_message_id = COALESCE(${messageId}, provider_message_id)
       WHERE id = ${row.notification_id} AND status <> 'delivered'`;
    await tx`
      INSERT INTO notification_deliveries
        (notification_id, provider, provider_message_id, receipt_status, detail_code)
      VALUES (${row.notification_id}, ${provider}, ${messageId}, ${outcome.status}, ${outcome.detail})`;
  });
}

/**
 * SMS data retention (design §13.2; final rules in the M6 evidence, revised at the M6.1 pre-PR
 * review). Idempotent and bounded per pass; counts only:
 *  - erase the number and its lookup hash as soon as the visit no longer needs it: the ticket
 *    is completed, cancelled or transferred away (a service transfer moves the contact to the
 *    destination ticket first, so the visit keeps it), missed beyond its grace window (it can
 *    no longer return to the queue), or its queue session is closed; opt-out erases at once;
 *  - as a backstop only, erase it at `retention_until` (7 days after joining) for sessions
 *    nobody closed;
 *  - while the number is held the row (its consent record) is never deleted, however long the
 *    visit; a row without a number (consent and opt-out record) is deleted 24 hours after the
 *    number was erased or opted out, or at `retention_until`;
 *  - delete SMS notification rows (and their outbox and delivery rows) after 30 days;
 *  - delete webhook nonces after 24 hours and daily counters after 90 days;
 *  - delete in-app "alert seen" marks (M6.3) after 24 hours.
 */
export interface SmsRetentionResult {
  erased: number;
  contactsDeleted: number;
  notificationsDeleted: number;
  noncesDeleted: number;
  countersDeleted: number;
  seenDeleted: number;
}

export async function purgeSmsData(
  sql: postgres.Sql,
  opts: { batch?: number } = {},
): Promise<SmsRetentionResult> {
  const batch = opts.batch ?? 1000;
  const erased = await sql`
    UPDATE visitor_contacts vc
       SET phone_ciphertext = NULL, phone_hash = NULL, erased_at = NOW()
     WHERE vc.id IN (
       SELECT vc2.id FROM visitor_contacts vc2
         JOIN tickets t ON t.id = vc2.ticket_id
         JOIN queue_sessions qs ON qs.id = t.queue_session_id
         JOIN services s ON s.id = qs.service_id
        WHERE vc2.phone_ciphertext IS NOT NULL
          AND (t.state IN ('completed', 'cancelled', 'transferred')
               OR qs.state = 'closed'
               OR (t.state = 'missed' AND t.missed_at IS NOT NULL
                   AND t.missed_at + make_interval(secs => COALESCE((s.policy ->> 'grace_window_seconds')::int, 300)) < NOW()))
        LIMIT ${batch})`;
  // Backstop only (a session nobody closed, or a contact without a ticket): 7 days after joining
  const backstop = await sql`
    UPDATE visitor_contacts SET phone_ciphertext = NULL, phone_hash = NULL, erased_at = NOW()
     WHERE id IN (
       SELECT id FROM visitor_contacts
        WHERE phone_ciphertext IS NOT NULL AND retention_until < NOW() LIMIT ${batch})`;
  // Never a row that still holds a number: its consent record lives as long as the number
  const contacts = await sql`
    DELETE FROM visitor_contacts WHERE id IN (
      SELECT id FROM visitor_contacts
       WHERE phone_ciphertext IS NULL
         AND (COALESCE(erased_at, opted_out_at) < NOW() - INTERVAL '24 hours'
              OR retention_until < NOW())
       LIMIT ${batch})`;
  const notifications = await sql`
    DELETE FROM notifications WHERE id IN (
      SELECT id FROM notifications
       WHERE channel = 'sms' AND created_at < NOW() - INTERVAL '30 days' LIMIT ${batch})`;
  const nonces = await sql`
    DELETE FROM sms_webhook_nonces WHERE (provider, nonce) IN (
      SELECT provider, nonce FROM sms_webhook_nonces
       WHERE received_at < NOW() - INTERVAL '24 hours' LIMIT ${batch})`;
  const counters = await sql`
    DELETE FROM sms_daily_usage WHERE usage_date < (NOW() AT TIME ZONE 'UTC')::date - 90`;
  // M6.3 in-app "alert seen" marks: needed only until the delayed SMS for that call is decided
  const seen = await sql`
    DELETE FROM turn_alert_seen WHERE (ticket_id, event_sequence) IN (
      SELECT ticket_id, event_sequence FROM turn_alert_seen
       WHERE seen_at < NOW() - INTERVAL '24 hours' LIMIT ${batch})`;
  return {
    erased: erased.count + backstop.count,
    contactsDeleted: contacts.count,
    notificationsDeleted: notifications.count,
    noncesDeleted: nonces.count,
    countersDeleted: counters.count,
    seenDeleted: seen.count,
  };
}
