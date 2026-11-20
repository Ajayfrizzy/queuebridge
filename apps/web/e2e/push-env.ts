/**
 * TEST-ONLY Web Push settings shared by the Playwright config (API server) and the specs that
 * run the real worker once. The VAPID PUBLIC key is public by definition; there is no private key
 * here because the worker uses the TEST-ONLY sandbox transport (`PUSH_TRANSPORT=sandbox`), which
 * signs and sends nothing. API and worker get the same values, so the dashboard's
 * configuration-consistency check stays quiet in browser tests.
 */
export const E2E_VAPID_PUBLIC_KEY =
  'BCtWHsnhaFUoWyUfDOf6csSwfMC2_oJvWwJYnwIsLya0Q40vPSZiKr828Pqx3qaV-zXQjj5Dzn2Ti1SD3icYNKo';
/** Fictional push-service host accepted by the API's endpoint allow-list in tests only. */
export const E2E_PUSH_HOST = 'push.sandbox.test';
export const E2E_CONTACT_KEY = 'e2e0'.repeat(16);
/** M6.1: TEST-ONLY HMAC secret for the sandbox SMS webhook (never a real secret). */
export const E2E_SMS_WEBHOOK_SECRET = 'e2e-only-sms-webhook-secret-0123456789abcdef';
/** M6.2: TEST-ONLY HMAC secret for the sandbox USSD webhook (never a real secret). */
export const E2E_USSD_WEBHOOK_SECRET = 'e2e-only-ussd-webhook-secret-0123456789abcdef';
/** M6.1: TEST-ONLY daily cap for the sandbox SMS adapter (API and worker use the same value). */
export const E2E_SMS_DAILY_CAP = '1000';

/** Environment for `node worker.js --once` in browser tests. */
export function e2eWorkerEnv(databaseUrl: string): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '',
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    LOG_LEVEL: 'warn',
    PUSH_TRANSPORT: 'sandbox',
    VAPID_PUBLIC_KEY: E2E_VAPID_PUBLIC_KEY,
    CONTACT_ENCRYPTION_KEY: E2E_CONTACT_KEY,
    // M6.1: the TEST-ONLY SMS sandbox (nothing is sent; every message is labelled [TEST])
    SMS_PROVIDER: 'sandbox',
    SMS_DAILY_CAP: E2E_SMS_DAILY_CAP,
  };
}
