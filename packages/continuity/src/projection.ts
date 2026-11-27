import {
  PriorityClass,
  QueueAction,
  type SyncStatus,
  TicketState,
  type StaffQueue,
} from '@queuebridge/contracts';
import { compareForCall } from '@queuebridge/domain';
import { isUnsynced, type OutboxOperation } from './outbox.js';

/**
 * Local projection of a queue: the last server snapshot with this device's unsent operations
 * applied on top. Everything the projection adds carries its sync status so the UI can never
 * present a local decision as server-confirmed (REQ-F1.7, REQ-F1.8).
 */
export interface LocalTicket {
  /** Stable React key: the server id, or `ref:<temporary ref>` while provisional */
  key: string;
  /** Server id; null while provisional */
  id: string | null;
  /** The confirmed public code, or the TEMPORARY REFERENCE while provisional */
  label: string;
  provisional: boolean;
  temporary_ref: string | null;
  state: TicketState;
  counter_id: string | null;
  counter_name: string | null;
  /** null = exactly as the server last reported; otherwise the status of the local change */
  local_status: SyncStatus | null;
  joined_at: string | null;
  issued_sequence: number;
  /** Server-reported class (provisional captures are always `normal`) */
  priority_class: PriorityClass;
  /** Server-reported waiting age; null for provisional captures (the server assigns it on sync) */
  wait_since: string | null;
  /** Position among waiting tickets (0 = next); null when not waiting */
  position: number | null;
}

export interface LocalCounter {
  id: string;
  name: string;
  active: boolean;
  /** Operational availability (M4): a closed counter receives no new calls */
  availability: 'open' | 'closed';
  busy_with: string | null;
}

export interface ProjectedQueue {
  tickets: LocalTicket[];
  counters: LocalCounter[];
  /** Unsent operations folded into this projection */
  applied: number;
  /** Operations that could not be folded in (target unknown / wrong state); still pending */
  skipped: string[];
  /** The published class order the local call order follows */
  priority_order: PriorityClass[];
}

const VIRTUAL_BASE = 1_000_000;

interface Target {
  ticket_id?: string;
  ticket_ref?: string;
}

function findTarget(tickets: LocalTicket[], t: Target): LocalTicket | undefined {
  if (t.ticket_id) return tickets.find((x) => x.id === t.ticket_id);
  if (t.ticket_ref) return tickets.find((x) => x.temporary_ref === t.ticket_ref);
  return undefined;
}

const STEP: Record<string, [TicketState, TicketState] | undefined> = {
  [QueueAction.TICKET_SERVE]: [TicketState.CALLED, TicketState.SERVING],
  [QueueAction.TICKET_COMPLETE]: [TicketState.SERVING, TicketState.COMPLETED],
  [QueueAction.TICKET_MISS]: [TicketState.CALLED, TicketState.MISSED],
};

/**
 * Waiting tickets in the order the SERVER would call them (same comparator as the API:
 * priority class → waiting age → issue number → id). Provisional captures have no waiting age
 * yet and a virtual issue number, so they rank after every confirmed ticket of their class —
 * exactly where the server will place them when they sync.
 */
function localCallOrder(tickets: LocalTicket[], order: readonly PriorityClass[]): LocalTicket[] {
  return tickets
    .filter((t) => t.state === TicketState.WAITING)
    .sort((a, b) =>
      compareForCall(
        { ...a, id: a.id ?? a.key, wait_since: a.provisional ? null : a.wait_since },
        { ...b, id: b.id ?? b.key, wait_since: b.provisional ? null : b.wait_since },
        order,
      ),
    );
}

/** Fold unsent operations onto a server snapshot. Pure and deterministic. */
export function projectQueue(
  snapshot: StaffQueue,
  ops: readonly OutboxOperation[],
): ProjectedQueue {
  // Snapshots cached by a pre-M4 build carry no policy / availability: default conservatively
  // (single FIFO class, counters open) — the server remains the judge on sync.
  const priorityOrder = [
    ...((snapshot.policy as StaffQueue['policy'] | undefined)?.priority_order ?? [
      PriorityClass.NORMAL,
    ]),
  ];
  const tickets: LocalTicket[] = snapshot.tickets.map((t) => ({
    key: t.id,
    id: t.id,
    label: t.public_code,
    provisional: false,
    temporary_ref: null,
    state: t.state,
    counter_id: t.counter_id,
    counter_name: t.counter_name,
    local_status: null,
    joined_at: t.joined_at,
    issued_sequence: t.issued_sequence,
    priority_class: t.priority_class,
    wait_since: (t.wait_since as string | undefined) ?? null,
    position: null,
  }));
  const counters: LocalCounter[] = snapshot.counters.map((c) => ({
    id: c.id,
    name: c.name,
    active: c.active,
    availability: (c.availability as LocalCounter['availability'] | undefined) ?? 'open',
    busy_with: c.busy_with_code,
  }));
  const skipped: string[] = [];
  let applied = 0;
  let virtual = 0;

  const pending = ops
    .filter((o) => o.queue_session_id === snapshot.id && isUnsynced(o))
    .sort((a, b) => a.client_sequence - b.client_sequence);

  for (const op of pending) {
    const p = op.payload as Target & { counter_id?: string };
    if (op.action === QueueAction.TICKET_CREATE) {
      tickets.push({
        key: `ref:${op.temporary_ref}`,
        id: null,
        label: op.temporary_ref ?? '?',
        provisional: true,
        temporary_ref: op.temporary_ref,
        state: TicketState.WAITING,
        counter_id: null,
        counter_name: null,
        local_status: op.status,
        joined_at: op.created_at_client,
        issued_sequence: VIRTUAL_BASE + ++virtual,
        priority_class: PriorityClass.NORMAL,
        wait_since: null,
        position: null,
      });
      applied++;
      continue;
    }
    const target = findTarget(tickets, p);
    if (op.action === QueueAction.TICKET_CALL_NEXT) {
      if (target?.state !== TicketState.WAITING) {
        skipped.push(op.operation_id);
        continue;
      }
      const c = counters.find((x) => x.id === p.counter_id);
      target.state = TicketState.CALLED;
      target.counter_id = p.counter_id ?? null;
      target.counter_name = c?.name ?? null;
      target.local_status = op.status;
      if (c) c.busy_with = target.label;
      applied++;
      continue;
    }
    const step = STEP[op.action];
    if (!target || !step || target.state !== step[0]) {
      skipped.push(op.operation_id);
      continue;
    }
    target.state = step[1];
    target.local_status = op.status;
    if (step[1] === TicketState.COMPLETED || step[1] === TicketState.MISSED) {
      const c = counters.find((x) => x.id === target.counter_id);
      if (c) c.busy_with = null;
    }
    applied++;
  }

  const waiting = localCallOrder(tickets, priorityOrder);
  for (const t of tickets) {
    const i = waiting.indexOf(t);
    t.position = i === -1 ? null : i;
  }
  return { tickets, counters, applied, skipped, priority_order: priorityOrder };
}

export type LocalCallDecision =
  | { ok: true; ticket: LocalTicket; payload: { counter_id: string } & Target }
  | {
      ok: false;
      reason:
        | 'queue_not_open'
        | 'queue_empty'
        | 'counter_missing'
        | 'counter_closed'
        | 'counter_busy';
    };

/**
 * Decide what an offline "Call next" would call, mirroring the server's rules (published class
 * order, waiting age, open counters only), so the UI can refuse obviously invalid calls early.
 * The server remains the judge on sync.
 */
export function decideLocalCall(
  queueState: StaffQueue['state'],
  projected: ProjectedQueue,
  counterId: string,
): LocalCallDecision {
  if (queueState !== 'open') return { ok: false, reason: 'queue_not_open' };
  const counter = projected.counters.find((c) => c.id === counterId && c.active);
  if (!counter) return { ok: false, reason: 'counter_missing' };
  if (counter.availability !== 'open') return { ok: false, reason: 'counter_closed' };
  if (counter.busy_with) return { ok: false, reason: 'counter_busy' };
  const next = localCallOrder(projected.tickets, projected.priority_order)[0];
  if (!next) return { ok: false, reason: 'queue_empty' };
  return {
    ok: true,
    ticket: next,
    payload: {
      counter_id: counterId,
      ...(next.id ? { ticket_id: next.id } : { ticket_ref: next.temporary_ref ?? '' }),
    },
  };
}
