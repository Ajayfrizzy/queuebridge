import {
  PriorityClass,
  QueueAction,
  QueueSessionState,
  TicketState,
  type PriorityClass as PriorityClassT,
} from '@queuebridge/contracts';
import { TRANSITION_RULES } from './state-machine.js';

// ---------------------------------------------------------------------------
// Published ordering policy (F3, F5) — deterministic, versioned by the service policy
// ---------------------------------------------------------------------------

export interface OrderableTicket {
  id: string;
  state: TicketState;
  priority_class: PriorityClassT;
  issued_sequence: number;
  /**
   * The instant this ticket's place in line is measured from (its waiting age): issue time for
   * native tickets, original join time or transfer time for transfers (per policy). ISO string
   * or epoch ms. Missing only for tickets replayed from pre-M4 events (issue order then decides).
   */
  wait_since?: string | number | Date | null;
}

/**
 * Rank of a priority class under a service's published `priority_order` (lower = served first).
 * Classes not enabled by the policy rank after every enabled class, so an unexpected class can
 * never jump the queue.
 */
export function priorityRank(
  cls: PriorityClassT,
  priorityOrder: readonly PriorityClassT[],
): number {
  const i = priorityOrder.indexOf(cls);
  return i === -1 ? priorityOrder.length : i;
}

/** The published, versioned ordering rule (REQ-F5.2), recorded with every routing decision. */
export const ORDERING_RULE = 'priority_class>wait_since>issued_sequence>id';

const waitMs = (t: OrderableTicket): number | null => {
  const v = t.wait_since;
  if (v === undefined || v === null) return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

/** Total, deterministic comparator for waiting tickets under a published priority order. */
export function compareForCall(
  a: OrderableTicket,
  b: OrderableTicket,
  priorityOrder: readonly PriorityClassT[],
): number {
  const r =
    priorityRank(a.priority_class, priorityOrder) - priorityRank(b.priority_class, priorityOrder);
  if (r !== 0) return r;
  const wa = waitMs(a);
  const wb = waitMs(b);
  if (wa !== null && wb !== null && wa !== wb) return wa - wb;
  if (a.issued_sequence !== b.issued_sequence) return a.issued_sequence - b.issued_sequence;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Waiting tickets in the order they will be called: priority rank (classes the policy does not
 * enable rank last), then waiting age (oldest `wait_since` first), then issue number, then id.
 * Paused, missed and other states are excluded. Never mutates its input.
 */
export function orderWaiting<T extends OrderableTicket>(
  tickets: readonly T[],
  priorityOrder: readonly PriorityClassT[],
): T[] {
  return tickets
    .filter((t) => t.state === TicketState.WAITING)
    .sort((a, b) => compareForCall(a, b, priorityOrder));
}

/** Next ticket to call, or null when nobody is waiting. */
export function selectNextTicket<T extends OrderableTicket>(
  tickets: readonly T[],
  priorityOrder: readonly PriorityClassT[],
): T | null {
  return orderWaiting(tickets, priorityOrder)[0] ?? null;
}

/** Number of waiting tickets ahead of `ticketId`; null if that ticket is not waiting. */
export function ticketsAhead(
  ticketId: string,
  tickets: readonly OrderableTicket[],
  priorityOrder: readonly PriorityClassT[],
): number | null {
  const i = orderWaiting(tickets, priorityOrder).findIndex((t) => t.id === ticketId);
  return i === -1 ? null : i;
}

const CLASS_LABEL: Record<string, string> = {
  [PriorityClass.URGENT]: 'Urgent',
  [PriorityClass.PRIORITY]: 'Priority',
  [PriorityClass.NORMAL]: 'Normal',
};

/**
 * Plain-language description of a published policy; lists only enabled classes. Mentions the
 * supervisor-override rule only when there is a class to move to, and the transfer placement
 * only when the policy states one (callers without it get the M2 wording unchanged).
 */
export function describeOrderingPolicy(policy: {
  priority_order: readonly PriorityClassT[];
  grace_window_seconds: number;
  transfer_placement?: 'by_original_join_time' | 'end_of_queue';
}): string {
  const grace = `Grace window ${policy.grace_window_seconds}s.`;
  const transfer =
    policy.transfer_placement === undefined
      ? ''
      : policy.transfer_placement === 'by_original_join_time'
        ? ' Transferred visitors keep their original waiting time.'
        : ' Transferred visitors join the end of the destination queue.';
  if (policy.priority_order.every((c) => c === PriorityClass.NORMAL)) {
    return `Single queue, first come first served (no priority classes). ${grace}${transfer}`;
  }
  const classes = policy.priority_order.map((c) => CLASS_LABEL[c] ?? c).join(', ');
  return (
    `Enabled classes, highest first: ${classes}. First come first served within each class. ` +
    `Only a supervisor can change a visitor's class, and must record a reason. ${grace}${transfer}`
  );
}

// ---------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------

const SESSION_TRANSITIONS: Record<string, { from: QueueSessionState[]; to: QueueSessionState }> = {
  [QueueAction.QUEUE_OPEN]: {
    from: [QueueSessionState.PAUSED, QueueSessionState.CLOSED],
    to: QueueSessionState.OPEN,
  },
  [QueueAction.QUEUE_PAUSE]: { from: [QueueSessionState.OPEN], to: QueueSessionState.PAUSED },
  [QueueAction.QUEUE_CLOSE]: {
    from: [QueueSessionState.OPEN, QueueSessionState.PAUSED],
    to: QueueSessionState.CLOSED,
  },
};

export function sessionTransition(
  current: QueueSessionState,
  action: string,
): { ok: true; to: QueueSessionState } | { ok: false; reason: string } {
  const rule = SESSION_TRANSITIONS[action];
  if (!rule) return { ok: false, reason: `Unknown queue action '${action}'` };
  if (!rule.from.includes(current)) {
    return { ok: false, reason: `Queue cannot go from '${current}' via '${action}'` };
  }
  return { ok: true, to: rule.to };
}

/** States in which a ticket still occupies the queue (blocks closing the session). */
export const ACTIVE_TICKET_STATES: readonly TicketState[] = [
  TicketState.WAITING,
  TicketState.CALLED,
  TicketState.SERVING,
  TicketState.PAUSED,
  TicketState.MISSED,
];

// ---------------------------------------------------------------------------
// Event replay projection (Group 1 determinism; DB log-completeness checks)
// ---------------------------------------------------------------------------

export interface QueueEventForReplay {
  sequence: number;
  event_type: string;
  payload: Record<string, unknown>;
}

/** Audit-only events: occupy a sequence, never change ticket or session state. */
const AUDIT_ONLY_PREFIXES = ['coordinator.', 'sync.', 'policy.'] as const;

export interface ProjectedTicket {
  id: string;
  public_code: string;
  state: TicketState;
  priority_class: PriorityClassT;
  issued_sequence: number;
  counter_id: string | null;
  /** From the ticket.create payload (M4+); null for tickets created by pre-M4 events */
  wait_since: string | null;
}

export interface QueueProjection {
  state: QueueSessionState;
  last_sequence: number;
  tickets: Record<string, ProjectedTicket>;
}

export class ReplayError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReplayError';
  }
}

export function emptyProjection(): QueueProjection {
  return { state: QueueSessionState.CLOSED, last_sequence: 0, tickets: {} };
}

function str(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  if (typeof v !== 'string') throw new ReplayError(`payload.${key} missing`);
  return v;
}

/**
 * Apply one committed event. Pure: returns a new projection and never mutates the input.
 * Throws ReplayError for gaps, re-ordering or transitions the state machine does not permit,
 * so a corrupted or incomplete event log cannot silently replay.
 */
export function applyQueueEvent(p: QueueProjection, e: QueueEventForReplay): QueueProjection {
  if (e.sequence !== p.last_sequence + 1) {
    throw new ReplayError(`expected sequence ${p.last_sequence + 1}, got ${e.sequence}`);
  }
  const next: QueueProjection = { ...p, last_sequence: e.sequence, tickets: { ...p.tickets } };

  // Authority and conflict-audit events occupy a sequence but never change ticket or session state
  if (AUDIT_ONLY_PREFIXES.some((prefix) => e.event_type.startsWith(prefix))) return next;

  if (
    e.event_type === 'queue.open' ||
    e.event_type === 'queue.pause' ||
    e.event_type === 'queue.close'
  ) {
    const fromState = str(e.payload, 'from_state');
    // The very first event opens a brand-new session
    if (!(e.sequence === 1 && e.event_type === 'queue.open')) {
      if (fromState !== p.state) throw new ReplayError(`session state mismatch at ${e.sequence}`);
      const t = sessionTransition(p.state, e.event_type);
      if (!t.ok) throw new ReplayError(t.reason);
    }
    next.state = str(e.payload, 'to_state') as QueueSessionState;
    return next;
  }

  if (e.event_type === QueueAction.TICKET_CREATE) {
    const id = str(e.payload, 'ticket_id');
    if (next.tickets[id]) throw new ReplayError(`duplicate ticket ${id}`);
    const issued = e.payload['issued_sequence'];
    if (typeof issued !== 'number') throw new ReplayError('payload.issued_sequence missing');
    if (Object.values(next.tickets).some((t) => t.issued_sequence === issued)) {
      throw new ReplayError(`duplicate issued_sequence ${issued}`);
    }
    next.tickets[id] = {
      id,
      public_code: str(e.payload, 'public_code'),
      state: TicketState.WAITING,
      priority_class:
        (e.payload['priority_class'] as PriorityClassT | undefined) ?? PriorityClass.NORMAL,
      issued_sequence: issued,
      counter_id: null,
      wait_since:
        typeof e.payload['wait_since'] === 'string' ? (e.payload['wait_since'] as string) : null,
    };
    return next;
  }

  if (e.event_type === QueueAction.TICKET_PRIORITY_OVERRIDE) {
    const id = str(e.payload, 'ticket_id');
    const t = next.tickets[id];
    if (!t) throw new ReplayError(`unknown ticket ${id} at ${e.sequence}`);
    if (t.state !== TicketState.WAITING)
      throw new ReplayError(`override of non-waiting ticket at ${e.sequence}`);
    if (str(e.payload, 'from_class') !== t.priority_class) {
      throw new ReplayError(`priority class mismatch at ${e.sequence}`);
    }
    next.tickets[id] = { ...t, priority_class: str(e.payload, 'to_class') as PriorityClassT };
    return next;
  }

  const id = str(e.payload, 'ticket_id');
  const current = next.tickets[id];
  if (!current) throw new ReplayError(`unknown ticket ${id} at ${e.sequence}`);
  const from = str(e.payload, 'from_state');
  const to = str(e.payload, 'to_state');
  if (from !== current.state) throw new ReplayError(`ticket ${id} state mismatch at ${e.sequence}`);
  const legal = TRANSITION_RULES.some(
    (r) => r.from === from && r.action === e.event_type && r.to === to,
  );
  if (!legal) throw new ReplayError(`illegal transition ${from} -[${e.event_type}]-> ${to}`);
  const counter = e.payload['counter_id'];
  next.tickets[id] = {
    ...current,
    state: to as TicketState,
    // An explicit null (e.g. ticket.release) clears the counter; an absent field keeps it
    counter_id:
      typeof counter === 'string' ? counter : counter === null ? null : current.counter_id,
  };
  return next;
}

export function replayQueueEvents(events: readonly QueueEventForReplay[]): QueueProjection {
  return events.reduce(applyQueueEvent, emptyProjection());
}
