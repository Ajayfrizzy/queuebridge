import {
  QueueAction,
  QueueSessionState,
  TicketState,
  DEFAULT_OVERRIDE_REASONS,
  type CommandOutcome,
  type PriorityClass,
  type QueueCommandAction,
  type QueueCommandRequest,
  type Role,
} from '@queuebridge/contracts';
import {
  ACTIVE_TICKET_STATES,
  counterIneligibility,
  decideNextCall,
  sessionTransition,
  transition,
  TRANSITION_RULES,
  validatePriorityOverride,
  type RoutingExplanation,
} from '@queuebridge/domain';
import { Permission, queueActorRoles, type AuthContext } from '../auth/rbac.js';
import type { Db } from '../db.js';
import { ApiProblem, isUniqueViolation, problems } from '../errors.js';
import { appendEvent, lockSessions, type LockedSession } from './events.js';
import { sha256Hex } from './hash.js';
import { issueTicket } from './tickets.js';

/**
 * A command as executed internally: the public online vocabulary plus the M4 supervisor and
 * routing actions. The public `/queues/:id/commands` schema cannot produce the M4 actions; they
 * arrive only through their own endpoints, which validate their own inputs.
 */
export type InternalCommand = Omit<QueueCommandRequest, 'action'> & {
  action: QueueCommandAction;
  /** ticket.priority_override */
  to_class?: PriorityClass;
  /** ticket.priority_override / ticket.call_specific */
  override_reason?: { code: string; text: string };
  /** ticket.counter_transfer */
  to_counter_id?: string;
  counter_reason_code?: string;
};

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
  wait_since: Date;
}

const TICKET_COLUMNS =
  'id, public_code, state, priority_class, issued_sequence, current_counter_id, missed_at, joined_at, wait_since';

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
    SELECT ${tx.unsafe(TICKET_COLUMNS)}
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
  command: InternalCommand;
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
        outcome = await applyCommand(tx, session, locked, destinationQueueId, roles, auth, command);
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

export interface ApplyOptions {
  /**
   * Set only by the offline-sync path, which has already verified coordinator authority.
   * Every other caller is blocked from advancing a queue while a coordinator is designated.
   */
  viaCoordinatorSync?: boolean;
}

/**
 * Apply one command to a LOCKED session inside the caller's transaction. Shared by the online
 * command endpoint and offline sync, so both obey exactly the same state machine, role rules
 * and event-append path. Throws CommandRejected for business-rule failures and ApiProblem for
 * authorization/lookup failures.
 */
export async function applyCommand(
  tx: Db,
  session: LockedSession,
  locked: Map<string, LockedSession>,
  destinationQueueId: string | null,
  roles: Role[],
  auth: AuthContext,
  command: InternalCommand,
  options: ApplyOptions = {},
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

  // ---- Coordinator fence (ADR-006) ------------------------------------------------------------
  // While a coordinator is designated, queue advancement happens only through that coordinator's
  // synced commands. Online advancement by anyone else would race an offline decision the server
  // cannot see yet, so it is refused (not recorded, so a retry after revocation works).
  if (session.coordinator_device_id !== null && !options.viaCoordinatorSync) {
    throw new ApiProblem(409, 'coordinator-active', 'Offline coordinator active', {
      detail:
        'A coordinator device holds authority over this queue. Calling and serving are paused here until it syncs or a supervisor revokes or replaces it.',
    });
  }

  // ---- Call next / call specific (routing) ---------------------------------------------------
  if (
    command.action === QueueAction.TICKET_CALL_NEXT ||
    command.action === QueueAction.TICKET_CALL_SPECIFIC
  ) {
    return callTicket(tx, session, roles, auth, command, base);
  }

  // ---- Priority override (supervisor; REQ-F3.3) ------------------------------------------------
  if (command.action === QueueAction.TICKET_PRIORITY_OVERRIDE) {
    return priorityOverride(tx, session, roles, auth, command, base);
  }

  // ---- Counter-to-counter transfer (same service) -----------------------------------------------
  if (command.action === QueueAction.TICKET_COUNTER_TRANSFER) {
    return counterTransfer(tx, session, roles, auth, command, base);
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

  // Starting service needs the ticket's counter to be IN SERVICE (active and open). Taking a
  // counter out of service locks this session first and then the counter (FOR UPDATE), so this
  // check cannot interleave with it: either the counter left service before (refused here) or
  // the serve commits first (and the closure is then refused because the counter is serving).
  if (to === TicketState.SERVING && ticket.current_counter_id) {
    const [c] = await tx<{ name: string; active: boolean; availability: string }[]>`
      SELECT name, active, availability FROM counters WHERE id = ${ticket.current_counter_id}
         FOR SHARE`;
    if (c && !c.active) {
      reject(
        'counter_inactive',
        `${c.name} is not active. Return ${ticket.public_code} to the queue so an open counter can call them.`,
      );
    }
    if (c && c.availability !== 'open') {
      reject(
        'counter_closed',
        `${c.name} is closed. Return ${ticket.public_code} to the queue so an open counter can call them.`,
      );
    }
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
  command: InternalCommand,
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

  // Placement follows the DESTINATION's published policy; the original join time is always kept
  const placement = destination.policy.transfer_placement ?? 'end_of_queue';
  const issued = await issueTicket(tx, destination, {
    channel: 'transfer',
    actorId: auth.staffUserId,
    operationId: command.operation_id,
    createdBy: auth.staffUserId,
    joinedAt: ticket.joined_at,
    transferredFromTicketId: ticket.id,
    sourceQueueId: session.id,
    ...(placement === 'by_original_join_time' ? { waitSince: ticket.joined_at } : {}),
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
      destination_placement: placement,
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

// ---------------------------------------------------------------------------
// M4 — routing and overrides
// ---------------------------------------------------------------------------

type CommittedBase = Omit<
  CommandOutcome,
  'server_revision' | 'server_sequence' | 'ticket_id' | 'public_code'
>;

interface CounterRow {
  id: string;
  name: string;
  active: boolean;
  availability: 'open' | 'closed';
  capable: boolean;
  busy_with: string | null;
}

/**
 * Lock a counter of the session's facility, THEN describe its eligibility in a separate
 * statement. Under READ COMMITTED a statement that waited for a row lock still evaluates its
 * other sub-queries against the snapshot from before the wait; checking "busy" in a fresh
 * statement after the lock sees a ticket a concurrent transaction just assigned to this counter.
 */
async function lockCounter(tx: Db, session: LockedSession, counterId: string): Promise<CounterRow> {
  const locked = await tx<{ id: string }[]>`
    SELECT id FROM counters
     WHERE id = ${counterId} AND facility_id = ${session.facility_id}
       AND organization_id = ${session.organization_id}
       FOR UPDATE`;
  // Another facility's or tenant's counter is indistinguishable from a missing one
  if (!locked[0]) throw problems.notFound();
  const rows = await tx<CounterRow[]>`
    SELECT c.id, c.name, c.active, c.availability,
           EXISTS (SELECT 1 FROM counter_service_capabilities csc
                    WHERE csc.counter_id = c.id AND csc.service_id = ${session.service_id}) AS capable,
           (SELECT t.public_code FROM tickets t
             WHERE t.current_counter_id = c.id AND t.state IN ('called', 'serving') LIMIT 1) AS busy_with
      FROM counters c WHERE c.id = ${counterId}`;
  const c = rows[0];
  if (!c) throw problems.notFound();
  return c;
}

/** Disabled, closed, incapable or busy counters can never receive a new assignment. */
function assertCounterCanTake(c: CounterRow, session: LockedSession): void {
  const why = counterIneligibility(
    {
      id: c.id,
      active: c.active,
      availability: c.availability,
      service_ids: c.capable ? [session.service_id] : [],
      busy_with: c.busy_with,
    },
    session.service_id,
  );
  if (why === 'inactive') reject('counter_inactive', `${c.name} is not active.`);
  if (why === 'closed') reject('counter_closed', `${c.name} is closed.`);
  if (why === 'not_capable') {
    reject('counter_not_capable', `${c.name} is not set to serve ${session.service_name}.`);
  }
  if (why === 'busy') reject('counter_busy', `${c.name} is still handling ${c.busy_with ?? ''}.`);
}

function policyOf(session: LockedSession): {
  version: string;
  priority_order: PriorityClass[];
  override_reasons: string[];
} {
  return {
    version: session.policy.version,
    priority_order: session.policy.priority_order,
    override_reasons: session.policy.override_reasons ?? [...DEFAULT_OVERRIDE_REASONS],
  };
}

/** Validate an override's reason against the session's configured codes and minimum text. */
function checkOverrideReason(
  session: LockedSession,
  roles: Role[],
  reason: InternalCommand['override_reason'],
): { code: string; text: string } {
  if (!reason) return reject('reason_required', 'A reason code and explanation are required.');
  const policy = policyOf(session);
  if (!policy.override_reasons.includes(reason.code)) {
    reject('invalid_reason_code', 'That reason is not configured for this service.');
  }
  // Reuse the domain rule (role, code, text length, policy version)
  const role = roles.find((r) => r === 'supervisor' || r === 'facility_admin') ?? roles[0];
  const problem = role
    ? validatePriorityOverride({
        actorRole: role,
        reasonCode: reason.code,
        reasonText: reason.text,
        policyVersion: policy.version,
      })
    : 'no role';
  if (problem) reject('invalid_override', problem);
  return reason;
}

async function recordOverride(
  tx: Db,
  session: LockedSession,
  auth: AuthContext,
  o: {
    id: string;
    kind: 'priority' | 'routing';
    ticketId: string;
    eventId: string;
    reason: { code: string; text: string };
    fromClass?: string;
    toClass?: string;
    counterId?: string;
    operationId: string;
  },
): Promise<void> {
  await tx`
    INSERT INTO priority_overrides
      (id, ticket_id, actor_id, reason_code, reason_text, policy_version, queue_event_id,
       organization_id, queue_session_id, kind, from_class, to_class, counter_id, operation_id)
    VALUES (${o.id}, ${o.ticketId}, ${auth.staffUserId}, ${o.reason.code}, ${o.reason.text},
            ${session.policy.version}, ${o.eventId}, ${session.organization_id}, ${session.id},
            ${o.kind}, ${o.fromClass ?? null}, ${o.toClass ?? null}, ${o.counterId ?? null},
            ${o.operationId})`;
}

async function waitingRows(tx: Db, session: LockedSession): Promise<TicketRow[]> {
  return tx<TicketRow[]>`
    SELECT ${tx.unsafe(TICKET_COLUMNS)} FROM tickets
     WHERE queue_session_id = ${session.id} AND state = 'waiting'
       FOR UPDATE`;
}

/**
 * Call the next ticket (published rule) or, as a supervisor routing override, a specific one.
 * Either way the counter must be active, open, capable and free, and the event records the
 * routing explanation so the decision can be replayed against its policy snapshot.
 */
async function callTicket(
  tx: Db,
  session: LockedSession,
  roles: Role[],
  auth: AuthContext,
  command: InternalCommand,
  base: CommittedBase,
): Promise<CommandOutcome> {
  const specific = command.action === QueueAction.TICKET_CALL_SPECIFIC;
  // Role check first (any waiting ticket would do): an unauthorized caller learns nothing
  authorizeTransition(roles, TicketState.WAITING, command.action);
  if (session.state !== QueueSessionState.OPEN) {
    reject('queue_not_open', 'Calling is only possible while the queue is open.');
  }
  const counter = await lockCounter(tx, session, command.counter_id as string);
  assertCounterCanTake(counter, session);

  const waiting = await waitingRows(tx, session);
  const policy = policyOf(session);
  const decision = decideNextCall(waiting, policy);
  if (!decision) return reject('queue_empty', 'Nobody is waiting.');

  let chosen: TicketRow = decision.ticket;
  let override: Record<string, unknown> | undefined;
  let reason: { code: string; text: string } | undefined;
  const overrideId = crypto.randomUUID();
  if (specific) {
    reason = checkOverrideReason(session, roles, command.override_reason);
    const target = waiting.find((t) => t.id === command.ticket_id);
    if (!target) {
      // Not waiting in THIS session (or not visible to this tenant): same answer either way
      await lockTicket(tx, session, command.ticket_id as string); // 404 if foreign
      return reject('invalid_state', 'Only a waiting ticket can be called out of order.');
    }
    chosen = target;
    override = {
      kind: 'routing',
      override_id: overrideId,
      reason_code: reason.code,
      reason_text_sha256: sha256Hex(reason.text),
      would_have_called: decision.ticket.id,
      would_have_called_code: decision.ticket.public_code,
    };
  }

  await tx`
    UPDATE tickets
       SET state = 'called', current_counter_id = ${counter.id}, called_at = NOW(),
           version = version + 1, updated_at = NOW()
     WHERE id = ${chosen.id}`;
  const routing: RoutingExplanation & { counter: { id: string; availability: string } } = {
    ...decision.explanation,
    counter: { id: counter.id, availability: counter.availability },
  };
  const ev = await appendEvent(tx, session, {
    eventType: command.action,
    actorId: auth.staffUserId,
    operationId: command.operation_id,
    payload: {
      ticket_id: chosen.id,
      public_code: chosen.public_code,
      from_state: TicketState.WAITING,
      to_state: TicketState.CALLED,
      counter_id: counter.id,
      policy_version: session.policy.version,
      routing,
      ...(override ? { override } : {}),
    },
    transition: { ticketId: chosen.id, from: TicketState.WAITING, to: TicketState.CALLED },
  });
  if (specific && reason) {
    await recordOverride(tx, session, auth, {
      id: overrideId,
      kind: 'routing',
      ticketId: chosen.id,
      eventId: ev.eventId,
      reason,
      counterId: counter.id,
      operationId: command.operation_id,
    });
  }
  return {
    ...base,
    server_revision: ev.revision,
    server_sequence: ev.sequence,
    ticket_id: chosen.id,
    public_code: chosen.public_code,
  };
}

/**
 * Supervisor priority override: change a WAITING ticket's priority class to another class the
 * service's published policy enables. Never assigns an arbitrary position — the published rule
 * then orders the ticket. Records actor, ticket, original and resulting class, reason code,
 * a hash of the explanation (the text itself stays in the access-controlled override record),
 * policy version and timestamp.
 */
async function priorityOverride(
  tx: Db,
  session: LockedSession,
  roles: Role[],
  auth: AuthContext,
  command: InternalCommand,
  base: CommittedBase,
): Promise<CommandOutcome> {
  const ticket = await lockTicket(tx, session, command.ticket_id as string);
  authorizeTransition(roles, ticket.state, QueueAction.TICKET_PRIORITY_OVERRIDE);
  const reason = checkOverrideReason(session, roles, command.override_reason);
  const to = command.to_class as PriorityClass;
  const policy = policyOf(session);
  if (!policy.priority_order.includes(to)) {
    reject('class_not_enabled', `The ${to} class is not enabled for ${session.service_name}.`);
  }
  if (to === ticket.priority_class) {
    reject('no_change', `${ticket.public_code} is already ${to}.`);
  }
  const overrideId = crypto.randomUUID();
  await tx`
    UPDATE tickets SET priority_class = ${to}, version = version + 1, updated_at = NOW()
     WHERE id = ${ticket.id}`;
  const ev = await appendEvent(tx, session, {
    eventType: QueueAction.TICKET_PRIORITY_OVERRIDE,
    actorId: auth.staffUserId,
    operationId: command.operation_id,
    payload: {
      ticket_id: ticket.id,
      public_code: ticket.public_code,
      from_class: ticket.priority_class,
      to_class: to,
      override_id: overrideId,
      reason_code: reason.code,
      reason_text_sha256: sha256Hex(reason.text),
      policy_version: session.policy.version,
    },
  });
  await recordOverride(tx, session, auth, {
    id: overrideId,
    kind: 'priority',
    ticketId: ticket.id,
    eventId: ev.eventId,
    reason,
    fromClass: ticket.priority_class,
    toClass: to,
    operationId: command.operation_id,
  });
  return {
    ...base,
    server_revision: ev.revision,
    server_sequence: ev.sequence,
    ticket_id: ticket.id,
    public_code: ticket.public_code,
  };
}

/** Hand a called/serving ticket to another active, open, capable, free counter (same service). */
async function counterTransfer(
  tx: Db,
  session: LockedSession,
  roles: Role[],
  auth: AuthContext,
  command: InternalCommand,
  base: CommittedBase,
): Promise<CommandOutcome> {
  const ticket = await lockTicket(tx, session, command.ticket_id as string);
  const to = authorizeTransition(roles, ticket.state, QueueAction.TICKET_COUNTER_TRANSFER);
  const target = await lockCounter(tx, session, command.to_counter_id as string);
  if (target.id === ticket.current_counter_id) {
    reject('same_counter', `${ticket.public_code} is already at ${target.name}.`);
  }
  assertCounterCanTake(target, session);
  await tx`
    UPDATE tickets SET current_counter_id = ${target.id}, version = version + 1, updated_at = NOW()
     WHERE id = ${ticket.id}`;
  const ev = await appendEvent(tx, session, {
    eventType: QueueAction.TICKET_COUNTER_TRANSFER,
    actorId: auth.staffUserId,
    operationId: command.operation_id,
    payload: {
      ticket_id: ticket.id,
      public_code: ticket.public_code,
      from_state: ticket.state,
      to_state: to,
      from_counter_id: ticket.current_counter_id,
      counter_id: target.id,
      reason_code: command.counter_reason_code ?? null,
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
