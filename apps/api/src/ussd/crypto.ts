import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { Env } from '../env.js';

/**
 * M6.2 USSD cryptography. Like recovery (M5.1) and SMS contacts (M6.1), every key is derived with
 * HKDF from CONTACT_ENCRYPTION_KEY, one per purpose, so no new secret is introduced. Without that
 * key USSD is unavailable (never weakened).
 *
 * - The provider session id and the subscriber number are stored only as keyed hashes.
 * - The last screen of a session is stored AES-256-GCM encrypted, because the join screen shows
 *   the recovery key once and a provider retry must get the same screen back.
 * - The join proof binds a USSD join to its session (the web join proof's role), without storing it.
 */
export interface UssdCrypto {
  sessionKeyHash(provider: string, sessionId: string): string;
  msisdnHash(e164: string): string;
  textHash(sessionKeyHash: string, text: string): string;
  joinProof(sessionKeyHash: string, operationId: string): string;
  /** Encrypts a stored USSD screen (its own purpose key; never a push or contact ciphertext) */
  sealScreen(plain: string): string;
  openScreen(sealed: string): string;
}

const DOMAIN = Buffer.from('queuebridge:ussd:v1');
const derive = (ikm: Buffer, purpose: string): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, DOMAIN, Buffer.from(purpose), 32));

export function createUssdCrypto(env: Pick<Env, 'CONTACT_ENCRYPTION_KEY'>): UssdCrypto | null {
  const raw = env.CONTACT_ENCRYPTION_KEY;
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) return null;
  const ikm = Buffer.from(raw, 'hex');
  const sessionKey = derive(ikm, 'ussd-session');
  const msisdnKey = derive(ikm, 'ussd-msisdn');
  const textKey = derive(ikm, 'ussd-text');
  const proofKey = derive(ikm, 'ussd-join-proof');
  const encKey = derive(ikm, 'ussd-response');
  const hmac = (k: Buffer, ...parts: string[]): string =>
    createHmac('sha256', k).update(parts.join('\u0000')).digest('hex');
  return {
    sessionKeyHash: (provider, sessionId) => hmac(sessionKey, provider, sessionId),
    msisdnHash: (e164) => hmac(msisdnKey, e164),
    textHash: (session, text) => hmac(textKey, session, text),
    joinProof: (session, op) => hmac(proofKey, session, op),
    sealScreen(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', encKey, iv);
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
    },
    openScreen(sealed) {
      const buf = Buffer.from(sealed, 'base64');
      if (buf.length < 29) throw new Error('invalid USSD ciphertext');
      const d = createDecipheriv('aes-256-gcm', encKey, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    },
  };
}
