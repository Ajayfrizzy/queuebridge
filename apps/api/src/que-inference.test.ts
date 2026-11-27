import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';
import {
  DisabledInferenceAdapter,
  SandboxInferenceAdapter,
  aiDeploymentAvailable,
  createInferenceAdapter,
} from './que/inference.js';

/**
 * MQ.4 checkpoint — sandbox isolation and disabled-by-default, independent of the database.
 */
const BASE = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
  SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
};
/** Production also requires the audit signing pair (TEST-ONLY values, never used to sign). */
const PRODUCTION = {
  ...BASE,
  NODE_ENV: 'production',
  AUDIT_SIGNING_KEY_ID: 'test-only-key',
  AUDIT_SIGNING_KEY: 'test-audit-signing-key-at-least-32-characters',
};

describe('inference adapter selection', () => {
  it('a production configuration with no AI settings uses the disabled adapter and keeps AI off', () => {
    const env = parseEnv(PRODUCTION);
    expect(env.QUE_AI_ADAPTER).toBe('disabled');
    expect(createInferenceAdapter(env)).toBeInstanceOf(DisabledInferenceAdapter);
    expect(aiDeploymentAvailable(env)).toBe(false);
  });

  it('the factory never returns the sandbox in production, even if the environment check were bypassed', () => {
    expect(
      createInferenceAdapter({ QUE_AI_ADAPTER: 'sandbox', NODE_ENV: 'production' }),
    ).toBeInstanceOf(DisabledInferenceAdapter);
    expect(createInferenceAdapter({ QUE_AI_ADAPTER: 'sandbox', NODE_ENV: 'test' })).toBeInstanceOf(
      SandboxInferenceAdapter,
    );
  });

  it('the environment schema refuses the sandbox in production (fails at start-up)', () => {
    expect(() => parseEnv({ ...PRODUCTION, QUE_AI_ADAPTER: 'sandbox' })).toThrow(
      /QUE_AI_ADAPTER: the sandbox inference adapter is test-only/,
    );
  });

  it('there is no paid or unknown adapter or cost mode', () => {
    expect(() => parseEnv({ ...BASE, QUE_AI_ADAPTER: 'openai' })).toThrow();
    expect(() => parseEnv({ ...BASE, QUE_AI_COST_MODE: 'paid' })).toThrow();
  });

  it('the disabled adapter always fails, so callers fall back to built-in help', async () => {
    await expect(new DisabledInferenceAdapter().explain()).rejects.toThrow(
      /inference provider_error/,
    );
  });

  it('no adapter code can make a network request (no provider integration exists)', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'que', 'inference.ts'),
      'utf8',
    );
    expect(src).not.toMatch(
      /\bfetch\s*\(|from 'node:(?:http|https|net|tls|dns)'|undici|axios|XMLHttpRequest|WebSocket/,
    );
    // No credential is read from the environment by the inference layer
    expect(src).not.toMatch(/API_KEY|_TOKEN|process\.env/);
  });
});
