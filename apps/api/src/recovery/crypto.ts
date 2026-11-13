import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { RECOVERY_KEY_BITS, encodeRecoveryKey } from '@queuebridge/contracts';
import type { Env } from '../env.js';

/**
 * M5.1 recovery cryptography (design §15.3, ADR-015).
 *
 * Peppers are derived with HKDF from CONTACT_ENCRYPTION_KEY, one per purpose, so no new secret is
 * introduced and a leak of one derived value says nothing about another. Without that key the
 * recovery capability is DISABLED (never weakened): joins still work, no key is issued.
 */
export interface RecoveryCrypto {
  /** A fresh 160-bit secret (recovery key or staff grant), 32 Crockford base32 characters. */
  newSecret(): string;
  /** HMAC of a recovery key, bound to the ROOT ticket it belongs to. */
  keyHmac(ticketId: string, key: string): string;
  /** HMAC of a staff grant (looked up by this value; the grant itself is never stored). */
  grantHmac(grant: string): string;
  /**
   * Throttle key: an HMAC of PUBLIC identifiers and the request source only. Callers must never
   * pass the submitted secret: changing a guess then cannot change any throttle key.
   */
  throttleKey(scope: string, ...publicParts: string[]): string;
  /** Constant-time comparison of two hex digests (false for any length mismatch). */
  equal(a: string, b: string): boolean;
}

const DOMAIN = Buffer.from('queuebridge:recovery:v1');

function pepper(ikm: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, DOMAIN, Buffer.from(purpose), 32));
}

export function createRecoveryCrypto(
  env: Pick<Env, 'CONTACT_ENCRYPTION_KEY'>,
): RecoveryCrypto | null {
  const raw = env.CONTACT_ENCRYPTION_KEY;
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) return null;
  const ikm = Buffer.from(raw, 'hex');
  const keyPepper = pepper(ikm, 'recovery-key');
  const grantPepper = pepper(ikm, 'recovery-grant');
  const throttlePepper = pepper(ikm, 'recovery-throttle');
  const hmac = (k: Buffer, msg: string): string =>
    createHmac('sha256', k).update(msg).digest('hex');
  return {
    newSecret: () => encodeRecoveryKey(randomBytes(RECOVERY_KEY_BITS / 8)),
    keyHmac: (ticketId, key) => hmac(keyPepper, `${ticketId}:${key}`),
    grantHmac: (grant) => hmac(grantPepper, grant),
    throttleKey: (scope, ...parts) => hmac(throttlePepper, [scope, ...parts].join('\u0000')),
    equal: (a, b) => {
      const x = Buffer.from(a, 'hex');
      const y = Buffer.from(b, 'hex');
      return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
    },
  };
}

/**
 * The request SOURCE for throttling: an IPv4 address, or the /64 network of an IPv6 address
 * (one device can trivially rotate within its /64). IPv4-mapped IPv6 is treated as IPv4.
 */
export function sourceOf(ip: string): string {
  const v = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  if (isIP(v) !== 6) return v;
  const [head = '', tail = ''] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = v.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${full
    .slice(0, 4)
    .map((g) => (g || '0').toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}
