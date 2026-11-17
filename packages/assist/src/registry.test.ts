import { describe, expect, it } from 'vitest';
import {
  KbArticleIdSchema,
  PERMISSION_NAMES,
  ROUTE_IDS,
  type RoleGrant,
  type RouteId,
} from '@queuebridge/contracts';
import {
  ROUTE_REGISTRY,
  UNREGISTERED_PATHS,
  audiencesForPermission,
  isRoutePermitted,
  permittedLinks,
} from './index.js';
import { FA, FB, QA, grant } from './fixtures.testkit.js';

const PUBLIC: RouteId[] = [
  'public.home',
  'public.signup',
  'public.login',
  'visitor.join',
  'visitor.recover',
  'public.display',
];
const SIGNED_IN: RouteId[] = ['admin.home', 'staff.home'];

/** Expected access matrix from design §11.3.1 (single role at facility A, context facility A). */
const EXPECTED: Record<string, RouteId[]> = {
  anonymous: PUBLIC,
  staff_reception: [...PUBLIC, ...SIGNED_IN, 'admin.facility', 'staff.facility', 'staff.console'],
  staff_counter: [...PUBLIC, ...SIGNED_IN, 'admin.facility', 'staff.facility', 'staff.console'],
  supervisor: [
    ...PUBLIC,
    ...SIGNED_IN,
    'admin.facility',
    'staff.facility',
    'staff.console',
    'staff.audit',
    'staff.connectivity',
  ],
  facility_admin: [
    ...PUBLIC,
    ...SIGNED_IN,
    'admin.facility',
    'admin.facility.staff',
    'staff.facility',
    'staff.console',
    'staff.audit',
    'staff.connectivity',
  ],
  auditor: [
    ...PUBLIC,
    ...SIGNED_IN,
    'admin.facility',
    'staff.facility',
    'staff.console',
    'staff.audit',
    'staff.connectivity',
  ],
  org_admin: [
    ...PUBLIC,
    ...SIGNED_IN,
    'admin.facility',
    'admin.facility.staff',
    'staff.facility',
    'staff.console',
    'staff.audit',
    'staff.connectivity',
  ],
};

function grantsFor(key: string): RoleGrant[] | null {
  if (key === 'anonymous') return null;
  if (key === 'org_admin') return [grant('org_admin', null)];
  return [grant(key as RoleGrant['role'], FA)];
}

const sort = (xs: readonly string[]): string[] => [...xs].sort();

describe('route registry (design §11.3.1)', () => {
  it('registers every RouteId exactly once, with unique paths', () => {
    expect(sort(Object.keys(ROUTE_REGISTRY))).toEqual(sort(ROUTE_IDS));
    const paths = Object.values(ROUTE_REGISTRY).map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('does not register the /supervisor/* placeholder (or anything under it)', () => {
    expect(UNREGISTERED_PATHS).toContain('/supervisor/*');
    for (const e of Object.values(ROUTE_REGISTRY)) {
      expect(e.path.startsWith('/supervisor')).toBe(false);
    }
  });

  it('records exactly the screen permissions of design §11.3.1', () => {
    const perms = Object.fromEntries(
      Object.values(ROUTE_REGISTRY).map((e) => [
        e.id,
        e.access.kind === 'permission' ? e.access.permission : e.access.kind,
      ]),
    );
    expect(perms).toEqual({
      'public.home': 'public',
      'public.signup': 'public',
      'public.login': 'public',
      'public.accept_invite': 'credential',
      'visitor.join': 'public',
      'visitor.ticket': 'credential',
      'visitor.recover': 'public',
      'public.display': 'public',
      'admin.home': 'signed_in',
      'admin.facility': 'FACILITY_READ',
      'admin.facility.staff': 'STAFF_MANAGE',
      'staff.home': 'signed_in',
      'staff.facility': 'QUEUE_VIEW',
      'staff.console': 'QUEUE_VIEW',
      'staff.audit': 'AUDIT_VIEW',
      'staff.connectivity': 'OPERATIONS_VIEW',
    });
    expect(ROUTE_REGISTRY['staff.console'].actionPermissions).toEqual(['WALK_IN', 'QUEUE_MANAGE']);
    expect(ROUTE_REGISTRY['staff.connectivity'].actionPermissions).toEqual(['QUEUE_MANAGE']);
    expect(ROUTE_REGISTRY['admin.facility'].actionPermissions).toEqual(['FACILITY_CONFIGURE']);
  });

  it('names only permissions that exist in the shared map', () => {
    for (const e of Object.values(ROUTE_REGISTRY)) {
      if (e.access.kind === 'permission') expect(PERMISSION_NAMES).toContain(e.access.permission);
      for (const p of e.actionPermissions) expect(PERMISSION_NAMES).toContain(p);
    }
  });

  it('declares path parameters consistent with the scope Que fills them from', () => {
    const params = (p: string): string[] => [...p.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1] ?? '');
    for (const e of Object.values(ROUTE_REGISTRY)) {
      const ps = params(e.path);
      if (e.scope === 'none' && e.linkable) expect(ps).toEqual([]);
      if (e.scope === 'facility')
        expect(ps.length === 1 && ['id', 'fid'].includes(ps[0]!)).toBe(true);
      if (e.scope === 'queue') expect(ps).toEqual(['queueId']);
      if (e.scope === 'facility_slugs') expect(ps).toEqual(['orgSlug', 'facilitySlug']);
    }
  });

  it('never makes credential screens linkable (ticket page, invitation)', () => {
    for (const e of Object.values(ROUTE_REGISTRY)) {
      if (e.access.kind === 'credential') expect(e.linkable).toBe(false);
    }
    expect(ROUTE_REGISTRY['visitor.recover'].path).toBe('/recover');
  });

  it('derives audiences of permission screens from the permission (plus org_admin)', () => {
    for (const e of Object.values(ROUTE_REGISTRY)) {
      if (e.access.kind === 'permission') {
        expect(e.audiences).toEqual(audiencesForPermission(e.access.permission));
        expect(e.audiences).toContain('org_admin');
        expect(e.audiences).not.toContain('visitor');
      }
    }
    expect(audiencesForPermission('AUDIT_VIEW')).toEqual([
      'supervisor',
      'facility_admin',
      'org_admin',
      'auditor',
    ]);
  });

  it('default article ids are well-formed and operation ids unique', () => {
    for (const e of Object.values(ROUTE_REGISTRY)) {
      for (const id of e.defaultArticles)
        expect(KbArticleIdSchema.safeParse(id).success).toBe(true);
      const ops = e.operations.map((o) => o.id);
      expect(new Set(ops).size).toBe(ops.length);
    }
    expect(ROUTE_REGISTRY['staff.console'].operations.length).toBeGreaterThan(0);
  });
});

describe('D3 check 2: Que route access per role equals the §11.3.1 matrix', () => {
  it.each(Object.keys(EXPECTED))('%s at facility A', (key) => {
    const ctx = { grants: grantsFor(key), facilityId: FA };
    const permitted = ROUTE_IDS.filter((id) => isRoutePermitted(id, ctx));
    expect(sort(permitted)).toEqual(sort(EXPECTED[key]!));
  });

  it.each(Object.keys(EXPECTED))('%s: links are the permitted, linkable screens', (key) => {
    const ctx = {
      grants: grantsFor(key),
      facilityId: FA,
      queueId: QA,
      orgSlug: 'org',
      facilitySlug: 'main',
    };
    expect(sort(permittedLinks(ctx))).toEqual(sort(EXPECTED[key]!));
  });
});

describe('D3 check 5: cross-facility authorization', () => {
  it.each(['staff_reception', 'staff_counter', 'supervisor', 'facility_admin', 'auditor'])(
    '%s at facility A gets no facility screen of facility B',
    (role) => {
      const ctx = {
        grants: [grant(role as RoleGrant['role'], FA)],
        facilityId: FB,
        queueId: QA,
      };
      const permitted = ROUTE_IDS.filter((id) => isRoutePermitted(id, ctx));
      expect(sort(permitted)).toEqual(sort([...PUBLIC, ...SIGNED_IN]));
      expect(sort(permittedLinks(ctx))).toEqual(
        sort(
          [...PUBLIC, ...SIGNED_IN].filter((r) => r !== 'visitor.join' && r !== 'public.display'),
        ),
      );
    },
  );

  it('a facility-scoped org_admin row (malformed) is not an org-wide administrator', () => {
    const ctx = { grants: [grant('org_admin', FA)], facilityId: FB };
    expect(isRoutePermitted('staff.audit', ctx)).toBe(false);
  });

  it('screens without a facility context are never permitted by a facility role', () => {
    const ctx = { grants: [grant('supervisor', FA)], facilityId: null };
    for (const id of ROUTE_IDS) {
      if (ROUTE_REGISTRY[id].access.kind === 'permission')
        expect(isRoutePermitted(id, ctx)).toBe(false);
    }
  });
});
