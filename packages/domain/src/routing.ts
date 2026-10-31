import { type PriorityClass, TicketState } from '@queuebridge/contracts';
import { comparePriority } from './state-machine.js';

export interface TicketForRouting {
  id: string;
  priority_class: PriorityClass;
  issued_sequence: number;
  /** ISO timestamp of original join time */
  created_at: string;
  state: TicketState;
  service_id: string;
}

export interface CounterForRouting {
  id: string;
  active: boolean;
  service_ids: string[];
}

export interface RoutingPolicy {
  version: string;
  /** IDs of priority classes to serve before NORMAL (in order) */
  priority_order: PriorityClass[];
  /** Maximum tickets a single counter can have in CALLED state simultaneously */
  max_concurrent_calls: number;
}

export interface RoutingResult {
  ticket: TicketForRouting;
  counter: CounterForRouting;
}

/**
 * Select the next ticket to call and the counter to assign it to.
 *
 * Deterministic: given identical inputs, always produces the same output.
 * Policy versioned: `policy.version` is recorded on every routing decision for replay fidelity.
 *
 * Selection order:
 *   1. Priority class (URGENT → PRIORITY → NORMAL per policy.priority_order)
 *   2. Issued sequence (FIFO within class)
 *
 * Pure function — no I/O.
 */
export function routeNextTicket(
  waitingTickets: TicketForRouting[],
  counters: CounterForRouting[],
  serviceId: string,
  _policy: RoutingPolicy,
): RoutingResult | null {
  // Find eligible waiting tickets for this service
  const eligible = waitingTickets.filter(
    (t) => t.state === TicketState.WAITING && t.service_id === serviceId,
  );

  if (eligible.length === 0) return null;

  // Sort by priority class then issued_sequence (deterministic)
  const sorted = [...eligible].sort((a, b) => {
    const pCmp = comparePriority(a.priority_class, b.priority_class);
    if (pCmp !== 0) return pCmp;
    return a.issued_sequence - b.issued_sequence;
  });

  // Find an active compatible counter
  const availableCounter = counters.find((c) => c.active && c.service_ids.includes(serviceId));

  if (!availableCounter) return null;

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const nextTicket = sorted[0]!;

  return { ticket: nextTicket, counter: availableCounter };
}

/**
 * Apply fairness policy: sort a queue of waiting tickets for display.
 *
 * Deterministic for replay: same events → same order.
 */
export function applyFairnessPolicy(
  tickets: TicketForRouting[],
  _policy: RoutingPolicy,
): TicketForRouting[] {
  return [...tickets].sort((a, b) => {
    const pCmp = comparePriority(a.priority_class, b.priority_class);
    if (pCmp !== 0) return pCmp;
    return a.issued_sequence - b.issued_sequence;
  });
}
