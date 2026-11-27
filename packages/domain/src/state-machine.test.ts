import { describe, expect, it } from 'vitest';
import { PriorityClass, QueueAction, Role, SystemActor, TicketState } from '@queuebridge/contracts';
import { comparePriority, transition, validatePriorityOverride } from './state-machine.js';

// ---------------------------------------------------------------------------
// Valid transitions
// ---------------------------------------------------------------------------

describe('transition — valid transitions', () => {
  it('waiting → called via call_next by counter operator', () => {
    const result = transition({
      currentState: TicketState.WAITING,
      action: QueueAction.TICKET_CALL_NEXT,
      actorRole: Role.STAFF_COUNTER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.newState).toBe(TicketState.CALLED);
    }
  });

  it('called → serving by counter operator', () => {
    const result = transition({
      currentState: TicketState.CALLED,
      action: QueueAction.TICKET_SERVE,
      actorRole: Role.STAFF_COUNTER,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.newState).toBe(TicketState.SERVING);
  });

  it('serving → completed by counter operator', () => {
    const result = transition({
      currentState: TicketState.SERVING,
      action: QueueAction.TICKET_COMPLETE,
      actorRole: Role.STAFF_COUNTER,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.newState).toBe(TicketState.COMPLETED);
  });

  it('called → missed by counter operator', () => {
    const result = transition({
      currentState: TicketState.CALLED,
      action: QueueAction.TICKET_MISS,
      actorRole: Role.STAFF_COUNTER,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.newState).toBe(TicketState.MISSED);
  });

  it('missed → waiting via supervisor with grace_window_active policy', () => {
    const result = transition({
      currentState: TicketState.MISSED,
      action: QueueAction.TICKET_RESUME,
      actorRole: Role.SUPERVISOR,
      satisfiedPolicies: ['grace_window_active'],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.newState).toBe(TicketState.WAITING);
  });

  it('paused → waiting by counter operator', () => {
    const result = transition({
      currentState: TicketState.PAUSED,
      action: QueueAction.TICKET_RESUME,
      actorRole: Role.STAFF_COUNTER,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.newState).toBe(TicketState.WAITING);
  });

  it('supervisor can call next', () => {
    const result = transition({
      currentState: TicketState.WAITING,
      action: QueueAction.TICKET_CALL_NEXT,
      actorRole: Role.SUPERVISOR,
    });
    expect(result.success).toBe(true);
  });

  it('supervisor can recall a called ticket back to waiting', () => {
    const result = transition({
      currentState: TicketState.CALLED,
      action: QueueAction.TICKET_RESUME,
      actorRole: Role.SUPERVISOR,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.newState).toBe(TicketState.WAITING);
  });

  it('serving → transferred by counter operator', () => {
    const result = transition({
      currentState: TicketState.SERVING,
      action: QueueAction.TICKET_TRANSFER,
      actorRole: Role.STAFF_COUNTER,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.newState).toBe(TicketState.TRANSFERRED);
  });
});

// ---------------------------------------------------------------------------
// Rejected transitions — wrong state
// ---------------------------------------------------------------------------

describe('transition — invalid state transitions', () => {
  it('cannot call from completed state', () => {
    const result = transition({
      currentState: TicketState.COMPLETED,
      action: QueueAction.TICKET_CALL_NEXT,
      actorRole: Role.STAFF_COUNTER,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toContain('completed');
    }
  });

  it('cannot complete from waiting state', () => {
    const result = transition({
      currentState: TicketState.WAITING,
      action: QueueAction.TICKET_COMPLETE,
      actorRole: Role.STAFF_COUNTER,
    });
    expect(result.success).toBe(false);
  });

  it('cannot call from cancelled state', () => {
    const result = transition({
      currentState: TicketState.CANCELLED,
      action: QueueAction.TICKET_CALL_NEXT,
      actorRole: Role.SUPERVISOR,
    });
    expect(result.success).toBe(false);
  });

  it('cannot directly transition out of needs_review', () => {
    const result = transition({
      currentState: TicketState.NEEDS_REVIEW,
      action: QueueAction.TICKET_RESUME,
      actorRole: Role.SUPERVISOR,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toContain('needs_review');
    }
  });
});

// ---------------------------------------------------------------------------
// Rejected transitions — wrong role
// ---------------------------------------------------------------------------

describe('transition — unauthorized role', () => {
  it('visitor_anonymous cannot call next', () => {
    const result = transition({
      currentState: TicketState.WAITING,
      action: QueueAction.TICKET_CALL_NEXT,
      actorRole: Role.VISITOR_ANONYMOUS,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toContain('visitor_anonymous');
    }
  });

  it('auditor cannot complete a ticket', () => {
    const result = transition({
      currentState: TicketState.SERVING,
      action: QueueAction.TICKET_COMPLETE,
      actorRole: Role.AUDITOR,
    });
    expect(result.success).toBe(false);
  });

  it('reception staff cannot call next', () => {
    const result = transition({
      currentState: TicketState.WAITING,
      action: QueueAction.TICKET_CALL_NEXT,
      actorRole: Role.STAFF_RECEPTION,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Policy preconditions
// ---------------------------------------------------------------------------

describe('transition — policy preconditions', () => {
  it('missed → waiting fails without grace_window_active policy', () => {
    const result = transition({
      currentState: TicketState.MISSED,
      action: QueueAction.TICKET_RESUME,
      actorRole: Role.SUPERVISOR,
      // grace_window_active NOT in satisfiedPolicies
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toContain('grace_window_active');
    }
  });

  it('missed → waiting succeeds WITH grace_window_active policy', () => {
    const result = transition({
      currentState: TicketState.MISSED,
      action: QueueAction.TICKET_RESUME,
      actorRole: Role.SUPERVISOR,
      satisfiedPolicies: ['grace_window_active'],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Priority override validation
// ---------------------------------------------------------------------------

describe('validatePriorityOverride', () => {
  it('accepts a valid supervisor override', () => {
    const error = validatePriorityOverride({
      actorRole: Role.SUPERVISOR,
      reasonCode: 'medical_urgency',
      reasonText: 'Patient shows signs of acute distress',
      policyVersion: 'v1',
    });
    expect(error).toBeNull();
  });

  it('accepts a facility_admin override', () => {
    const error = validatePriorityOverride({
      actorRole: Role.FACILITY_ADMIN,
      reasonCode: 'elderly_visitor',
      reasonText: 'Elderly visitor requires priority service',
      policyVersion: 'v1',
    });
    expect(error).toBeNull();
  });

  it('rejects counter operator attempting override', () => {
    const error = validatePriorityOverride({
      actorRole: Role.STAFF_COUNTER,
      reasonCode: 'urgent',
      reasonText: 'Seems urgent',
      policyVersion: 'v1',
    });
    expect(error).not.toBeNull();
    expect(error).toContain('SUPERVISOR');
  });

  it('rejects override without reason code', () => {
    const error = validatePriorityOverride({
      actorRole: Role.SUPERVISOR,
      reasonCode: '',
      reasonText: 'Some reason',
      policyVersion: 'v1',
    });
    expect(error).not.toBeNull();
    expect(error).toContain('reason code');
  });

  it('rejects override with too-short reason text', () => {
    const error = validatePriorityOverride({
      actorRole: Role.SUPERVISOR,
      reasonCode: 'urgent',
      reasonText: 'ok',
      policyVersion: 'v1',
    });
    expect(error).not.toBeNull();
    expect(error).toContain('reason text');
  });

  it('rejects override without policy version', () => {
    const error = validatePriorityOverride({
      actorRole: Role.SUPERVISOR,
      reasonCode: 'urgent',
      reasonText: 'Valid reason text here',
      policyVersion: '',
    });
    expect(error).not.toBeNull();
    expect(error).toContain('Policy version');
  });
});

// ---------------------------------------------------------------------------
// Priority ordering
// ---------------------------------------------------------------------------

describe('comparePriority', () => {
  it('urgent has higher priority than priority', () => {
    expect(comparePriority(PriorityClass.URGENT, PriorityClass.PRIORITY)).toBeLessThan(0);
  });

  it('priority has higher priority than normal', () => {
    expect(comparePriority(PriorityClass.PRIORITY, PriorityClass.NORMAL)).toBeLessThan(0);
  });

  it('urgent has higher priority than normal', () => {
    expect(comparePriority(PriorityClass.URGENT, PriorityClass.NORMAL)).toBeLessThan(0);
  });

  it('same class compares equal', () => {
    expect(comparePriority(PriorityClass.NORMAL, PriorityClass.NORMAL)).toBe(0);
  });

  it('normal has lower priority than urgent', () => {
    expect(comparePriority(PriorityClass.NORMAL, PriorityClass.URGENT)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// M5.1: transition-only actors (never roles)
// ---------------------------------------------------------------------------

describe('M5.1 visitor rejoin and automatic no-show actors', () => {
  const allActions = Object.values(QueueAction);
  const allStates = Object.values(TicketState);

  it('a visitor may rejoin their own missed ticket only inside the grace window AND with self_resume', () => {
    const base = {
      currentState: TicketState.MISSED,
      action: QueueAction.TICKET_RESUME,
      actorRole: SystemActor.VISITOR_SELF,
    };
    expect(
      transition({ ...base, satisfiedPolicies: ['grace_window_active', 'self_resume_allowed'] }),
    ).toMatchObject({ success: true, newState: TicketState.WAITING });
    expect(transition({ ...base, satisfiedPolicies: ['grace_window_active'] }).success).toBe(false);
    expect(transition({ ...base, satisfiedPolicies: ['self_resume_allowed'] }).success).toBe(false);
    expect(transition({ ...base, satisfiedPolicies: [] }).success).toBe(false);
  });

  it('automatic no-show applies only to a called ticket whose call window elapsed', () => {
    const base = {
      currentState: TicketState.CALLED,
      action: QueueAction.TICKET_MISS,
      actorRole: SystemActor.SYSTEM,
    };
    expect(transition({ ...base, satisfiedPolicies: ['auto_miss_due'] })).toMatchObject({
      success: true,
      newState: TicketState.MISSED,
    });
    expect(transition({ ...base, satisfiedPolicies: [] }).success).toBe(false);
    // never from serving: a visitor being served is never auto-missed
    expect(
      transition({
        ...base,
        currentState: TicketState.SERVING,
        satisfiedPolicies: ['auto_miss_due'],
      }).success,
    ).toBe(false);
  });

  it('neither actor can do anything else, whatever policies are claimed', () => {
    const allowed = new Set([
      `${SystemActor.VISITOR_SELF}|${TicketState.MISSED}|${QueueAction.TICKET_RESUME}`,
      `${SystemActor.SYSTEM}|${TicketState.CALLED}|${QueueAction.TICKET_MISS}`,
    ]);
    const every = ['grace_window_active', 'self_resume_allowed', 'auto_miss_due'];
    for (const actor of [SystemActor.VISITOR_SELF, SystemActor.SYSTEM]) {
      for (const state of allStates) {
        for (const action of allActions) {
          const r = transition({
            currentState: state,
            action,
            actorRole: actor,
            satisfiedPolicies: every,
          });
          expect(r.success, `${actor} ${state} ${action}`).toBe(
            allowed.has(`${actor}|${state}|${action}`),
          );
        }
      }
    }
  });

  it('the new actors are not roles (they can never be granted)', () => {
    expect(Object.values(Role)).not.toContain(SystemActor.VISITOR_SELF);
    expect(Object.values(Role)).not.toContain(SystemActor.SYSTEM);
  });

  it('staff resume of a missed ticket is unchanged (no self_resume needed for staff)', () => {
    expect(
      transition({
        currentState: TicketState.MISSED,
        action: QueueAction.TICKET_RESUME,
        actorRole: Role.STAFF_COUNTER,
        satisfiedPolicies: ['grace_window_active'],
      }),
    ).toMatchObject({ success: true, newState: TicketState.WAITING });
  });
});
