import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFacility,
  createStaff,
  createTestApp,
  signupOrg,
  TEST_PASSWORD,
  TestClient,
  uniqueSlug,
  type TestApp,
  type TestOrg,
} from './testing/harness.js';

/**
 * Authorization is evaluated from the database on EVERY request, never cached in the session.
 * These tests keep a session cookie alive across role changes and deactivation and prove the
 * change is effective on the very next request.
 */

let t: TestApp;
let org: TestOrg;
let fid: string;

beforeAll(async () => {
  t = await createTestApp();
  org = await signupOrg(t.app);
  fid = (await createFacility(org)).id;
});
afterAll(async () => {
  await t.close();
});

const newService = (): { name: string } => ({ name: `Svc ${uniqueSlug('s')}` });

describe('role changes apply to already-authenticated sessions', () => {
  it('downgrading facility_admin to auditor removes write access on the next request but keeps read', async () => {
    const person = await createStaff(t.app, org, fid, 'facility_admin');
    expect(
      (await person.client.post(`/api/v1/facilities/${fid}/services`, newService())).status,
    ).toBe(201);

    await org.admin.post(`/api/v1/facilities/${fid}/staff/${person.userId}/roles`, {
      role: 'auditor',
    });
    expect(
      (await org.admin.del(`/api/v1/facilities/${fid}/staff/${person.userId}/roles/facility_admin`))
        .status,
    ).toBe(204);

    // Same cookie, no re-login
    expect(
      (await person.client.post(`/api/v1/facilities/${fid}/services`, newService())).status,
    ).toBe(403);
    expect((await person.client.get(`/api/v1/facilities/${fid}/staff`)).status).toBe(403);
    expect((await person.client.get(`/api/v1/facilities/${fid}/services`)).status).toBe(200);
    const me = await person.client.get<{ user: { roles: { role: string }[] } }>('/api/v1/auth/me');
    expect(me.body.user.roles.map((r) => r.role)).toEqual(['auditor']);
  });

  it('revoking the last role makes the facility invisible (404) to the live session', async () => {
    const person = await createStaff(t.app, org, fid, 'supervisor');
    expect((await person.client.get(`/api/v1/facilities/${fid}`)).status).toBe(200);
    await org.admin.del(`/api/v1/facilities/${fid}/staff/${person.userId}/roles/supervisor`);
    expect((await person.client.get(`/api/v1/facilities/${fid}`)).status).toBe(404);
    const list = await person.client.get<{ facilities: unknown[] }>('/api/v1/facilities');
    expect(list.body.facilities).toEqual([]);
  });

  it('granting a role is also immediate', async () => {
    const person = await createStaff(t.app, org, fid, 'auditor');
    expect(
      (await person.client.post(`/api/v1/facilities/${fid}/services`, newService())).status,
    ).toBe(403);
    await org.admin.post(`/api/v1/facilities/${fid}/staff/${person.userId}/roles`, {
      role: 'facility_admin',
    });
    expect(
      (await person.client.post(`/api/v1/facilities/${fid}/services`, newService())).status,
    ).toBe(201);
  });
});

describe('deactivation applies to already-authenticated sessions', () => {
  it('kills every concurrent session, blocks login, and is not undone by reactivation', async () => {
    const person = await createStaff(t.app, org, fid, 'staff_counter');
    // A second, independent session for the same account
    const second = new TestClient(t.app);
    const login = await second.post('/api/v1/auth/login', {
      organization_slug: org.slug,
      email: person.email,
      password: TEST_PASSWORD,
    });
    expect(login.status).toBe(200);
    expect((await person.client.get('/api/v1/auth/me')).status).toBe(200);
    expect((await second.get('/api/v1/auth/me')).status).toBe(200);
    const oldCookies = [person.client.cookie, second.cookie];

    const off = await org.admin.patch(`/api/v1/staff/${person.userId}`, { status: 'inactive' });
    expect(off.status).toBe(200);
    expect((await person.client.get(`/api/v1/facilities/${fid}/services`)).status).toBe(401);
    expect((await second.get(`/api/v1/facilities/${fid}/services`)).status).toBe(401);
    expect(
      await t.db`SELECT 1 FROM staff_sessions WHERE staff_user_id = ${person.userId}`,
    ).toHaveLength(0);

    // Login is refused while inactive
    const refused = await new TestClient(t.app).post('/api/v1/auth/login', {
      organization_slug: org.slug,
      email: person.email,
      password: TEST_PASSWORD,
    });
    expect(refused.status).toBe(401);

    // Reactivation does NOT resurrect old sessions…
    expect(
      (await org.admin.patch(`/api/v1/staff/${person.userId}`, { status: 'active' })).status,
    ).toBe(200);
    for (const cookie of oldCookies) {
      const replay = new TestClient(t.app);
      replay.cookie = cookie;
      expect((await replay.get('/api/v1/auth/me')).status).toBe(401);
    }
    // …a fresh login is required, and the original role is intact
    const again = new TestClient(t.app);
    expect(
      (
        await again.post('/api/v1/auth/login', {
          organization_slug: org.slug,
          email: person.email,
          password: TEST_PASSWORD,
        })
      ).status,
    ).toBe(200);
    expect((await again.get(`/api/v1/facilities/${fid}/services`)).status).toBe(200);
  });

  it('deactivated users keep their history but cannot be given new roles or redeem invitations', async () => {
    const person = await createStaff(t.app, org, fid, 'staff_reception');
    const inv = await org.admin.post<{ token: string }>(`/api/v1/facilities/${fid}/invitations`, {
      email: person.email,
      role: 'auditor',
    });
    await org.admin.patch(`/api/v1/staff/${person.userId}`, { status: 'inactive' });
    expect(
      (
        await org.admin.post(`/api/v1/facilities/${fid}/staff/${person.userId}/roles`, {
          role: 'supervisor',
        })
      ).status,
    ).toBe(404);
    const accept = await new TestClient(t.app).post('/api/v1/invitations/accept', {
      token: inv.body.token,
      display_name: 'Nope',
      password: TEST_PASSWORD,
    });
    expect(accept.status).toBe(410);
    // Still listed (as inactive) with their roles for administrators
    const list = await org.admin.get<{ staff: { id: string; status: string; roles: string[] }[] }>(
      `/api/v1/facilities/${fid}/staff`,
    );
    expect(list.body.staff.find((s) => s.id === person.userId)).toMatchObject({
      status: 'inactive',
      roles: ['staff_reception'],
    });
  });

  it('only an org_admin may deactivate or reactivate; a facility_admin cannot, even for their own staff', async () => {
    const admin = await createStaff(t.app, org, fid, 'facility_admin');
    const victim = await createStaff(t.app, org, fid, 'staff_counter');
    expect(
      (await admin.client.patch(`/api/v1/staff/${victim.userId}`, { status: 'inactive' })).status,
    ).toBe(403);
    expect((await victim.client.get('/api/v1/auth/me')).status).toBe(200);
    // an org_admin cannot reach into another organization
    const foreign = await signupOrg(t.app);
    expect(
      (await foreign.admin.patch(`/api/v1/staff/${victim.userId}`, { status: 'inactive' })).status,
    ).toBe(404);
    expect((await victim.client.get('/api/v1/auth/me')).status).toBe(200);
  });

  it('the staff list also exposes organization administrators read-only for visibility', async () => {
    const res = await org.admin.get<{ org_admins: { id: string }[] }>(
      `/api/v1/facilities/${fid}/staff`,
    );
    expect(res.body.org_admins.map((a) => a.id)).toEqual([org.adminId]);
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|password/i);
  });
});

describe('last active organization administrator safeguard', () => {
  async function addOrgAdmin(o: TestOrg): Promise<{ client: TestClient; userId: string }> {
    // Organization administrators cannot be created through the API by design (signup only);
    // insert directly to model an organization that has more than one.
    const { hashPassword } = await import('./auth/password.js');
    const email = `second-${uniqueSlug('a')}@example.test`;
    const rows = await t.db<{ id: string }[]>`
      INSERT INTO staff_users (organization_id, email, password_hash, display_name)
      VALUES (${o.organizationId}, ${email}, ${await hashPassword(TEST_PASSWORD)}, 'Second Admin')
      RETURNING id`;
    const userId = rows[0]?.id ?? '';
    await t.db`INSERT INTO role_assignments (staff_user_id, organization_id, facility_id, role)
               VALUES (${userId}, ${o.organizationId}, NULL, 'org_admin')`;
    const client = new TestClient(t.app);
    const login = await client.post('/api/v1/auth/login', {
      organization_slug: o.slug,
      email,
      password: TEST_PASSWORD,
    });
    expect(login.status).toBe(200);
    return { client, userId };
  }

  it('a sole organization administrator cannot be deactivated by themselves or anyone else', async () => {
    const o = await signupOrg(t.app);
    const f = (await createFacility(o)).id;
    const fa = await createStaff(t.app, o, f, 'facility_admin');
    expect((await o.admin.patch(`/api/v1/staff/${o.adminId}`, { status: 'inactive' })).status).toBe(
      409,
    );
    expect(
      (await fa.client.patch(`/api/v1/staff/${o.adminId}`, { status: 'inactive' })).status,
    ).toBe(403);
    expect((await o.admin.get('/api/v1/auth/me')).status).toBe(200);
  });

  it('with two admins, one can deactivate the other but the survivor is then protected', async () => {
    const o = await signupOrg(t.app);
    const second = await addOrgAdmin(o);
    expect(
      (await o.admin.patch(`/api/v1/staff/${second.userId}`, { status: 'inactive' })).status,
    ).toBe(200);
    expect((await second.client.get('/api/v1/auth/me')).status).toBe(401);
    // the survivor is the last active admin: no one (not even themselves) can remove them
    expect((await o.admin.patch(`/api/v1/staff/${o.adminId}`, { status: 'inactive' })).status).toBe(
      409,
    );
    const left =
      await t.db`SELECT 1 FROM role_assignments ra JOIN staff_users u ON u.id = ra.staff_user_id
        WHERE ra.organization_id = ${o.organizationId} AND ra.role = 'org_admin' AND u.status = 'active'`;
    expect(left).toHaveLength(1);
  });

  it('two admins deactivating each other concurrently never leaves zero active admins', async () => {
    for (let round = 0; round < 5; round++) {
      const o = await signupOrg(t.app);
      const second = await addOrgAdmin(o);
      const results = await Promise.all([
        o.admin.patch(`/api/v1/staff/${second.userId}`, { status: 'inactive' }),
        second.client.patch(`/api/v1/staff/${o.adminId}`, { status: 'inactive' }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      // exactly one succeeds; the other is refused (409 last-admin, or 401 because it was deactivated first)
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      const active =
        await t.db`SELECT 1 FROM role_assignments ra JOIN staff_users u ON u.id = ra.staff_user_id
          WHERE ra.organization_id = ${o.organizationId} AND ra.role = 'org_admin' AND u.status = 'active'`;
      expect(active).toHaveLength(1);
    }
  });
});
