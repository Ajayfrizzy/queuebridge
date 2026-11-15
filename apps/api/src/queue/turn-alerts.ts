import { TURN_ALERT_TEMPLATE } from '@queuebridge/contracts';
import type { Db } from '../db.js';
import { registerTransitionHook, type AppendedTransition, type TransitionHook } from './events.js';

/**
 * M5.4 turn-alert enqueue (REQ-F14.2, F14.7, F14.8; design §12.4; ADR-013 §4).
 *
 * Registered (by `app.ts`, through `installTurnAlerts`) as a transition hook of `appendEvent`,
 * so EVERY committed event that leaves a ticket `called` alerts through the same code: call
 * next, out-of-order call, counter transfer of a called ticket, an offline coordinator's call
 * when the sync batch commits it, a conflict a supervisor applies. An offline-applied action
 * alerts nobody until it is committed. The queue core never imports this module, so the
 * command executor and the automatic no-show sweep have no import path to alert code.
 *
 * Isolation: `appendEvent` runs the hook inside a SAVEPOINT of the queue transaction and the
 * hook does no network I/O. Any error rolls back to the savepoint, is logged and counted, and
 * the queue command commits normally: alert code can never fail or change a queue command.
 */

export interface TurnAlertLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

let logger: TurnAlertLogger = { warn: () => undefined };
/** Errors swallowed by the savepoint since this process started. */
let enqueueErrors = 0;
/** The same errors per facility, as timestamps, for the supervisors' last-hour counter. */
const HOUR_MS = 3_600_000;
const errorsByFacility = new Map<string, number[]>();

export function setTurnAlertLogger(l: TurnAlertLogger): void {
  logger = l;
}
export function turnAlertEnqueueErrors(): number {
  return enqueueErrors;
}
/** Enqueue errors at one facility in the last hour (this process only). */
export function facilityEnqueueErrors(facilityId: string, now = Date.now()): number {
  const recent = (errorsByFacility.get(facilityId) ?? []).filter((t) => now - t < HOUR_MS);
  if (recent.length === 0) errorsByFacility.delete(facilityId);
  else errorsByFacility.set(facilityId, recent);
  return recent.length;
}

/**
 * TESTS ONLY: run this inside the savepoint before the real work, to prove that a failure there
 * (for example a deliberately failing SQL statement) cannot fail the queue command.
 */
let faultForTests: ((tx: Db) => Promise<void>) | null = null;
export function setTurnAlertFaultForTests(fn: ((tx: Db) => Promise<void>) | null): void {
  faultForTests = fn;
}

/**
 * One `notifications` + `notification_outbox` pair per ACTIVE subscription of the ticket,
 * created together in one statement (the outbox row first; the notification only for rows the
 * outbox accepted), so a replayed key skips exactly that device and never leaves half a pair.
 * Key: `web_push:ticket.called:<ticket_id>:<event_sequence>:<subscription_id>`.
 */
async function enqueueTurnAlerts(
  sp: Db,
  session: { id: string; organization_id: string },
  call: { ticketId: string; sequence: number; counterId: string | null },
): Promise<void> {
  await sp`
    WITH k AS (
      SELECT gen_random_uuid() AS nid, s.id AS sub_id,
             ${`web_push:${TURN_ALERT_TEMPLATE}:${call.ticketId}:${call.sequence}:`}::text
               || s.id::text AS dedup
        FROM push_subscriptions s
       WHERE s.ticket_id = ${call.ticketId} AND s.organization_id = ${session.organization_id}
         AND s.revoked_at IS NULL AND s.expires_at > NOW()
       ORDER BY s.id
    ), o AS (
      INSERT INTO notification_outbox (notification_id, dedup_key, payload)
      SELECT k.nid, k.dedup,
             jsonb_build_object('subscription_id', k.sub_id, 'event_sequence', ${call.sequence}::int,
                                'ticket_id', ${call.ticketId}::uuid, 'counter_id', ${call.counterId}::uuid)
        FROM k
      ON CONFLICT (dedup_key) DO NOTHING
      RETURNING notification_id
    )
    INSERT INTO notifications
      (id, organization_id, ticket_id, channel, template_key, status, push_subscription_id, event_sequence)
    SELECT k.nid, ${session.organization_id}, ${call.ticketId}, 'web_push', ${TURN_ALERT_TEMPLATE},
           'pending', k.sub_id, ${call.sequence}
      FROM k JOIN o ON o.notification_id = k.nid`;
}

/**
 * A service transfer creates a new ticket row: the visitor's active subscriptions follow it
 * (same `subscription_id`, so the saved `pushRef` stays valid).
 */
async function rebindTurnAlertSubscriptions(
  sp: Db,
  session: { id: string; organization_id: string },
  fromTicketId: string,
  toTicketId: string,
): Promise<void> {
  await sp`
    UPDATE push_subscriptions SET ticket_id = ${toTicketId}
     WHERE ticket_id = ${fromTicketId} AND organization_id = ${session.organization_id}
       AND revoked_at IS NULL`;
}

export const turnAlertHook: TransitionHook = {
  name: 'turn-alerts',
  async run(sp, session, t: AppendedTransition): Promise<void> {
    if (t.to === 'called') {
      if (faultForTests) await faultForTests(sp);
      const counterId = t.payload['counter_id'];
      await enqueueTurnAlerts(sp, session, {
        ticketId: t.ticketId,
        sequence: t.sequence,
        counterId: typeof counterId === 'string' ? counterId : null,
      });
      return;
    }
    const destination = t.payload['destination_ticket_id'];
    if (t.to === 'transferred' && typeof destination === 'string') {
      if (faultForTests) await faultForTests(sp);
      await rebindTurnAlertSubscriptions(sp, session, t.ticketId, destination);
    }
  },
  onError(err, ids): void {
    enqueueErrors += 1;
    const now = Date.now();
    const list = (errorsByFacility.get(ids.facility_id) ?? []).filter((t) => now - t < HOUR_MS);
    list.push(now);
    errorsByFacility.set(ids.facility_id, list);
    if (errorsByFacility.size > 10_000) errorsByFacility.clear();
    // Ids and the error class only: never payloads, endpoints or credentials
    logger.warn(
      { ...ids, error: err instanceof Error ? err.name : 'unknown', enqueue_errors: enqueueErrors },
      'turn alert enqueue failed; the queue command continues',
    );
  },
};

/** Install the turn-alert hook (idempotent; registering by name replaces). */
export function installTurnAlerts(): () => void {
  return registerTransitionHook(turnAlertHook);
}
