import type postgres from 'postgres';
import {
  TURN_ALERT_DEFAULTS,
  TURN_ALERT_TEMPLATE,
  TurnAlertPayloadSchema,
  turnAlertTopic,
  type TurnAlertPayload,
} from '@queuebridge/contracts';
import type { PushTarget, PushTransport, SubscriptionCipher } from '@queuebridge/channels';

/**
 * M5.4 turn-alert delivery (REQ-F14.5–F14.8, design §12.5.4, ADR-013 §4–§6).
 *
 * One outbox row = one device. Concurrency and crashes:
 *  - CLAIM: a short transaction takes due rows with `FOR UPDATE SKIP LOCKED`, increments
 *    `attempt_count` and pushes `next_attempt_at` forward by a LEASE. Concurrent workers never
 *    take the same row; a worker that dies mid-send leaves its row due again after the lease.
 *  - RENEW: immediately before sending, the worker renews its lease in one guarded statement;
 *    if another worker has re-claimed the row meanwhile (a long batch outlived the lease), it
 *    skips the row without sending, so a slow batch does not cause a duplicate send.
 *  - FINISH: every result is written with a guard on the claimed `attempt_count`, so a worker
 *    whose lease expired cannot overwrite a newer attempt's result.
 *  - BOUNDS: at most `maxAttempts` claims (crashes included) and never after the TTL.
 *  - Delivery is AT-LEAST-ONCE WITH COLLAPSE: a crash between the push service accepting and
 *    the result being recorded can re-send after the lease; the same `Topic` and notification
 *    tag make the device replace, not stack, the message. Exactly-once is never claimed.
 *
 * Honesty: `sent` = the push service accepted it; only the visitor's page (API ack) can make it
 * `delivered`. The worker never writes `tickets`, `queue_sessions` or `queue_events`.
 */
export interface TurnAlertOptions {
  ttlSeconds?: number;
  maxAttempts?: number;
  leaseSeconds?: number;
  batchSize?: number;
  /** base backoff before the first retry; doubles each attempt, always inside the TTL */
  backoffSeconds?: number;
  concurrency?: number;
}

export interface TurnAlertResult {
  claimed: number;
  sent: number;
  failed: number;
  suppressed: number;
  retrying: number;
  unknown: number;
  /** rows another worker re-claimed before this one reached them (not sent, not recorded) */
  superseded: number;
}

interface Claimed {
  id: string;
  notification_id: string;
  attempt_count: number;
  age_seconds: number;
  payload: {
    subscription_id: string;
    event_sequence: number;
    ticket_id: string;
    counter_id: string | null;
  };
}

interface Context {
  ticket_state: string;
  current_counter_id: string | null;
  call_sequence: number | null;
  public_code: string;
  counter_name: string | null;
  org_slug: string;
  facility_slug: string;
  root_code: string;
  sub_active: boolean;
  sub_expired: boolean;
  credential_revoked: boolean;
  endpoint_ct: Buffer | null;
  keys_ct: Buffer | null;
}

type Outcome =
  | { status: 'sent'; detail: 'accepted' }
  | { status: 'failed'; detail: 'gone' | 'ttl_elapsed' | 'retries_exhausted' | 'rejected' }
  | { status: 'suppressed'; detail: 'ticket_changed' | 'subscription_revoked' }
  | { status: 'unknown'; detail: 'error' }
  | { status: 'retry'; delaySeconds: number }
  | { status: 'superseded' };

export async function processTurnAlerts(
  sql: postgres.Sql,
  transport: PushTransport | null,
  cipher: SubscriptionCipher | null,
  opts: TurnAlertOptions = {},
): Promise<TurnAlertResult> {
  const ttl = opts.ttlSeconds ?? TURN_ALERT_DEFAULTS.ttlSeconds;
  const maxAttempts = opts.maxAttempts ?? TURN_ALERT_DEFAULTS.maxAttempts;
  const lease = opts.leaseSeconds ?? 30;
  const result: TurnAlertResult = {
    claimed: 0,
    sent: 0,
    failed: 0,
    suppressed: 0,
    retrying: 0,
    unknown: 0,
    superseded: 0,
  };

  // Without a transport (push not configured in this worker) nothing is sent; rows past their
  // TTL are closed honestly as failed, never left pending forever.
  if (!transport || !cipher) {
    const expired = await sql<{ id: string }[]>`
      WITH x AS (
        UPDATE notification_outbox o SET processed_at = NOW()
          FROM notifications n
         WHERE n.id = o.notification_id AND n.channel = 'web_push' AND o.processed_at IS NULL
           AND o.created_at < NOW() - make_interval(secs => ${ttl})
        RETURNING o.notification_id AS id)
      UPDATE notifications n SET status = 'failed', detail_code = 'ttl_elapsed', updated_at = NOW()
        FROM x WHERE n.id = x.id AND n.status NOT IN ('delivered')
      RETURNING n.id`;
    result.failed += expired.length;
    return result;
  }

  const claimed = await sql<Claimed[]>`
    WITH due AS (
      SELECT o.id FROM notification_outbox o
        JOIN notifications n ON n.id = o.notification_id
       WHERE o.processed_at IS NULL AND o.next_attempt_at <= NOW() AND n.channel = 'web_push'
       ORDER BY o.next_attempt_at, o.id
       LIMIT ${opts.batchSize ?? 50}
       FOR UPDATE OF o SKIP LOCKED)
    UPDATE notification_outbox o
       SET attempt_count = o.attempt_count + 1,
           next_attempt_at = NOW() + make_interval(secs => ${lease})
      FROM due WHERE o.id = due.id
    RETURNING o.id, o.notification_id, o.attempt_count, o.payload,
              EXTRACT(EPOCH FROM NOW() - o.created_at)::float AS age_seconds`;
  result.claimed = claimed.length;

  const work = [...claimed];
  const workers = Array.from({ length: Math.min(opts.concurrency ?? 8, work.length) }, async () => {
    for (let row = work.shift(); row; row = work.shift()) {
      let outcome: Outcome;
      try {
        outcome = await attempt(sql, transport, cipher, row, {
          ttl,
          maxAttempts,
          backoff: opts.backoffSeconds ?? 5,
          lease,
        });
      } catch {
        // decryption, payload or transport defects: honest "unknown", never a retry storm
        outcome = { status: 'unknown', detail: 'error' };
      }
      if (outcome.status === 'superseded') {
        result.superseded += 1;
        continue;
      }
      await finish(sql, row, outcome);
      if (outcome.status === 'retry') result.retrying += 1;
      else result[outcome.status] += 1;
    }
  });
  await Promise.all(workers);
  return result;
}

async function attempt(
  sql: postgres.Sql,
  transport: PushTransport,
  cipher: SubscriptionCipher,
  row: Claimed,
  o: { ttl: number; maxAttempts: number; backoff: number; lease: number },
): Promise<Outcome> {
  if (row.attempt_count > o.maxAttempts) return { status: 'failed', detail: 'retries_exhausted' };
  if (row.age_seconds >= o.ttl) return { status: 'failed', detail: 'ttl_elapsed' };
  const p = row.payload;
  // Re-read everything at send time (plain reads; no locks on queue tables)
  const [c] = await sql<Context[]>`
    WITH RECURSIVE chain AS (
      SELECT t.id, t.public_code, t.transferred_from_ticket_id, 0 AS depth FROM tickets t WHERE t.id = ${p.ticket_id}
      UNION ALL
      SELECT p2.id, p2.public_code, p2.transferred_from_ticket_id, ch.depth + 1
        FROM chain ch JOIN tickets p2 ON p2.id = ch.transferred_from_ticket_id WHERE ch.depth < 10)
    SELECT t.state AS ticket_state, t.current_counter_id, t.public_code, cn.name AS counter_name,
           o.slug AS org_slug, f.slug AS facility_slug,
           (SELECT public_code FROM chain ORDER BY depth DESC LIMIT 1) AS root_code,
           (SELECT e.sequence FROM ticket_transitions tt JOIN queue_events e ON e.id = tt.queue_event_id
             WHERE tt.ticket_id = t.id AND tt.to_state = 'called' ORDER BY e.sequence DESC LIMIT 1) AS call_sequence,
           (ps.revoked_at IS NULL) AS sub_active, (ps.expires_at <= NOW()) AS sub_expired,
           -- no status token behind it any more (deleted by retention) counts as revoked
           (ps.credential_id IS NULL OR cr.id IS NULL OR cr.revoked_at IS NOT NULL OR cr.expires_at <= NOW()) AS credential_revoked,
           ps.endpoint_ct, ps.keys_ct
      FROM tickets t
      JOIN queue_sessions qs ON qs.id = t.queue_session_id
      JOIN facilities f ON f.id = qs.facility_id
      JOIN organizations o ON o.id = qs.organization_id
      JOIN push_subscriptions ps ON ps.id = ${p.subscription_id} AND ps.ticket_id = t.id
      LEFT JOIN counters cn ON cn.id = t.current_counter_id
      LEFT JOIN ticket_recovery_credentials cr ON cr.id = ps.credential_id
     WHERE t.id = ${p.ticket_id}`;
  // The subscription moved with a transfer, was deleted, or the ticket is gone
  if (!c) return { status: 'suppressed', detail: 'ticket_changed' };
  if (
    c.ticket_state !== 'called' ||
    c.call_sequence !== p.event_sequence ||
    (p.counter_id !== null && c.current_counter_id !== p.counter_id)
  ) {
    return { status: 'suppressed', detail: 'ticket_changed' };
  }
  if (!c.sub_active || c.sub_expired || c.credential_revoked || !c.endpoint_ct || !c.keys_ct) {
    return { status: 'suppressed', detail: 'subscription_revoked' };
  }
  // Still ours? Renew the lease for this send, or skip if another worker re-claimed the row
  const renewed = await sql`
    UPDATE notification_outbox SET next_attempt_at = NOW() + make_interval(secs => ${o.lease})
     WHERE id = ${row.id} AND processed_at IS NULL AND attempt_count = ${row.attempt_count}
    RETURNING id`;
  if (renewed.length === 0) return { status: 'superseded' };
  const payload: TurnAlertPayload = TurnAlertPayloadSchema.parse({
    v: 2,
    type: TURN_ALERT_TEMPLATE,
    ref: p.subscription_id,
    code: c.public_code,
    counter: c.counter_name ?? '',
    seq: p.event_sequence,
    rp: `/recover/${encodeURIComponent(c.org_slug)}/${encodeURIComponent(c.facility_slug)}/${encodeURIComponent(c.root_code)}`,
    ts: new Date().toISOString(),
  });
  const target: PushTarget = {
    endpoint: cipher.open(c.endpoint_ct),
    keys: JSON.parse(cipher.open(c.keys_ct)) as PushTarget['keys'],
  };
  const res = await transport.send(target, JSON.stringify(payload), {
    ttlSeconds: Math.max(1, Math.floor(o.ttl - row.age_seconds)),
    topic: turnAlertTopic(p.subscription_id),
    urgency: 'high',
  });
  if (res.kind === 'accepted') return { status: 'sent', detail: 'accepted' };
  if (res.kind === 'gone') return { status: 'failed', detail: 'gone' };
  if (res.kind === 'rejected') return { status: 'failed', detail: 'rejected' };
  // retryable: back off exponentially, but never beyond the TTL or the attempt cap
  if (row.attempt_count >= o.maxAttempts) return { status: 'failed', detail: 'retries_exhausted' };
  const delay = o.backoff * 2 ** (row.attempt_count - 1);
  if (row.age_seconds + delay >= o.ttl) return { status: 'failed', detail: 'ttl_elapsed' };
  return { status: 'retry', delaySeconds: delay };
}

async function finish(
  sql: postgres.Sql,
  row: Claimed,
  outcome: Exclude<Outcome, { status: 'superseded' }>,
): Promise<void> {
  await sql.begin(async (tx) => {
    // Guarded by the attempt this worker claimed: a newer claim owns the row now
    if (outcome.status === 'retry') {
      await tx`
        UPDATE notification_outbox
           SET next_attempt_at = NOW() + make_interval(secs => ${outcome.delaySeconds})
         WHERE id = ${row.id} AND processed_at IS NULL AND attempt_count = ${row.attempt_count}`;
      return;
    }
    const done = await tx`
      UPDATE notification_outbox SET processed_at = NOW()
       WHERE id = ${row.id} AND processed_at IS NULL AND attempt_count = ${row.attempt_count}
      RETURNING id`;
    if (done.length === 0) return;
    // `delivered` (a first-party ack that may have arrived meanwhile) is never downgraded
    await tx`
      UPDATE notifications SET status = ${outcome.status}, detail_code = ${outcome.detail}, updated_at = NOW()
       WHERE id = ${row.notification_id} AND status <> 'delivered'`;
    await tx`
      INSERT INTO notification_deliveries (notification_id, provider, receipt_status, detail_code)
      VALUES (${row.notification_id}, 'web_push', ${outcome.status}, ${outcome.detail})`;
    if (outcome.status === 'failed' && outcome.detail === 'gone') {
      // 404/410: revoke THIS subscription only and erase its secrets
      await tx`
        UPDATE push_subscriptions
           SET revoked_at = NOW(), revoke_reason = 'gone', endpoint_ct = NULL, keys_ct = NULL
         WHERE id = ${row.payload.subscription_id} AND revoked_at IS NULL`;
    }
    if (outcome.status === 'failed' && outcome.detail !== 'gone') {
      await tx`UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ${row.payload.subscription_id}`;
    }
  });
}

/**
 * Retention and revocation (design §12.13; REQ-F14.5.3, F14.5.8). Idempotent, bounded per pass,
 * counts only. Every rule is a condition on a row (no tenant mixing):
 *  - revoke (and erase ciphertext) when the ticket ended, was missed beyond its grace window,
 *    its queue session closed, the subscription expired, or its credential was revoked;
 *  - delete tombstones 24 hours after revocation;
 *  - delete web_push notification rows (with their outbox and delivery rows) after 30 days;
 *  - delete per-ticket subscription-change throttle windows an hour after they started.
 */
export interface AlertRetentionResult {
  revoked: number;
  tombstonesDeleted: number;
  /** per-ticket subscription-change windows older than an hour (they last one minute) */
  throttleDeleted: number;
  notificationsDeleted: number;
}

export async function purgeAlertData(
  sql: postgres.Sql,
  opts: { batch?: number } = {},
): Promise<AlertRetentionResult> {
  const batch = opts.batch ?? 1000;
  const revoked = await sql`
    WITH due AS (
      SELECT * FROM (
      SELECT ps.id,
             CASE
               WHEN t.state IN ('completed', 'cancelled', 'transferred') THEN 'ticket_ended'
               WHEN t.state = 'missed' AND t.missed_at IS NOT NULL
                    AND t.missed_at + make_interval(secs => COALESCE((s.policy ->> 'grace_window_seconds')::int, 300)) < NOW()
                 THEN 'ticket_ended'
               WHEN qs.state = 'closed' THEN 'session_closed'
               WHEN ps.credential_id IS NULL OR cr.revoked_at IS NOT NULL OR cr.expires_at <= NOW() THEN 'credentials_revoked'
               WHEN ps.expires_at <= NOW() THEN 'expired'
             END AS reason
        FROM push_subscriptions ps
        JOIN tickets t ON t.id = ps.ticket_id
        JOIN queue_sessions qs ON qs.id = t.queue_session_id
        JOIN services s ON s.id = qs.service_id
        LEFT JOIN ticket_recovery_credentials cr ON cr.id = ps.credential_id
       WHERE ps.revoked_at IS NULL) x
       WHERE x.reason IS NOT NULL
       LIMIT ${batch})
    UPDATE push_subscriptions ps
       SET revoked_at = NOW(), revoke_reason = due.reason, endpoint_ct = NULL, keys_ct = NULL
      FROM due
     WHERE ps.id = due.id AND ps.revoked_at IS NULL`;
  const tombstones = await sql`
    DELETE FROM push_subscriptions WHERE id IN (
      SELECT id FROM push_subscriptions WHERE revoked_at < NOW() - INTERVAL '24 hours' LIMIT ${batch})`;
  const notifications = await sql`
    DELETE FROM notifications WHERE id IN (
      SELECT id FROM notifications
       WHERE channel = 'web_push' AND created_at < NOW() - INTERVAL '30 days' LIMIT ${batch})`;
  const throttle = await sql`
    DELETE FROM push_subscription_throttle WHERE ticket_id IN (
      SELECT ticket_id FROM push_subscription_throttle
       WHERE window_started_at < NOW() - INTERVAL '1 hour' LIMIT ${batch})`;
  return {
    revoked: revoked.count,
    tombstonesDeleted: tombstones.count,
    throttleDeleted: throttle.count,
    notificationsDeleted: notifications.count,
  };
}
