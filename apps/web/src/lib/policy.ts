import type { ServicePolicy, TicketStatus } from '@queuebridge/contracts';
import { describeOrderingPolicy } from '@queuebridge/domain';

const LABELS: Record<string, string> = { urgent: 'Urgent', priority: 'Priority', normal: 'Normal' };

/** Priority classes that are actually enabled, highest rank first (as stored in the policy). */
export function enabledClasses(policy: ServicePolicy): string[] {
  return policy.priority_order.map((c) => LABELS[c] ?? c);
}

/** True when the service only has the default class (plain first-come, first-served). */
export function isSingleQueue(policy: ServicePolicy): boolean {
  return policy.priority_order.every((c) => c === 'normal');
}

/**
 * Human description of what the policy really enables — never a fixed urgent → priority →
 * normal sequence. Same wording the server publishes to visitors (single source in domain).
 */
export function describePolicy(policy: ServicePolicy): string {
  return describeOrderingPolicy(policy);
}

/** Labels for priority classes (for badges and selects). */
export function classLabel(c: string): string {
  return LABELS[c] ?? c;
}
/**
 * MQ.5 U3: what a transferred visitor's place really is, from the placement the committed
 * transfer recorded (`TicketStatus.transfer_placement`). Never inferred from the current policy:
 * when the placement is unknown (an older saved copy, or an event without it) the note says only
 * that the ticket moved.
 */
export function transferPlacementNote(
  fromCode: string,
  placement: TicketStatus['transfer_placement'] | undefined,
): string {
  const moved = `Your ticket ${fromCode} was moved to this service.`;
  if (placement === 'by_original_join_time') {
    return `${moved} Your original waiting time was kept, so your place reflects when you first joined.`;
  }
  if (placement === 'end_of_queue') return `${moved} You joined the end of this service's queue.`;
  return moved;
}
