import { describe, expect, it } from 'vitest';
import { ROUTE_IDS } from '@queuebridge/contracts';
import { buildPath, permittedLinks } from './index.js';
import { FA, QA, grant } from './fixtures.testkit.js';

const admin = { grants: [grant('facility_admin', FA)], facilityId: FA };

describe('safe navigation links (REQ-F13.1.2)', () => {
  it('builds paths only from context ids, with no query, fragment or credential', () => {
    expect(buildPath('admin.facility.staff', admin)).toBe(`/admin/facilities/${FA}/staff`);
    expect(buildPath('staff.connectivity', admin)).toBe(`/staff/facilities/${FA}/connectivity`);
    expect(buildPath('staff.audit', { ...admin, queueId: QA })).toBe(`/staff/queues/${QA}/audit`);
    expect(buildPath('visitor.recover', { grants: null, facilityId: null })).toBe('/recover');
    expect(
      buildPath('visitor.join', {
        grants: null,
        facilityId: null,
        orgSlug: 'acme',
        facilitySlug: 'main-1',
      }),
    ).toBe('/join/acme/main-1');
    const all = ROUTE_IDS.map((id) =>
      buildPath(id, { ...admin, queueId: QA, orgSlug: 'acme', facilitySlug: 'main' }),
    ).filter((p): p is string => p !== null);
    for (const p of all) {
      expect(p.startsWith('/')).toBe(true);
      expect(p).not.toMatch(/[?#]|\/\/|\.\./);
    }
  });

  it.each([
    ['a non-UUID facility', { ...admin, facilityId: '../../admin' }, 'admin.facility'],
    ['a queue id that is not a UUID', { ...admin, queueId: `${QA}/../x` }, 'staff.audit'],
    ['a missing queue id', { ...admin }, 'staff.console'],
    [
      'a slug with a query',
      { grants: null, facilityId: null, orgSlug: 'a?b', facilitySlug: 'c' },
      'visitor.join',
    ],
    [
      'a slug with a path',
      { grants: null, facilityId: null, orgSlug: 'a', facilitySlug: 'c/../d' },
      'public.display',
    ],
    ['a missing slug', { grants: null, facilityId: null, orgSlug: 'a' }, 'public.display'],
  ] as const)('refuses %s', (_label, ctx, id) => {
    expect(buildPath(id, ctx)).toBeNull();
  });

  it('never links the ticket page or the invitation page, for anyone', () => {
    const ctxs = [
      { grants: null, facilityId: null },
      { grants: [grant('org_admin', null)], facilityId: FA, queueId: QA },
    ];
    for (const ctx of ctxs) {
      expect(buildPath('visitor.ticket', ctx)).toBeNull();
      expect(buildPath('public.accept_invite', ctx)).toBeNull();
      expect(permittedLinks(ctx)).not.toContain('visitor.ticket');
      expect(permittedLinks(ctx)).not.toContain('public.accept_invite');
    }
  });

  it('an anonymous visitor gets public screens only', () => {
    expect(permittedLinks({ grants: null, facilityId: FA, queueId: QA })).toEqual([
      'public.home',
      'public.signup',
      'public.login',
      'visitor.recover',
    ]);
  });
});
