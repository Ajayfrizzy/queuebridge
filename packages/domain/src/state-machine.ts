import {
  PriorityClass,
  QueueAction,
  Role,
  SystemActor,
  TicketState,
  type TransitionActor,
} from '@queuebridge/contracts';

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * Each entry defines: from state, action, required role(s), and resulting state.
 * Every transition requires both a role and state precondition.
 * `needs_review` can only be resolved by a supervisor — never client-side overwrite.
 */
export interface TransitionRule {
  from: TicketState;
  action: QueueAction;
  allowedRoles: TransitionActor[];
  to: TicketState;
  /** Additional policy preconditions (validated at runtime) */
  requiresPolicy?: string[];
}

export const TRANSITION_RULES: TransitionRule[] = [
  // waiting → called
  {
    from: TicketState.WAITING,
    action: QueueAction.TICKET_CALL_NEXT,
    allowedRoles: [Role.STAFF_COUNTER, Role.SUPERVISOR],
    to: TicketState.CALLED,
  },
  // Calling a specific ticket out of the published order is a ROUTING OVERRIDE (REQ-F5.5):
  // supervisor only, with a recorded reason
  {
    from: TicketState.WAITING,
    action: QueueAction.TICKET_CALL_SPECIFIC,
    allowedRoles: [Role.SUPERVISOR],
    to: TicketState.CALLED,
  },
  // Priority class change (REQ-F3.3): the ticket keeps waiting; only its class changes
  {
    from: TicketState.WAITING,
    action: QueueAction.TICKET_PRIORITY_OVERRIDE,
    allowedRoles: [Role.SUPERVISOR, Role.FACILITY_ADMIN],
    to: TicketState.WAITING,
  },
  // waiting → paused
  {
    from: TicketState.WAITING,
    action: QueueAction.TICKET_PAUSE,
    allowedRoles: [Role.STAFF_COUNTER, Role.SUPERVISOR],
    to: TicketState.PAUSED,
  },
  // waiting → cancelled
  {
    from: TicketState.WAITING,
    action: QueueAction.TICKET_CANCEL,
    allowedRoles: [Role.STAFF_RECEPTION, Role.STAFF_COUNTER, Role.SUPERVISOR, Role.FACILITY_ADMIN],
    to: TicketState.CANCELLED,
  },
  // waiting → transferred
  {
    from: TicketState.WAITING,
    action: QueueAction.TICKET_TRANSFER,
    allowedRoles: [Role.STAFF_COUNTER, Role.SUPERVISOR],
    to: TicketState.TRANSFERRED,
  },
  // called → serving
  {
    from: TicketState.CALLED,
    action: QueueAction.TICKET_SERVE,
    allowedRoles: [Role.STAFF_COUNTER, Role.SUPERVISOR],
    to: TicketState.SERVING,
  },
  // called → missed
  {
    from: TicketState.CALLED,
    action: QueueAction.TICKET_MISS,
    allowedRoles: [Role.STAFF_COUNTER, Role.SUPERVISOR],
    to: TicketState.MISSED,
  },
  // called → waiting (authorized recall)
  {
    from: TicketState.CALLED,
    action: QueueAction.TICKET_RESUME,
    allowedRoles: [Role.SUPERVISOR],
    to: TicketState.WAITING,
  },
  // called → cancelled
  {
    from: TicketState.CALLED,
    action: QueueAction.TICKET_CANCEL,
    allowedRoles: [Role.STAFF_COUNTER, Role.SUPERVISOR],
    to: TicketState.CANCELLED,
  },
  // serving → completed
  {
    from: TicketState.SERVING,
    action: QueueAction.TICKET_COMPLETE,
    allowedRoles: [Role.STAFF_COUNTER, Role.SUPERVISOR],
    to: TicketState.COMPLETED,
  },
  // serving → paused
  {
    from: TicketState.SERVING,
    action: QueueAction.TICKET_PAUSE,
    allowedRoles: [Role.STAFF_COUNTER, Role.SUPERVISOR],
    to: TicketState.PAUSED,
  },
  // serving → transferred
  {
    from: TicketState.SERVING,
    action: QueueAction.TICKET_TRANSFER,
    allowedRoles: [Role.STAFF_COUNTER, Role.SUPERVISOR],
    to: TicketState.TRANSFERRED,
  },
  // paused → waiting
  {
    from: TicketState.PAUSED,
    action: QueueAction.TICKET_RESUME,
    allowedRoles: [Role.STAFF_COUNTER, Role.SUPERVISOR],
    to: TicketState.WAITING,
  },
  // paused → cancelled
  {
    from: TicketState.PAUSED,
    action: QueueAction.TICKET_CANCEL,
    allowedRoles: [Role.STAFF_COUNTER, Role.SUPERVISOR, Role.FACILITY_ADMIN],
    to: TicketState.CANCELLED,
  },
  // missed → waiting (grace rule)
  {
    from: TicketState.MISSED,
    action: QueueAction.TICKET_RESUME,
    allowedRoles: [Role.STAFF_RECEPTION, Role.STAFF_COUNTER, Role.SUPERVISOR],
    to: TicketState.WAITING,
    requiresPolicy: ['grace_window_active'],
  },
  // M5.1 (REQ-F4.13): with the `self_resume` policy, the visitor holding the ticket's status
  // token may return their OWN missed ticket to the queue, inside the grace window only.
  {
    from: TicketState.MISSED,
    action: QueueAction.TICKET_RESUME,
    allowedRoles: [SystemActor.VISITOR_SELF],
    to: TicketState.WAITING,
    requiresPolicy: ['grace_window_active', 'self_resume_allowed'],
  },
  // missed → cancelled
  {
    from: TicketState.MISSED,
    action: QueueAction.TICKET_CANCEL,
    allowedRoles: [Role.STAFF_RECEPTION, Role.STAFF_COUNTER, Role.SUPERVISOR],
    to: TicketState.CANCELLED,
  },
  // M5.1 (REQ-F4.14): automatic no-show, opt-in per service, driven only by the elapsed time
  // since the committed call. Never by a notification outcome.
  {
    from: TicketState.CALLED,
    action: QueueAction.TICKET_MISS,
    allowedRoles: [SystemActor.SYSTEM],
    to: TicketState.MISSED,
    requiresPolicy: ['auto_miss_due'],
  },
  // M4 routing: hand a called/serving ticket to another counter of the same service
  {
    from: TicketState.CALLED,
    action: QueueAction.TICKET_COUNTER_TRANSFER,
    allowedRoles: [Role.STAFF_COUNTER, Role.SUPERVISOR],
    to: TicketState.CALLED,
  },
  {
    from: TicketState.SERVING,
    action: QueueAction.TICKET_COUNTER_TRANSFER,
    allowedRoles: [Role.STAFF_COUNTER, Role.SUPERVISOR],
    to: TicketState.SERVING,
  },
  // M4 routing: a called ticket returns to the head of its queue when its counter closes. Only
  // roles that may close a busy counter can cause it (an idle counter has nothing to release).
  {
    from: TicketState.CALLED,
    action: QueueAction.TICKET_RELEASE,
    allowedRoles: [Role.SUPERVISOR, Role.FACILITY_ADMIN],
    to: TicketState.WAITING,
  },
  // any → needs_review (supervisor forced review)
  // needs_review can only be resolved by supervisor; transition OUT handled separately
];

// ---------------------------------------------------------------------------
// Priority override (supervisor-only)
// ---------------------------------------------------------------------------

export interface PriorityOverrideParams {
  actorRole: Role;
  reasonCode: string;
  reasonText: string;
  policyVersion: string;
}

/**
 * Validate that a priority override is authorized.
 * Does not mutate state — returns an error string or null.
 */
export function validatePriorityOverride(params: PriorityOverrideParams): string | null {
  if (params.actorRole !== Role.SUPERVISOR && params.actorRole !== Role.FACILITY_ADMIN) {
    return 'Priority overrides require SUPERVISOR or FACILITY_ADMIN role';
  }
  if (!params.reasonCode || params.reasonCode.trim().length === 0) {
    return 'A reason code is required for priority overrides';
  }
  if (!params.reasonText || params.reasonText.trim().length < 5) {
    return 'A meaningful reason text (≥5 characters) is required for priority overrides';
  }
  if (!params.policyVersion || params.policyVersion.trim().length === 0) {
    return 'Policy version must be recorded with every priority override';
  }
  return null;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export interface TransitionInput {
  currentState: TicketState;
  action: QueueAction;
  actorRole: TransitionActor;
  /** Policy conditions satisfied for this transition (e.g. 'grace_window_active') */
  satisfiedPolicies?: string[];
}

export interface TransitionResult {
  success: true;
  newState: TicketState;
  rule: TransitionRule;
}

export interface TransitionError {
  success: false;
  reason: string;
}

/**
 * Attempt a ticket state transition.
 *
 * Pure function — no side effects, no I/O.
 * Returns the new state or a descriptive error.
 */
export function transition(input: TransitionInput): TransitionResult | TransitionError {
  const { currentState, action, actorRole, satisfiedPolicies = [] } = input;

  // needs_review cannot be overwritten by standard transitions
  if (currentState === TicketState.NEEDS_REVIEW) {
    return {
      success: false,
      reason: `Ticket is in needs_review state and requires supervisor resolution — no direct transitions permitted`,
    };
  }

  const matchingRules = TRANSITION_RULES.filter(
    (r) => r.from === currentState && r.action === action,
  );

  if (matchingRules.length === 0) {
    return {
      success: false,
      reason: `No transition exists from '${currentState}' for action '${action}'`,
    };
  }

  // Find a rule that matches the actor's role
  const rule = matchingRules.find((r) => r.allowedRoles.includes(actorRole));
  if (rule === undefined) {
    return {
      success: false,
      reason: `Role '${actorRole}' is not permitted to perform action '${action}' from state '${currentState}'`,
    };
  }

  // Check policy preconditions
  if (rule.requiresPolicy && rule.requiresPolicy.length > 0) {
    const missing = rule.requiresPolicy.filter((p) => !satisfiedPolicies.includes(p));
    if (missing.length > 0) {
      return {
        success: false,
        reason: `Policy preconditions not satisfied: ${missing.join(', ')}`,
      };
    }
  }

  return { success: true, newState: rule.to, rule };
}

// ---------------------------------------------------------------------------
// Priority class ordering (lower number = higher priority)
// ---------------------------------------------------------------------------

export const PRIORITY_ORDER: Record<PriorityClass, number> = {
  [PriorityClass.URGENT]: 0,
  [PriorityClass.PRIORITY]: 1,
  [PriorityClass.NORMAL]: 2,
};

/**
 * Compare two priority classes. Returns negative if a has higher priority than b.
 */
export function comparePriority(a: PriorityClass, b: PriorityClass): number {
  return (PRIORITY_ORDER[a] ?? 0) - (PRIORITY_ORDER[b] ?? 0);
}
