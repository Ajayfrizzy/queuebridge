import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFacility,
  createStaff,
  createTestApp,
  signupOrg,
  uniqueSlug,
  type TestApp,
  type TestClient,
  type TestOrg,
} from './testing/harness.js';

/**
 * Group 8 (M1 scope): permission matrix. Every protected route is exercised by every role
 * and the expected HTTP status is asserted — both the allow and the deny side.
 */

let t: TestApp;
let org: TestOrg;
let f1: string;
let f2: string;
let serviceId: string;
let counterId: string;
let targetStaffId: string;

const staff = {} as Record<string, { client: TestClient; userId: string }>;
let otherFacilityAdmin: TestClient;

const ROLES = [
  'staff_reception',
  'staff_counter',
  'supervisor',
  'facility_admin',
  'auditor',
] as const;
const READ_ROLES = new Set<string>([...ROLES, 'org_admin']);
const ADMIN_ROLES = new Set<string>(['facility_admin', 'org_admin']);
const ORG_ADMIN_ONLY = new Set<string>(['org_admin']);

beforeAll(async () => {
  t = await createTestApp();
  org = await signupOrg(t.app);
  f1 = (await createFacility(org, 'Facility One')).id;
  f2 = (await createFacility(org, 'Facility Two')).id;
  serviceId = (
    await org.admin.post<{ service: { id: string } }>(`/api/v1/facilities/${f1}/services`, {
      name: 'Seed Service',
    })
  ).body.service.id;
  counterId = (
    await org.admin.post<{ counter: { id: string } }>(`/api/v1/facilities/${f1}/counters`, {
      name: 'Seed Counter',
    })
  ).body.counter.id;
  for (const role of ROLES) staff[role] = await createStaff(t.app, org, f1, role);
  targetStaffId = staff['auditor']?.userId ?? '';
  otherFacilityAdmin = (await createStaff(t.app, org, f2, 'facility_admin')).client;
});
afterAll(async () => {
  await t.close();
});

interface Endpoint {
  name: string;
  allowed: Set<string>;
  call: (c: TestClient) => Promise<{ status: number }>;
}

const uniq = (): string => `X${randomBytes(4).toString('hex')}`;

const endpoints: Endpoint[] = [
  { name: 'GET facility', allowed: READ_ROLES, call: (c) => c.get(`/api/v1/facilities/${f1}`) },
  {
    name: 'GET services',
    allowed: READ_ROLES,
    call: (c) => c.get(`/api/v1/facilities/${f1}/services`),
  },
  {
    name: 'GET counters',
    allowed: READ_ROLES,
    call: (c) => c.get(`/api/v1/facilities/${f1}/counters`),
  },
  {
    name: 'GET join-link',
    allowed: READ_ROLES,
    call: (c) => c.get(`/api/v1/facilities/${f1}/join-link`),
  },
  {
    name: 'POST service',
    allowed: ADMIN_ROLES,
    call: (c) => c.post(`/api/v1/facilities/${f1}/services`, { name: uniq() }),
  },
  {
    name: 'PATCH service',
    allowed: ADMIN_ROLES,
    call: (c) => c.patch(`/api/v1/facilities/${f1}/services/${serviceId}`, { description: uniq() }),
  },
  {
    name: 'POST counter',
    allowed: ADMIN_ROLES,
    call: (c) => c.post(`/api/v1/facilities/${f1}/counters`, { name: uniq() }),
  },
  {
    name: 'PATCH counter',
    allowed: ADMIN_ROLES,
    call: (c) => c.patch(`/api/v1/facilities/${f1}/counters/${counterId}`, { active: true }),
  },
  {
    name: 'POST capability',
    allowed: ADMIN_ROLES,
    call: (c) =>
      c.post('/api/v1/counter_service_capabilities', {
        counter_id: counterId,
        service_id: serviceId,
      }),
  },
  { name: 'GET staff', allowed: ADMIN_ROLES, call: (c) => c.get(`/api/v1/facilities/${f1}/staff`) },
  {
    name: 'GET invitations',
    allowed: ADMIN_ROLES,
    call: (c) => c.get(`/api/v1/facilities/${f1}/invitations`),
  },
  {
    name: 'POST invitation',
    allowed: ADMIN_ROLES,
    call: (c) =>
      c.post(`/api/v1/facilities/${f1}/invitations`, {
        email: `${uniq()}@example.test`.toLowerCase(),
        role: 'auditor',
      }),
  },
  {
    name: 'POST role grant',
    allowed: ADMIN_ROLES,
    call: (c) =>
      c.post(`/api/v1/facilities/${f1}/staff/${targetStaffId}/roles`, { role: 'staff_reception' }),
  },
  {
    name: 'DELETE role (absent role → 404 only if authorized)',
    allowed: new Set<string>(),
    call: (c) => c.del(`/api/v1/facilities/${f1}/staff/${targetStaffId}/roles/supervisor`),
  },
  {
    name: 'POST facility (org level)',
    allowed: ORG_ADMIN_ONLY,
    call: (c) => c.post('/api/v1/facilities', { name: 'Org Level', slug: uniqueSlug('ol') }),
  },
  {
    name: 'PATCH staff status (org level)',
    allowed: ORG_ADMIN_ONLY,
    call: (c) => c.patch(`/api/v1/staff/${targetStaffId}`, { status: 'active' }),
  },
];

function clientFor(role: string): TestClient {
  if (role === 'org_admin') return org.admin;
  const s = staff[role];
  if (!s) throw new Error(`no staff for ${role}`);
  return s.client;
}

describe('role × endpoint permission matrix', () => {
  for (const ep of endpoints) {
    for (const role of [...ROLES, 'org_admin']) {
      const allowed = ep.allowed.has(role);
      it(`${ep.name} as ${role} → ${allowed ? '2xx' : '403'}`, async () => {
        const res = await ep.call(clientFor(role));
        if (ep.name.startsWith('DELETE role')) {
          // Authorized callers reach the handler and get 404 (role not held); others get 403
          const authorized = ADMIN_ROLES.has(role);
          expect(res.status).toBe(authorized ? 404 : 403);
        } else if (allowed) {
          expect(res.status).toBeGreaterThanOrEqual(200);
          expect(res.status).toBeLessThan(300);
        } else {
          expect(res.status).toBe(403);
        }
      });
    }
  }
});

describe('facility scoping inside one organization', () => {
  it.each(endpoints.filter((e) => !e.name.includes('org level')))(
    'a facility_admin of another facility gets 404 (not 403) for: $name',
    async (ep) => {
      const res = await ep.call(otherFacilityAdmin);
      expect(res.status).toBe(404);
    },
  );

  it('facility list shows only facilities where the user holds a role', async () => {
    const res = await otherFacilityAdmin.get<{ facilities: { id: string }[] }>(
      '/api/v1/facilities',
    );
    expect(res.body.facilities.map((f) => f.id)).toEqual([f2]);
    const own = await clientFor('supervisor').get<{ facilities: { id: string }[] }>(
      '/api/v1/facilities',
    );
    expect(own.body.facilities.map((f) => f.id)).toEqual([f1]);
    const all = await org.admin.get<{ facilities: { id: string }[] }>('/api/v1/facilities');
    expect(all.body.facilities.map((f) => f.id)).toEqual(expect.arrayContaining([f1, f2]));
  });
});

describe('privilege escalation is blocked', () => {
  it('org_admin cannot be granted or invited at facility scope', async () => {
    const admin = clientFor('facility_admin');
    const inv = await admin.post(`/api/v1/facilities/${f1}/invitations`, {
      email: 'escalate@example.test',
      role: 'org_admin',
    });
    expect(inv.status).toBe(400);
    const grant = await admin.post(`/api/v1/facilities/${f1}/staff/${targetStaffId}/roles`, {
      role: 'org_admin',
    });
    expect(grant.status).toBe(400);
    const rows =
      await t.db`SELECT 1 FROM role_assignments WHERE role = 'org_admin' AND organization_id = ${org.organizationId}`;
    expect(rows).toHaveLength(1); // only the founding administrator
  });

  it('a counter operator cannot grant themselves supervisor', async () => {
    const me = staff['staff_counter'];
    const res = await clientFor('staff_counter').post(
      `/api/v1/facilities/${f1}/staff/${me?.userId}/roles`,
      { role: 'supervisor' },
    );
    expect(res.status).toBe(403);
    const rows =
      await t.db`SELECT 1 FROM role_assignments WHERE staff_user_id = ${me?.userId ?? ''} AND role = 'supervisor'`;
    expect(rows).toHaveLength(0);
  });

  it('a facility_admin cannot assign roles at another facility', async () => {
    const res = await clientFor('facility_admin').post(
      `/api/v1/facilities/${f2}/staff/${targetStaffId}/roles`,
      { role: 'supervisor' },
    );
    expect(res.status).toBe(404);
  });

  it('client-supplied role/actor/org fields are ignored or rejected, never trusted', async () => {
    const res = await clientFor('staff_reception').post(`/api/v1/facilities/${f1}/services`, {
      name: uniq(),
      role: 'facility_admin',
      actor_id: org.adminId,
    });
    expect(res.status).toBe(403); // authorization precedes parsing
    const ok = await org.admin.post(`/api/v1/facilities/${f1}/services`, {
      name: uniq(),
      actor_id: org.adminId,
    });
    expect(ok.status).toBe(400);
  });
});

describe('role lifecycle', () => {
  it('revoking a role takes effect on the very next request (sessions are not role snapshots)', async () => {
    const victim = await createStaff(t.app, org, f1, 'supervisor');
    expect((await victim.client.get(`/api/v1/facilities/${f1}/services`)).status).toBe(200);
    const del = await org.admin.del(
      `/api/v1/facilities/${f1}/staff/${victim.userId}/roles/supervisor`,
    );
    expect(del.status).toBe(204);
    // No remaining role at the facility → indistinguishable from a non-existent facility
    expect((await victim.client.get(`/api/v1/facilities/${f1}/services`)).status).toBe(404);
  });

  it('granting an additional role is idempotent and visible in the staff list', async () => {
    const person = await createStaff(t.app, org, f1, 'staff_reception');
    const url = `/api/v1/facilities/${f1}/staff/${person.userId}/roles`;
    expect((await org.admin.post(url, { role: 'supervisor' })).status).toBe(201);
    expect((await org.admin.post(url, { role: 'supervisor' })).status).toBe(200);
    const list = await org.admin.get<{ staff: { id: string; roles: string[] }[] }>(
      `/api/v1/facilities/${f1}/staff`,
    );
    const row = list.body.staff.find((s) => s.id === person.userId);
    expect(row?.roles).toEqual(['staff_reception', 'supervisor']);
    expect(JSON.stringify(list.body)).not.toMatch(/argon2|password_hash/);
  });

  it('a facility must keep one facility_admin unless an org_admin intervenes', async () => {
    const o = await signupOrg(t.app);
    const f = (await createFacility(o)).id;
    const only = await createStaff(t.app, o, f, 'facility_admin');
    const blocked = await only.client.del(
      `/api/v1/facilities/${f}/staff/${only.userId}/roles/facility_admin`,
    );
    expect(blocked.status).toBe(409);

    const second = await createStaff(t.app, o, f, 'facility_admin');
    const ok = await only.client.del(
      `/api/v1/facilities/${f}/staff/${only.userId}/roles/facility_admin`,
    );
    expect(ok.status).toBe(204);
    // `second` is now the last one
    expect(
      (
        await second.client.del(
          `/api/v1/facilities/${f}/staff/${second.userId}/roles/facility_admin`,
        )
      ).status,
    ).toBe(409);
    expect(
      (await o.admin.del(`/api/v1/facilities/${f}/staff/${second.userId}/roles/facility_admin`))
        .status,
    ).toBe(204);
  });

  it('deactivating a staff account destroys its sessions; self-deactivation is refused', async () => {
    const person = await createStaff(t.app, org, f1, 'staff_counter');
    expect((await person.client.get('/api/v1/auth/me')).status).toBe(200);
    expect(
      (await org.admin.patch(`/api/v1/staff/${person.userId}`, { status: 'inactive' })).status,
    ).toBe(200);
    expect((await person.client.get('/api/v1/auth/me')).status).toBe(401);
    const sessions =
      await t.db`SELECT 1 FROM staff_sessions WHERE staff_user_id = ${person.userId}`;
    expect(sessions).toHaveLength(0);
    expect(
      (await org.admin.patch(`/api/v1/staff/${org.adminId}`, { status: 'inactive' })).status,
    ).toBe(409);
  });

  it('role changes are audited with actor and role, without email addresses', async () => {
    const person = await createStaff(t.app, org, f1, 'staff_reception');
    await org.admin.post(`/api/v1/facilities/${f1}/staff/${person.userId}/roles`, {
      role: 'auditor',
    });
    await org.admin.del(`/api/v1/facilities/${f1}/staff/${person.userId}/roles/auditor`);
    const ev = await t.db<{ event_type: string; details: { role: string }; actor_id: string }[]>`
      SELECT event_type, details, actor_id FROM admin_events
       WHERE target_id = ${person.userId} AND event_type LIKE 'role.%' ORDER BY created_at`;
    expect(ev.map((e) => e.event_type)).toEqual(['role.granted', 'role.revoked']);
    expect(ev.every((e) => e.details.role === 'auditor' && e.actor_id === org.adminId)).toBe(true);
  });
});
