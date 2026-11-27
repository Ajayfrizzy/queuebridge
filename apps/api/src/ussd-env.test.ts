import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';
import { ussdDeployment } from './ussd/service.js';
/** M6.2: USSD is off by default, the sandbox never runs in production, and no live mode exists. */
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
const SECRET = 'test-only-ussd-webhook-secret-0123456789abcdef';
describe('USSD deployment configuration', () => {
  it('defaults: off, 180 s sessions, 5 joins per phone per hour, nothing offered', () => {
    const env = parseEnv({ ...BASE, CONTACT_ENCRYPTION_KEY: KEY });
    expect(env.USSD_PROVIDER).toBe('off');
    expect(env.USSD_SESSION_TTL_SECONDS).toBe(180);
    expect(env.USSD_JOINS_PER_PHONE_PER_HOUR).toBe(5);
    expect(ussdDeployment(env)).toMatchObject({ mode: 'off', available: false });
  });
  it('production starts with USSD off; the sandbox is refused at startup and again by the deployment check', () => {
    expect(ussdDeployment(parseEnv({ ...PRODUCTION, CONTACT_ENCRYPTION_KEY: KEY })).available).toBe(
      false,
    );
    expect(() => parseEnv({ ...PRODUCTION, USSD_PROVIDER: 'sandbox' })).toThrow(
      /USSD_PROVIDER: the sandbox USSD adapter is test-only/,
    );
    expect(
      ussdDeployment({
        USSD_PROVIDER: 'sandbox',
        USSD_WEBHOOK_SECRET: SECRET,
        USSD_SESSION_TTL_SECONDS: 180,
        USSD_JOINS_PER_PHONE_PER_HOUR: 5,
        CONTACT_ENCRYPTION_KEY: KEY,
        NODE_ENV: 'production',
      }),
    ).toMatchObject({ mode: 'off', available: false });
  });
  it('no unknown or live provider can be configured', () => {
    for (const p of ['africastalking', 'infobip', 'live', 'termii']) {
      expect(() => parseEnv({ ...BASE, USSD_PROVIDER: p })).toThrow();
    }
  });
  it('the sandbox is offered only with the contact key and a webhook secret; bounds are enforced', () => {
    const on = parseEnv({
      ...BASE,
      CONTACT_ENCRYPTION_KEY: KEY,
      USSD_PROVIDER: 'sandbox',
      USSD_WEBHOOK_SECRET: SECRET,
    });
    expect(ussdDeployment(on)).toMatchObject({ mode: 'sandbox', available: true });
    expect(ussdDeployment({ ...on, USSD_WEBHOOK_SECRET: undefined }).available).toBe(false);
    expect(ussdDeployment({ ...on, CONTACT_ENCRYPTION_KEY: undefined }).available).toBe(false);
    expect(() => parseEnv({ ...BASE, USSD_WEBHOOK_SECRET: 'short' })).toThrow();
    expect(() => parseEnv({ ...BASE, USSD_SESSION_TTL_SECONDS: '5' })).toThrow();
    expect(() => parseEnv({ ...BASE, USSD_JOINS_PER_PHONE_PER_HOUR: '0' })).toThrow();
  });
});
