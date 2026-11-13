import type { Db } from '../db.js';
import { ApiProblem } from '../errors.js';
import type { RecoveryCrypto } from './crypto.js';

/**
 * Recovery abuse controls (design §15.10, REQ-F4.10).
 *
 * Keys are HMACs of PUBLIC identifiers and the request source only. The submitted recovery key or
 * grant is never part of any key, so changing the guess cannot move an attacker to a fresh
 * counter. Every window resets itself (at most 15 minutes): there is no lifetime counter, no lock
 * state and no unlock action, so an attacker can block only sources they control, never the
 * rightful holder on a clean source.
 */
export interface ThrottleLimits {
  /** L1: attempts per source per minute (every attempt, including malformed ones) */
  perSourcePerMinute: number;
}

const MINUTE = 60;
const QUARTER = 15 * 60;
/** L2: failures per 15 minutes for one ticket code from one source (REQ-F4.4, per client) */
export const TARGET_SOURCE_FAILURES = 5;
/** L3: failures per 15 minutes for one ticket code across all sources (abuse alert) */
export const TARGET_FAILURES = 50;
/** L4: failures per 15 minutes in one facility (abuse alert) */
export const FACILITY_FAILURES = 100;

type Scope = 'source' | 'target_source' | 'target' | 'facility' | 'facility_source';

interface Counter {
  attempts: number;
  failures: number;
}

/**
 * Atomically add to a fixed window, resetting it first when it has expired. One statement, so
 * parallel requests never lose an update.
 */
async function bump(
  db: Db,
  scope: Scope,
  key: string,
  windowSeconds: number,
  add: { attempt: number; failure: number },
): Promise<Counter> {
  const rows = await db<Counter[]>`
    INSERT INTO recovery_throttle AS r (scope, key_hash, window_started_at, attempts, failures)
    VALUES (${scope}, ${key}, NOW(), ${add.attempt}, ${add.failure})
    ON CONFLICT (scope, key_hash) DO UPDATE SET
      window_started_at = CASE WHEN r.window_started_at < NOW() - make_interval(secs => ${windowSeconds})
                               THEN NOW() ELSE r.window_started_at END,
      attempts = CASE WHEN r.window_started_at < NOW() - make_interval(secs => ${windowSeconds})
                      THEN ${add.attempt} ELSE r.attempts + ${add.attempt} END,
      failures = CASE WHEN r.window_started_at < NOW() - make_interval(secs => ${windowSeconds})
                      THEN ${add.failure} ELSE r.failures + ${add.failure} END
    RETURNING attempts, failures`;
  return rows[0] ?? { attempts: 0, failures: 0 };
}

const tooMany = (): ApiProblem =>
  new ApiProblem(429, 'recovery-throttled', 'Too many attempts', {
    detail: 'Too many recovery attempts from this connection. Wait a few minutes, or ask staff.',
  });

/** The throttle keys of one key-recovery request (public identifiers and the source only). */
export interface TargetKeys {
  source: string;
  targetSource: string;
  target: string;
  facility: string;
  facilitySource: string;
}

export function targetKeys(
  crypto: RecoveryCrypto,
  publicTarget: { orgSlug: string; facilitySlug: string; ticketCode: string },
  source: string,
): TargetKeys {
  const fac = `${publicTarget.orgSlug}/${publicTarget.facilitySlug}`;
  const tgt = `${fac}/${publicTarget.ticketCode}`;
  return {
    source: crypto.throttleKey('source', source),
    targetSource: crypto.throttleKey('target_source', tgt, source),
    target: crypto.throttleKey('target', tgt),
    facility: crypto.throttleKey('facility', fac),
    facilitySource: crypto.throttleKey('facility_source', fac, source),
  };
}

/** L1: count this attempt for its source; refuse beyond the per-minute limit. */
export async function admitSource(
  db: Db,
  sourceKey: string,
  limits: ThrottleLimits,
): Promise<void> {
  const c = await bump(db, 'source', sourceKey, MINUTE, { attempt: 1, failure: 0 });
  if (c.attempts > limits.perSourcePerMinute) throw tooMany();
}

/**
 * L2–L4 before verifying a key. Aggregate limits (L3, L4) refuse only sources that have ALREADY
 * failed for this ticket / facility; a clean source is always verified.
 */
export async function admitTarget(
  db: Db,
  k: TargetKeys,
): Promise<{ aggregateUnderAttack: boolean }> {
  const zero = { attempt: 0, failure: 0 };
  const [ts, t, f, fs] = await Promise.all([
    bump(db, 'target_source', k.targetSource, QUARTER, zero),
    bump(db, 'target', k.target, QUARTER, zero),
    bump(db, 'facility', k.facility, QUARTER, zero),
    bump(db, 'facility_source', k.facilitySource, QUARTER, zero),
  ]);
  if (ts.failures >= TARGET_SOURCE_FAILURES) throw tooMany();
  if (t.failures >= TARGET_FAILURES && ts.failures > 0) throw tooMany();
  if (f.failures >= FACILITY_FAILURES && fs.failures > 0) throw tooMany();
  return { aggregateUnderAttack: t.failures >= TARGET_FAILURES || f.failures >= FACILITY_FAILURES };
}

/** Record one failed proof. Returns which aggregate thresholds this failure just reached. */
export async function recordFailure(
  db: Db,
  k: TargetKeys,
): Promise<{ targetThresholdReached: boolean; facilityThresholdReached: boolean }> {
  const one = { attempt: 0, failure: 1 };
  const [, t, f] = await Promise.all([
    bump(db, 'target_source', k.targetSource, QUARTER, one),
    bump(db, 'target', k.target, QUARTER, one),
    bump(db, 'facility', k.facility, QUARTER, one),
    bump(db, 'facility_source', k.facilitySource, QUARTER, one),
  ]);
  return {
    targetThresholdReached: t.failures === TARGET_FAILURES,
    facilityThresholdReached: f.failures === FACILITY_FAILURES,
  };
}

/** L5: a per-process cap on concurrent verifications (resource protection). */
export class VerificationGate {
  private active = 0;
  public constructor(private readonly max: number) {}
  public async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      throw new ApiProblem(503, 'recovery-busy', 'Recovery is busy', {
        detail: 'Recovery is busy right now. Try again in a moment.',
        headers: { 'Retry-After': '2' },
      });
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
    }
  }
}
