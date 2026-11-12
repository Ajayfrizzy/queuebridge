import { describe, expect, it } from 'vitest';
import { auditKeyFingerprint } from './checkpoints.js';
import { parseEnv } from './env.js';

describe('worker parseEnv', () => {
  it('accepts valid minimum config', () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: 'postgres://localhost:5432/queuebridge_test',
      }),
    ).not.toThrow();
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => parseEnv({})).toThrow('DATABASE_URL');
  });

  it('defaults SMS_PROVIDER to sandbox', () => {
    const env = parseEnv({ DATABASE_URL: 'postgres://localhost:5432/test' });
    expect(env.SMS_PROVIDER).toBe('sandbox');
  });

  it('defaults USSD_PROVIDER to sandbox', () => {
    const env = parseEnv({ DATABASE_URL: 'postgres://localhost:5432/test' });
    expect(env.USSD_PROVIDER).toBe('sandbox');
  });

  it('defaults poll interval to 5000ms', () => {
    const env = parseEnv({ DATABASE_URL: 'postgres://localhost:5432/test' });
    expect(env.WORKER_POLL_INTERVAL_MS).toBe(5000);
  });

  it('rejects poll interval below 1000ms', () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: 'postgres://localhost:5432/test',
        WORKER_POLL_INTERVAL_MS: '500',
      }),
    ).toThrow();
  });
});

describe('worker audit signing configuration (same rules as the API)', () => {
  const base = { DATABASE_URL: 'postgres://localhost:5432/test' };
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
});

describe('audit key fingerprint', () => {
  it('matches the fixed vector the API test also asserts (both logs are comparable)', () => {
    expect(auditKeyFingerprint('test-audit-signing-key-at-least-32-characters')).toBe(
      '7714c1b67f8249cb',
    );
  });
});
