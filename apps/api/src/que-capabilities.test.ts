import { createECDH, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  CAPABILITY_IDS,
  CapabilityManifestSchema,
  isCapabilityUsable,
  type CapabilityManifest,
} from '@queuebridge/contracts';
import { buildApp } from './app.js';
import { parseEnv } from './env.js';

/**
 * MQ.1 — `GET /api/v1/que/capabilities` (decision D1). Runs without a database: the database URL
 * points at a port that refuses connections, which also proves the endpoint reads no table.
 */

const ORIGIN = 'http://localhost:5173';
const VAPID_PUBLIC = createECDH('prime256v1').generateKeys().toString('base64url');
const CONTACT_KEY = randomBytes(32).toString('hex');
const SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
const DB_URL = 'postgres://qbuser:dbpassword-should-not-leak@127.0.0.1:1/queuebridge_unreachable';

function env(extra: Record<string, string> = {}): ReturnType<typeof parseEnv> {
  return parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: DB_URL,
    SESSION_SECRET,
    CORS_ORIGIN: ORIGIN,
    LOG_LEVEL: 'silent',
    ...extra,
  });
}

let noPush: FastifyInstance;
let withPush: FastifyInstance;
let keyOnly: FastifyInstance;

beforeAll(async () => {
  noPush = await buildApp(env());
  withPush = await buildApp(
    env({ VAPID_PUBLIC_KEY: VAPID_PUBLIC, CONTACT_ENCRYPTION_KEY: CONTACT_KEY }),
  );
  keyOnly = await buildApp(env({ VAPID_PUBLIC_KEY: VAPID_PUBLIC }));
  await Promise.all([noPush.ready(), withPush.ready(), keyOnly.ready()]);
});

afterAll(async () => {
  await Promise.all([noPush.close(), withPush.close(), keyOnly.close()]);
});

async function manifestOf(
  app: FastifyInstance,
  headers: Record<string, string> = {},
  url = '/api/v1/que/capabilities',
): Promise<{
  status: number;
  body: CapabilityManifest;
  raw: string;
  headers: Record<string, unknown>;
}> {
  const r = await app.inject({ method: 'GET', url, headers });
  return {
    status: r.statusCode,
    body: JSON.parse(r.body) as CapabilityManifest,
    raw: r.body,
    headers: r.headers,
  };
}

describe('GET /api/v1/que/capabilities (public, server-authoritative)', () => {
  it('returns a schema-valid, exhaustive manifest without authentication', async () => {
    const r = await manifestOf(noPush);
    expect(r.status).toBe(200);
    const m = CapabilityManifestSchema.parse(r.body);
    expect(Object.keys(m.capabilities).sort()).toEqual([...CAPABILITY_IDS].sort());
    expect(m.version).toBe(1);
    expect(Number.isNaN(Date.parse(m.generatedAt))).toBe(false);
    expect(r.headers['x-ratelimit-limit']).toBeDefined();
  });

  it('retains the four statuses and reports availability separately (D1)', async () => {
    const m = (await manifestOf(noPush)).body;
    for (const e of Object.values(m.capabilities)) {
      expect(['live', 'preview', 'sandbox', 'planned']).toContain(e.status);
      expect(['available', 'unavailable']).toContain(e.availability);
    }
  });

  it('Web Push without VAPID: live but unavailable/not_configured, never usable', async () => {
    const m = (await manifestOf(noPush)).body;
    expect(m.capabilities.turn_alert_web_push).toEqual({
      status: 'live',
      availability: 'unavailable',
      unavailableReason: 'not_configured',
      since: 'M5',
      note: 'Push alerts are not set up here.',
    });
    expect(isCapabilityUsable(m, 'turn_alert_web_push')).toBe(false);
  });

  it('Web Push with VAPID and the encryption key: live and available', async () => {
    const m = (await manifestOf(withPush)).body;
    expect(m.capabilities.turn_alert_web_push).toEqual({
      status: 'live',
      availability: 'available',
      since: 'M5',
    });
    expect(isCapabilityUsable(m, 'turn_alert_web_push')).toBe(true);
  });

  it('a VAPID key without the encryption key is still unavailable (same check as the feature)', async () => {
    const m = (await manifestOf(keyOnly)).body;
    expect(m.capabilities.turn_alert_web_push.availability).toBe('unavailable');
    const push = JSON.parse(
      (await keyOnly.inject({ method: 'GET', url: '/api/v1/push/capability' })).body,
    ) as { web_push: string };
    expect(push.web_push).toBe('disabled');
  });

  it('agrees with GET /push/capability in both configurations', async () => {
    for (const app of [noPush, withPush, keyOnly]) {
      const push = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/v1/push/capability' })).body,
      ) as {
        web_push: string;
      };
      const m = (await manifestOf(app)).body;
      expect(push.web_push === 'live').toBe(isCapabilityUsable(m, 'turn_alert_web_push'));
    }
  });

  it('USSD and SMS are TEST-ONLY sandboxes, not set up by default; AI is switched off; none is usable', async () => {
    for (const app of [noPush, withPush]) {
      const m = (await manifestOf(app)).body;
      // M6.2: built as the sandbox only (never `live`), and off unless USSD_PROVIDER is set up
      expect(m.capabilities.ussd.status).toBe('sandbox');
      expect(m.capabilities.ussd.availability).toBe('unavailable');
      expect(m.capabilities.ussd.unavailableReason).toBe('not_configured');
      expect(isCapabilityUsable(m, 'ussd')).toBe(false);
      // M6.1: built as the sandbox only (never `live`), and off unless SMS_PROVIDER is set up
      expect(m.capabilities.sms_turn_alerts.status).toBe('sandbox');
      expect(m.capabilities.sms_turn_alerts.availability).toBe('unavailable');
      expect(m.capabilities.sms_turn_alerts.unavailableReason).toBe('not_configured');
      expect(isCapabilityUsable(m, 'sms_turn_alerts')).toBe(false);
      // MQ.4 built the layer; no provider is selected, so it is switched off (D1)
      expect(m.capabilities.ask_que_ai.status).toBe('live');
      expect(m.capabilities.ask_que_ai.availability).toBe('unavailable');
      expect(m.capabilities.ask_que_ai.unavailableReason).toBe('switched_off');
      expect(isCapabilityUsable(m, 'ask_que_ai')).toBe(false);
    }
  });

  it('M5 capabilities are live and available (design §11.10a)', async () => {
    const m = (await manifestOf(noPush)).body;
    for (const id of [
      'visitor_join',
      'ticket_recovery_key',
      'staff_assisted_recovery',
      'recovery_audit_view',
      'self_resume',
      'auto_miss',
      'offline_coordinator',
      'device_health',
      'turn_alert_in_app',
      'turn_alert_sound',
      'turn_alert_vibration',
      'accessibility_prefs',
    ] as const) {
      expect(isCapabilityUsable(m, id)).toBe(true);
    }
  });

  it('exposes no environment value, secret or key', async () => {
    const { raw } = await manifestOf(withPush);
    for (const secret of [
      VAPID_PUBLIC,
      CONTACT_KEY,
      SESSION_SECRET,
      'dbpassword-should-not-leak',
      '127.0.0.1',
      ORIGIN,
    ]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).not.toMatch(/VAPID|ENCRYPTION|SECRET|DATABASE|postgres:/i);
  });

  it('output does not depend on the caller (cookies, headers, query, origin)', async () => {
    const strip = (m: CapabilityManifest): unknown => ({ ...m, generatedAt: null });
    const base = strip((await manifestOf(withPush)).body);
    const variants = [
      { cookie: 'qb_session=forged; other=1' },
      { origin: 'https://evil.example', 'x-forwarded-for': '203.0.113.9' },
      { 'x-qb-ticket-token': 'A'.repeat(43) },
    ];
    for (const h of variants) expect(strip((await manifestOf(withPush, h)).body)).toEqual(base);
    expect(
      strip(
        (await manifestOf(withPush, {}, '/api/v1/que/capabilities?facility=x&role=org_admin')).body,
      ),
    ).toEqual(base);
  });
});

describe('Que is read-only in MQ.1', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    '%s /que/capabilities is not routed',
    async (method) => {
      const r = await noPush.inject({
        method,
        url: '/api/v1/que/capabilities',
        headers: { origin: ORIGIN, 'x-qb-csrf': '1', 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(r.statusCode).toBe(404);
    },
  );

  it('POST /api/v1/que/ask (MQ.4) requires a staff session: anonymous callers get 401', async () => {
    const r = await noPush.inject({
      method: 'POST',
      url: '/api/v1/que/ask',
      headers: { origin: ORIGIN, 'x-qb-csrf': '1', 'content-type': 'application/json' },
      payload: '{"question":"x"}',
    });
    expect(r.statusCode).toBe(401);
  });

  it('MQ.2 KB endpoints: public is open, restricted needs a session (no database involved)', async () => {
    const pub = await noPush.inject({ method: 'GET', url: '/api/v1/que/kb/public' });
    expect(pub.statusCode).toBe(200);
    const restricted = await noPush.inject({ method: 'GET', url: '/api/v1/que/kb' });
    expect(restricted.statusCode).toBe(401);
  });
});
