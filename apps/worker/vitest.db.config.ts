import { defineConfig } from 'vitest/config';

const databaseUrl = process.env['TEST_DATABASE_URL'];
if (!databaseUrl) {
  throw new Error('TEST_DATABASE_URL is required for worker database tests.');
}

/** Worker jobs against a REAL PostgreSQL (migrations applied by the API's global setup). */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.db.test.ts'],
    globalSetup: ['../api/src/testing/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: { NODE_ENV: 'test', DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl },
  },
});
