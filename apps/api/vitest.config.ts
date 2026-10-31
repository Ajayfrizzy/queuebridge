import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.db.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
    env: {
      NODE_ENV: 'test',
      DATABASE_URL:
        process.env['TEST_DATABASE_URL'] ?? 'postgres://localhost:5432/queuebridge_test',
      SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
      CORS_ORIGIN: 'http://localhost:5173',
    },
  },
});
