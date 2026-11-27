import { createHash, randomBytes } from 'node:crypto';

/** 256-bit URL-safe random secret (session tokens, invitation secrets). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex digest — the only form in which tokens are persisted. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
