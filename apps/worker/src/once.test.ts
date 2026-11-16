import { spawn } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `worker --once` is bounded (found while investigating a browser-suite hang: a `--once` run
 * stuck on a stalled database connection ignored SIGTERM, so its caller's timeout could not stop
 * it and the suite hung). Runs the BUILT worker (`pnpm build` first, as CI does) against a fake
 * "database" that accepts TCP connections and never answers: a stall at its simplest.
 */
const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'worker.js');
let server: Server | null = null;
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});
async function stalledDatabase(): Promise<number> {
  server = createServer((s) => sockets.push(s)); // accept, then say nothing, ever
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}
function runOnce(
  port: number,
  extraEnv: Record<string, string>,
  signalAfterMs?: number,
): Promise<{ code: number | null; ms: number; stderr: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [WORKER, '--once'], {
      env: {
        PATH: process.env['PATH'] ?? '',
        NODE_ENV: 'test',
        DATABASE_URL: `postgres://u:p@127.0.0.1:${port}/stalled`,
        LOG_LEVEL: 'info',
        ...extraEnv,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    if (signalAfterMs !== undefined) setTimeout(() => child.kill('SIGTERM'), signalAfterMs);
    // a hard backstop so a regression fails this test instead of hanging it
    const backstop = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('exit', (code) => {
      clearTimeout(backstop);
      resolve({ code, ms: Date.now() - started, stderr });
    });
  });
}

describe('worker --once is bounded', () => {
  it('exits with status 1 when the run does not finish within WORKER_ONCE_TIMEOUT_MS', async () => {
    const port = await stalledDatabase();
    const r = await runOnce(port, { WORKER_ONCE_TIMEOUT_MS: '1500' });
    expect(r.code).toBe(1);
    expect(r.ms).toBeLessThan(10_000);
    expect(r.stderr).toContain('Worker --once did not finish in time');
  }, 30_000);

  it('a stop signal ends a stalled --once run at once', async () => {
    const port = await stalledDatabase();
    const r = await runOnce(port, { WORKER_ONCE_TIMEOUT_MS: '60000' }, 800);
    expect(r.code).toBe(1);
    expect(r.ms).toBeLessThan(10_000);
    expect(r.stderr).toContain('Worker --once stopped by signal');
  }, 30_000);
});
