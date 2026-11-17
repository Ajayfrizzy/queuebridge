import { Role, type QueueAction, type RoleGrant, type TicketState } from '@queuebridge/contracts';
import { queueActorRolesAt } from './audiences.js';
import type { QueueOperation } from './registry.js';

/**
 * Structural view of a domain transition rule (`TransitionRule` in `@queuebridge/domain`).
 * `assist` may import only `contracts`, so callers that hold the domain table (`apps/web`,
 * `apps/api`) pass `TRANSITION_RULES` in; the role list is never copied into Que.
 */
export interface TransitionRuleLike {
  from: TicketState;
  action: QueueAction;
  allowedRoles: readonly string[];
}

/**
 * Roles that may perform a ticket operation, exactly as the state machine allows it, plus
 * `org_admin` when supervisor or facility-admin authority suffices (the API's `queueActorRoles`
 * rule). System actors (`system`, `visitor_self`) are not roles and are never named. An
 * operation with no matching rule returns an empty list (nobody, fail closed).
 */
export function operationRoles(
  op: Pick<QueueOperation, 'action' | 'from'>,
  rules: readonly TransitionRuleLike[],
): Role[] {
  const named = new Set<string>();
  for (const r of rules) {
    if (r.action !== op.action || r.from !== op.from) continue;
    for (const a of r.allowedRoles) named.add(a);
  }
  if (named.has(Role.SUPERVISOR) || named.has(Role.FACILITY_ADMIN)) named.add(Role.ORG_ADMIN);
  // Only real roles, in canonical order: system actors (`system`, `visitor_self`) drop out here
  return Object.values(Role).filter((r) => named.has(r));
}

/** Whether the user's queue-actor roles at the facility satisfy the operation (advisory). */
export function canPerformOperation(
  grants: readonly RoleGrant[] | null,
  facilityId: string | null,
  op: Pick<QueueOperation, 'action' | 'from'>,
  rules: readonly TransitionRuleLike[],
): boolean {
  const held = queueActorRolesAt(grants, facilityId);
  return rules.some(
    (r) =>
      r.action === op.action &&
      r.from === op.from &&
      held.some((role) => r.allowedRoles.includes(role)),
  );
}
