import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { parseEnv } from './env.js';
import { auditKeyFingerprint } from './queue/audit.js';

let app: FastifyInstance;

beforeAll(async () => {
  const env = parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://postgres:x@127.0.0.1:1/queuebridge_unreachable',
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    CORS_ORIGIN: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
  });
  app = await buildApp(env);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('returns 200 with ok status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { status: string; timestamp: string };
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeTruthy();
  });

  it('response includes a valid ISO timestamp', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const body = JSON.parse(response.body) as { timestamp: string };
    expect(() => new Date(body.timestamp).toISOString()).not.toThrow();
  });
});

describe('GET /health/ready', () => {
  it('returns 503 (not a false "ok") when the database is unreachable', async () => {
    // Port 1 refuses connections: the readiness probe must report the dependency as down.
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe('unavailable');
    expect(body.checks['database']).toBe('unavailable');
  });
});

describe('404 handler', () => {
  it('returns 404 with problem+json content type for unknown routes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/nonexistent',
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const body = JSON.parse(response.body) as { title: string; status: number };
    expect(body.status).toBe(404);
    expect(body.title).toBeTruthy();
  });
});

describe('env validation', () => {
  it('throws when DATABASE_URL is missing', () => {
    expect(() => parseEnv({ SESSION_SECRET: 'a'.repeat(32) })).toThrow();
  });

  it('throws when SESSION_SECRET is too short', () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: 'postgres://localhost:5432/test',
        SESSION_SECRET: 'short',
      }),
    ).toThrow();
  });

  it('defaults the API port to 3002 so it never collides with other local projects on 3001', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgres://localhost:5432/test',
      SESSION_SECRET: 'a'.repeat(32),
    });
    expect(env.PORT).toBe(3002);
  });

  it('accepts valid env configuration', () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: 'postgres://localhost:5432/test',
        SESSION_SECRET: 'a'.repeat(32),
      }),
    ).not.toThrow();
  });
});

describe('API audit signing configuration (same rules as the worker)', () => {
  const base = { DATABASE_URL: 'postgres://localhost:5432/test', SESSION_SECRET: 'a'.repeat(32) };
  const REAL = '3f9c2a7e1b0d4c6f8a5e2d9b7c1f0a3e6d8b4c2a9f7e1d0c5b3a8e6f2d4c1b9a';

  it('loads a real key', () => {
    const env = parseEnv({ ...base, AUDIT_SIGNING_KEY_ID: 'dev-1', AUDIT_SIGNING_KEY: REAL });
    expect(env.AUDIT_SIGNING_KEY_ID).toBe('dev-1');
  });

  it('refuses the example placeholder without printing it', () => {
    const placeholder = 'replace-with-ed25519-or-hmac-key';
    let message = '';
    try {
      parseEnv({ ...base, AUDIT_SIGNING_KEY_ID: 'dev-1', AUDIT_SIGNING_KEY: placeholder });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/AUDIT_SIGNING_KEY: .*placeholder/);
    expect(message).not.toContain(placeholder);
  });

  it('refuses a key without an id (and vice versa), and no key in production', () => {
    expect(() => parseEnv({ ...base, AUDIT_SIGNING_KEY: REAL })).toThrow(/set together/);
    expect(() => parseEnv({ ...base, AUDIT_SIGNING_KEY_ID: 'dev-1' })).toThrow(/set together/);
    expect(() => parseEnv({ ...base, NODE_ENV: 'production' })).toThrow(/required in production/);
  });

  it('fingerprint matches the fixed vector the worker test also asserts', () => {
    expect(auditKeyFingerprint('test-audit-signing-key-at-least-32-characters')).toBe(
      '7714c1b67f8249cb',
    );
  });
});
