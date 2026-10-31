import { describe, expect, it } from 'vitest';
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
