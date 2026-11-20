import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';
import { smsDeployment } from './sms/service.js';

/** M6.1: SMS is off by default, the sandbox never runs in production, and no paid mode exists. */
const BASE = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
  SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
};
const PRODUCTION = {
  ...BASE,
  NODE_ENV: 'production',
  AUDIT_SIGNING_KEY_ID: 'test-only-key',
  AUDIT_SIGNING_KEY: 'test-audit-signing-key-at-least-32-characters',
};
const KEY = '7e57'.repeat(16);

describe('SMS deployment configuration (design §13.3)', () => {
  it('defaults: off, cap 0, nothing offered', () => {
    const env = parseEnv({ ...BASE, CONTACT_ENCRYPTION_KEY: KEY });
    expect(env.SMS_PROVIDER).toBe('off');
    expect(env.SMS_DAILY_CAP).toBe(0);
    expect(smsDeployment(env)).toMatchObject({ mode: 'off', available: false, adapter: null });
  });

  it('the sandbox is refused in production at start-up, and the deployment check refuses it again', () => {
    expect(() => parseEnv({ ...PRODUCTION, SMS_PROVIDER: 'sandbox' })).toThrow(
      /SMS_PROVIDER: the sandbox SMS adapter is test-only/,
    );
    expect(
      smsDeployment({
        SMS_PROVIDER: 'sandbox',
        SMS_DAILY_CAP: 10,
        SMS_WEBHOOK_SECRET: undefined,
        CONTACT_ENCRYPTION_KEY: KEY,
        NODE_ENV: 'production',
      }),
    ).toMatchObject({ mode: 'off', available: false });
  });

  it('no unknown or live provider can be configured', () => {
    for (const p of ['termii', 'africastalking', 'twilio', 'live']) {
      expect(() => parseEnv({ ...BASE, SMS_PROVIDER: p })).toThrow();
    }
  });

  it('the sandbox is offered only with the contact key and a positive cap; a short webhook secret is refused', () => {
    const on = parseEnv({
      ...BASE,
      CONTACT_ENCRYPTION_KEY: KEY,
      SMS_PROVIDER: 'sandbox',
      SMS_DAILY_CAP: '5',
    });
    expect(smsDeployment(on)).toMatchObject({ mode: 'sandbox', available: true, dailyCap: 5 });
    expect(smsDeployment({ ...on, SMS_DAILY_CAP: 0 }).available).toBe(false);
    expect(smsDeployment({ ...on, CONTACT_ENCRYPTION_KEY: undefined }).available).toBe(false);
    expect(() => parseEnv({ ...BASE, SMS_WEBHOOK_SECRET: 'short' })).toThrow();
  });
});
