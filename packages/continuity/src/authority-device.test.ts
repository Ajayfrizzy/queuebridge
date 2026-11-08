import { describe, expect, it } from 'vitest';
import { QueueAction, Role, type CoordinatorAuth } from '@queuebridge/contracts';
import {
  advanceFloor,
  CLOCK_TOLERANCE_MS,
  decodeAuthorityToken,
  evaluateOfflineAction,
  measureElapsed,
  offlineAuthorityState,
  receiveAuthority,
  shouldReplaceAuthority,
  timingEvidence,
  type ClockReading,
  type LocalAuthority,
} from './authority.js';

const Q = '550e8400-e29b-41d4-a716-446655440003';
const D = '550e8400-e29b-41d4-a716-446655440001';
const MIN = 60_000;
const SERVER_DELIVERED = Date.parse('2026-11-08T10:00:00.000Z');
const CLAIMS: CoordinatorAuth = {
  device_id: D,
  facility_id: '550e8400-e29b-41d4-a716-446655440002',
  queue_session_id: Q,
  epoch: 2,
  allowed_actions: [QueueAction.TICKET_CALL_NEXT, QueueAction.TICKET_SERVE],
  issued_at: '2026-11-08T09:55:00.000Z',
  expires_at: '2026-11-08T11:00:00.000Z', // 60 min after delivery
  delivered_at: new Date(SERVER_DELIVERED).toISOString(),
  issued_by_role: Role.SUPERVISOR,
  issued_by_actor_id: '550e8400-e29b-41d4-a716-446655440004',
};
const token = (claims: unknown): string =>
  `v1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2ln`;

/**
 * A device whose wall clock is 3 hours WRONG (behind the server) receives the token at perf=1000.
 * Its clocks then evolve per scenario; the server timeline is never read from the device.
 */
const WALL0 = SERVER_DELIVERED - 3 * 60 * MIN;
const PERF0 = 1000;
const at = (minutes: number, o: Partial<ClockReading> = {}): ClockReading => ({
  wallMs: WALL0 + minutes * MIN,
  perfMs: PERF0 + minutes * MIN,
  pageSession: 'page-1',
  ...o,
});
function held(): LocalAuthority {
  const a = receiveAuthority(token(CLAIMS), at(0));
  if (!a) throw new Error('token rejected');
  return a;
}
const ctx = (
  clock: ClockReading,
  over: Partial<Parameters<typeof evaluateOfflineAction>[1]> = {},
): Parameters<typeof evaluateOfflineAction>[1] => ({
  queueId: Q,
  deviceId: D,
  action: QueueAction.TICKET_CALL_NEXT,
  clock,
  ...over,
});

describe('decodeAuthorityToken / receiveAuthority', () => {
  it('reads valid claims and rejects anything malformed', () => {
    expect(decodeAuthorityToken(token(CLAIMS))?.epoch).toBe(2);
    expect(decodeAuthorityToken('garbage')).toBeNull();
    expect(decodeAuthorityToken('v2.e30.c2ln')).toBeNull();
    expect(decodeAuthorityToken(token({ ...CLAIMS, epoch: 0 }))).toBeNull();
    expect(decodeAuthorityToken('v1.%%%.sig')).toBeNull();
  });
  it('refuses a token that carries no server delivery time (cannot be timed)', () => {
    const { delivered_at: _d, ...old } = CLAIMS;
    expect(receiveAuthority(token(old), at(0))).toBeNull();
  });
});

describe('measureElapsed — independent of the device clock offset', () => {
  it('a device clock that is hours wrong does not matter: expiry follows the SERVER timeline', () => {
    const a = held();
    expect(evaluateOfflineAction(a, ctx(at(30)))).toEqual({ allowed: true, expiresInMs: 30 * MIN });
    expect(evaluateOfflineAction(a, ctx(at(60)))).toEqual({ allowed: false, reason: 'expired' });
  });

  it('system sleep (monotonic paused, wall advanced) is counted — conservative', () => {
    const a = held();
    const slept = at(10, { wallMs: WALL0 + 70 * MIN }); // perf says 10 min, wall says 70
    expect(measureElapsed(a, slept)).toMatchObject({
      elapsed_ms: 70 * MIN,
      floor_ms: 10 * MIN,
      rollback_detected: false,
    });
    expect(evaluateOfflineAction(a, ctx(slept))).toEqual({ allowed: false, reason: 'expired' });
  });
});

describe('clock moved backwards', () => {
  it('while the app is open: detected, advancement stops (capture only)', () => {
    const a = held();
    const wound = at(45, { wallMs: WALL0 + 5 * MIN }); // 45 min of monotonic time, wall says 5
    expect(measureElapsed(a, wound).rollback_detected).toBe(true);
    expect(evaluateOfflineAction(a, ctx(wound))).toEqual({
      allowed: false,
      reason: 'clock_unverifiable',
    });
    expect(
      evaluateOfflineAction(a, ctx(wound, { action: QueueAction.TICKET_CREATE })).allowed,
    ).toBe(true);
  });

  it('is sticky once persisted: moving the clock forward again does not restore authority', () => {
    const a = advanceFloor(held(), at(45, { wallMs: WALL0 + 5 * MIN }));
    expect(a.rollback_detected).toBe(true);
    expect(evaluateOfflineAction(a, ctx(at(46))).allowed).toBe(false);
  });

  it('within tolerance is not a rollback (timer jitter)', () => {
    const a = held();
    expect(
      measureElapsed(a, at(10, { wallMs: WALL0 + 10 * MIN - CLOCK_TOLERANCE_MS + 1 }))
        .rollback_detected,
    ).toBe(false);
  });

  it('before a restart: a wall clock behind the persisted floor is detected on reopening', () => {
    let a = held();
    a = advanceFloor(a, at(40)); // the app saw 40 min elapse, persisted
    const reopened = { wallMs: WALL0 + 15 * MIN, perfMs: 50, pageSession: 'page-2' }; // clock wound back
    expect(measureElapsed(a, reopened)).toMatchObject({
      rollback_detected: true,
      source: 'restarted',
    });
  });
});

describe('restarts', () => {
  it('carry the persisted floor forward and mark evidence as restarted', () => {
    let a = advanceFloor(held(), at(20)); // persisted floor 20 min
    const reopen = { wallMs: WALL0 + 30 * MIN, perfMs: 10, pageSession: 'page-2' };
    a = advanceFloor(a, reopen); // anchored to the new page session
    const later = { wallMs: WALL0 + 35 * MIN, perfMs: 10 + 5 * MIN, pageSession: 'page-2' };
    const m = measureElapsed(a, later);
    expect(m.source).toBe('restarted');
    expect(m.floor_ms).toBe(25 * MIN); // 20 persisted + 5 monotonic since anchoring
    expect(m.elapsed_ms).toBe(35 * MIN); // wall clock covers the closed-app gap
    expect(timingEvidence(a, later)).toMatchObject({
      delivered_at: CLAIMS.delivered_at,
      source: 'restarted',
      floor_ms: 25 * MIN,
    });
  });

  it('the floor never goes backwards', () => {
    const a = advanceFloor(held(), at(20));
    const b = advanceFloor(a, { wallMs: WALL0 + 21 * MIN, perfMs: 0, pageSession: 'page-3' });
    expect(b.floor_ms).toBe(20 * MIN);
  });
});

describe('evaluateOfflineAction — remaining rules', () => {
  it.each([
    ['no authority', null, {}, 'no_authority'],
    ['another queue', 'held', { queueId: 'other' }, 'wrong_queue'],
    ['another device', 'held', { deviceId: 'other' }, 'wrong_device'],
    [
      'action outside the grant',
      'held',
      { action: QueueAction.TICKET_COMPLETE },
      'action_not_allowed',
    ],
    ['superseded epoch', 'held', { knownServerEpoch: 3 }, 'superseded'],
  ] as const)('denies: %s', (_n, auth, over, reason) => {
    expect(evaluateOfflineAction(auth ? held() : null, ctx(at(1), over))).toEqual({
      allowed: false,
      reason,
    });
  });

  it('offlineAuthorityState summarises advance vs capture-only', () => {
    expect(offlineAuthorityState(held(), { queueId: Q, deviceId: D, clock: at(10) })).toEqual({
      mode: 'advance',
      expiresInMs: 50 * MIN,
    });
    expect(offlineAuthorityState(null, { queueId: Q, deviceId: D, clock: at(10) })).toEqual({
      mode: 'capture_only',
      reason: 'no_authority',
    });
  });
});

describe('shouldReplaceAuthority', () => {
  it('keeps the held token (and its monotonic anchor) for a same-session re-delivery of the same grant', () => {
    const a = held();
    const fresh = receiveAuthority(
      token({ ...CLAIMS, delivered_at: new Date(SERVER_DELIVERED + MIN).toISOString() }),
      at(1),
    );
    expect(fresh && shouldReplaceAuthority(a, fresh)).toBe(false);
  });
  it('replaces on renewal, new epoch, rollback, or a new page session', () => {
    const a = held();
    const renew = receiveAuthority(
      token({ ...CLAIMS, expires_at: '2026-11-08T12:00:00.000Z' }),
      at(1),
    );
    const epoch = receiveAuthority(token({ ...CLAIMS, epoch: 3 }), at(1));
    const nextPage = receiveAuthority(token(CLAIMS), at(1, { pageSession: 'page-2' }));
    for (const f of [renew, epoch, nextPage]) expect(f && shouldReplaceAuthority(a, f)).toBe(true);
    const rolled = advanceFloor(a, at(45, { wallMs: WALL0 }));
    expect(shouldReplaceAuthority(rolled, held())).toBe(true);
  });
});
