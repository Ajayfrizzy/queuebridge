import { describe, expect, it } from 'vitest';
import {
  CLEAR_EVALUATIONS_TO_RESOLVE,
  coordinatorCondition,
  deviceHealthState,
  nextFailureStreak,
} from './device-health.js';

const now = new Date('2026-11-12T12:00:00Z');
const ago = (s: number): Date => new Date(now.getTime() - s * 1000);
const base = {
  revoked_at: null,
  needs_review_count: 0,
  last_seen_at: ago(5),
  reported_pending_count: 0,
};

describe('device health states by server time (8.D6)', () => {
  it('healthy, pending, offline after 120 s, stale after 900 s (defaults)', () => {
    expect(deviceHealthState(base, now)).toBe('healthy');
    expect(deviceHealthState({ ...base, reported_pending_count: 2 }, now)).toBe('pending');
    expect(deviceHealthState({ ...base, last_seen_at: ago(120) }, now)).toBe('healthy');
    expect(deviceHealthState({ ...base, last_seen_at: ago(121) }, now)).toBe('offline');
    expect(deviceHealthState({ ...base, last_seen_at: ago(900) }, now)).toBe('offline');
    expect(deviceHealthState({ ...base, last_seen_at: ago(901) }, now)).toBe('stale');
    expect(deviceHealthState({ ...base, last_seen_at: null }, now)).toBe('stale');
  });
  it('revoked and needs_review outrank silence', () => {
    expect(deviceHealthState({ ...base, last_seen_at: ago(5000), revoked_at: ago(1) }, now)).toBe(
      'revoked',
    );
    expect(
      deviceHealthState({ ...base, last_seen_at: ago(5000), needs_review_count: 1 }, now),
    ).toBe('needs_review');
  });
  it('configured thresholds are honoured', () => {
    const t = {
      offlineAfterSeconds: 30,
      deviceStaleAfterSeconds: 60,
      coordinatorExpiryWarnSeconds: 10,
    };
    expect(deviceHealthState({ ...base, last_seen_at: ago(31) }, now, t)).toBe('offline');
    expect(deviceHealthState({ ...base, last_seen_at: ago(61) }, now, t)).toBe('stale');
  });
});

describe('coordinator authorization condition', () => {
  const at = (s: number): Date => new Date(now.getTime() + s * 1000);
  it('none, active, expiring inside 300 s, expired at or after the end', () => {
    expect(coordinatorCondition(null, now)).toBe('none');
    expect(coordinatorCondition(at(301), now)).toBe('active');
    expect(coordinatorCondition(at(300), now)).toBe('expiring');
    expect(coordinatorCondition(at(1), now)).toBe('expiring');
    expect(coordinatorCondition(at(0), now)).toBe('expired');
    expect(coordinatorCondition(at(-60), now)).toBe('expired');
  });
});

describe('failure streak and damping', () => {
  it('the same code extends, a different code restarts, a clean report resets', () => {
    expect(nextFailureStreak(null, 0, 'sync_failed')).toBe(1);
    expect(nextFailureStreak('sync_failed', 1, 'sync_failed')).toBe(2);
    expect(nextFailureStreak('sync_failed', 2, 'sync_failed')).toBe(3);
    expect(nextFailureStreak('sync_failed', 2, 'storage_unavailable')).toBe(1);
    expect(nextFailureStreak('sync_failed', 5, null)).toBe(0);
  });
  it('alerts resolve after two clear evaluations', () => {
    expect(CLEAR_EVALUATIONS_TO_RESOLVE).toBe(2);
  });
});
