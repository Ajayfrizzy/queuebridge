import {
  QueueAction,
  TicketState,
  type CounterAvailabilityRequest,
  type CounterAvailabilityResult,
} from '@queuebridge/contracts';
import { recordAdminEvent } from '../admin-events.js';
import { queueActorRoles, requireFacilityPermission, type AuthContext } from '../auth/rbac.js';
import type { Db } from '../db.js';
import { ApiProblem, problems } from '../errors.js';
import { appendEvent, lockSessions, type LockedSession } from './events.js';
import { QUEUE_CHANNEL, type QueueSignal } from './notifier.js';

/** Roles that may change a counter's availability at all. */
const AVAILABILITY_ROLES = ['staff_counter', 'supervisor', 'facility_admin'] as const;
/** Roles that may take out of service a counter still calling a visitor (who is released). */
export const RELEASE_ROLES = ['supervisor', 'facility_admin'] as const;

/**
 * Open or close a counter for the day (operational availability; the admin `active` switch is
 * separate). A closed counter receives no new assignments.
 *
 * Closing a counter that is CALLING a visitor returns that visitor to the head of their queue
 * (`ticket.release`, waiting age kept) so the next open, capable counter calls them first — the
 * pull-model equivalent of reassigning waiting tickets. Only supervisors / facility admins may do
 * that; a counter that is SERVING someone cannot be closed until that visit is completed or
 * handed over. While an offline coordinator holds any affected queue, releasing is refused (the
 * coordinator may have acted on that ticket offline). Idempotent: repeating a state is a no-op.
 */
export async function setCounterAvailability(
  db: Db,
  auth: AuthContext,
  counterId: string,
  body: CounterAvailabilityRequest,
): Promise<CounterAvailabilityResult> {
  const found = await db<{ id: string; facility_id: string }[]>`
    SELECT id, facility_id FROM counters WHERE id = ${counterId} AND organization_id = ${auth.organizationId}`;
  const c0 = found[0];
  if (!c0) throw problems.notFound();
  await requireFacilityPermission(db, auth, c0.facility_id, 'QUEUE_VIEW');
  const roles = queueActorRoles(auth, c0.facility_id);
  if (!roles.some((r) => (AVAILABILITY_ROLES as readonly string[]).includes(r))) {
    throw problems.forbidden();
  }

  const result = await db.begin(async (tx) => {
    const { sessions, counter } = await lockCounterScope(tx, auth, counterId, c0.facility_id);
    if (counter.availability === body.availability) {
      return { changed: false, released: [] as CounterAvailabilityResult['released'] };
    }
    const released =
      body.availability === 'closed'
        ? await vacateCounter(tx, auth, counter, sessions, {
            mayRelease: roles.some((r) => (RELEASE_ROLES as readonly string[]).includes(r)),
            reasonCode: `counter_closed:${body.reason_code ?? 'other'}`,
          })
        : [];
    await tx`
      UPDATE counters SET availability = ${body.availability}, availability_changed_at = NOW(),
             availability_changed_by = ${auth.staffUserId}, updated_at = NOW()
       WHERE id = ${counter.id}`;
    await recordAdminEvent(tx, {
      organizationId: auth.organizationId,
      facilityId: c0.facility_id,
      actorId: auth.staffUserId,
      eventType: `counter.${body.availability === 'open' ? 'opened' : 'closed'}`,
      targetType: 'counter',
      targetId: counter.id,
      details: { reason_code: body.reason_code ?? null, released: released.length },
    });
    await signalCounterQueues(tx, auth, c0.facility_id, counter.id);
    return { changed: true, released };
  });

  return {
    counter_id: counterId,
    availability: body.availability,
    changed: result.changed,
    released: result.released,
    services_without_open_counter: await servicesWithoutOpenCounter(db, auth, counterId),
  };
}

export interface ScopedCounter {
  id: string;
  name: string;
  active: boolean;
  availability: 'open' | 'closed';
}

/**
 * Lock everything a change of this counter's service state can affect, in the GLOBAL lock order
 * used by every queue command: queue sessions first (id order), THEN the counter. Sessions: every
 * session of a service this counter can serve today (where calls to it come from) plus any
 * session holding a ticket at it. Queue commands lock their session before touching a ticket or
 * a counter, so a serve, call or transfer at this counter can never interleave with the change.
 */
export async function lockCounterScope(
  tx: Db,
  auth: AuthContext,
  counterId: string,
  facilityId: string,
): Promise<{ sessions: Map<string, LockedSession>; counter: ScopedCounter }> {
  const candidateSessions = await tx<{ id: string }[]>`
    SELECT DISTINCT qs.id FROM queue_sessions qs
      JOIN facilities f ON f.id = qs.facility_id
     WHERE qs.organization_id = ${auth.organizationId}
       AND (
         (qs.operational_date = (NOW() AT TIME ZONE f.timezone)::date AND EXISTS (
            SELECT 1 FROM counter_service_capabilities csc
             WHERE csc.counter_id = ${counterId} AND csc.service_id = qs.service_id))
         OR EXISTS (SELECT 1 FROM tickets t WHERE t.queue_session_id = qs.id
                     AND t.current_counter_id = ${counterId} AND t.state IN ('called', 'serving'))
       )`;
  const sessions = await lockSessions(
    tx,
    auth.organizationId,
    candidateSessions.map((x) => x.id),
  );
  const locked = await tx<ScopedCounter[]>`
    SELECT id, name, active, availability FROM counters
     WHERE id = ${counterId} AND facility_id = ${facilityId}
       AND organization_id = ${auth.organizationId} FOR UPDATE`;
  const counter = locked[0];
  if (!counter) throw problems.notFound();
  return { sessions, counter };
}

/**
 * Make a counter safe to take out of service (closed OR deactivated), under the locks taken by
 * `lockCounterScope`. Invariant: no out-of-service counter holds a called or serving ticket.
 *
 * - SERVING visitor → refused (409): finish the visit or hand it to another counter first.
 * - CALLED visitor → atomically returned to the head of their queue (`ticket.release`: called →
 *   waiting, counter cleared, waiting age kept), if the actor may release (supervisor / facility
 *   admin) and no offline coordinator holds that queue (it may have acted on the ticket offline).
 */
export async function vacateCounter(
  tx: Db,
  auth: AuthContext,
  counter: ScopedCounter,
  sessions: Map<string, LockedSession>,
  opts: { mayRelease: boolean; reasonCode: string },
): Promise<{ queue_id: string; public_code: string }[]> {
  // Fresh statement AFTER the locks: sees every ticket committed before we acquired them
  const active = await tx<
    { id: string; queue_session_id: string; public_code: string; state: string }[]
  >`
    SELECT id, queue_session_id, public_code, state FROM tickets
     WHERE current_counter_id = ${counter.id} AND organization_id = ${auth.organizationId}
       AND state IN ('called', 'serving')
       FOR UPDATE`;
  if (active.some((t) => t.state === TicketState.SERVING)) {
    throw problems.conflict(
      `${counter.name} is serving a visitor. Complete the visit or hand it to another counter first.`,
    );
  }
  if (active.length > 0 && !opts.mayRelease) {
    throw new ApiProblem(403, 'forbidden', 'Forbidden', {
      detail: `${counter.name} is calling a visitor. Only a supervisor can take it out of service and return that visitor to the queue.`,
    });
  }
  const released: { queue_id: string; public_code: string }[] = [];
  for (const t of active) {
    const session = sessions.get(t.queue_session_id);
    // A ticket appeared in a session we did not lock (raced in): refuse rather than guess
    if (!session) throw problems.conflict('The counter changed meanwhile. Try again.');
    if (session.coordinator_device_id !== null) {
      throw new ApiProblem(409, 'coordinator-active', 'Offline coordinator active', {
        detail: `An offline coordinator holds ${session.service_name}. End its authority before releasing ${t.public_code}.`,
      });
    }
    await tx`
      UPDATE tickets SET state = 'waiting', current_counter_id = NULL, called_at = NULL,
             version = version + 1, updated_at = NOW()
       WHERE id = ${t.id}`;
    await appendEvent(tx, session, {
      eventType: QueueAction.TICKET_RELEASE,
      actorId: auth.staffUserId,
      operationId: null,
      payload: {
        ticket_id: t.id,
        public_code: t.public_code,
        from_state: TicketState.CALLED,
        to_state: TicketState.WAITING,
        counter_id: null,
        from_counter_id: counter.id,
        reason_code: opts.reasonCode,
        policy_version: session.policy.version,
      },
      transition: { ticketId: t.id, from: TicketState.CALLED, to: TicketState.WAITING },
    });
    released.push({ queue_id: session.id, public_code: t.public_code });
  }
  return released;
}

/** Staff consoles of today's queues served by this counter refresh (signal only, no data). */
export async function signalCounterQueues(
  tx: Db,
  auth: AuthContext,
  facilityId: string,
  counterId: string,
): Promise<void> {
  const todays = await tx<{ id: string; revision: number }[]>`
    SELECT qs.id, qs.revision FROM queue_sessions qs
      JOIN facilities f ON f.id = qs.facility_id
      JOIN counter_service_capabilities csc ON csc.service_id = qs.service_id AND csc.counter_id = ${counterId}
     WHERE qs.organization_id = ${auth.organizationId}
       AND qs.operational_date = (NOW() AT TIME ZONE f.timezone)::date`;
  for (const s of todays) {
    const signal: QueueSignal = { f: facilityId, s: s.id, r: s.revision };
    await tx`SELECT pg_notify(${QUEUE_CHANNEL}, ${JSON.stringify(signal)})`;
  }
}

/** Active services this counter serves that now have no active, open counter at all. */
export async function servicesWithoutOpenCounter(
  db: Db,
  auth: AuthContext,
  counterId: string,
): Promise<{ service_id: string; name: string }[]> {
  return db<{ service_id: string; name: string }[]>`
    SELECT s.id AS service_id, s.name FROM services s
      JOIN counter_service_capabilities csc ON csc.service_id = s.id AND csc.counter_id = ${counterId}
     WHERE s.organization_id = ${auth.organizationId} AND s.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM counters c JOIN counter_service_capabilities x ON x.counter_id = c.id
          WHERE x.service_id = s.id AND c.active AND c.availability = 'open')
     ORDER BY s.name`;
}
