import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  CoordinatorAuthSchema,
  type CoordinatorAuth,
  type CoordinatorStatus,
} from '@queuebridge/contracts';
import type { Env } from '../env.js';
import type { LockedSession } from './events.js';

/** Token wire format: `v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256)>`. */
const VERSION = 'v1';
const DOMAIN = 'queuebridge/coordinator-authority/v1';

/** Signing key: the dedicated key when configured, otherwise derived from SESSION_SECRET. */
export function authoritySigningKey(env: Env): Buffer {
  if (env.COORDINATOR_SIGNING_KEY) {
    return createHmac('sha256', env.COORDINATOR_SIGNING_KEY).update(DOMAIN).digest();
  }
  return createHmac('sha256', env.SESSION_SECRET).update(DOMAIN).digest();
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** Sign a coordinator authorization. The result is opaque to clients. */
export function signAuthority(auth: CoordinatorAuth, key: Buffer): string {
  const body = `${VERSION}.${b64u(JSON.stringify(auth))}`;
  const mac = createHmac('sha256', key).update(body).digest();
  return `${body}.${b64u(mac)}`;
}

/**
 * Verify a token's signature and shape. Does NOT check expiry: an offline coordinator's
 * commands are synced after its authority may have lapsed, and the server decides what an
 * expired-but-genuine token still means (see sync evaluation). Returns null for anything that
 * is malformed, mis-signed or not produced by this server.
 */
export function verifyAuthority(token: string, key: Buffer): CoordinatorAuth | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, payload, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', key).update(`${VERSION}.${payload}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = CoordinatorAuthSchema.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Short stable fingerprint for logs (never log tokens themselves). */
export const tokenFingerprint = (token: string): string =>
  createHash('sha256').update(token).digest('hex').slice(0, 12);

export function coordinatorStatus(
  s: Pick<
    LockedSession,
    | 'coordinator_epoch'
    | 'coordinator_device_id'
    | 'coordinator_granted_at'
    | 'coordinator_expires_at'
    | 'coordinator_allowed_actions'
  >,
  deviceLabel: string | null,
  now: Date,
): CoordinatorStatus {
  const has = s.coordinator_device_id !== null && s.coordinator_expires_at !== null;
  const expired = has && (s.coordinator_expires_at as Date).getTime() <= now.getTime();
  return {
    epoch: s.coordinator_epoch,
    device_id: s.coordinator_device_id,
    device_label: has ? deviceLabel : null,
    granted_at: s.coordinator_granted_at?.toISOString() ?? null,
    expires_at: s.coordinator_expires_at?.toISOString() ?? null,
    allowed_actions: has ? s.coordinator_allowed_actions : [],
    status: !has ? 'none' : expired ? 'expired' : 'active',
  };
}
