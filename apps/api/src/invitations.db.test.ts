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

  describe('expired invitations do not block replacements', () => {
    it('an expired invitation is retired and a replacement can be issued; the old token stays dead', async () => {
      const email = `expired-${Date.now()}@example.test`;
      const old = await invite('auditor', email);
      await t.db`UPDATE staff_invitations SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${old.invitation.id}`;

      const replacement = await org.admin.post<InviteBody>(
        `/api/v1/facilities/${fid}/invitations`,
        {
          email,
          role: 'auditor',
        },
      );
      expect(replacement.status).toBe(201);
      expect(replacement.body.token).not.toBe(old.token);

      // old token: still unusable
      expect(
        (await new TestClient(t.app).post('/api/v1/invitations/preview', { token: old.token }))
          .status,
      ).toBe(410);
      expect(
        (
          await new TestClient(t.app).post('/api/v1/invitations/accept', {
            token: old.token,
            display_name: 'Old Token',
            password: TEST_PASSWORD,
          })
        ).status,
      ).toBe(410);
      // new token: works
      expect(
        (
          await new TestClient(t.app).post('/api/v1/invitations/accept', {
            token: replacement.body.token,
            display_name: 'New Token',
            password: TEST_PASSWORD,
          })
        ).status,
      ).toBe(201);

      // exactly one row of this email/role was ever open; the old one is retired, not deleted
      const rows = await t.db<{ id: string; revoked_at: Date | null; accepted_at: Date | null }[]>`
        SELECT id, revoked_at, accepted_at FROM staff_invitations
         WHERE facility_id = ${fid} AND email = ${email} ORDER BY created_at`;
      expect(rows).toHaveLength(2);
      expect(rows[0]?.revoked_at).not.toBeNull();
      expect(rows[1]?.accepted_at).not.toBeNull();
    });

    it('is audited without leaking the email or any token', async () => {
      const email = `audit-exp-${Date.now()}@example.test`;
      const old = await invite('supervisor', email);
      await t.db`UPDATE staff_invitations SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = ${old.invitation.id}`;
      const rep = await org.admin.post<InviteBody>(`/api/v1/facilities/${fid}/invitations`, {
        email,
        role: 'supervisor',
      });
      const ev = await t.db<{ details: unknown; actor_id: string; target_id: string }[]>`
        SELECT details, actor_id, target_id FROM admin_events
         WHERE event_type = 'invitation.expired_retired' AND target_id = ${old.invitation.id}`;
      expect(ev).toHaveLength(1);
      expect(ev[0]?.actor_id).toBe(org.adminId);
      const dump = JSON.stringify(ev);
      expect(dump).not.toContain(email);
      expect(dump).not.toContain(old.token);
      expect(dump).not.toContain(rep.body.token);
    });

    it('genuinely pending invitations still deduplicate (409), expired status is not required', async () => {
      const email = `pending-${Date.now()}@example.test`;
      await invite('staff_reception', email);
      const dup = await org.admin.post(`/api/v1/facilities/${fid}/invitations`, {
        email,
        role: 'staff_reception',
      });
      expect(dup.status).toBe(409);
      const open =
        await t.db`SELECT 1 FROM staff_invitations WHERE facility_id = ${fid} AND email = ${email}
          AND accepted_at IS NULL AND revoked_at IS NULL`;
      expect(open).toHaveLength(1);
    });

    it('a still-pending invitation and an expired one for DIFFERENT roles are independent', async () => {
      const email = `roles-${Date.now()}@example.test`;
      const keep = await invite('supervisor', email);
      const stale = await invite('auditor', email);
      await t.db`UPDATE staff_invitations SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${stale.invitation.id}`;
      expect(
        (await org.admin.post(`/api/v1/facilities/${fid}/invitations`, { email, role: 'auditor' }))
          .status,
      ).toBe(201);
      // the other role's pending invitation was not retired
      const kept = await t.db<{ revoked_at: Date | null }[]>`
        SELECT revoked_at FROM staff_invitations WHERE id = ${keep.invitation.id}`;
      expect(kept[0]?.revoked_at).toBeNull();
    });

    it('never touches another facility’s or another organization’s expired invitations', async () => {
      const email = `scope-${Date.now()}@example.test`;
      const otherFid = (await createFacility(org, 'Scope Other')).id;
      const here = await invite('auditor', email);
      const there = await org.admin.post<InviteBody>(`/api/v1/facilities/${otherFid}/invitations`, {
        email,
        role: 'auditor',
      });
      const foreign = await signupOrg(t.app);
      const foreignFid = (await createFacility(foreign)).id;
      const alien = await foreign.admin.post<InviteBody>(
        `/api/v1/facilities/${foreignFid}/invitations`,
        { email, role: 'auditor' },
      );
      await t.db`UPDATE staff_invitations SET expires_at = NOW() - INTERVAL '1 minute'
                  WHERE id IN (${here.invitation.id}, ${there.body.invitation.id}, ${alien.body.invitation.id})`;

      expect(
        (await org.admin.post(`/api/v1/facilities/${fid}/invitations`, { email, role: 'auditor' }))
          .status,
      ).toBe(201);
      const states = await t.db<{ id: string; revoked_at: Date | null }[]>`
        SELECT id, revoked_at FROM staff_invitations
         WHERE id IN (${there.body.invitation.id}, ${alien.body.invitation.id})`;
      expect(states.every((s) => s.revoked_at === null)).toBe(true);
    });

    it('concurrent replacement requests: exactly one is created, the rest get 409, no 500', async () => {
      const email = `race-exp-${Date.now()}@example.test`;
      const old = await invite('staff_counter', email);
      await t.db`UPDATE staff_invitations SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${old.invitation.id}`;
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map(() =>
          org.admin.post(`/api/v1/facilities/${fid}/invitations`, { email, role: 'staff_counter' }),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(4);
      expect(statuses.filter((s) => s >= 500)).toHaveLength(0);
      const open =
        await t.db`SELECT 1 FROM staff_invitations WHERE facility_id = ${fid} AND email = ${email}
          AND accepted_at IS NULL AND revoked_at IS NULL`;
      expect(open).toHaveLength(1);
    });

    it('the expired invitation remains visible in history, not as pending', async () => {
      const email = `hist-${Date.now()}@example.test`;
      const old = await invite('staff_reception', email);
      await t.db`UPDATE staff_invitations SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${old.invitation.id}`;
      await org.admin.post(`/api/v1/facilities/${fid}/invitations`, {
        email,
        role: 'staff_reception',
      });
      const list = await org.admin.get<{ invitations: { id: string; status: string }[] }>(
        `/api/v1/facilities/${fid}/invitations`,
      );
      expect(list.body.invitations.find((i) => i.id === old.invitation.id)?.status).toBe('revoked');
      expect(
        list.body.invitations.filter((i) => i.status === 'pending' && i.id !== old.invitation.id)
          .length,
      ).toBeGreaterThan(0);
    });
  });
});
