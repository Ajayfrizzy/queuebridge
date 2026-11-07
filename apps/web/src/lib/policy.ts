import type { ServicePolicy } from '@queuebridge/contracts';

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
 * normal sequence. Visitors within one class are always served first come, first served.
 */
export function describePolicy(policy: ServicePolicy): string {
  const grace = `Grace window ${policy.grace_window_seconds}s`;
  if (isSingleQueue(policy)) {
    return `Single queue, first come first served (no priority classes). ${grace}.`;
  }
  return `Enabled classes, highest first: ${enabledClasses(policy).join(', ')}. First come first served within each class. ${grace}.`;
}
