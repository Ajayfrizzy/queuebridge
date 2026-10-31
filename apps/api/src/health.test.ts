import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { parseEnv } from './env.js';

let app: FastifyInstance;

beforeAll(async () => {
  const env = parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost:5432/queuebridge_test',
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
  it('returns 200 with ok status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/ready',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('includes a checks object', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    const body = JSON.parse(response.body) as { checks: Record<string, string> };
    expect(body.checks).toBeDefined();
    expect(typeof body.checks).toBe('object');
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

  it('accepts valid env configuration', () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: 'postgres://localhost:5432/test',
        SESSION_SECRET: 'a'.repeat(32),
      }),
    ).not.toThrow();
  });
});
