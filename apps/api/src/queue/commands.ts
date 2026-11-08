import {
  QueueAction,
  QueueSessionState,
  TicketState,
  type CommandOutcome,
  type PriorityClass,
  type QueueCommandRequest,
  type Role,
} from '@queuebridge/contracts';
import {
  ACTIVE_TICKET_STATES,
  selectNextTicket,
  sessionTransition,
  transition,
  TRANSITION_RULES,
} from '@queuebridge/domain';
import { Permission, queueActorRoles, type AuthContext } from '../auth/rbac.js';
import type { Db } from '../db.js';
import { isUniqueViolation, problems } from '../errors.js';
import { appendEvent, lockSessions, type LockedSession } from './events.js';
import { issueTicket } from './tickets.js';

/** A business-rule rejection: recorded as the operation's disposition and replayed on retry. */
export class CommandRejected extends Error {
  public constructor(
    public readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'CommandRejected';
  }
}

const reject = (code: string, message: string): never => {
  throw new CommandRejected(code, message);
};

interface TicketRow {
  id: string;
  public_code: string;
  state: TicketState;
  priority_class: PriorityClass;
  issued_sequence: number;
  current_counter_id: string | null;
  missed_at: Date | null;
  joined_at: Date;
}

interface StoredOperation {
  queue_session_id: string;
  action: string;
  status: string;
  result_json: CommandOutcome;
}

const SESSION_ACTIONS: string[] = [
  QueueAction.QUEUE_OPEN,
  QueueAction.QUEUE_PAUSE,
  QueueAction.QUEUE_CLOSE,
];

/**
 * Roles that may manage sessions (Permission.QUEUE_MANAGE) — evaluated server-side from the
 * session's role grants, never from the request.
 */
function canManage(roles: Role[]): boolean {
  const allowed: readonly Role[] = Permission.QUEUE_MANAGE;
  return roles.some((r) => allowed.includes(r));
}

/**
 * Evaluate a ticket transition against every role the actor holds at the facility, using the
 * domain transition table as the single source of truth:
 *  - no held role may ever perform this action        → 403 (not recorded)
 *  - the ticket's state does not allow the action      → rejected 'invalid_state'
 *  - the state allows it, but not for the held roles   → 403
 *  - a policy precondition fails (grace window)        → rejected 'grace_window_expired'
 */
function authorizeTransition(
  roles: Role[],
  from: TicketState,
  action: QueueAction,
  satisfiedPolicies: string[] = [],
): TicketState {
  const forAction = TRANSITION_RULES.filter((r) => r.action === action);
  if (!forAction.some((r) => r.allowedRoles.some((ar) => roles.includes(ar)))) {
    throw problems.forbidden();
  }
  if (from === TicketState.NEEDS_REVIEW) {
    return reject('needs_review', 'This ticket needs supervisor review before it can change.');
  }
  const forState = forAction.filter((r) => r.from === from);
  if (forState.length === 0) {
    return reject('invalid_state', `A ${from} ticket cannot be changed with ${action}.`);
  }
  if (!forState.some((r) => r.allowedRoles.some((ar) => roles.includes(ar)))) {
    throw problems.forbidden();
  }
  for (const role of roles) {
    const r = transition({ currentState: from, action, actorRole: role, satisfiedPolicies });
    if (r.success) return r.newState;
  }
  return reject('grace_window_expired', 'The grace window for this missed ticket has expired.');
}

async function lockTicket(tx: Db, session: LockedSession, ticketId: string): Promise<TicketRow> {
  const rows = await tx<TicketRow[]>`
    SELECT id, public_code, state, priority_class, issued_sequence, current_counter_id, missed_at, joined_at
      FROM tickets
     WHERE id = ${ticketId} AND queue_session_id = ${session.id}
       AND organization_id = ${session.organization_id}
       FOR UPDATE`;
  const t = rows[0];
  // A ticket from another queue session or tenant is indistinguishable from a missing one
  if (!t) throw problems.notFound();
  return t;
}

export interface ExecuteCommandInput {
  auth: AuthContext;
  queueId: string;
  facilityId: string;
  command: QueueCommandRequest;
}

/**
 * Execute one online queue command atomically (architecture "server transaction" steps 1–6):
 * authenticate (caller) → deduplicate by (organization_id, operation_id) → lock session row(s)
 * → validate role, state and policy preconditions → apply state, append hash-chained event,
 * record the operation's disposition → return committed | duplicate | rejected.
 */
export async function executeCommand(db: Db, input: ExecuteCommandInput): Promise<CommandOutcome> {
  const { auth, command } = input;
  const roles = queueActorRoles(auth, input.facilityId);

  // Transfers lock two sessions; resolve the destination first so both are locked in id order.
  let destinationQueueId: string | null = null;
  if (command.action === QueueAction.TICKET_TRANSFER && command.destination_service_id) {
    const dest = await db<{ id: string }[]>`
      SELECT qs.id FROM queue_sessions qs
        JOIN facilities f ON f.id = qs.facility_id
       WHERE qs.organization_id = ${auth.organizationId} AND qs.facility_id = ${input.facilityId}
         AND qs.service_id = ${command.destination_service_id}
         AND qs.operational_date = (NOW() AT TIME ZONE f.timezone)::date`;
    destinationQueueId = dest[0]?.id ?? null;
  }

  try {
    return await db.begin(async (tx) => {
      const locked = await lockSessions(tx, auth.organizationId, [
        input.queueId,
        ...(destinationQueueId ? [destinationQueueId] : []),
      ]);
      const session = locked.get(input.queueId);
      if (!session || session.facility_id !== input.facilityId) throw problems.notFound();

      // Deduplicate: an operation id can only ever produce one disposition
      const prior = await tx<StoredOperation[]>`
        SELECT queue_session_id, action, status, result_json FROM client_operations
         WHERE organization_id = ${auth.organizationId} AND operation_id = ${command.operation_id}`;
      const existing = prior[0];
      if (existing) {
        if (existing.queue_session_id !== session.id || existing.action !== command.action) {
          throw problems.conflict('This operation id was already used for a different command.');
        }
        return existing.status === 'committed'
          ? { ...existing.result_json, disposition: 'duplicate' as const }
          : existing.result_json;
      }

      let outcome: CommandOutcome;
      try {
        outcome = await apply(tx, session, locked, destinationQueueId, roles, auth, command);
      } catch (err) {
        if (!(err instanceof CommandRejected)) throw err;
        outcome = {
          disposition: 'rejected',
          operation_id: command.operation_id,
          action: command.action,
          server_revision: session.revision,
          server_sequence: null,
          ticket_id: command.ticket_id ?? null,
          public_code: null,
          reason_code: err.reasonCode,
          message: err.message,
        };
      }

      await tx`
        INSERT INTO client_operations
          (organization_id, queue_session_id, device_id, actor_id, operation_id, client_sequence,
           action, status, result_json, source)
        VALUES (${auth.organizationId}, ${session.id}, NULL, ${auth.staffUserId}, ${command.operation_id},
                0, ${command.action}, ${outcome.disposition}, ${tx.json(outcome as never)}, 'online')`;
      return outcome;
    });
  } catch (err) {
    // Same operation id raced in another transaction (e.g. a different session): exactly one
    // committed; report this attempt as a duplicate of the stored result.
    if (isUniqueViolation(err, 'client_operations_org_op_idx')) {
      const rows = await db<StoredOperation[]>`
        SELECT queue_session_id, action, status, result_json FROM client_operations
         WHERE organization_id = ${auth.organizationId} AND operation_id = ${command.operation_id}`;
      const stored = rows[0];
      if (stored && stored.queue_session_id === input.queueId && stored.action === command.action) {
        return stored.status === 'committed'
          ? { ...stored.result_json, disposition: 'duplicate' }
          : stored.result_json;
      }
      throw problems.conflict('This operation id was already used for a different command.');
    }
    // Database-level backstops (should be unreachable thanks to the locks above)
    if (isUniqueViolation(err, 'tickets_one_active_per_counter_idx')) {
      throw problems.conflict('That counter is already serving a ticket.');
    }
    throw err;
  }
}

async function apply(
  tx: Db,
  session: LockedSession,
  locked: Map<string, LockedSession>,
  destinationQueueId: string | null,
  roles: Role[],
  auth: AuthContext,
  command: QueueCommandRequest,
): Promise<CommandOutcome> {
  if (command.expected_revision !== undefined && command.expected_revision !== session.revision) {
    reject('stale_revision', 'The queue changed since you loaded it. Refresh and try again.');
  }

  const base = {
    disposition: 'committed' as const,
    operation_id: command.operation_id,
    action: command.action,
    reason_code: null,
    message: null,
  };

  // ---- Session actions ----------------------------------------------------------------------
  if (SESSION_ACTIONS.includes(command.action)) {
    if (!canManage(roles)) throw problems.forbidden();
    const t = sessionTransition(session.state, command.action);
    if (!t.ok) reject('invalid_queue_state', t.ok ? '' : t.reason);
    if (command.action === QueueAction.QUEUE_OPEN && session.service_status !== 'active') {
      reject('service_inactive', 'Activate the service before opening its queue.');
    }
    if (command.action === QueueAction.QUEUE_CLOSE) {
      const active = await tx`
        SELECT 1 FROM tickets WHERE queue_session_id = ${session.id}
           AND state = ANY(${ACTIVE_TICKET_STATES as string[]}) LIMIT 1`;
      if (active.length > 0) {
        reject(
          'queue_has_active_tickets',
          'Tickets are still waiting or being served. Complete, cancel or transfer them before closing.',
        );
      }
    }
    const to = (t as { ok: true; to: QueueSessionState }).to;
    await tx`UPDATE queue_sessions SET state = ${to}, updated_at = NOW() WHERE id = ${session.id}`;
    const from = session.state;
    session.state = to;
    const ev = await appendEvent(tx, session, {
      eventType: command.action,
      actorId: auth.staffUserId,
      operationId: command.operation_id,
      payload: { from_state: from, to_state: to },
    });
    return {
      ...base,
      server_revision: ev.revision,
      server_sequence: ev.sequence,
      ticket_id: null,
      public_code: null,
    };
  }

  // ---- Call next ----------------------------------------------------------------------------
  if (command.action === QueueAction.TICKET_CALL_NEXT) {
    // Role check first (any waiting ticket would do): an unauthorized caller learns nothing
    authorizeTransition(roles, TicketState.WAITING, QueueAction.TICKET_CALL_NEXT);
    if (session.state !== QueueSessionState.OPEN) {
      reject('queue_not_open', 'Calling is only possible while the queue is open.');
    }
    const counterId = command.counter_id as string;
    const counters = await tx<{ id: string; name: string; active: boolean }[]>`
      SELECT id, name, active FROM counters
       WHERE id = ${counterId} AND facility_id = ${session.facility_id}
         AND organization_id = ${session.organization_id}
         FOR UPDATE`;
    const counter = counters[0];
    if (!counter) throw problems.notFound();
    if (!counter.active) reject('counter_inactive', `${counter.name} is not active.`);
    const capable = await tx`
      SELECT 1 FROM counter_service_capabilities
       WHERE counter_id = ${counter.id} AND service_id = ${session.service_id}`;
    if (capable.length === 0) {
      reject('counter_not_capable', `${counter.name} is not set to serve ${session.service_name}.`);
    }
    const busy = await tx<{ public_code: string }[]>`
      SELECT public_code FROM tickets
       WHERE current_counter_id = ${counter.id} AND state IN ('called', 'serving')`;
    if (busy[0]) {
      reject('counter_busy', `${counter.name} is still handling ${busy[0].public_code}.`);
    }
    const waiting = await tx<TicketRow[]>`
      SELECT id, public_code, state, priority_class, issued_sequence, current_counter_id, missed_at, joined_at
        FROM tickets
       WHERE queue_session_id = ${session.id} AND state = 'waiting'
         FOR UPDATE`;
    const next = selectNextTicket(waiting, session.policy.priority_order);
    if (!next) return reject('queue_empty', 'Nobody is waiting.');
    await tx`
      UPDATE tickets
         SET state = 'called', current_counter_id = ${counter.id}, called_at = NOW(),
             version = version + 1, updated_at = NOW()
       WHERE id = ${next.id}`;
    const ev = await appendEvent(tx, session, {
      eventType: QueueAction.TICKET_CALL_NEXT,
      actorId: auth.staffUserId,
      operationId: command.operation_id,
      payload: {
        ticket_id: next.id,
        public_code: next.public_code,
        from_state: TicketState.WAITING,
        to_state: TicketState.CALLED,
        counter_id: counter.id,
        policy_version: session.policy.version,
      },
      transition: { ticketId: next.id, from: TicketState.WAITING, to: TicketState.CALLED },
    });
    return {
      ...base,
      server_revision: ev.revision,
      server_sequence: ev.sequence,
      ticket_id: next.id,
      public_code: next.public_code,
    };
  }

  // ---- Ticket-specific actions ----------------------------------------------------------------
  const ticket = await lockTicket(tx, session, command.ticket_id as string);
  const action = command.action as QueueAction;

  const policies: string[] = [];
  if (
    action === QueueAction.TICKET_RESUME &&
    ticket.state === TicketState.MISSED &&
    ticket.missed_at
  ) {
    const elapsed = (Date.now() - ticket.missed_at.getTime()) / 1000;
    if (elapsed <= session.policy.grace_window_seconds) policies.push('grace_window_active');
  }
  const to = authorizeTransition(roles, ticket.state, action, policies);

  if (action === QueueAction.TICKET_TRANSFER) {
    return transfer(tx, session, locked, destinationQueueId, auth, command, ticket, base);
  }

  // Column side-effects per transition
  const counterAfter =
    to === TicketState.WAITING || to === TicketState.CANCELLED ? null : ticket.current_counter_id;
  await tx`
    UPDATE tickets SET
      state = ${to},
      current_counter_id = ${counterAfter},
      serving_started_at = CASE WHEN ${to} = 'serving' THEN NOW() ELSE serving_started_at END,
      completed_at = CASE WHEN ${to} = 'completed' THEN NOW() ELSE completed_at END,
      missed_at = CASE WHEN ${to} = 'missed' THEN NOW() ELSE missed_at END,
      called_at = CASE WHEN ${to} = 'waiting' THEN NULL ELSE called_at END,
      version = version + 1, updated_at = NOW()
    WHERE id = ${ticket.id}`;
  const ev = await appendEvent(tx, session, {
    eventType: action,
    actorId: auth.staffUserId,
    operationId: command.operation_id,
    payload: {
      ticket_id: ticket.id,
      public_code: ticket.public_code,
      from_state: ticket.state,
      to_state: to,
      counter_id: counterAfter,
      policy_version: session.policy.version,
    },
    transition: { ticketId: ticket.id, from: ticket.state, to },
  });
  return {
    ...base,
    server_revision: ev.revision,
    server_sequence: ev.sequence,
    ticket_id: ticket.id,
    public_code: ticket.public_code,
  };
}

async function transfer(
  tx: Db,
  session: LockedSession,
  locked: Map<string, LockedSession>,
  destinationQueueId: string | null,
  auth: AuthContext,
  command: QueueCommandRequest,
  ticket: TicketRow,
  base: Omit<CommandOutcome, 'server_revision' | 'server_sequence' | 'ticket_id' | 'public_code'>,
): Promise<CommandOutcome> {
  const destId = command.destination_service_id as string;
  if (destId === session.service_id)
    reject('same_service', 'Choose a different service to transfer to.');
  const svc = await tx<{ id: string; status: string; name: string }[]>`
    SELECT id, status, name FROM services
     WHERE id = ${destId} AND facility_id = ${session.facility_id} AND organization_id = ${session.organization_id}`;
  if (!svc[0]) throw problems.notFound();
  if (svc[0].status !== 'active') reject('destination_inactive', `${svc[0].name} is not active.`);
  const dest = destinationQueueId ? locked.get(destinationQueueId) : undefined;
  if (!dest || dest.state !== QueueSessionState.OPEN) {
    reject('destination_not_open', `The ${svc[0].name} queue is not open today.`);
  }
  const destination = dest as LockedSession;

  const issued = await issueTicket(tx, destination, {
    channel: 'transfer',
    actorId: auth.staffUserId,
    operationId: command.operation_id,
    createdBy: auth.staffUserId,
    joinedAt: ticket.joined_at,
    transferredFromTicketId: ticket.id,
    sourceQueueId: session.id,
  });

  await tx`
    UPDATE tickets SET state = 'transferred', current_counter_id = NULL,
           transferred_to_ticket_id = ${issued.ticketId}, version = version + 1, updated_at = NOW()
     WHERE id = ${ticket.id}`;
  const ev = await appendEvent(tx, session, {
    eventType: QueueAction.TICKET_TRANSFER,
    actorId: auth.staffUserId,
    operationId: command.operation_id,
    payload: {
      ticket_id: ticket.id,
      public_code: ticket.public_code,
      from_state: ticket.state,
      to_state: TicketState.TRANSFERRED,
      destination_queue_id: destination.id,
      destination_ticket_id: issued.ticketId,
      destination_code: issued.publicCode,
      reason_code: command.reason_code ?? null,
      policy_version: session.policy.version,
    },
    transition: { ticketId: ticket.id, from: ticket.state, to: TicketState.TRANSFERRED },
  });
  return {
    ...base,
    disposition: 'committed',
    server_revision: ev.revision,
    server_sequence: ev.sequence,
    ticket_id: issued.ticketId,
    public_code: issued.publicCode,
  };
}
