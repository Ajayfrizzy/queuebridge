import { describe, expect, it } from 'vitest';
import { AUDIENCES, Role, type Audience, type RoleGrant } from '@queuebridge/contracts';
import { ROLE_DIGEST_DOMAIN, roleDigest } from './auth/role-digest.js';
import { loadKnowledgeBase } from './que/kb.js';

const ORG = '0193a000-0000-7000-8000-0000000000c0';
const USER = '0193a000-0000-7000-8000-0000000000e1';
const FA = '0193a000-0000-7000-8000-00000000000a';
const FB = '0193a000-0000-7000-8000-00000000000b';

const d = (roles: RoleGrant[], org = ORG, user = USER): string =>
  roleDigest({ organizationId: org, staffUserId: user, roles });

describe('roleDigest (decision D2, design §11.5.4)', () => {
  const base: RoleGrant[] = [
    { role: Role.SUPERVISOR, facility_id: FA },
    { role: Role.AUDITOR, facility_id: FB },
    { role: Role.ORG_ADMIN, facility_id: null },
  ];

  it('is lowercase hex SHA-256 and independent of the order grants are loaded in', () => {
    expect(d(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(d([...base].reverse())).toBe(d(base));
    expect(ROLE_DIGEST_DOMAIN).toBe('qb.que.role-digest.v1');
  });

  it.each([
    ['a role added', [...base, { role: Role.STAFF_COUNTER, facility_id: FA }]],
    ['a role removed', base.slice(1)],
    [
      'a role moved to another facility',
      [{ role: Role.SUPERVISOR, facility_id: FB }, ...base.slice(1)],
    ],
    ['a role changed', [{ role: Role.FACILITY_ADMIN, facility_id: FA }, ...base.slice(1)]],
    ['org_admin lost', base.slice(0, 2)],
  ])('changes when %s', (_l, roles) => {
    expect(d(roles as RoleGrant[])).not.toBe(d(base));
  });

  it('binds the organization and the user', () => {
    expect(d(base, FB)).not.toBe(d(base));
    expect(d(base, ORG, FA)).not.toBe(d(base));
  });
});

describe('loadKnowledgeBase (fails closed)', () => {
  it('loads the compiled bundles of @queuebridge/assist', () => {
    const kb = loadKnowledgeBase();
    expect(kb.kbVersion).toBeGreaterThanOrEqual(1);
    for (const a of kb.bundles.visitor.articles) expect(a.audiences).toContain('visitor');
  });

  const good = (audience: Audience): string =>
    JSON.stringify({ kbVersion: 1, audience, articles: [] });

  it.each([
    ['malformed JSON', (): string => '{'],
    [
      'a bundle that fails the schema',
      (a: Audience): string =>
        JSON.stringify({ kbVersion: 1, audience: a, articles: [{ id: 'x' }] }),
    ],
    [
      'a bundle with the wrong audience',
      (a: Audience): string => good(a === 'auditor' ? 'visitor' : a),
    ],
    [
      'bundles of different versions',
      (a: Audience): string =>
        a === 'counter' ? JSON.stringify({ kbVersion: 2, audience: a, articles: [] }) : good(a),
    ],
    [
      'a missing bundle',
      (a: Audience): string => {
        if (a === 'supervisor') throw new Error('ENOENT');
        return good(a);
      },
    ],
  ])('refuses %s', (_l, read) => {
    expect(() => loadKnowledgeBase(read)).toThrow();
  });

  it('accepts a complete, consistent set', () => {
    expect(loadKnowledgeBase(good).kbVersion).toBe(1);
    expect(Object.keys(loadKnowledgeBase(good).bundles).sort()).toEqual([...AUDIENCES].sort());
  });
});
