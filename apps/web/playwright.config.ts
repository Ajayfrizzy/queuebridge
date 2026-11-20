import { defineConfig, devices } from '@playwright/test';
import {
  E2E_CONTACT_KEY,
  E2E_PUSH_HOST,
  E2E_SMS_DAILY_CAP,
  E2E_SMS_WEBHOOK_SECRET,
  E2E_USSD_WEBHOOK_SECRET,
  E2E_VAPID_PUBLIC_KEY,
} from './e2e/push-env.js';

/** Dedicated test port: never the dev API (3002) nor other local projects (3001). */
const API_PORT = 3101;
// E2E_WEB_PORT: local override when 4173 is taken (for example by a manual phase B preview); CI
// and normal runs use 4173. Specs derive expected links from `baseURL` (WEB_BASE_URL = WEB_ORIGIN)
const WEB_PORT = Number(process.env['E2E_WEB_PORT'] ?? 4173);
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgres://postgres:password@localhost:55433/queuebridge_test';

/**
 * Browser tests run against the REAL stack: built API (Fastify) + real PostgreSQL + built web
 * app served by `vite preview`, which proxies /api to the API (same-origin cookies).
 * Required: TEST_DATABASE_URL pointing at a disposable database.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  workers: 2,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: WEB_ORIGIN,
    // The PWA service worker would cache app shell between tests; keep tests hermetic
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'desktop-1440',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
      grep: /@responsive/,
    },
    {
      name: 'mobile-320',
      use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 640 } },
      grep: /@responsive/,
    },
    {
      name: 'mobile-375',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 667 } },
      grep: /@responsive/,
    },
  ],
  webServer: [
    {
      // The worker is built too: device-health tests run its real evaluator once (`--once`)
      command:
        'pnpm --filter @queuebridge/api --filter @queuebridge/worker build && node ../api/dist/server.js',
      url: `http://localhost:${API_PORT}/health/ready`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'test',
        PORT: String(API_PORT),
        DATABASE_URL,
        SESSION_SECRET: 'e2e-session-secret-at-least-32-characters-long',
        CORS_ORIGIN: WEB_ORIGIN,
        WEB_BASE_URL: WEB_ORIGIN,
        AUTH_RATE_LIMIT_MAX: '10000',
        JOIN_RATE_LIMIT_MAX: '10000',
        PUBLIC_READ_RATE_LIMIT_MAX: '10000',
        COMMAND_RATE_LIMIT_MAX: '10000',
        // M5.1: TEST-ONLY recovery key material (never a real secret); the throttle itself is
        // covered by the PostgreSQL tests, so the browser suite raises its per-source limit
        CONTACT_ENCRYPTION_KEY: E2E_CONTACT_KEY,
        RECOVERY_RATE_LIMIT_MAX: '1000',
        // M5.4: push is "live" with a TEST-ONLY public key and a fictional push host; the worker
        // run by the specs uses the sandbox transport (nothing leaves the machine)
        VAPID_PUBLIC_KEY: E2E_VAPID_PUBLIC_KEY,
        PUSH_ENDPOINT_HOSTS: E2E_PUSH_HOST,
        // MQ.4: the TEST-ONLY sandbox inference adapter (scripted, never networked; refused in
        // production). AI still needs a facility opt-in, so other specs are unaffected.
        QUE_AI_ADAPTER: 'sandbox',
        QUE_AI_ENABLED: 'true',
        QUE_AI_COST_MODE: 'free_tier',
        QUE_AI_DAILY_CAP: '100000',
        QUE_AI_TIMEOUT_MS: '1500',
        QUE_AI_RATE_LIMIT_MAX: '1000',
        // M6.1: the TEST-ONLY SMS sandbox (refused in production). SMS still needs a facility
        // opt-in, so other specs are unaffected; the worker run by the specs uses the same cap.
        SMS_PROVIDER: 'sandbox',
        SMS_DAILY_CAP: E2E_SMS_DAILY_CAP,
        SMS_WEBHOOK_SECRET: E2E_SMS_WEBHOOK_SECRET,
        // M6.2: the TEST-ONLY USSD sandbox (signed requests from the specs; no shortcode, no
        // mobile network; refused in production). A facility must opt in, so other specs are
        // unaffected; the per-address webhook limit is raised (the limit is a DB test).
        USSD_PROVIDER: 'sandbox',
        USSD_WEBHOOK_SECRET: E2E_USSD_WEBHOOK_SECRET,
        USSD_WEBHOOK_RATE_LIMIT_MAX: '100000',
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: `pnpm exec vite build && pnpm exec vite preview --port ${WEB_PORT} --strictPort`,
      url: WEB_ORIGIN,
      timeout: 180_000,
      reuseExistingServer: false,
      env: { VITE_API_BASE_URL: '', API_PROXY_TARGET: `http://localhost:${API_PORT}` },
    },
  ],
});
