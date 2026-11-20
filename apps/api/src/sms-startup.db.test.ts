import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
/**
 * M6.1 pre-PR review (2026-11-20): the REAL API startup path with SMS unavailable. Runs the
 * BUILT server (`node dist/server.js`, `pnpm build` first, as CI does) with a production
 * configuration against the migrated test database, then asks it over HTTP:
 *  - the default production configuration (no SMS variables, or a cap without a provider)
 *    starts, is ready, describes SMS as not available (never `live`, never `available`) and has
 *    no SMS webhook (that a join then stores no number is tested in-process, `sms.db.test.ts`);
 *  - the sandbox named in production is refused before the server listens (fail closed: the
 *    API never runs the test adapter where real visitors are).
 */
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.js');
const DB_URL = process.env['TEST_DATABASE_URL'] ?? '';
const ORIGIN = 'http://localhost:5173';
const BASE_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: DB_URL,
  SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
  CORS_ORIGIN: ORIGIN,
  WEB_BASE_URL: ORIGIN,
  CONTACT_ENCRYPTION_KEY: '7e57'.repeat(16),
  // TEST-ONLY audit key pair (production requires one; never a real secret)
  AUDIT_SIGNING_KEY_ID: 'test-only-key',
  AUDIT_SIGNING_KEY: 'test-audit-signing-key-at-least-32-characters',
  AUTO_MISS_SWEEP_SECONDS: '0',
  LOG_LEVEL: 'info',
};
let child: ChildProcess | null = null;
afterEach(() => {
  child?.kill('SIGKILL');
  child = null;
});
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const a = s.address();
  await new Promise<void>((r) => s.close(() => r()));
  return typeof a === 'object' && a ? a.port : 0;
}
interface Started {
  port: number;
  output: () => string;
  exited: Promise<number | null>;
}
function start(extra: Record<string, string>, port: number): Started {
  let out = '';
  const proc = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env['PATH'] ?? '', ...BASE_ENV, PORT: String(port), ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = proc;
  proc.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
  return { port, output: () => out, exited };
}
/** Polls readiness (bounded); resolves false if the process exits first. */
async function ready(s: Started): Promise<boolean> {
  let gone = false;
  void s.exited.then(() => (gone = true));
  for (let i = 0; i < 100 && !gone; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/health/ready`);
      if (r.status === 200) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
const get = async (s: Started, path: string): Promise<{ status: number; body: unknown }> => {
  const r = await fetch(`http://127.0.0.1:${s.port}${path}`);
  return { status: r.status, body: await r.json().catch(() => null) };
};

describe('API startup with SMS unavailable (real process, production configuration)', () => {
  for (const [label, extra] of [
    ['no SMS variables (the default)', {}],
    ['a daily cap but no provider', { SMS_DAILY_CAP: '500' }],
    ['SMS explicitly off', { SMS_PROVIDER: 'off', SMS_DAILY_CAP: '500' }],
  ] as const) {
    it(`${label}: starts, is ready, and describes SMS truthfully as not available`, async () => {
      const s = start(extra, await freePort());
      expect(await ready(s), s.output()).toBe(true);
      const caps = await get(s, '/api/v1/que/capabilities');
      expect(caps.status).toBe(200);
      const sms = (caps.body as { capabilities: Record<string, Record<string, unknown>> })
        .capabilities['sms_turn_alerts'];
      expect(sms).toMatchObject({ status: 'sandbox', availability: 'unavailable' });
      expect(sms?.['status']).not.toBe('live');
      // no SMS webhook exists without a provider (same 404 as any unknown route)
      const hook = await fetch(`http://127.0.0.1:${s.port}/api/v1/webhooks/sms/sandbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(hook.status).toBe(404);
      expect(s.output()).not.toContain('[SANDBOX]');
    }, 30_000);
  }

  it('the sandbox named in production is refused before the server listens', async () => {
    const s = start({ SMS_PROVIDER: 'sandbox', SMS_DAILY_CAP: '500' }, await freePort());
    const code = await Promise.race([
      s.exited,
      new Promise<'running'>((r) => setTimeout(() => r('running'), 15_000)),
    ]);
    expect(code).not.toBe('running');
    expect(code).not.toBe(0);
    expect(s.output()).toContain(
      'the sandbox SMS adapter is test-only and cannot run in production',
    );
    await expect(fetch(`http://127.0.0.1:${s.port}/health`)).rejects.toThrow();
  }, 30_000);
});
