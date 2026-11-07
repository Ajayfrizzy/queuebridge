import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@queuebridge/contracts';
import { isFacilityAdmin, isOrgAdmin, slugify } from './permissions.js';

const user = (roles: SessionUser['roles']): SessionUser => ({
  id: '018d1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b',
  email: 'a@b.co',
  display_name: 'A',
  organization: { id: '018d1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5c', name: 'O', slug: 'o' },
  roles,
});

describe('permission hints', () => {
  it('org admins administer every facility; facility admins only their own', () => {
    const org = user([{ role: 'org_admin', facility_id: null }]);
    const fac = user([{ role: 'facility_admin', facility_id: 'f1' }]);
    expect(isOrgAdmin(org)).toBe(true);
    expect(isFacilityAdmin(org, 'anything')).toBe(true);
    expect(isOrgAdmin(fac)).toBe(false);
    expect(isFacilityAdmin(fac, 'f1')).toBe(true);
    expect(isFacilityAdmin(fac, 'f2')).toBe(false);
  });

  it('other roles are never administrators', () => {
    const u = user([
      { role: 'supervisor', facility_id: 'f1' },
      { role: 'auditor', facility_id: 'f1' },
    ]);
    expect(isFacilityAdmin(u, 'f1')).toBe(false);
  });
});

describe('slugify', () => {
  it('produces slugs that satisfy the API pattern', () => {
    expect(slugify('Lagos  General Hospital!')).toBe('lagos-general-hospital');
    expect(slugify('Café Étoile')).toBe('cafe-etoile');
    expect(slugify('---')).toBe('');
    expect(slugify('x'.repeat(100))).toHaveLength(48);
  });
});
