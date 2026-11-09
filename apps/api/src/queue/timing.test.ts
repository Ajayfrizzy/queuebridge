import { describe, expect, it } from 'vitest';
import {
  QueueAction,
  Role,
  type AuthorityTiming,
  type CoordinatorAuth,
} from '@queuebridge/contracts';
import {
  assessTiming,
  FUTURE_TOLERANCE_MS,
  ORDER_TOLERANCE_MS,
  type TimingVerdict,
} from './timing.js';

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const token = (deliveredMs: number, expiresMs: number): CoordinatorAuth => ({
  device_id: '550e8400-e29b-41d4-a716-446655440001',
  facility_id: '550e8400-e29b-41d4-a716-446655440002',
  queue_session_id: '550e8400-e29b-41d4-a716-446655440003',
  epoch: 1,
  allowed_actions: [QueueAction.TICKET_CALL_NEXT],
  issued_at: iso(deliveredMs),
  expires_at: iso(expiresMs),
  delivered_at: iso(deliveredMs),
  issued_by_role: Role.SUPERVISOR,
  issued_by_actor_id: '550e8400-e29b-41d4-a716-446655440004',
});
const ev = (deliveredMs: number, o: Partial<AuthorityTiming> = {}): AuthorityTiming => ({
  delivered_at: iso(deliveredMs),
  elapsed_ms: o.elapsed_ms ?? 0,
  floor_ms: o.floor_ms ?? o.elapsed_ms ?? 0,
  source: o.source ?? 'monotonic',
  rollback_detected: o.rollback_detected ?? false,
});

const D = NOW - 60 * MIN; // delivered an hour ago
const E = NOW - 30 * MIN; // expired half an hour ago
const run = (
  timing: AuthorityTiming | undefined,
  extra: Partial<Parameters<typeof assessTiming>[0]> = {},
): TimingVerdict =>
  assessTiming({ timing, token: token(D, E), sessionExpiresAt: new Date(E), nowMs: NOW, ...extra });

describe('assessTiming', () => {
  it('places the action on the SERVER timeline: delivered_at + elapsed', () => {
    expect(run(ev(D, { elapsed_ms: 10 * MIN }))).toEqual({ ok: true, actionAtMs: D + 10 * MIN });
  });

  it.each([
    ['missing evidence', undefined, 'authority_timing_unverifiable'],
    ['rollback flagged', ev(D, { elapsed_ms: MIN, rollback_detected: true }), 'clock_rollback'],
    [
      'floor > estimate',
      ev(D, { floor_ms: 5 * MIN, elapsed_ms: MIN }),
      'authority_timing_unverifiable',
    ],
    ['exactly at expiry', ev(D, { elapsed_ms: 30 * MIN }), 'authority_expired'],
    ['after expiry', ev(D, { elapsed_ms: 31 * MIN }), 'authority_expired'],
    [
      'floor after expiry',
      ev(D, { floor_ms: 31 * MIN, elapsed_ms: 31 * MIN, source: 'restarted' }),
      'authority_expired',
    ],
    [
      'restarted, synced after expiry',
      ev(D, { floor_ms: MIN, elapsed_ms: 10 * MIN, source: 'restarted' }),
      'authority_timing_unverifiable',
    ],
    [
      'claims the future',
      ev(D, { elapsed_ms: 60 * MIN + FUTURE_TOLERANCE_MS + 1 }),
      'authority_timing_unverifiable',
    ],
  ] as const)('holds: %s', (_n, timing, reason) => {
    const v = run(timing);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe(reason);
  });

  it('a forged delivered_at that does not match the signed token is unverifiable', () => {
    const v = run({ ...ev(D, { elapsed_ms: MIN }), delivered_at: iso(NOW) });
    expect(v).toMatchObject({ ok: false, reason: 'authority_timing_unverifiable' });
  });

  it('a token without delivered_at (issued before this rule) is unverifiable', () => {
    const tk = { ...token(D, E) };
    delete tk.delivered_at;
    expect(
      assessTiming({
        timing: ev(D, { elapsed_ms: MIN }),
        token: tk,
        sessionExpiresAt: new Date(E),
        nowMs: NOW,
      }).ok,
    ).toBe(false);
  });

  it('restarted evidence is accepted when the server itself received it before expiry', () => {
    const v = assessTiming({
      timing: ev(D, { floor_ms: MIN, elapsed_ms: 50 * MIN, source: 'restarted' }),
      token: token(D, NOW + 10 * MIN),
      sessionExpiresAt: new Date(NOW + 10 * MIN),
      nowMs: NOW,
    });
    expect(v.ok).toBe(true);
  });

  it('uses the EARLIER of the signed expiry and the stored session expiry', () => {
    const later = new Date(NOW + 60 * MIN);
    expect(run(ev(D, { elapsed_ms: 40 * MIN }), { sessionExpiresAt: later }).ok).toBe(false); // token says E
    const shorter = assessTiming({
      timing: ev(D, { elapsed_ms: 40 * MIN }),
      token: token(D, NOW + 60 * MIN),
      sessionExpiresAt: new Date(NOW - 25 * MIN),
      nowMs: NOW,
    });
    expect(shorter.ok).toBe(false);
    expect(
      assessTiming({
        timing: ev(D, { elapsed_ms: MIN }),
        token: token(D, NOW + 60 * MIN),
        sessionExpiresAt: null,
        nowMs: NOW,
      }).ok,
    ).toBe(false);
  });

  it('elapsed must not go backwards across successive commands (beyond jitter)', () => {
    expect(
      run(ev(D, { elapsed_ms: 10 * MIN }), { previousElapsedMs: 10 * MIN + ORDER_TOLERANCE_MS }).ok,
    ).toBe(true);
    expect(
      run(ev(D, { elapsed_ms: 10 * MIN }), { previousElapsedMs: 10 * MIN + ORDER_TOLERANCE_MS + 1 })
        .ok,
    ).toBe(false);
  });
});
