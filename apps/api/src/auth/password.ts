import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing with argon2id (OWASP-recommended parameters are the library defaults:
 * m=19456 KiB, t=2, p=1). Plaintext passwords are never stored or logged.
 */
export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // Malformed stored hash (e.g. placeholder) — treat as mismatch, never throw to callers
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burn the same CPU cost as a real verification when the account does not exist,
 * so that response time does not reveal whether an email is registered.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword('queuebridge-timing-equalizer');
  await verifyPassword(await dummyHash, password);
}
