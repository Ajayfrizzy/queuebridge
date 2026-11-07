import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  signupOrg,
  TEST_ORIGIN,
  TEST_PASSWORD,
  TestClient,
  uniqueSlug,
  type TestApp,
} from './testing/harness.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

interface UserBody {
  user: {
    id: string;
    email: string;
    display_name: string;
    organization: { id: string; slug: string };
    roles: { role: string; facility_id: string | null }[];
  };
}

describe('organization signup (M1.1 / M1.2)', () => {
  it('creates the org, an org_admin and a signed-in session', async () => {
    const org = await signupOrg(t.app);
    const me = await org.admin.get<UserBody>('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.organization.slug).toBe(org.slug);
    expect(me.body.user.roles).toEqual([{ role: 'org_admin', facility_id: null }]);
  });

  it('sets a hardened session cookie and persists only hashes', async () => {
    const org = await signupOrg(t.app);
    const login = await new TestClient(t.app).post('/api/v1/auth/login', {
      organization_slug: org.slug,
      email: org.adminEmail,
      password: TEST_PASSWORD,
    });
    const cookie = login.setCookie.find((c) => c.startsWith('qb_session='));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//i);

    const token = cookie?.split(';')[0]?.split('=')[1] ?? '';
    // 32 random bytes, base64url => 43 chars => 256 bits of entropy (>= 128 required)
    expect(token).toHaveLength(43);
    const hash = createHash('sha256').update(token).digest('hex');
    const rows = await t.db`SELECT token_hash FROM staff_sessions WHERE token_hash = ${hash}`;
    expect(rows).toHaveLength(1);
    const raw = await t.db`SELECT 1 FROM staff_sessions WHERE token_hash = ${token}`;
    expect(raw).toHaveLength(0);
  });

  it('stores an argon2id password hash, never the password, and never returns it', async () => {
    const slug = uniqueSlug('pw');
    const client = new TestClient(t.app);
    const res = await client.post('/api/v1/organizations', {
      organization_name: 'Hash Org',
      organization_slug: slug,
      admin_display_name: 'Hash Admin',
      admin_email: `a@${slug}.test`,
      admin_password: TEST_PASSWORD,
    });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|password/i);
    const [row] = await t.db<{ password_hash: string }[]>`
      SELECT password_hash FROM staff_users WHERE email = ${`a@${slug}.test`}`;
    expect(row?.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(row?.password_hash).not.toContain(TEST_PASSWORD);
  });

  it('rejects a duplicate organization slug with 409 and creates nothing', async () => {
    const org = await signupOrg(t.app);
    const res = await new TestClient(t.app).post('/api/v1/organizations', {
      organization_name: 'Another',
      organization_slug: org.slug,
      admin_display_name: 'Other Admin',
      admin_email: 'other@example.test',
      admin_password: TEST_PASSWORD,
    });
    expect(res.status).toBe(409);
    const users = await t.db`SELECT 1 FROM staff_users WHERE email = 'other@example.test'`;
    expect(users).toHaveLength(0);
  });

  it.each([
    ['short password', { admin_password: 'short' }],
    ['invalid email', { admin_email: 'not-an-email' }],
    ['uppercase slug', { organization_slug: 'Bad_Slug' }],
    ['short name', { organization_name: 'x' }],
    ['extra field (mass assignment)', { organization_id: '018d1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b' }],
    ['privilege field', { role: 'org_admin' }],
  ])('rejects invalid input: %s', async (_label, patch) => {
    const slug = uniqueSlug('bad');
    const res = await new TestClient(t.app).post('/api/v1/organizations', {
      organization_name: 'Valid Name',
      organization_slug: slug,
      admin_display_name: 'Valid Admin',
      admin_email: `v@${slug}.test`,
      admin_password: TEST_PASSWORD,
      ...patch,
    });
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const org = await t.db`SELECT 1 FROM organizations WHERE slug = ${slug}`;
    expect(org).toHaveLength(0);
  });

  it('normalizes email case so login is case-insensitive', async () => {
    const slug = uniqueSlug('case');
    const c = new TestClient(t.app);
    await c.post('/api/v1/organizations', {
      organization_name: 'Case Org',
      organization_slug: slug,
      admin_display_name: 'Case Admin',
      admin_email: 'Mixed.Case@Example.TEST',
      admin_password: TEST_PASSWORD,
    });
    const login = await new TestClient(t.app).post('/api/v1/auth/login', {
      organization_slug: slug,
      email: 'MIXED.case@example.test',
      password: TEST_PASSWORD,
    });
    expect(login.status).toBe(200);
  });
});

describe('login / logout / session', () => {
  it('logs in, then logout destroys the server-side session', async () => {
    const org = await signupOrg(t.app);
    const c = new TestClient(t.app);
    const login = await c.post<UserBody>('/api/v1/auth/login', {
      organization_slug: org.slug,
      email: org.adminEmail,
      password: TEST_PASSWORD,
    });
    expect(login.status).toBe(200);
    const stolenCookie = c.cookie;
    expect((await c.get('/api/v1/auth/me')).status).toBe(200);

    const out = await c.post('/api/v1/auth/logout');
    expect(out.status).toBe(204);
    expect(c.cookie).toBeNull();

    // Replaying the old cookie must fail: the session is gone server-side, not just in the browser
    const replay = new TestClient(t.app);
    replay.cookie = stolenCookie;
    expect((await replay.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('returns an identical 401 for wrong password, unknown email and unknown org', async () => {
    const org = await signupOrg(t.app);
    const attempts = await Promise.all([
      new TestClient(t.app).post('/api/v1/auth/login', {
        organization_slug: org.slug,
        email: org.adminEmail,
        password: 'wrong-password-123',
      }),
      new TestClient(t.app).post('/api/v1/auth/login', {
        organization_slug: org.slug,
        email: 'nobody@example.test',
        password: 'wrong-password-123',
      }),
      new TestClient(t.app).post('/api/v1/auth/login', {
        organization_slug: 'no-such-org',
        email: org.adminEmail,
        password: 'wrong-password-123',
      }),
    ]);
    for (const a of attempts) {
      expect(a.status).toBe(401);
      expect(a.setCookie).toHaveLength(0);
    }
    const shape = (b: Record<string, unknown>): unknown => ({ ...b, instance: undefined });
    expect(shape(attempts[1]?.body ?? {})).toEqual(shape(attempts[0]?.body ?? {}));
    expect(shape(attempts[2]?.body ?? {})).toEqual(shape(attempts[0]?.body ?? {}));
  });

  it('rejects expired sessions', async () => {
    const org = await signupOrg(t.app);
    await t.db`UPDATE staff_sessions SET expires_at = NOW() - INTERVAL '1 second'
                WHERE staff_user_id = ${org.adminId}`;
    expect((await org.admin.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('rejects garbage and oversized cookies', async () => {
    const c = new TestClient(t.app);
    c.cookie = 'qb_session=not-a-real-token';
    expect((await c.get('/api/v1/auth/me')).status).toBe(401);
    c.cookie = `qb_session=${'a'.repeat(500)}`;
    expect((await c.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('protected routes return 401 without a session, before touching any data', async () => {
    const c = new TestClient(t.app);
    for (const [method, url] of [
      ['GET', '/api/v1/facilities'],
      ['POST', '/api/v1/facilities'],
      ['GET', '/api/v1/facilities/018d1a2b-3c4d-7e5f-8a9b-1c2d3e4f5a6b/services'],
      ['POST', '/api/v1/counter_service_capabilities'],
      ['GET', '/api/v1/auth/me'],
    ] as const) {
      const res = await c.request(method, url, method === 'POST' ? {} : undefined);
      expect(res.status, `${method} ${url}`).toBe(401);
    }
  });

  it('a deactivated account loses access immediately', async () => {
    const org = await signupOrg(t.app);
    await t.db`UPDATE staff_users SET status = 'inactive' WHERE id = ${org.adminId}`;
    expect((await org.admin.get('/api/v1/auth/me')).status).toBe(401);
    const login = await new TestClient(t.app).post('/api/v1/auth/login', {
      organization_slug: org.slug,
      email: org.adminEmail,
      password: TEST_PASSWORD,
    });
    expect(login.status).toBe(401);
  });

  it('the same email in two organizations is two independent accounts', async () => {
    const a = await signupOrg(t.app);
    const slugB = uniqueSlug('twin');
    const b = new TestClient(t.app);
    await b.post('/api/v1/organizations', {
      organization_name: 'Twin',
      organization_slug: slugB,
      admin_display_name: 'Twin Admin',
      admin_email: a.adminEmail,
      admin_password: 'a-completely-different-pass-9',
    });
    const loginA = await new TestClient(t.app).post<UserBody>('/api/v1/auth/login', {
      organization_slug: a.slug,
      email: a.adminEmail,
      password: TEST_PASSWORD,
    });
    expect(loginA.status).toBe(200);
    expect(loginA.body.user.organization.slug).toBe(a.slug);
    // A's password does not work in B
    const cross = await new TestClient(t.app).post('/api/v1/auth/login', {
      organization_slug: slugB,
      email: a.adminEmail,
      password: TEST_PASSWORD,
    });
    expect(cross.status).toBe(401);
  });
});

describe('CSRF and CORS protections', () => {
  it('rejects cookie-authenticated mutations without the CSRF header', async () => {
    const org = await signupOrg(t.app);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/facilities',
      headers: { cookie: org.admin.cookie ?? '', origin: TEST_ORIGIN },
      payload: { name: 'No CSRF', slug: uniqueSlug('csrf'), timezone: 'UTC' },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).title).toBe('Request rejected');
  });

  it('rejects mutations from a foreign Origin even with the header and a valid cookie', async () => {
    const org = await signupOrg(t.app);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/facilities',
      headers: {
        cookie: org.admin.cookie ?? '',
        origin: 'https://evil.example',
        'x-qb-csrf': '1',
      },
      payload: { name: 'Evil', slug: uniqueSlug('evil'), timezone: 'UTC' },
    });
    expect(res.statusCode).toBe(403);
    const rows = await t.db`SELECT 1 FROM facilities WHERE organization_id = ${org.organizationId}`;
    expect(rows).toHaveLength(0);
  });

  it('protects login itself against cross-site requests (login CSRF)', async () => {
    const org = await signupOrg(t.app);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://evil.example', 'x-qb-csrf': '1' },
      payload: { organization_slug: org.slug, email: org.adminEmail, password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('only allows the configured origin in CORS responses', async () => {
    const ok = await t.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/facilities',
      headers: {
        origin: TEST_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-qb-csrf',
      },
    });
    expect(ok.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await t.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/facilities',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sends security headers and disables caching of API responses', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});

describe('error format (RFC 9457)', () => {
  it('returns problem+json with type, title, status, instance and retryable; no stack or SQL', async () => {
    const res = await new TestClient(t.app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      type: expect.stringContaining('unauthenticated'),
      title: expect.any(String),
      status: 401,
      instance: expect.any(String),
      retryable: false,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/stack|select|postgres|node_modules/i);
  });

  it('returns 400 (not 500) for malformed JSON', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json', origin: TEST_ORIGIN, 'x-qb-csrf': '1' },
      payload: '{ not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('field-level validation errors never echo submitted values', async () => {
    const res = await new TestClient(t.app).post<{ errors: { field: string; message: string }[] }>(
      '/api/v1/organizations',
      {
        organization_name: 'Valid',
        organization_slug: 'valid-slug',
        admin_display_name: 'Valid',
        admin_email: 'bad-email-SECRET-MARKER',
        admin_password: 'SECRET',
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.errors.map((e) => e.field).sort()).toEqual(['admin_email', 'admin_password']);
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
  });
});

describe('rate limiting on unauthenticated auth endpoints', () => {
  it('returns 429 problem+json after the configured number of attempts', async () => {
    const limited = await createTestApp({ AUTH_RATE_LIMIT_MAX: '3' });
    try {
      const statuses: number[] = [];
      let last: Awaited<ReturnType<TestClient['post']>> | undefined;
      for (let i = 0; i < 5; i++) {
        last = await new TestClient(limited.app).post('/api/v1/auth/login', {
          organization_slug: 'nope-org',
          email: 'x@example.test',
          password: 'whatever-password',
        });
        statuses.push(last.status);
      }
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses.slice(3)).toEqual([429, 429]);
      expect(last?.headers['content-type']).toContain('application/problem+json');
      expect(last?.body).toMatchObject({ status: 429, retryable: true });
      expect(last?.headers['retry-after']).toBeDefined();
    } finally {
      await limited.close();
    }
  });
});
