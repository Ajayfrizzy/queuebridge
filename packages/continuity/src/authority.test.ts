import { describe, expect, it } from 'vitest';
import { QueueAction, Role } from '@queuebridge/contracts';
import type { CoordinatorAuth } from '@queuebridge/contracts';
import { canAdvanceOffline, validateCoordinatorEpoch } from './authority.js';

const BASE_AUTH: CoordinatorAuth = {
  device_id: '550e8400-e29b-41d4-a716-446655440001',
  facility_id: '550e8400-e29b-41d4-a716-446655440002',
  queue_session_id: '550e8400-e29b-41d4-a716-446655440003',
  epoch: 3,
  allowed_actions: [
    QueueAction.TICKET_CALL_NEXT,
    QueueAction.TICKET_COMPLETE,
    QueueAction.TICKET_SERVE,
  ],
  issued_at: '2026-10-30T17:00:00.000Z',
  expires_at: '2026-10-30T18:00:00.000Z',
  issued_by_role: Role.SUPERVISOR,
  issued_by_actor_id: '550e8400-e29b-41d4-a716-446655440004',
};

const WITHIN_WINDOW = new Date('2026-10-30T17:30:00.000Z');
const AFTER_EXPIRY = new Date('2026-10-30T18:00:01.000Z');
const AT_EXPIRY = new Date('2026-10-30T18:00:00.000Z');

describe('validateCoordinatorEpoch', () => {
  it('returns valid for an allowed action within the expiry window', () => {
    const result = validateCoordinatorEpoch(BASE_AUTH, QueueAction.TICKET_CALL_NEXT, WITHIN_WINDOW);
    expect(result.valid).toBe(true);
  });

  it('returns expired when current time is at or after expires_at', () => {
    const result = validateCoordinatorEpoch(BASE_AUTH, QueueAction.TICKET_CALL_NEXT, AT_EXPIRY);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('expired');
  });

  it('returns expired when current time is after expires_at', () => {
    const result = validateCoordinatorEpoch(BASE_AUTH, QueueAction.TICKET_CALL_NEXT, AFTER_EXPIRY);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('expired');
  });

  it('returns action_not_allowed when action is not in allowed_actions', () => {
    const result = validateCoordinatorEpoch(
      BASE_AUTH,
      QueueAction.TICKET_PRIORITY_OVERRIDE,
      WITHIN_WINDOW,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('action_not_allowed');
  });

  it('returns invalid when auth is null', () => {
    const result = validateCoordinatorEpoch(null, QueueAction.TICKET_CALL_NEXT, WITHIN_WINDOW);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('invalid');
  });

  it('returns invalid when auth is undefined', () => {
    const result = validateCoordinatorEpoch(undefined, QueueAction.TICKET_CALL_NEXT, WITHIN_WINDOW);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('invalid');
  });

  it('validates all explicitly allowed actions', () => {
    for (const action of BASE_AUTH.allowed_actions) {
      const result = validateCoordinatorEpoch(BASE_AUTH, action, WITHIN_WINDOW);
      expect(result.valid).toBe(true);
    }
  });
});

describe('canAdvanceOffline', () => {
  it('returns true when auth is valid and has advance actions', () => {
    expect(canAdvanceOffline(BASE_AUTH, WITHIN_WINDOW)).toBe(true);
  });

  it('returns false when auth is expired', () => {
    expect(canAdvanceOffline(BASE_AUTH, AFTER_EXPIRY)).toBe(false);
  });

  it('returns false when auth is null', () => {
    expect(canAdvanceOffline(null, WITHIN_WINDOW)).toBe(false);
  });

  it('returns false when auth has no advance actions', () => {
    const createOnlyAuth: CoordinatorAuth = {
      ...BASE_AUTH,
      allowed_actions: [QueueAction.TICKET_CREATE],
    };
    expect(canAdvanceOffline(createOnlyAuth, WITHIN_WINDOW)).toBe(false);
  });
});
