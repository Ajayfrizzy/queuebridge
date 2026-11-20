import {
  SMS_TURN_ALERT_TEMPLATE,
  maxSmsDelaySeconds,
  smsIdempotencyKey,
} from '@queuebridge/contracts';
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
/**
 * M6.3: the API deployment's turn-alert TTL (`TURN_ALERT_TTL_SECONDS`, the value the worker also
 * reads), supplied by each app at install. The hook is process-wide, so the most recently
 * installed app that is still open supplies it; a closed app hands it back to the one before
 * (one app per process in production; several only in tests). Until an app installs one, the
 * environment schema's default applies.
 */
const DEFAULT_TTL_SECONDS = 120;
const ttlStack: { ttlSeconds: number }[] = [];
let lastTtlSeconds = DEFAULT_TTL_SECONDS;
function currentTtlSeconds(): number {
  return ttlStack.at(-1)?.ttlSeconds ?? lastTtlSeconds;
}

async function enqueueSmsTurnAlert(
  sp: Db,
  session: { id: string; organization_id: string; facility_id: string },
  call: { ticketId: string; sequence: number; counterId: string | null },
): Promise<void> {
  // M6.3 optional delay: used only when it is still safe for THIS call under the deployment's
  // CURRENT turn-alert TTL and this service's CURRENT automatic no-show (the same bound as at
  // save, `maxSmsDelaySeconds`); otherwise the SMS goes immediately, as without the setting, so
  // a TTL lowered or a stricter no-show set after the facility saved its delay can never make
  // a delayed alert expire unsent or arrive after the no-show. The worker's own TTL check
  // (`ttl_elapsed`, never sent late) is unchanged.
  const [d] = await sp<
    { delay_seconds: number | null; auto_on: boolean | null; auto_after: number | null }[]
  >`
    SELECT fs.delay_seconds,
           (s.policy -> 'auto_miss' ->> 'enabled')::boolean AS auto_on,
           (s.policy -> 'auto_miss' ->> 'after_seconds')::int AS auto_after
      FROM queue_sessions qs
      JOIN services s ON s.id = qs.service_id
      LEFT JOIN facility_sms_settings fs
        ON fs.facility_id = qs.facility_id AND fs.organization_id = qs.organization_id
     WHERE qs.id = ${session.id} AND qs.organization_id = ${session.organization_id}`;
  const saved = d?.delay_seconds ?? null;
  const max =
    saved !== null
      ? maxSmsDelaySeconds(currentTtlSeconds(), d?.auto_on ? (d.auto_after ?? null) : null)
      : null;
  const delay = saved !== null && max !== null && saved <= max ? saved : 0;
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
      INSERT INTO notification_outbox (notification_id, dedup_key, payload, next_attempt_at)
      SELECT c.nid, ${smsIdempotencyKey(SMS_TURN_ALERT_TEMPLATE, call.ticketId, call.sequence)},
             jsonb_build_object('contact_id', c.contact_id, 'event_sequence', ${call.sequence}::int,
                                'ticket_id', ${call.ticketId}::uuid, 'counter_id', ${call.counterId}::uuid,
                                'facility_id', ${session.facility_id}::uuid,
                                'skip_if_seen', ${delay > 0}::boolean),
             NOW() + make_interval(secs => ${delay})
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

/**
 * Install the SMS alert hook (idempotent; registering by name replaces) with this app's
 * turn-alert TTL. Returns a release function for the TTL only: the hook itself stays registered
 * (process-wide, shared by other app instances), as before.
 */
export function installSmsAlerts(opts: { ttlSeconds: number }): () => void {
  registerTransitionHook(smsAlertHook);
  const entry = { ttlSeconds: opts.ttlSeconds };
  ttlStack.push(entry);
  lastTtlSeconds = opts.ttlSeconds;
  return () => {
    const i = ttlStack.indexOf(entry);
    if (i >= 0) ttlStack.splice(i, 1);
    const top = ttlStack.at(-1);
    if (top) lastTtlSeconds = top.ttlSeconds;
  };
}
