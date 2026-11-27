import { describe, expect, it } from 'vitest';
import { QueueAction, TicketState } from '@queuebridge/contracts';
import { canPerformOperation, operationRoles, type TransitionRuleLike } from './index.js';
import { FA, FB, grant } from './fixtures.testkit.js';

/** A small stand-in table; the real domain table is checked in apps/api (D3 check 4). */
const RULES: TransitionRuleLike[] = [
  {
    from: TicketState.WAITING,
    action: QueueAction.TICKET_CALL_NEXT,
    allowedRoles: ['staff_counter', 'supervisor'],
  },
  { from: TicketState.CALLED, action: QueueAction.TICKET_MISS, allowedRoles: ['staff_counter'] },
  { from: TicketState.CALLED, action: QueueAction.TICKET_MISS, allowedRoles: ['system'] },
  { from: TicketState.MISSED, action: QueueAction.TICKET_RESUME, allowedRoles: ['visitor_self'] },
];

describe('state-machine operation roles (decision D3 check 4)', () => {
  it('resolves roles from the transition table, adding org_admin only with supervisor authority', () => {
    expect(
      operationRoles({ action: QueueAction.TICKET_CALL_NEXT, from: TicketState.WAITING }, RULES),
    ).toEqual(['staff_counter', 'supervisor', 'org_admin']);
    expect(
      operationRoles({ action: QueueAction.TICKET_MISS, from: TicketState.CALLED }, RULES),
    ).toEqual(['staff_counter']);
  });

  it('never names system actors and fails closed for unknown transitions', () => {
    expect(
      operationRoles({ action: QueueAction.TICKET_RESUME, from: TicketState.MISSED }, RULES),
    ).toEqual([]);
    expect(
      operationRoles({ action: QueueAction.TICKET_COMPLETE, from: TicketState.SERVING }, RULES),
    ).toEqual([]);
  });

  it('checks the operation at the context facility only', () => {
    const op = { action: QueueAction.TICKET_CALL_NEXT, from: TicketState.WAITING };
    expect(canPerformOperation([grant('staff_counter')], FA, op, RULES)).toBe(true);
    expect(canPerformOperation([grant('staff_counter')], FB, op, RULES)).toBe(false);
    expect(canPerformOperation([grant('staff_reception')], FA, op, RULES)).toBe(false);
    expect(canPerformOperation([grant('org_admin', null)], FB, op, RULES)).toBe(true);
    expect(canPerformOperation(null, FA, op, RULES)).toBe(false);
  });
});
