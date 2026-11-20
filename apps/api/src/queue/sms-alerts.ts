import { SMS_TURN_ALERT_TEMPLATE, smsIdempotencyKey } from '@queuebridge/contracts';
import type { Db } from '../db.js';
import { registerTransitionHook, type AppendedTransition, type TransitionHook } from './events.js';

/**
 * M6.1 SMS turn alert enqueue (design §13.1; REQ-F11.8, F11.10). Same pattern as the push hook
 * (`turn-alerts.ts`), registered separately so each runs in its OWN savepoint: an SMS failure can
 * neither fail the queue command nor stop the push or in-app alert, and the other way round.
 *
 * It runs inside `appendEvent`, i.e. only for a transition the server is committing (online or a
 * synced offline command); an offline-applied, local-only action never reaches it. It does no
 * network I/O and reads no phone number: the outbox payload holds ids and the call sequence only.
 *
 * One outbox + notification pair for the ticket's consented, active contact when the facility
 * has SMS on. Key: `sms:ticket.called:<ticket_id>:<event_sequence>` (one contact per ticket).
 * The deployment check (provider, cap) is the worker's: enqueueing never depends on it.
 */

let enqueueErrors = 0;
let logger: { warn: (o: object, msg: string) => void } = { warn: () => undefined };
let faultForTests: ((sp: Db) => Promise<void>) | null = null;

export function setSmsAlertLogger(l: { warn: (o: object, msg: string) => void }): void {
  logger = l;
}
/** TEST-ONLY: make the hook throw inside its savepoint. */
export function setSmsAlertFaultForTests(fault: ((sp: Db) => Promise<void>) | null): void {
  faultForTests = fault;
}
export function smsAlertEnqueueErrors(): number {
  return enqueueErrors;
}

async function enqueueSmsTurnAlert(
  sp: Db,
  session: { id: string; organization_id: string; facility_id: string },
  call: { ticketId: string; sequence: number; counterId: string | null },
): Promise<void> {
  await sp`
    WITH c AS (
      SELECT vc.id AS contact_id, gen_random_uuid() AS nid
        FROM visitor_contacts vc
        JOIN facility_sms_settings fs
          ON fs.facility_id = vc.facility_id AND fs.organization_id = vc.organization_id
       WHERE vc.ticket_id = ${call.ticketId} AND vc.organization_id = ${session.organization_id}
         AND vc.facility_id = ${session.facility_id}
         AND vc.phone_ciphertext IS NOT NULL AND vc.consent_at IS NOT NULL
         AND vc.opted_out_at IS NULL AND vc.erased_at IS NULL
         AND fs.enabled
    ), o AS (
      INSERT INTO notification_outbox (notification_id, dedup_key, payload)
      SELECT c.nid, ${smsIdempotencyKey(SMS_TURN_ALERT_TEMPLATE, call.ticketId, call.sequence)},
             jsonb_build_object('contact_id', c.contact_id, 'event_sequence', ${call.sequence}::int,
                                'ticket_id', ${call.ticketId}::uuid, 'counter_id', ${call.counterId}::uuid,
                                'facility_id', ${session.facility_id}::uuid)
        FROM c
      ON CONFLICT (dedup_key) DO NOTHING
      RETURNING notification_id
    )
    INSERT INTO notifications
      (id, organization_id, ticket_id, channel, template_key, status, visitor_contact_id, event_sequence)
    SELECT c.nid, ${session.organization_id}, ${call.ticketId}, 'sms', ${SMS_TURN_ALERT_TEMPLATE},
           'pending', c.contact_id, ${call.sequence}
      FROM c JOIN o ON o.notification_id = c.nid`;
}

export const smsAlertHook: TransitionHook = {
  name: 'sms-alerts',
  async run(sp, session, t: AppendedTransition): Promise<void> {
    if (t.to === 'called') {
      if (faultForTests) await faultForTests(sp);
      const counterId = t.payload['counter_id'];
      await enqueueSmsTurnAlert(sp, session, {
        ticketId: t.ticketId,
        sequence: t.sequence,
        counterId: typeof counterId === 'string' ? counterId : null,
      });
      return;
    }
    // A service transfer creates a new ticket row: the visitor's contact follows it
    const destination = t.payload['destination_ticket_id'];
    if (t.to === 'transferred' && typeof destination === 'string') {
      if (faultForTests) await faultForTests(sp);
      await sp`
        UPDATE visitor_contacts SET ticket_id = ${destination}
         WHERE ticket_id = ${t.ticketId} AND organization_id = ${session.organization_id}`;
    }
  },
  onError(err, ids): void {
    enqueueErrors += 1;
    // Ids and the error class only: never a number, a hash or a payload
    logger.warn(
      {
        ...ids,
        error: err instanceof Error ? err.name : 'unknown',
        sms_enqueue_errors: enqueueErrors,
      },
      'SMS alert enqueue failed; the queue command continues',
    );
  },
};

/** Install the SMS alert hook (idempotent; registering by name replaces). */
export function installSmsAlerts(): () => void {
  return registerTransitionHook(smsAlertHook);
}
