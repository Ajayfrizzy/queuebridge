import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { createDb } from '../db.js';
import { buildApp } from '../app.js';
import { parseEnv, type Env } from '../env.js';

export const TEST_ORIGIN = 'http://localhost:5173';
export const TEST_PASSWORD = 'correct-horse-battery-1';

export function testEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '',
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    CORS_ORIGIN: TEST_ORIGIN,
    WEB_BASE_URL: TEST_ORIGIN,
    LOG_LEVEL: 'silent',
    AUTH_RATE_LIMIT_MAX: '100000',
    ...overrides,
  });
}

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  env: Env;
  close: () => Promise<void>;
}

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const env = testEnv(overrides);
  const db = createDb(env);
  const app = await buildApp(env, { db });
  await app.ready();
  return {
    app,
    db,
    env,
    close: async (): Promise<void> => {
      await app.close();
      await db.end({ timeout: 5 });
    },
  };
}

export function uniqueSlug(prefix = 't'): string {
  return `${prefix}-${randomBytes(5).toString('hex')}`;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | number | undefined>;
  setCookie: string[];
}

/** Minimal cookie-jar HTTP client over `app.inject`, behaving like the browser SPA. */
export class TestClient {
  public cookie: string | null = null;

  public constructor(private readonly app: FastifyInstance) {}

  public async request<T = Record<string, unknown>>(
    method: Method,
    url: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {
      origin: TEST_ORIGIN,
      'x-qb-csrf': '1',
      ...extraHeaders,
    };
    if (this.cookie) headers['cookie'] = this.cookie;
    const res = await this.app.inject({
      method,
      url,
      headers,
      ...(body !== undefined ? { payload: body as object } : {}),
    });

    const setCookie = ([] as string[]).concat(
      (res.headers['set-cookie'] as string[] | string | undefined) ?? [],
    );
    for (const c of setCookie) {
      const [pair] = c.split(';');
      if (!pair) continue;
      const [name, ...rest] = pair.split('=');
      const value = rest.join('=');
      if (name === 'qb_session') this.cookie = value === '' ? null : `${name}=${value}`;
    }

    let parsed: unknown = {};
    if (res.body) {
      try {
        parsed = JSON.parse(res.body);
      } catch {
        parsed = { raw: res.body };
      }
    }
    return { status: res.statusCode, body: parsed as T, headers: res.headers, setCookie };
  }

  public get = <T = Record<string, unknown>>(url: string): Promise<ApiResult<T>> =>
    this.request<T>('GET', url);
  public post = <T = Record<string, unknown>>(url: string, body?: unknown): Promise<ApiResult<T>> =>
    this.request<T>('POST', url, body ?? {});
  public patch = <T = Record<string, unknown>>(url: string, body: unknown): Promise<ApiResult<T>> =>
    this.request<T>('PATCH', url, body);
  public del = <T = Record<string, unknown>>(url: string): Promise<ApiResult<T>> =>
    this.request<T>('DELETE', url);
}

export interface TestOrg {
  slug: string;
  adminEmail: string;
  admin: TestClient;
  organizationId: string;
  adminId: string;
}

interface UserBody {
  user: { id: string; organization: { id: string } };
}

export async function signupOrg(app: FastifyInstance, name = 'Test Org'): Promise<TestOrg> {
  const slug = uniqueSlug('org');
  const adminEmail = `admin-${slug}@example.test`;
  const admin = new TestClient(app);
  const res = await admin.post<UserBody>('/api/v1/organizations', {
    organization_name: name,
    organization_slug: slug,
    admin_display_name: 'Org Admin',
    admin_email: adminEmail,
    admin_password: TEST_PASSWORD,
  });
  if (res.status !== 201)
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    slug,
    adminEmail,
    admin,
    organizationId: res.body.user.organization.id,
    adminId: res.body.user.id,
  };
}

export async function createFacility(
  org: TestOrg,
  name = 'Main Clinic',
): Promise<{ id: string; slug: string }> {
  const slug = uniqueSlug('fac');
  const res = await org.admin.post<{ facility: { id: string; slug: string } }>(
    '/api/v1/facilities',
    {
      name,
      slug,
      timezone: 'Africa/Lagos',
    },
  );
  if (res.status !== 201)
    throw new Error(`facility failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.facility;
}

/** Invite + accept so the returned client is signed in as a staff member holding `role`. */
export async function createStaff(
  app: FastifyInstance,
  org: TestOrg,
  facilityId: string,
  role: string,
): Promise<{ client: TestClient; email: string; userId: string }> {
  const email = `${role}-${uniqueSlug('u')}@example.test`;
  const inv = await org.admin.post<{ token: string }>(
    `/api/v1/facilities/${facilityId}/invitations`,
    {
      email,
      role,
    },
  );
  if (inv.status !== 201)
    throw new Error(`invite failed: ${inv.status} ${JSON.stringify(inv.body)}`);
  const client = new TestClient(app);
  const acc = await client.post<UserBody>('/api/v1/invitations/accept', {
    token: inv.body.token,
    display_name: `Staff ${role}`,
    password: TEST_PASSWORD,
  });
  if (acc.status !== 201)
    throw new Error(`accept failed: ${acc.status} ${JSON.stringify(acc.body)}`);
  return { client, email, userId: acc.body.user.id };
}
