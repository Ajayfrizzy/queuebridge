import { QueueAction, QueueSessionState } from '@queuebridge/contracts';
import type { Db } from '../db.js';
import { isUniqueViolation, problems } from '../errors.js';
import { appendEvent, lockSessions } from './events.js';
import { ensureTicketPrefix } from './tickets.js';

export interface OpenSessionResult {
  queueId: string;
  created: boolean;
  state: QueueSessionState;
}

/**
 * Open today's queue session (facility time zone) for a service, idempotently.
 * Creates the session with its genesis `queue.open` event; if today's session already exists it
 * is returned unchanged (reopening a paused/closed session is an explicit `queue.open` command).
 */
export async function openTodaysSession(
  db: Db,
  input: { organizationId: string; facilityId: string; serviceId: string; actorId: string },
): Promise<OpenSessionResult> {
  const existing = async (): Promise<OpenSessionResult | null> => {
    const rows = await db<{ id: string; state: QueueSessionState }[]>`
      SELECT qs.id, qs.state FROM queue_sessions qs JOIN facilities f ON f.id = qs.facility_id
       WHERE qs.organization_id = ${input.organizationId} AND qs.facility_id = ${input.facilityId}
         AND qs.service_id = ${input.serviceId}
         AND qs.operational_date = (NOW() AT TIME ZONE f.timezone)::date`;
    return rows[0] ? { queueId: rows[0].id, created: false, state: rows[0].state } : null;
  };

  const found = await existing();
  if (found) return found;

  const svc = await db<{ status: string }[]>`
    SELECT status FROM services
     WHERE id = ${input.serviceId} AND facility_id = ${input.facilityId}
       AND organization_id = ${input.organizationId}`;
  if (!svc[0]) throw problems.notFound();
  if (svc[0].status !== 'active')
    throw problems.conflict('Activate the service before opening its queue.');

  try {
    return await db.begin(async (tx) => {
      await ensureTicketPrefix(tx, input.facilityId, input.serviceId);
      const created = await tx<{ id: string }[]>`
        INSERT INTO queue_sessions (facility_id, organization_id, service_id, operational_date, state)
        SELECT ${input.facilityId}, ${input.organizationId}, ${input.serviceId},
               (NOW() AT TIME ZONE f.timezone)::date, 'open'
          FROM facilities f WHERE f.id = ${input.facilityId} AND f.organization_id = ${input.organizationId}
        RETURNING id`;
      const id = created[0]?.id;
      if (!id) throw problems.notFound();
      const session = (await lockSessions(tx, input.organizationId, [id])).get(id);
      if (!session) throw new Error('created session not lockable');
      await appendEvent(tx, session, {
        eventType: QueueAction.QUEUE_OPEN,
        actorId: input.actorId,
        operationId: null,
        payload: {
          from_state: QueueSessionState.CLOSED,
          to_state: QueueSessionState.OPEN,
          genesis: true,
        },
      });
      return { queueId: id, created: true, state: QueueSessionState.OPEN };
    });
  } catch (err) {
    // Concurrent open of the same service/day: the other transaction won; return its session
    if (isUniqueViolation(err, 'queue_sessions_facility_service_date_idx')) {
      const again = await existing();
      if (again) return again;
    }
    throw err;
  }
}
