import { describe, expect, it } from 'vitest';
import { Role } from '@queuebridge/contracts';
import { ApiProblem, isUniqueViolation, parseInput } from '../errors.js';
import { z } from 'zod';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.js';
import { facilityRoles, isOrgAdmin, type AuthContext } from './rbac.js';
import { generateToken, hashToken } from './tokens.js';

describe('password hashing', () => {
  it('uses argon2id with a per-hash salt and verifies only the right password', async () => {
    const h1 = await hashPassword('correct-horse-battery-1');
    const h2 = await hashPassword('correct-horse-battery-1');
    expect(h1.startsWith('$argon2id$')).toBe(true);
    expect(h1).not.toEqual(h2);
    expect(await verifyPassword(h1, 'correct-horse-battery-1')).toBe(true);
    expect(await verifyPassword(h1, 'correct-horse-battery-2')).toBe(false);
  });

  it('treats malformed stored hashes as a mismatch instead of throwing', async () => {
    expect(await verifyPassword('$2b$12$placeholder_hash', 'anything-at-all')).toBe(false);
    expect(await verifyPassword('', 'anything-at-all')).toBe(false);
  });

  it('the timing-equalizer path resolves without side effects', async () => {
    await expect(verifyAgainstDummy('whatever-password')).resolves.toBeUndefined();
  });
});

describe('tokens', () => {
  it('generates 256-bit URL-safe unique secrets and hashes them with SHA-256', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const h = hashToken(a);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).toBe(h);
    expect(hashToken(b)).not.toBe(h);
  });
});

describe('rbac helpers', () => {
  const base: AuthContext = {
    sessionId: 's',
    sessionExpiresAt: new Date('2030-01-01T00:00:00Z'),
    staffUserId: 'u',
    organizationId: 'o',
    organizationName: 'O',
    organizationSlug: 'o',
    email: 'e@example.test',
    displayName: 'E',
    roles: [],
  };

  it('org_admin is recognised only when it carries no facility', () => {
    expect(isOrgAdmin({ ...base, roles: [{ role: Role.ORG_ADMIN, facility_id: null }] })).toBe(
      true,
    );
    expect(isOrgAdmin({ ...base, roles: [{ role: Role.FACILITY_ADMIN, facility_id: 'f' }] })).toBe(
      false,
    );
    expect(isOrgAdmin({ ...base, roles: [{ role: Role.ORG_ADMIN, facility_id: 'f' }] })).toBe(
      false,
    );
  });

  it('facilityRoles returns only roles for the requested facility', () => {
    const ctx: AuthContext = {
      ...base,
      roles: [
        { role: Role.SUPERVISOR, facility_id: 'f1' },
        { role: Role.AUDITOR, facility_id: 'f2' },
        { role: Role.STAFF_COUNTER, facility_id: 'f1' },
      ],
    };
    expect(facilityRoles(ctx, 'f1').sort()).toEqual([Role.STAFF_COUNTER, Role.SUPERVISOR].sort());
    expect(facilityRoles(ctx, 'f3')).toEqual([]);
  });
});

describe('error helpers', () => {
  it('parseInput throws a 400 problem listing field paths but never values', () => {
    const schema = z.object({ email: z.string().email() }).strict();
    try {
      parseInput(schema, { email: 'leaky-value', extra: 1 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiProblem);
      const p = err as ApiProblem;
      expect(p.status).toBe(400);
      expect(JSON.stringify(p.errors)).not.toContain('leaky-value');
      expect(p.type).toBe('https://queuebridge.dev/problems/validation-error');
    }
  });

  it('isUniqueViolation recognises 23505 and optionally the constraint', () => {
    expect(isUniqueViolation({ code: '23505', constraint_name: 'x' })).toBe(true);
    expect(isUniqueViolation({ code: '23505', constraint_name: 'x' }, 'y')).toBe(false);
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
