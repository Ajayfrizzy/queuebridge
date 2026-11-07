import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFacility,
  createStaff,
  createTestApp,
  signupOrg,
  TEST_PASSWORD,
  TestClient,
  type TestApp,
  type TestOrg,
} from './testing/harness.js';

/**
 * Cross-tenant isolation: organization A must be unable to read, modify or even detect
 * organization B's resources. Every probe is made by A's strongest principal (org_admin)
 * and by A's facility_admin, using B's *real* identifiers.
 */

interface Tenant {
  org: TestOrg;
  facilityId: string;
  serviceId: string;
  counterId: string;
  invitationId: string;
  staffUserId: string;
  facilityAdmin: TestClient;
}

let t: TestApp;
let a: Tenant;
let b: Tenant;
const NIL = '018d1a2b-3c4d-7e5f-8a9b-1c2d3e4f5a6b';

async function makeTenant(): Promise<Tenant> {
  const org = await signupOrg(t.app);
  const facilityId = (await createFacility(org)).id;
  const serviceId = (
    await org.admin.post<{ service: { id: string } }>(`/api/v1/facilities/${facilityId}/services`, {
      name: 'Tenant Service',
    })
  ).body.service.id;
  const counterId = (
    await org.admin.post<{ counter: { id: string } }>(`/api/v1/facilities/${facilityId}/counters`, {
      name: 'Tenant Counter',
    })
  ).body.counter.id;
  const invitationId = (
    await org.admin.post<{ invitation: { id: string } }>(
      `/api/v1/facilities/${facilityId}/invitations`,
      {
        email: 'pending@example.test',
        role: 'auditor',
      },
    )
  ).body.invitation.id;
  const staff = await createStaff(t.app, org, facilityId, 'supervisor');
  const fa = await createStaff(t.app, org, facilityId, 'facility_admin');
  return {
    org,
    facilityId,
    serviceId,
    counterId,
    invitationId,
    staffUserId: staff.userId,
    facilityAdmin: fa.client,
  };
}

beforeAll(async () => {
  t = await createTestApp();
  a = await makeTenant();
  b = await makeTenant();
});
afterAll(async () => {
  await t.close();
});

type Probe = {
  name: string;
  call: (c: TestClient, x: Tenant) => Promise<{ status: number; body: Record<string, unknown> }>;
};

/** Each probe targets resources of tenant `x` (B) — or the NIL control id when x is undefined. */
const probes: Probe[] = [
  { name: 'GET facility', call: (c, x) => c.get(`/api/v1/facilities/${x.facilityId}`) },
  { name: 'GET services', call: (c, x) => c.get(`/api/v1/facilities/${x.facilityId}/services`) },
  { name: 'GET counters', call: (c, x) => c.get(`/api/v1/facilities/${x.facilityId}/counters`) },
  { name: 'GET join-link', call: (c, x) => c.get(`/api/v1/facilities/${x.facilityId}/join-link`) },
  { name: 'GET staff', call: (c, x) => c.get(`/api/v1/facilities/${x.facilityId}/staff`) },
  {
    name: 'GET invitations',
    call: (c, x) => c.get(`/api/v1/facilities/${x.facilityId}/invitations`),
  },
  {
    name: 'POST service',
    call: (c, x) => c.post(`/api/v1/facilities/${x.facilityId}/services`, { name: 'Injected' }),
  },
  {
    name: 'POST counter',
    call: (c, x) => c.post(`/api/v1/facilities/${x.facilityId}/counters`, { name: 'Injected' }),
  },
  {
    name: 'POST invitation',
    call: (c, x) =>
      c.post(`/api/v1/facilities/${x.facilityId}/invitations`, {
        email: 'evil@example.test',
        role: 'facility_admin',
      }),
  },
  {
    name: 'PATCH service',
    call: (c, x) =>
      c.patch(`/api/v1/facilities/${x.facilityId}/services/${x.serviceId}`, { name: 'Hijacked' }),
  },
  {
    name: 'PATCH counter',
    call: (c, x) =>
      c.patch(`/api/v1/facilities/${x.facilityId}/counters/${x.counterId}`, { name: 'Hijacked' }),
  },
  {
    name: 'POST capability (both ids foreign)',
    call: (c, x) =>
      c.post('/api/v1/counter_service_capabilities', {
        counter_id: x.counterId,
        service_id: x.serviceId,
      }),
  },
  {
    name: 'DELETE capability',
    call: (c, x) => c.del(`/api/v1/counter_service_capabilities/${x.counterId}/${x.serviceId}`),
  },
  {
    name: 'POST role grant',
    call: (c, x) =>
      c.post(`/api/v1/facilities/${x.facilityId}/staff/${x.staffUserId}/roles`, {
        role: 'facility_admin',
      }),
  },
  {
    name: 'DELETE role',
    call: (c, x) =>
      c.del(`/api/v1/facilities/${x.facilityId}/staff/${x.staffUserId}/roles/supervisor`),
  },
  {
    name: 'DELETE invitation',
    call: (c, x) => c.del(`/api/v1/facilities/${x.facilityId}/invitations/${x.invitationId}`),
  },
  {
    name: 'PATCH staff status',
    call: (c, x) => c.patch(`/api/v1/staff/${x.staffUserId}`, { status: 'inactive' }),
  },
];

const control: Tenant = {
  org: undefined as unknown as TestOrg,
  facilityId: NIL,
  serviceId: NIL,
  counterId: NIL,
  invitationId: NIL,
  staffUserId: NIL,
  facilityAdmin: undefined as unknown as TestClient,
};

describe('organization A cannot reach organization B', () => {
  for (const probe of probes) {
    for (const who of ['org_admin', 'facility_admin'] as const) {
      it(`${probe.name} as A's ${who} → 404, indistinguishable from a non-existent id`, async () => {
        const client = who === 'org_admin' ? a.org.admin : a.facilityAdmin;
        const real = await probe.call(client, b);
        const fake = await probe.call(client, control);
        // Organization-level actions are role-gated first: a facility_admin gets 403 for
        // real and fake ids alike, so nothing about B can be inferred from it.
        const expected =
          probe.name === 'PATCH staff status' && who === 'facility_admin' ? 403 : 404;
        expect(real.status).toBe(expected);
        expect(fake.status).toBe(expected);
        const strip = (x: Record<string, unknown>): unknown => ({ ...x, instance: undefined });
        expect(strip(real.body)).toEqual(strip(fake.body));
      });
    }
  }

  it('B data is unchanged after all the probes', async () => {
    const [svc] = await t.db<
      { name: string }[]
    >`SELECT name FROM services WHERE id = ${b.serviceId}`;
    const [ctr] = await t.db<
      { name: string }[]
    >`SELECT name FROM counters WHERE id = ${b.counterId}`;
    expect(svc?.name).toBe('Tenant Service');
    expect(ctr?.name).toBe('Tenant Counter');
    const svcCount = await t.db`SELECT 1 FROM services WHERE facility_id = ${b.facilityId}`;
    const ctrCount = await t.db`SELECT 1 FROM counters WHERE facility_id = ${b.facilityId}`;
    const caps =
      await t.db`SELECT 1 FROM counter_service_capabilities WHERE counter_id = ${b.counterId}`;
    const invs =
      await t.db`SELECT 1 FROM staff_invitations WHERE facility_id = ${b.facilityId} AND revoked_at IS NULL`;
    const roles =
      await t.db`SELECT 1 FROM role_assignments WHERE staff_user_id = ${b.staffUserId} AND role = 'supervisor'`;
    const [user] = await t.db<
      { status: string }[]
    >`SELECT status FROM staff_users WHERE id = ${b.staffUserId}`;
    expect([svcCount.length, ctrCount.length, caps.length, roles.length]).toEqual([1, 1, 0, 1]);
    expect(invs.length).toBe(3); // pending auditor + two accepted
    expect(user?.status).toBe('active');
  });

  it('list endpoints never include the other tenant', async () => {
    const facilities = await a.org.admin.get<{ facilities: { id: string }[] }>(
      '/api/v1/facilities',
    );
    expect(facilities.body.facilities.map((f) => f.id)).not.toContain(b.facilityId);
    const staff = await a.org.admin.get<{ staff: { id: string }[] }>(
      `/api/v1/facilities/${a.facilityId}/staff`,
    );
    expect(staff.body.staff.map((s) => s.id)).not.toContain(b.staffUserId);
    expect(JSON.stringify(staff.body)).not.toContain(b.staffUserId);
  });

  it("mixing A's counter with B's service (and vice versa) is refused", async () => {
    const r1 = await a.org.admin.post('/api/v1/counter_service_capabilities', {
      counter_id: a.counterId,
      service_id: b.serviceId,
    });
    const r2 = await a.org.admin.post('/api/v1/counter_service_capabilities', {
      counter_id: b.counterId,
      service_id: a.serviceId,
    });
    expect([r1.status, r2.status]).toEqual([404, 404]);
    const rows = await t.db`SELECT 1 FROM counter_service_capabilities
        WHERE counter_id IN (${a.counterId}, ${b.counterId})`;
    expect(rows).toHaveLength(0);
  });

  it("A's facility path with B's child ids resolves nothing (no confused-deputy)", async () => {
    const svc = await a.org.admin.patch(
      `/api/v1/facilities/${a.facilityId}/services/${b.serviceId}`,
      {
        name: 'Hijacked',
      },
    );
    const ctr = await a.org.admin.patch(
      `/api/v1/facilities/${a.facilityId}/counters/${b.counterId}`,
      {
        name: 'Hijacked',
      },
    );
    const inv = await a.org.admin.del(
      `/api/v1/facilities/${a.facilityId}/invitations/${b.invitationId}`,
    );
    const role = await a.org.admin.post(
      `/api/v1/facilities/${a.facilityId}/staff/${b.staffUserId}/roles`,
      {
        role: 'auditor',
      },
    );
    expect([svc.status, ctr.status, inv.status, role.status]).toEqual([404, 404, 404, 404]);
    const [s] = await t.db<{ name: string }[]>`SELECT name FROM services WHERE id = ${b.serviceId}`;
    expect(s?.name).toBe('Tenant Service');
  });

  it('login is scoped by organization: B credentials do not open A', async () => {
    const res = await new TestClient(t.app).post('/api/v1/auth/login', {
      organization_slug: a.org.slug,
      email: b.org.adminEmail,
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(401);
  });

  it('an invitation token from A can only ever create access inside A', async () => {
    const inv = await a.org.admin.post<{ token: string }>(
      `/api/v1/facilities/${a.facilityId}/invitations`,
      {
        email: b.org.adminEmail, // same address as B's administrator
        role: 'auditor',
      },
    );
    const c = new TestClient(t.app);
    const acc = await c.post<{
      user: { organization: { id: string }; roles: { facility_id: string | null }[] };
    }>('/api/v1/invitations/accept', {
      token: inv.body.token,
      display_name: 'Same Email Elsewhere',
      password: 'another-strong-pass-77',
    });
    expect(acc.status).toBe(201);
    expect(acc.body.user.organization.id).toBe(a.org.organizationId);
    expect(acc.body.user.roles.every((r) => r.facility_id === a.facilityId)).toBe(true);
    // B's account with that email is untouched and still uses its own password
    const bLogin = await new TestClient(t.app).post('/api/v1/auth/login', {
      organization_slug: b.org.slug,
      email: b.org.adminEmail,
      password: TEST_PASSWORD,
    });
    expect(bLogin.status).toBe(200);
  });
});

describe('database-level tenant integrity (defence in depth)', () => {
  it('refuses a service whose organization disagrees with its facility', async () => {
    await expect(
      t.db`INSERT INTO services (facility_id, organization_id, name)
           VALUES (${a.facilityId}, ${b.org.organizationId}, 'Forged')`,
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('refuses a counter whose organization disagrees with its facility', async () => {
    await expect(
      t.db`INSERT INTO counters (facility_id, organization_id, name)
           VALUES (${a.facilityId}, ${b.org.organizationId}, 'Forged')`,
    ).rejects.toMatchObject({ code: '23503' });
  });

  it("refuses a role assignment pairing org B's user with org A's facility", async () => {
    await expect(
      t.db`INSERT INTO role_assignments (staff_user_id, organization_id, facility_id, role)
           VALUES (${b.staffUserId}, ${a.org.organizationId}, ${a.facilityId}, 'auditor')`,
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      t.db`INSERT INTO role_assignments (staff_user_id, organization_id, facility_id, role)
           VALUES (${b.staffUserId}, ${b.org.organizationId}, ${a.facilityId}, 'auditor')`,
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('refuses a capability between a counter and a service of different facilities', async () => {
    await expect(
      t.db`INSERT INTO counter_service_capabilities (counter_id, service_id)
           VALUES (${a.counterId}, ${b.serviceId})`,
    ).rejects.toMatchObject({ code: '23514' });
  });
});
