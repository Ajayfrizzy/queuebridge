import {
  QueueAction,
  TicketState,
  type PriorityClass as PriorityClassT,
} from '@queuebridge/contracts';
import {
  applyQueueEvent,
  emptyProjection,
  ORDERING_RULE,
  orderWaiting,
  ReplayError,
  selectNextTicket,
  type OrderableTicket,
  type QueueEventForReplay,
  type QueueProjection,
} from './queue.js';

// ---------------------------------------------------------------------------
// Counter eligibility (REQ-F5.1, REQ-F5.2: service match and counter availability)
// ---------------------------------------------------------------------------

export interface CounterForRouting {
  id: string;
  /** Administrative switch (configured by facility admins) */
  active: boolean;
  /** Operational availability during the day */
  availability: 'open' | 'closed';
  service_ids: readonly string[];
  /** Public code of the ticket the counter is currently calling/serving, if any */
  busy_with: string | null;
}

export type CounterIneligibility = 'inactive' | 'closed' | 'not_capable' | 'busy';

/** Why a counter cannot take a new ticket for `serviceId`, or null if it can. Pure. */
export function counterIneligibility(
  c: CounterForRouting,
  serviceId: string,
): CounterIneligibility | null {
  if (!c.active) return 'inactive';
  if (c.availability !== 'open') return 'closed';
  if (!c.service_ids.includes(serviceId)) return 'not_capable';
  if (c.busy_with !== null) return 'busy';
  return null;
}

/** Counters that may serve the service at all right now (ignoring momentary busyness). */
export function openCapableCounters<T extends CounterForRouting>(
  counters: readonly T[],
  serviceId: string,
): T[] {
  return counters.filter((c) => {
    const why = counterIneligibility(c, serviceId);
    return why === null || why === 'busy';
  });
}

// ---------------------------------------------------------------------------
// Routing decision with explanation (REQ-F5.2, REQ-F5.6)
// ---------------------------------------------------------------------------

/** Recorded in every call event so the decision can be explained and replayed. */
export interface RoutingExplanation {
  rule: typeof ORDERING_RULE;
  policy_version: string;
  priority_order: PriorityClassT[];
  /** Waiting tickets that were eligible when the decision was made */
  candidates: number;
  /** Rank keys of the selected ticket */
  selected: { priority_class: PriorityClassT; wait_since: string | null; issued_sequence: number };
}

export interface CallDecision<T extends OrderableTicket> {
  ticket: T;
  explanation: RoutingExplanation;
}

const iso = (v: OrderableTicket['wait_since']): string | null => {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  return typeof v === 'number' ? new Date(v).toISOString() : v;
};

/** Choose the next ticket under a published policy, with the explanation to record. Pure. */
export function decideNextCall<T extends OrderableTicket>(
  waiting: readonly T[],
  policy: { version: string; priority_order: readonly PriorityClassT[] },
): CallDecision<T> | null {
  const ordered = orderWaiting(waiting, policy.priority_order);
  const next = ordered[0];
  if (!next) return null;
  return {
    ticket: next,
    explanation: {
      rule: ORDERING_RULE,
      policy_version: policy.version,
      priority_order: [...policy.priority_order],
      candidates: ordered.length,
      selected: {
        priority_class: next.priority_class,
        wait_since: iso(next.wait_since),
        issued_sequence: next.issued_sequence,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic replay of recorded routing decisions (REQ-F5.6)
// ---------------------------------------------------------------------------

export interface PolicySnapshotForReplay {
  priority_order: readonly PriorityClassT[];
}

export interface DecisionReplayResult {
  valid: boolean;
  /** Call decisions recomputed from history under their cited policy and found identical */
  verified: number;
  /** Call events that carry no routing explanation (recorded before M4) — not checkable */
  not_replayable: number;
  mismatches: { sequence: number; reason: string }[];
  /** A replay error means the event log itself is not a legal history */
  error: string | null;
}

/**
 * Re-run every recorded routing decision of one queue session against the policy snapshot it
 * cites, using only the event history before it. A `ticket.call_next` must have selected exactly
 * the ticket the rule selects; a `ticket.call_specific` (routing override) must have recorded the
 * ticket the rule WOULD have selected. Pure: the caller supplies the policy snapshots.
 */
export function verifyRoutingDecisions(
  events: readonly QueueEventForReplay[],
  policies: ReadonlyMap<string, PolicySnapshotForReplay>,
): DecisionReplayResult {
  const out: DecisionReplayResult = {
    valid: true,
    verified: 0,
    not_replayable: 0,
    mismatches: [],
    error: null,
  };
  let p: QueueProjection = emptyProjection();
  for (const e of events) {
    const isCall =
      e.event_type === QueueAction.TICKET_CALL_NEXT ||
      e.event_type === QueueAction.TICKET_CALL_SPECIFIC;
    if (isCall) {
      const routing = e.payload['routing'] as
        | { policy_version?: unknown; rule?: unknown }
        | undefined;
      const calledId = e.payload['ticket_id'];
      if (!routing || typeof routing.policy_version !== 'string') {
        out.not_replayable++;
      } else {
        const policy = policies.get(routing.policy_version);
        const waiting = Object.values(p.tickets).filter((t) => t.state === TicketState.WAITING);
        if (!policy) {
          out.mismatches.push({
            sequence: e.sequence,
            reason: `unknown policy ${routing.policy_version}`,
          });
        } else if (routing.rule !== ORDERING_RULE) {
          out.mismatches.push({
            sequence: e.sequence,
            reason: `unknown rule ${String(routing.rule)}`,
          });
        } else if (waiting.some((t) => t.wait_since === null)) {
          // History mixes pre-M4 tickets: the M4 rule cannot be recomputed faithfully
          out.not_replayable++;
        } else {
          const expected = selectNextTicket(waiting, policy.priority_order);
          const subject =
            e.event_type === QueueAction.TICKET_CALL_NEXT
              ? calledId
              : (e.payload['override'] as { would_have_called?: unknown } | undefined)
                  ?.would_have_called;
          if (expected?.id !== subject) {
            out.mismatches.push({
              sequence: e.sequence,
              reason:
                e.event_type === QueueAction.TICKET_CALL_NEXT
                  ? `rule selects ${expected?.id ?? 'nobody'}, event called ${String(subject)}`
                  : `override recorded ${String(subject)} as the rule's choice; rule selects ${expected?.id ?? 'nobody'}`,
            });
          } else {
            out.verified++;
          }
        }
      }
    }
    try {
      p = applyQueueEvent(p, e);
    } catch (err) {
      out.error = err instanceof ReplayError ? err.message : String(err);
      out.valid = false;
      return out;
    }
  }
  out.valid = out.mismatches.length === 0;
  return out;
}
