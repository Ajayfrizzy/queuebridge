import {
  CoordinatorAuthSchema,
  QueueAction,
  type AuthorityTiming,
  type CoordinatorAuth,
} from '@queuebridge/contracts';

export type EpochValidationResult =
  | { valid: true }
  | { valid: false; reason: 'expired' | 'revoked' | 'action_not_allowed' | 'invalid' };

/**
 * Validate a coordinator authorization token against a caller-supplied `now`.
 *
 * @deprecated M0 helper. Only meaningful with a TRUSTED clock (e.g. the server's). Never use it
 * to decide offline authority on a device: device wall clocks are untrusted — use
 * `evaluateOfflineAction` (elapsed-time evidence) and the server's `assessTiming`.
 */
export function validateCoordinatorEpoch(
  auth: CoordinatorAuth | null | undefined,
  action: QueueAction,
  now: Date,
): EpochValidationResult {
  if (!auth) {
    return { valid: false, reason: 'invalid' };
  }

  const expiresAt = new Date(auth.expires_at);
  if (now >= expiresAt) {
    return { valid: false, reason: 'expired' };
  }

  if (!auth.allowed_actions.includes(action)) {
    return { valid: false, reason: 'action_not_allowed' };
  }

  return { valid: true };
}

/**
 * Whether the coordinator authorization allows offline advancement at a caller-supplied `now`.
 *
 * @deprecated See `validateCoordinatorEpoch`; use `offlineAuthorityState` on devices.
 */
export function canAdvanceOffline(auth: CoordinatorAuth | null | undefined, now: Date): boolean {
  if (!auth) return false;
  const advanceActions: QueueAction[] = [
    QueueAction.TICKET_CALL_NEXT,
    QueueAction.TICKET_CALL_SPECIFIC,
    QueueAction.TICKET_COMPLETE,
    QueueAction.TICKET_SERVE,
  ];
  return advanceActions.some((action) => validateCoordinatorEpoch(auth, action, now).valid);
}

// ---------------------------------------------------------------------------
// Device-side coordinator authority (M3)
// ---------------------------------------------------------------------------

/**
 * Coordinator authority as held by a device.
 *
 * The token is opaque and signed by the server; a browser cannot verify the signature, so its
 * claims only decide what the UI offers. The server re-verifies everything on sync.
 *
 * TIMING. Device wall clocks are untrusted (they can be wrong, or be moved). Elapsed time since
 * the token was received is therefore measured with:
 *  - the monotonic clock (`performance.now()`) while the same page session lasts, and
 *  - a persisted elapsed-time FLOOR carried across reloads/restarts (a provable lower bound),
 *  - cross-checked against the wall clock: a wall clock that falls behind the lower bound means
 *    the clock was moved backwards — that is recorded permanently for this authority.
 * The server then times each action as `delivered_at (server clock) + elapsed`, independent of the
 * device's clock offset.
 */
export interface LocalAuthority {
  token: string;
  auth: CoordinatorAuth;
  /** Server-signed delivery time (epoch ms, server clock) */
  delivered_at_ms: number;
  /** Device wall clock at receipt (epoch ms) */
  received_wall_ms: number;
  /** Monotonic clock at receipt, valid only inside `received_page_session` */
  received_perf_ms: number;
  received_page_session: string;
  /** Persisted provable lower bound of elapsed time since receipt */
  floor_ms: number;
  /** The page session and monotonic reading at which `floor_ms` was last advanced */
  floor_page_session: string;
  floor_perf_ms: number;
  /** Sticky: once a backwards clock is seen, timing for this authority is unverifiable */
  rollback_detected: boolean;
}

/** One reading of the device clocks. `pageSession` is random per page load. */
export interface ClockReading {
  wallMs: number;
  perfMs: number;
  pageSession: string;
}

/** Wall-vs-monotonic disagreement tolerated before a rollback is declared. */
export const CLOCK_TOLERANCE_MS = 2000;

export interface ElapsedMeasurement {
  elapsed_ms: number;
  floor_ms: number;
  source: 'monotonic' | 'restarted';
  rollback_detected: boolean;
}

/** Provable lower bound of time elapsed since receipt for this reading. */
function lowerBound(a: LocalAuthority, r: ClockReading): number {
  if (r.pageSession === a.received_page_session) {
    return Math.max(a.floor_ms, r.perfMs - a.received_perf_ms);
  }
  if (r.pageSession === a.floor_page_session) {
    return a.floor_ms + Math.max(0, r.perfMs - a.floor_perf_ms);
  }
  // A new page session that has not anchored yet: only the persisted floor is known
  return a.floor_ms;
}

/** Measure elapsed time since the authority was received (pure). */
export function measureElapsed(a: LocalAuthority, r: ClockReading): ElapsedMeasurement {
  const floor = Math.max(0, Math.round(lowerBound(a, r)));
  const wall = r.wallMs - a.received_wall_ms;
  const rollback = a.rollback_detected || wall < floor - CLOCK_TOLERANCE_MS;
  return {
    // Sleep can pause the monotonic clock; the wall clock then runs ahead — use the larger
    elapsed_ms: Math.max(floor, Math.round(wall)),
    floor_ms: floor,
    source: r.pageSession === a.received_page_session ? 'monotonic' : 'restarted',
    rollback_detected: rollback,
  };
}

/**
 * Advance the persisted floor to "now" and anchor it to this page session. Call periodically
 * and before recording an operation; persist the result. Never moves the floor backwards.
 */
export function advanceFloor(a: LocalAuthority, r: ClockReading): LocalAuthority {
  const m = measureElapsed(a, r);
  return {
    ...a,
    floor_ms: Math.max(a.floor_ms, m.floor_ms),
    floor_page_session: r.pageSession,
    floor_perf_ms: r.perfMs,
    rollback_detected: m.rollback_detected,
  };
}

/** The evidence attached to an offline advancement command. */
export function timingEvidence(a: LocalAuthority, r: ClockReading): AuthorityTiming {
  const m = measureElapsed(a, r);
  return {
    delivered_at: new Date(a.delivered_at_ms).toISOString(),
    elapsed_ms: m.elapsed_ms,
    floor_ms: m.floor_ms,
    source: m.source,
    rollback_detected: m.rollback_detected,
  };
}

export type AuthorityDenial =
  | 'no_authority'
  | 'wrong_queue'
  | 'wrong_device'
  | 'superseded'
  | 'expired'
  | 'clock_unverifiable'
  | 'action_not_allowed';

export type OfflineAuthorityState =
  | { mode: 'advance'; expiresInMs: number }
  | { mode: 'capture_only'; reason: AuthorityDenial };

/** Banner text for a state in which the device may only capture provisional tickets. */
export const CAPTURE_ONLY_MESSAGE: Record<AuthorityDenial, string> = {
  no_authority: 'No offline authority — contact a supervisor. You can still capture tickets.',
  wrong_queue: 'No offline authority for this queue — contact a supervisor.',
  wrong_device: 'This device is not the designated coordinator — ticket capture only.',
  superseded:
    'Offline authority was replaced by a supervisor — ticket capture only. Unsent actions will be reviewed.',
  expired: 'Offline authority expired — ticket capture only.',
  clock_unverifiable:
    "This device's clock was changed, so offline authority can no longer be timed safely — ticket capture only. Reconnect to renew it.",
  action_not_allowed: 'Your offline authority does not include this action.',
};

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Dependency-free base64url → UTF-8 string (this package targets plain ES2022: no DOM/Node). */
function b64urlToString(input: string): string {
  let bits = 0;
  let acc = 0;
  let encoded = '';
  for (const ch of input) {
    const v = B64URL.indexOf(ch);
    if (v === -1) throw new Error('invalid base64url');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      encoded += `%${((acc >> bits) & 0xff).toString(16).padStart(2, '0')}`;
    }
  }
  return decodeURIComponent(encoded);
}

/**
 * Read the claims of an authority token WITHOUT verifying its signature (see LocalAuthority).
 * Returns null for anything that is not a well-formed v1 token.
 */
export function decodeAuthorityToken(token: string): CoordinatorAuth | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1]) return null;
  try {
    const parsed = CoordinatorAuthSchema.safeParse(JSON.parse(b64urlToString(parts[1])));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Build a LocalAuthority from a freshly received token. Null if it cannot be timed. */
export function receiveAuthority(token: string, r: ClockReading): LocalAuthority | null {
  const auth = decodeAuthorityToken(token);
  const delivered = auth?.delivered_at ? Date.parse(auth.delivered_at) : NaN;
  if (!auth || !Number.isFinite(delivered)) return null;
  return {
    token,
    auth,
    delivered_at_ms: delivered,
    received_wall_ms: r.wallMs,
    received_perf_ms: r.perfMs,
    received_page_session: r.pageSession,
    floor_ms: 0,
    floor_page_session: r.pageSession,
    floor_perf_ms: r.perfMs,
    rollback_detected: false,
  };
}

/**
 * Should a freshly delivered token replace the one held? Only when it carries new authority
 * (epoch or expiry changed), the held one is unusable (rollback seen), or the held one was
 * received in an earlier page session (a new token gives fresh monotonic evidence).
 */
export function shouldReplaceAuthority(
  held: LocalAuthority | null | undefined,
  fresh: LocalAuthority,
): boolean {
  if (!held) return true;
  return (
    held.auth.epoch !== fresh.auth.epoch ||
    held.auth.expires_at !== fresh.auth.expires_at ||
    held.auth.queue_session_id !== fresh.auth.queue_session_id ||
    held.auth.device_id !== fresh.auth.device_id ||
    held.rollback_detected ||
    held.received_page_session !== fresh.received_page_session
  );
}

export interface OfflineActionContext {
  queueId: string;
  deviceId: string;
  action: QueueAction;
  clock: ClockReading;
  /** Highest coordinator epoch this device has seen the server report for the queue */
  knownServerEpoch?: number;
}

/**
 * May this device record `action` offline right now? Capture (ticket.create) never needs
 * authority. Advancement needs an authority for THIS queue and device, not superseded by a newer
 * epoch the device has learned about, with no clock rollback seen, unexpired on the SERVER's
 * timeline (`delivered_at + elapsed`), and including the action.
 */
export function evaluateOfflineAction(
  authority: LocalAuthority | null | undefined,
  ctx: OfflineActionContext,
): { allowed: true; expiresInMs: number } | { allowed: false; reason: AuthorityDenial } {
  if (ctx.action === QueueAction.TICKET_CREATE) return { allowed: true, expiresInMs: Infinity };
  if (!authority) return { allowed: false, reason: 'no_authority' };
  const a = authority.auth;
  if (a.queue_session_id !== ctx.queueId) return { allowed: false, reason: 'wrong_queue' };
  if (a.device_id !== ctx.deviceId) return { allowed: false, reason: 'wrong_device' };
  if (ctx.knownServerEpoch !== undefined && a.epoch < ctx.knownServerEpoch) {
    return { allowed: false, reason: 'superseded' };
  }
  const m = measureElapsed(authority, ctx.clock);
  if (m.rollback_detected) return { allowed: false, reason: 'clock_unverifiable' };
  const remaining = Date.parse(a.expires_at) - (authority.delivered_at_ms + m.elapsed_ms);
  if (!(remaining > 0)) return { allowed: false, reason: 'expired' };
  if (!a.allowed_actions.includes(ctx.action)) {
    return { allowed: false, reason: 'action_not_allowed' };
  }
  return { allowed: true, expiresInMs: remaining };
}

/** Summary used by the UI banner: can this device advance the queue offline, or capture only? */
export function offlineAuthorityState(
  authority: LocalAuthority | null | undefined,
  ctx: Omit<OfflineActionContext, 'action'>,
): OfflineAuthorityState {
  const r = evaluateOfflineAction(authority, { ...ctx, action: QueueAction.TICKET_CALL_NEXT });
  return r.allowed
    ? { mode: 'advance', expiresInMs: r.expiresInMs }
    : { mode: 'capture_only', reason: r.reason };
}
