import { defineConfig } from 'vitest/config';

const databaseUrl = process.env['TEST_DATABASE_URL'];
if (!databaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is required for database tests (see .env.example). ' +
      'It must point at a dedicated, disposable PostgreSQL database.',
  );
}

/**
 * Database-backed tests (`*.db.test.ts`). They run against a real PostgreSQL instance —
 * SQL is never mocked. Migrations are applied once by the global setup.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.db.test.ts'],
    globalSetup: ['./src/testing/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      TEST_DATABASE_URL: databaseUrl,
      SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
      CORS_ORIGIN: 'http://localhost:5173',
      LOG_LEVEL: 'silent',
    },
  },
});
