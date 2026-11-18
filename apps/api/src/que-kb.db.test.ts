import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PublicKbResponseSchema,
  RestrictedKbResponseSchema,
  type RestrictedKbResponse,
} from '@queuebridge/contracts';
import {
  TestClient,
  createFacility,
  createStaff,
  createTestApp,
  signupOrg,
  type TestApp,
  type TestOrg,
} from './testing/harness.js';
import { roleDigest } from './auth/role-digest.js';

/**
 * MQ.2 — knowledge-base delivery (design §11.5, decision D2) against real PostgreSQL sessions
 * and role grants. The articles are the committed initial delivery content of
 * `packages/assist/knowledge` (2 public, 2 restricted).
 */

let t: TestApp;
let shortTtl: TestApp;
let org: TestOrg;
let facility: { id: string; slug: string };

beforeAll(async () => {
  t = await createTestApp();
  shortTtl = await createTestApp({ QUE_OFFLINE_HELP_TTL_SECONDS: '300' });
  org = await signupOrg(t.app, 'Que Org');
  facility = await createFacility(org, 'Que Clinic');
});

afterAll(async () => {
  await t.close();
  await shortTtl.close();
});

async function kb(
  c: TestClient,
  query = '',
): Promise<{ status: number; body: RestrictedKbResponse }> {
  const r = await c.get<RestrictedKbResponse>(`/api/v1/que/kb${query}`);
  return { status: r.status, body: r.body };
}

const ids = (b: RestrictedKbResponse): string[] => b.articles.map((a) => a.id);

describe('GET /api/v1/que/kb/public (anonymous)', () => {
  it('serves only public (visitor) articles without authentication', async () => {
    const r = await new TestClient(t.app).get('/api/v1/que/kb/public');
    expect(r.status).toBe(200);
    const b = PublicKbResponseSchema.parse(r.body);
    expect(b.audience).toBe('visitor');
    expect(b.articles.map((a) => a.id).sort()).toEqual([
      'visitor.recovery.how',
      'visitor.recovery.staff',
    ]);
    for (const a of b.articles) expect(a.audiences).toContain('visitor');
    const raw = JSON.stringify(r.body).toLowerCase();
    // D4: the staff verification procedure is not public
    expect(raw).not.toContain('correct service');
    expect(raw).not.toContain('staff.recovery.assist');
  });

  it('is identical for a signed-in staff user (no session-dependent content)', async () => {
    const anon = await new TestClient(t.app).get('/api/v1/que/kb/public');
    const staff = await org.admin.get('/api/v1/que/kb/public');
    expect(staff.body).toEqual(anon.body);
  });
});

describe('GET /api/v1/que/kb (authenticated, role-filtered)', () => {
  it('refuses anonymous and forged sessions with 401', async () => {
    expect((await kb(new TestClient(t.app))).status).toBe(401);
    const forged = new TestClient(t.app);
    forged.cookie = 'qb_session=forged-token-value';
    expect((await kb(forged)).status).toBe(401);
  });

  it.each([
    ['staff_reception', ['reception'], ['staff.recovery.assist', 'staff.sync.states']],
    ['staff_counter', ['counter'], ['staff.recovery.assist', 'staff.sync.states']],
    ['supervisor', ['supervisor'], ['staff.recovery.assist', 'staff.sync.states']],
    ['facility_admin', ['facility_admin'], ['staff.recovery.assist', 'staff.sync.states']],
    // Auditors never receive the staff-assisted recovery procedure
    ['auditor', ['auditor'], ['staff.sync.states']],
  ])('%s receives exactly its restricted articles', async (role, audiences, expected) => {
    const s = await createStaff(t.app, org, facility.id, role);
    const r = await kb(s.client);
    expect(r.status).toBe(200);
    const b = RestrictedKbResponseSchema.parse(r.body);
    expect(b.userId).toBe(s.userId);
    expect(b.audiences).toEqual(audiences);
    expect(ids(b)).toEqual(expected);
    expect(b.index.map((x) => x.id)).toEqual(expected);
    // Restricted responses never repeat public articles
    for (const a of b.articles) expect(a.audiences).not.toContain('visitor');
  });

  it('org_admin receives every staff audience', async () => {
    const r = await kb(org.admin);
    expect(r.status).toBe(200);
    expect(r.body.audiences).toEqual([
      'reception',
      'counter',
      'supervisor',
      'facility_admin',
      'org_admin',
      'auditor',
    ]);
    expect(ids(r.body)).toEqual(['staff.recovery.assist', 'staff.sync.states']);
  });

  it('contains no tenant data: no names, emails, slugs or facility ids', async () => {
    const s = await createStaff(t.app, org, facility.id, 'supervisor');
    const raw = JSON.stringify((await kb(s.client)).body);
    for (const v of [
      s.email,
      org.adminEmail,
      org.slug,
      facility.slug,
      facility.id,
      'Que Clinic',
      'Que Org',
      'Staff supervisor',
    ]) {
      expect(raw).not.toContain(v);
    }
  });
});

describe('D2: server-issued role fingerprint', () => {
  it('is the single server calculation over the session grants, stable across requests', async () => {
    const s = await createStaff(t.app, org, facility.id, 'staff_counter');
    const a = (await kb(s.client)).body;
    const b = (await kb(s.client)).body;
    expect(a.roleDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(b.roleDigest).toBe(a.roleDigest);
    expect(a.roleDigest).toBe(
      roleDigest({
        organizationId: org.organizationId,
        staffUserId: s.userId,
        roles: [{ role: 'staff_counter', facility_id: facility.id }],
      }),
    );
  });

  it('differs between users with the same role and across organizations', async () => {
    const x = await createStaff(t.app, org, facility.id, 'staff_counter');
    const y = await createStaff(t.app, org, facility.id, 'staff_counter');
    const other = await signupOrg(t.app, 'Other Org');
    const f2 = await createFacility(other, 'Other Clinic');
    const z = await createStaff(t.app, other, f2.id, 'staff_counter');
    const dx = (await kb(x.client)).body.roleDigest;
    const dy = (await kb(y.client)).body.roleDigest;
    const dz = (await kb(z.client)).body;
    expect(new Set([dx, dy, dz.roleDigest]).size).toBe(3);
    // Another organization's user gets only its own grants' content, never org A data
    expect(dz.userId).toBe(z.userId);
    expect(JSON.stringify(dz)).not.toContain(facility.id);
  });

  it('changes when a role is granted or revoked; revoking every role empties the bundle', async () => {
    const s = await createStaff(t.app, org, facility.id, 'auditor');
    const before = (await kb(s.client)).body;
    expect(ids(before)).toEqual(['staff.sync.states']);
    const grant = await org.admin.post(
      `/api/v1/facilities/${facility.id}/staff/${s.userId}/roles`,
      {
        role: 'staff_reception',
      },
    );
    expect([200, 201]).toContain(grant.status);
    const granted = (await kb(s.client)).body;
    expect(granted.roleDigest).not.toBe(before.roleDigest);
    expect(ids(granted)).toEqual(['staff.recovery.assist', 'staff.sync.states']);
    for (const role of ['staff_reception', 'auditor']) {
      const r = await org.admin.del(
        `/api/v1/facilities/${facility.id}/staff/${s.userId}/roles/${role}`,
      );
      expect([200, 204]).toContain(r.status);
    }
    const none = (await kb(s.client)).body;
    expect(none.roleDigest).not.toBe(granted.roleDigest);
    expect(none.audiences).toEqual([]);
    expect(none.articles).toEqual([]);
    expect(none.index).toEqual([]);
  });

  it('a deactivated account gets 401 (its sessions are destroyed)', async () => {
    const s = await createStaff(t.app, org, facility.id, 'supervisor');
    expect((await kb(s.client)).status).toBe(200);
    expect(
      (await org.admin.patch(`/api/v1/staff/${s.userId}`, { status: 'inactive' })).status,
    ).toBe(200);
    expect((await kb(s.client)).status).toBe(401);
  });

  it('a signed-out session gets 401', async () => {
    const s = await createStaff(t.app, org, facility.id, 'supervisor');
    const cookie = s.client.cookie;
    expect((await s.client.post('/api/v1/auth/logout')).status).toBe(204);
    const replay = new TestClient(t.app);
    replay.cookie = cookie;
    expect((await kb(replay)).status).toBe(401);
  });
});

describe('offline authorization metadata (design §11.5.2)', () => {
  it('authorizedUntil never exceeds the session end; validForMs = authorizedUntil - issuedAt', async () => {
    const s = await createStaff(t.app, org, facility.id, 'staff_counter');
    const me = await s.client.get<{ session: { expires_at: string } }>('/api/v1/auth/me');
    const b = (await kb(s.client)).body;
    const issued = Date.parse(b.issuedAt);
    const until = Date.parse(b.authorizedUntil);
    expect(until).toBeLessThanOrEqual(Date.parse(me.body.session.expires_at));
    expect(b.validForMs).toBe(until - issued);
    expect(b.validForMs).toBeGreaterThan(11 * 3600 * 1000);
    expect(b.validForMs).toBeLessThanOrEqual(12 * 3600 * 1000);
  });

  it('honours a shorter configured TTL', async () => {
    const o = await signupOrg(shortTtl.app, 'TTL Org');
    const f = await createFacility(o);
    const s = await createStaff(shortTtl.app, o, f.id, 'staff_counter');
    const r = await s.client.get<RestrictedKbResponse>('/api/v1/que/kb');
    expect(r.body.validForMs).toBe(300_000);
  });
});

describe('incremental update by article version', () => {
  it('does not resend articles the client already holds at that version', async () => {
    const s = await createStaff(t.app, org, facility.id, 'staff_counter');
    const full = (await kb(s.client)).body;
    const known = full.index.map((x) => `${x.id}:${x.version}`).join(',');
    const delta = (await kb(s.client, `?known=${encodeURIComponent(known)}`)).body;
    expect(delta.articles).toEqual([]);
    expect(delta.index).toEqual(full.index);
    expect(delta.roleDigest).toBe(full.roleDigest);
    // An outdated version is resent
    const stale = (await kb(s.client, '?known=staff.sync.states:999,staff.recovery.assist:1')).body;
    expect(ids(stale)).toEqual(['staff.sync.states']);
  });

  it.each([
    ['a malformed known list', '?known=not%20valid'],
    ['a version zero', '?known=staff.sync.states:0'],
    ['an unknown parameter', '?facility_id=x'],
    ['a role claim', '?role=org_admin'],
  ])('rejects %s with 400', async (_l, q) => {
    const s = await createStaff(t.app, org, facility.id, 'staff_counter');
    expect((await kb(s.client, q)).status).toBe(400);
  });
});

describe('read-only', () => {
  it('Que endpoints change no tenant or queue table (this organization; other files run in parallel)', async () => {
    const o = await signupOrg(t.app, 'Read-only Org');
    const f = await createFacility(o);
    const s = await createStaff(t.app, o, f.id, 'supervisor');
    const tables = [
      'queue_events',
      'tickets',
      'client_operations',
      'admin_events',
      'role_assignments',
      'staff_users',
    ] as const;
    const count = async (): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const table of tables) {
        const [r] = await t.db.unsafe<{ n: string }[]>(
          `SELECT count(*)::text AS n FROM ${table} WHERE organization_id = $1`,
          [o.organizationId],
        );
        out[table] = Number(r?.n);
      }
      return out;
    };
    const before = await count();
    expect(before['role_assignments']).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) {
      expect((await kb(s.client)).status).toBe(200);
      expect((await s.client.get('/api/v1/que/kb/public')).status).toBe(200);
      expect((await s.client.get('/api/v1/que/capabilities')).status).toBe(200);
      expect((await kb(o.admin)).status).toBe(200);
    }
    expect(await count()).toEqual(before);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    '%s on the KB endpoints is not routed',
    async (m) => {
      for (const url of ['/api/v1/que/kb', '/api/v1/que/kb/public']) {
        expect((await org.admin.request(m, url, {})).status).toBe(404);
      }
    },
  );
});
