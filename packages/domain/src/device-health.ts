import { HEALTH_DEFAULTS, type DeviceHealthState } from '@queuebridge/contracts';

/**
 * M5.3 device-health states (REQ-F9.6; design §17.3). Pure, by SERVER time only: no device clock
 * is ever an input, so a device with a wrong clock cannot change its own state.
 */
export interface HealthThresholds {
  offlineAfterSeconds: number;
  deviceStaleAfterSeconds: number;
  coordinatorExpiryWarnSeconds: number;
}

export const DEFAULT_THRESHOLDS: Readonly<HealthThresholds> = Object.freeze({
  offlineAfterSeconds: HEALTH_DEFAULTS.offlineAfterSeconds,
  deviceStaleAfterSeconds: HEALTH_DEFAULTS.deviceStaleAfterSeconds,
  coordinatorExpiryWarnSeconds: HEALTH_DEFAULTS.coordinatorExpiryWarnSeconds,
});

export interface DeviceFacts {
  revoked_at: Date | null;
  needs_review_count: number;
  /** Server time of the last heartbeat, sync or snapshot */
  last_seen_at: Date | null;
  reported_pending_count: number;
}

/**
 * Priority: revoked > needs_review > stale > offline > pending > healthy. `stale` outranks
 * `offline` because it is the stronger statement about the same silence.
 */
export function deviceHealthState(
  d: DeviceFacts,
  now: Date,
  t: HealthThresholds = DEFAULT_THRESHOLDS,
): DeviceHealthState {
  if (d.revoked_at) return 'revoked';
  if (d.needs_review_count > 0) return 'needs_review';
  const silentMs = d.last_seen_at ? now.getTime() - d.last_seen_at.getTime() : Infinity;
  if (silentMs > t.deviceStaleAfterSeconds * 1000) return 'stale';
  if (silentMs > t.offlineAfterSeconds * 1000) return 'offline';
  return d.reported_pending_count > 0 ? 'pending' : 'healthy';
}

export type CoordinatorCondition = 'none' | 'active' | 'expiring' | 'expired';

/** The authorization's condition at `now` (server time). */
export function coordinatorCondition(
  expiresAt: Date | null,
  now: Date,
  t: Pick<HealthThresholds, 'coordinatorExpiryWarnSeconds'> = DEFAULT_THRESHOLDS,
): CoordinatorCondition {
  if (!expiresAt) return 'none';
  const left = expiresAt.getTime() - now.getTime();
  if (left <= 0) return 'expired';
  if (left <= t.coordinatorExpiryWarnSeconds * 1000) return 'expiring';
  return 'active';
}

/**
 * Next failure streak after a device report (design §17.4 `sync_failing`): the SAME code again
 * extends it; a different code starts at 1; no code (healthy report) resets it.
 */
export function nextFailureStreak(
  previousCode: string | null,
  previousStreak: number,
  reported: string | null,
): number {
  if (!reported) return 0;
  return reported === previousCode ? previousStreak + 1 : 1;
}

/** Alert damping (design §17.11): resolve only after the condition was clear this many times. */
export const CLEAR_EVALUATIONS_TO_RESOLVE = 2;
