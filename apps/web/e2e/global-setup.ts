import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Apply migrations to the browser-test database before the servers start. */
export default function globalSetup(): void {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('TEST_DATABASE_URL is required for browser tests');
  const script = fileURLToPath(new URL('../../../infra/scripts/migrate.js', import.meta.url));
  execFileSync('node', [script], { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
}
