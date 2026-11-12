import { z } from 'zod';

/**
 * Audit checkpoint signing configuration, shared by apps/api (verifies) and apps/worker (signs)
 * so both accept and refuse exactly the same keys (ADR-012).
 *
 * Validation messages NEVER include the value: zod does not echo input in these messages, and
 * the env parsers print only the variable name and message.
 */

/** Substrings that mark a value copied from an example file or docs, never a real secret. */
const PLACEHOLDER_MARKERS = [
  'replace-with',
  'replace_with',
  'replaceme',
  'change-me',
  'changeme',
  'placeholder',
  'your-key',
  'your_key',
  'example',
  'secret-here',
  'ed25519-or-hmac',
] as const;

/** Exact values published in this repository's examples and docs. */
const KNOWN_PLACEHOLDERS = new Set([
  'replace-with-ed25519-or-hmac-key',
  'replace-with-at-least-32-random-characters',
]);

/** True when a secret is obviously not a real random key (placeholder or very low variety). */
export function isPlaceholderSecret(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (KNOWN_PLACEHOLDERS.has(v)) return true;
  if (PLACEHOLDER_MARKERS.some((m) => v.includes(m))) return true;
  // e.g. 'aaaa…' or 'abababab…': far too little variety to be a generated key
  return new Set(v).size < 8;
}

export const AuditSigningKeySchema = z
  .string()
  .min(32, 'AUDIT_SIGNING_KEY must be at least 32 characters')
  .max(512, 'AUDIT_SIGNING_KEY is unreasonably long')
  .refine((v) => !isPlaceholderSecret(v), {
    message:
      "AUDIT_SIGNING_KEY is a placeholder or not random enough — generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  });

export const AuditSigningKeyIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/, 'AUDIT_SIGNING_KEY_ID may contain only letters, digits and . _ : -');

/**
 * Cross-field rules: the id and the key come as a pair, and production requires them (the worker
 * would otherwise write no checkpoints, and the API could never report a checkpoint as verified).
 */
export function checkAuditSigningPair<
  T extends {
    NODE_ENV: string;
    AUDIT_SIGNING_KEY_ID?: string | undefined;
    AUDIT_SIGNING_KEY?: string | undefined;
  },
>(env: T, ctx: z.RefinementCtx<T>): void {
  const hasId = env.AUDIT_SIGNING_KEY_ID !== undefined;
  const hasKey = env.AUDIT_SIGNING_KEY !== undefined;
  if (hasId !== hasKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasId ? 'AUDIT_SIGNING_KEY' : 'AUDIT_SIGNING_KEY_ID'],
      message: 'AUDIT_SIGNING_KEY_ID and AUDIT_SIGNING_KEY must be set together',
    });
  }
  if (env.NODE_ENV === 'production' && !hasKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AUDIT_SIGNING_KEY'],
      message: 'AUDIT_SIGNING_KEY is required in production',
    });
  }
}

/** Message whose HMAC identifies a key without revealing it (compare API vs worker logs). */
export const AUDIT_KEY_FINGERPRINT_MESSAGE = 'queuebridge:v1:audit-key-fingerprint';
/** Hex characters of the fingerprint that are logged (64 bits: identifies, does not reveal). */
export const AUDIT_KEY_FINGERPRINT_LENGTH = 16;
