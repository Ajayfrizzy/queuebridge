import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AuditSigningKeyIdSchema,
  AuditSigningKeySchema,
  checkAuditSigningPair,
  isPlaceholderSecret,
} from './audit-key.js';

/** Group 2 / 8 — audit signing key configuration shared by the API and the worker. */

const REAL = '3f9c2a7e1b0d4c6f8a5e2d9b7c1f0a3e6d8b4c2a9f7e1d0c5b3a8e6f2d4c1b9a';

describe('isPlaceholderSecret / AuditSigningKeySchema', () => {
  it.each([
    ['the old .env.example value', 'replace-with-ed25519-or-hmac-key'],
    ['the current .env.example value', 'replace-with-at-least-32-random-characters'],
    ['upper-case variant', 'REPLACE-WITH-ED25519-OR-HMAC-KEY'],
    ['padded with spaces', '  replace-with-ed25519-or-hmac-key  '],
    ['"changeme" style', 'changeme-changeme-changeme-changeme'],
    ['"placeholder" style', 'this-is-a-placeholder-value-for-the-key'],
    ['"example" style', 'example-audit-signing-key-0123456789'],
    ['a single repeated character', 'k'.repeat(40)],
    ['a short repeating pattern', 'abab'.repeat(10)],
  ])('refuses %s', (_name, value) => {
    expect(isPlaceholderSecret(value)).toBe(true);
    expect(AuditSigningKeySchema.safeParse(value).success).toBe(false);
  });

  it('accepts a generated random key and a long passphrase-like test key', () => {
    expect(AuditSigningKeySchema.safeParse(REAL).success).toBe(true);
    expect(
      AuditSigningKeySchema.safeParse('test-audit-signing-key-at-least-32-characters').success,
    ).toBe(true);
  });

  it('refuses keys shorter than 32 characters', () => {
    expect(AuditSigningKeySchema.safeParse(REAL.slice(0, 31)).success).toBe(false);
  });

  it('never echoes the rejected value in its error messages', () => {
    for (const v of ['replace-with-ed25519-or-hmac-key', REAL.slice(0, 20)]) {
      const r = AuditSigningKeySchema.safeParse(v);
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.success ? {} : r.error.issues.map((i) => i.message))).not.toContain(
        v,
      );
    }
  });

  it('key ids are short identifiers', () => {
    expect(AuditSigningKeyIdSchema.safeParse('local-dev-2026-11').success).toBe(true);
    expect(AuditSigningKeyIdSchema.safeParse('has spaces').success).toBe(false);
    expect(AuditSigningKeyIdSchema.safeParse('').success).toBe(false);
  });
});

describe('checkAuditSigningPair', () => {
  const S = z
    .object({
      NODE_ENV: z.string(),
      AUDIT_SIGNING_KEY_ID: z.string().optional(),
      AUDIT_SIGNING_KEY: z.string().optional(),
    })
    .superRefine(checkAuditSigningPair);

  it('id and key must be set together', () => {
    expect(S.safeParse({ NODE_ENV: 'development' }).success).toBe(true);
    expect(
      S.safeParse({ NODE_ENV: 'development', AUDIT_SIGNING_KEY_ID: 'k1', AUDIT_SIGNING_KEY: REAL })
        .success,
    ).toBe(true);
    expect(S.safeParse({ NODE_ENV: 'development', AUDIT_SIGNING_KEY_ID: 'k1' }).success).toBe(
      false,
    );
    expect(S.safeParse({ NODE_ENV: 'development', AUDIT_SIGNING_KEY: REAL }).success).toBe(false);
  });

  it('production requires the key', () => {
    expect(S.safeParse({ NODE_ENV: 'production' }).success).toBe(false);
    expect(
      S.safeParse({ NODE_ENV: 'production', AUDIT_SIGNING_KEY_ID: 'k1', AUDIT_SIGNING_KEY: REAL })
        .success,
    ).toBe(true);
  });
});
