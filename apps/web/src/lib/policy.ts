import type { ServicePolicy } from '@queuebridge/contracts';
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
