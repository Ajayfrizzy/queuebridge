import { type CoordinatorAuth, QueueAction } from '@queuebridge/contracts';

export type EpochValidationResult =
  | { valid: true }
  | { valid: false; reason: 'expired' | 'revoked' | 'action_not_allowed' | 'invalid' };

/**
 * Validate a coordinator authorization token.
 *
 * Pure function — no I/O. `now` injected for testability.
 */
export function validateCoordinatorEpoch(
  auth: CoordinatorAuth | null | undefined,
  action: QueueAction,
  now: Date,
): EpochValidationResult {
  if (!auth) {
    return { valid: false, reason: 'invalid' };
  }

  const expiresAt = new Date(auth.expires_at);
  if (now >= expiresAt) {
    return { valid: false, reason: 'expired' };
  }

  if (!auth.allowed_actions.includes(action)) {
    return { valid: false, reason: 'action_not_allowed' };
  }

  return { valid: true };
}

/**
 * Whether the coordinator authorization allows offline advancement
 * (call_next or call_specific actions).
 */
export function canAdvanceOffline(auth: CoordinatorAuth | null | undefined, now: Date): boolean {
  if (!auth) return false;
  const advanceActions: QueueAction[] = [
    QueueAction.TICKET_CALL_NEXT,
    QueueAction.TICKET_CALL_SPECIFIC,
    QueueAction.TICKET_COMPLETE,
    QueueAction.TICKET_SERVE,
  ];
  return advanceActions.some((action) => validateCoordinatorEpoch(auth, action, now).valid);
}
