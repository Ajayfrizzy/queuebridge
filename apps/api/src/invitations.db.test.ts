import { createHash } from 'node:crypto';
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

interface InviteBody {
  invitation: { id: string; email: string; role: string; status: string };
  token: string;
  accept_url: string;
  delivery: string;
}

let n = 0;
async function invite(role = 'staff_counter', email?: string): Promise<InviteBody> {
  n += 1;
  const res = await org.admin.post<InviteBody>(`/api/v1/facilities/${fid}/invitations`, {
    email: email ?? `invitee${n}-${Date.now()}@example.test`,
    role,
  });
  expect(res.status).toBe(201);
  return res.body;
}

describe('staff invitation flow (invite → preview → accept → role)', () => {
  it('completes end to end and the new member can sign in with their role', async () => {
    const inv = await invite('supervisor', 'new.supervisor@example.test');
    expect(inv.delivery).toBe('manual');
    expect(inv.invitation.status).toBe('pending');
    expect(inv.accept_url).toBe(`http://localhost:5173/accept-invite#token=${inv.token}`);

    const anon = new TestClient(t.app);
    const preview = await anon.post<{
      invitation: { facility_name: string; role: string; email: string };
    }>('/api/v1/invitations/preview', { token: inv.token });
    expect(preview.status).toBe(200);
    expect(preview.body.invitation).toMatchObject({
      role: 'supervisor',
      email: 'new.supervisor@example.test',
    });

    const accepted = await anon.post<{
      user: { roles: { role: string; facility_id: string }[]; display_name: string };
    }>('/api/v1/invitations/accept', {
      token: inv.token,
      display_name: 'New Supervisor',
      password: TEST_PASSWORD,
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body.user.roles).toEqual([{ role: 'supervisor', facility_id: fid }]);
    expect((await anon.get(`/api/v1/facilities/${fid}/services`)).status).toBe(200);

    // Fresh login works with the chosen credentials
    const login = await new TestClient(t.app).post('/api/v1/auth/login', {
      organization_slug: org.slug,
      email: 'new.supervisor@example.test',
      password: TEST_PASSWORD,
    });
    expect(login.status).toBe(200);

    const list = await org.admin.get<{ invitations: { id: string; status: string }[] }>(
      `/api/v1/facilities/${fid}/invitations`,
    );
    expect(list.body.invitations.find((i) => i.id === inv.invitation.id)?.status).toBe('accepted');
  });

  it('persists only a hash of the secret and never returns it in listings', async () => {
    const inv = await invite();
    const hash = createHash('sha256').update(inv.token).digest('hex');
    expect(await t.db`SELECT 1 FROM staff_invitations WHERE token_hash = ${hash}`).toHaveLength(1);
    expect(
      await t.db`SELECT 1 FROM staff_invitations WHERE token_hash = ${inv.token}`,
    ).toHaveLength(0);
    const list = await org.admin.get(`/api/v1/facilities/${fid}/invitations`);
    expect(JSON.stringify(list.body)).not.toContain(inv.token);
    expect(inv.token.length).toBeGreaterThanOrEqual(43); // >= 256 bits
  });

  it('is single-use: a second accept of the same token fails with 410', async () => {
    const inv = await invite();
    const body = { token: inv.token, display_name: 'Once Only', password: TEST_PASSWORD };
    expect((await new TestClient(t.app).post('/api/v1/invitations/accept', body)).status).toBe(201);
    const again = await new TestClient(t.app).post('/api/v1/invitations/accept', body);
    expect(again.status).toBe(410);
    expect(
      (await new TestClient(t.app).post('/api/v1/invitations/preview', { token: inv.token }))
        .status,
    ).toBe(410);
  });

  it('concurrent redemptions of one token produce exactly one account', async () => {
    const inv = await invite('staff_reception', 'race@example.test');
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        new TestClient(t.app).post('/api/v1/invitations/accept', {
          token: inv.token,
          display_name: 'Racer',
          password: TEST_PASSWORD,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 410)).toHaveLength(3);
    const users =
      await t.db`SELECT 1 FROM staff_users WHERE email = 'race@example.test' AND organization_id = ${org.organizationId}`;
    expect(users).toHaveLength(1);
  });

  it('revoked invitations cannot be accepted', async () => {
    const inv = await invite();
    expect(
      (await org.admin.del(`/api/v1/facilities/${fid}/invitations/${inv.invitation.id}`)).status,
    ).toBe(204);
    const res = await new TestClient(t.app).post('/api/v1/invitations/accept', {
      token: inv.token,
      display_name: 'Too Late',
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(410);
    // already revoked → 404 on second revoke
    expect(
      (await org.admin.del(`/api/v1/facilities/${fid}/invitations/${inv.invitation.id}`)).status,
    ).toBe(404);
  });

  it('expired invitations cannot be previewed or accepted', async () => {
    const inv = await invite();
    await t.db`UPDATE staff_invitations SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${inv.invitation.id}`;
    expect(
      (await new TestClient(t.app).post('/api/v1/invitations/preview', { token: inv.token }))
        .status,
    ).toBe(410);
    expect(
      (
        await new TestClient(t.app).post('/api/v1/invitations/accept', {
          token: inv.token,
          display_name: 'Late',
          password: TEST_PASSWORD,
        })
      ).status,
    ).toBe(410);
    const list = await org.admin.get<{ invitations: { id: string; status: string }[] }>(
      `/api/v1/facilities/${fid}/invitations`,
    );
    expect(list.body.invitations.find((i) => i.id === inv.invitation.id)?.status).toBe('expired');
  });

  it('unknown and malformed tokens get the same safe answer / validation error', async () => {
    const guess = 'A'.repeat(43);
    const unknown = await new TestClient(t.app).post('/api/v1/invitations/preview', {
      token: guess,
    });
    expect(unknown.status).toBe(410);
    expect(JSON.stringify(unknown.body)).not.toMatch(/exist|found/i);
    const malformed = await new TestClient(t.app).post('/api/v1/invitations/preview', {
      token: 'short',
    });
    expect(malformed.status).toBe(400);
    const weak = await invite();
    const res = await new TestClient(t.app).post('/api/v1/invitations/accept', {
      token: weak.token,
      display_name: 'Weak',
      password: 'short',
    });
    expect(res.status).toBe(400);
    // a failed validation must not consume the invitation
    expect(
      (await new TestClient(t.app).post('/api/v1/invitations/preview', { token: weak.token }))
        .status,
    ).toBe(200);
  });

  it('rejects duplicate pending invitations and invitations for someone who already holds the role', async () => {
    const email = 'dupe@example.test';
    await invite('auditor', email);
    const dup = await org.admin.post(`/api/v1/facilities/${fid}/invitations`, {
      email,
      role: 'auditor',
    });
    expect(dup.status).toBe(409);
    // different role to the same email is a different invitation
    expect(
      (await org.admin.post(`/api/v1/facilities/${fid}/invitations`, { email, role: 'supervisor' }))
        .status,
    ).toBe(201);

    const member = await createStaff(t.app, org, fid, 'staff_counter');
    const holds = await org.admin.post(`/api/v1/facilities/${fid}/invitations`, {
      email: member.email,
      role: 'staff_counter',
    });
    expect(holds.status).toBe(409);
  });

  it('an existing member invited to a second facility must prove their password; wrong password keeps the invitation usable', async () => {
    const f2 = (await createFacility(org, 'Second Site')).id;
    const member = await createStaff(t.app, org, fid, 'staff_counter');
    const inv = await org.admin.post<InviteBody>(`/api/v1/facilities/${f2}/invitations`, {
      email: member.email,
      role: 'supervisor',
    });

    const wrong = await new TestClient(t.app).post('/api/v1/invitations/accept', {
      token: inv.body.token,
      display_name: 'Ignored',
      password: 'not-the-right-password',
    });
    expect(wrong.status).toBe(401);
    expect(
      await t.db`SELECT 1 FROM role_assignments WHERE staff_user_id = ${member.userId} AND facility_id = ${f2}`,
    ).toHaveLength(0);

    const ok = await new TestClient(t.app).post<{
      user: { id: string; roles: { role: string; facility_id: string }[] };
    }>('/api/v1/invitations/accept', {
      token: inv.body.token,
      display_name: 'Ignored',
      password: TEST_PASSWORD,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.user.id).toBe(member.userId);
    expect(ok.body.user.roles).toEqual(
      expect.arrayContaining([
        { role: 'staff_counter', facility_id: fid },
        { role: 'supervisor', facility_id: f2 },
      ]),
    );
    expect(await t.db`SELECT 1 FROM staff_users WHERE email = ${member.email}`).toHaveLength(1);
  });

  it('never logs secrets, passwords, emails or cookies across auth and invitation flows', async () => {
    const { Writable } = await import('node:stream');
    const { buildApp } = await import('./app.js');
    const { createDb } = await import('./db.js');
    const { testEnv } = await import('./testing/harness.js');
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk: Buffer, _enc, cb): void {
        lines.push(chunk.toString());
        cb();
      },
    });
    const env = testEnv({ LOG_LEVEL: 'debug' });
    const db = createDb(env);
    const app = await buildApp(env, { db, logStream });
    await app.ready();
    try {
      const admin = new TestClient(app);
      const secretPassword = 'log-check-password-SECRET-1';
      const signup = await admin.post('/api/v1/organizations', {
        organization_name: 'Log Org',
        organization_slug: `log-${Date.now()}`,
        admin_display_name: 'Log Admin',
        admin_email: 'log.admin@example.test',
        admin_password: secretPassword,
      });
      expect(signup.status).toBe(201);
      const sessionCookie = admin.cookie ?? '';
      const facility = await admin.post<{ facility: { id: string } }>('/api/v1/facilities', {
        name: 'Log Facility',
        slug: `logf-${Date.now()}`,
      });
      const inv = await admin.post<InviteBody>(
        `/api/v1/facilities/${facility.body.facility.id}/invitations`,
        {
          email: 'log.invitee@example.test',
          role: 'auditor',
        },
      );
      expect(inv.status).toBe(201);
      await new TestClient(app).post('/api/v1/invitations/accept', {
        token: inv.body.token,
        display_name: 'Log Invitee',
        password: secretPassword,
      });
      await new TestClient(app).post('/api/v1/auth/login', {
        organization_slug: 'log-org',
        email: 'log.admin@example.test',
        password: 'wrong-SECRET-password',
      });

      const output = lines.join('\n');
      expect(output.length).toBeGreaterThan(0); // logging really was captured
      expect(output).toContain('[SANDBOX] invitation created');
      for (const forbidden of [
        inv.body.token,
        secretPassword,
        'wrong-SECRET-password',
        'log.admin@example.test',
        'log.invitee@example.test',
        sessionCookie.split('=')[1] ?? 'unreachable-cookie-value',
      ]) {
        expect(output).not.toContain(forbidden);
      }
    } finally {
      await app.close();
    }
  });
});
