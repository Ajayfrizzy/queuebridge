import type { AuthorityTiming, CoordinatorAuth } from '@queuebridge/contracts';

/**
 * Server-side timing decision for an offline ADVANCEMENT command (M3).
 *
 * Inputs the server trusts: its own clock (`now`), the coordinator expiry it stored, and the
 * `delivered_at` / `expires_at` it signed into the authority token. Inputs it does NOT trust as
 * proof: everything the device says. The device's evidence is used only to (a) place the action
 * on the server's timeline as `delivered_at + elapsed`, and (b) detect inconsistency.
 *
 * Decision (first match wins):
 *  1. no evidence, or evidence for a token that was not presented       → unverifiable
 *  2. the device itself detected its clock moving backwards             → clock_rollback
 *  3. internally inconsistent (floor > elapsed, or the action would be
 *     later than the server's own "now")                                 → unverifiable
 *  4. even the provable lower bound is at/after expiry                  → expired
 *  5. the best estimate is at/after expiry                              → expired
 *  6. timing crossed an app restart (gap evidenced only by wall clock)
 *     and the command reached the server only after expiry               → unverifiable
 *  7. elapsed went backwards relative to an earlier command of the same
 *     device and token                                                   → unverifiable
 *  otherwise                                                             → ok
 *
 * Rule 6 is what makes restarts safe: across a restart the closed-app gap is only known from the
 * (untrusted) wall clock, so such a command is accepted without review only when the SERVER saw
 * it before the authority expired — which proves the action happened before expiry too.
 * Every non-ok result is held as `needs_review`, never silently committed or discarded.
 */

/** Allowance for network delay between the device's measurement and server receipt. */
export const FUTURE_TOLERANCE_MS = 5000;
/** Allowance for timer jitter when comparing successive measurements. */
export const ORDER_TOLERANCE_MS = 2000;

export type TimingVerdict =
  | { ok: true; actionAtMs: number }
  | {
      ok: false;
      reason: 'authority_timing_unverifiable' | 'clock_rollback' | 'authority_expired';
      detail: string;
    };

export interface TimingInput {
  timing: AuthorityTiming | undefined;
  /** The verified token whose delivered_at matches the evidence, if presented */
  token: CoordinatorAuth | undefined;
  /** Current coordinator expiry stored on the session (server truth; null if none) */
  sessionExpiresAt: Date | null;
  nowMs: number;
  /** elapsed_ms of the previous command of this device under the same token, if any */
  previousElapsedMs?: number | undefined;
}

export function assessTiming(i: TimingInput): TimingVerdict {
  const t = i.timing;
  if (!t || !i.token?.delivered_at || i.token.delivered_at !== t.delivered_at) {
    return {
      ok: false,
      reason: 'authority_timing_unverifiable',
      detail: 'no timing evidence for a presented authority',
    };
  }
  if (t.rollback_detected) {
    return { ok: false, reason: 'clock_rollback', detail: 'device reported its clock moved back' };
  }
  const delivered = Date.parse(i.token.delivered_at);
  if (!Number.isFinite(delivered) || t.floor_ms > t.elapsed_ms) {
    return { ok: false, reason: 'authority_timing_unverifiable', detail: 'inconsistent evidence' };
  }
  const actionAt = delivered + t.elapsed_ms;
  if (actionAt > i.nowMs + FUTURE_TOLERANCE_MS) {
    return {
      ok: false,
      reason: 'authority_timing_unverifiable',
      detail: 'action claims a future time',
    };
  }
  const tokenExpiry = Date.parse(i.token.expires_at);
  const expiry = Math.min(
    tokenExpiry,
    i.sessionExpiresAt ? i.sessionExpiresAt.getTime() : Number.NEGATIVE_INFINITY,
  );
  if (delivered + t.floor_ms >= expiry || actionAt >= expiry) {
    return { ok: false, reason: 'authority_expired', detail: 'action after authority expiry' };
  }
  if (t.source === 'restarted' && i.nowMs >= expiry) {
    return {
      ok: false,
      reason: 'authority_timing_unverifiable',
      detail: 'restart gap unverifiable and synced after expiry',
    };
  }
  if (
    i.previousElapsedMs !== undefined &&
    t.elapsed_ms + ORDER_TOLERANCE_MS < i.previousElapsedMs
  ) {
    return {
      ok: false,
      reason: 'authority_timing_unverifiable',
      detail: 'elapsed time went backwards',
    };
  }
  return { ok: true, actionAtMs: actionAt };
}
