import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `infra/scripts/local-env.js` — the developer secret generator/checker. Runs on temporary files
 * only (never the real .env) and asserts that no secret value ever reaches its output.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(ROOT, 'infra', 'scripts', 'local-env.js');
const run = promisify(execFile);
let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qb-env-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const parse = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split('\n')
      .map((l) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1] ?? '', m[2] ?? '']),
  );

async function envFile(name: string, text: string): Promise<string> {
  const f = join(dir, name);
  await writeFile(f, text, { mode: 0o644 });
  return f;
}

async function script(...args: string[]): Promise<{ code: number; out: string }> {
  try {
    const r = await run(process.execPath, [SCRIPT, ...args], { cwd: ROOT });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

const EXAMPLE_LIKE = `# comment kept
DATABASE_URL=postgres://u:p@localhost:55433/queuebridge
SESSION_SECRET=replace-with-at-least-64-character-random-hex-string
CONTACT_ENCRYPTION_KEY=replace-with-64-character-hex-key
# AUDIT_SIGNING_KEY_ID=local-dev-key-v1
# AUDIT_SIGNING_KEY=replace-with-at-least-32-random-characters
LOG_LEVEL=info
`;

describe('local-env generate', () => {
  it('replaces placeholders with fresh random values, sets a new key id, keeps other lines, never prints values', async () => {
    const f = await envFile('a.env', EXAMPLE_LIKE);
    const r = await script('generate', '--file', f);
    expect(r.code).toBe(0);
    const text = await readFile(f, 'utf8');
    const env = parse(text);
    expect(env['SESSION_SECRET']).toMatch(/^[0-9a-f]{64}$/);
    expect(env['CONTACT_ENCRYPTION_KEY']).toMatch(/^[0-9a-f]{64}$/);
    expect(env['AUDIT_SIGNING_KEY']).toMatch(/^[0-9a-f]{64}$/);
    expect(env['AUDIT_SIGNING_KEY_ID']).toMatch(/^local-dev-\d{8}-[0-9a-f]{4}$/);
    expect(
      new Set([env['SESSION_SECRET'], env['CONTACT_ENCRYPTION_KEY'], env['AUDIT_SIGNING_KEY']])
        .size,
    ).toBe(3);
    expect(text).toContain('# comment kept');
    expect(env['LOG_LEVEL']).toBe('info');
    expect(env['DATABASE_URL']).toBe('postgres://u:p@localhost:55433/queuebridge');
    for (const k of ['SESSION_SECRET', 'CONTACT_ENCRYPTION_KEY', 'AUDIT_SIGNING_KEY']) {
      expect(r.out).not.toContain(env[k]);
    }
    expect((await stat(f)).mode & 0o777).toBe(0o600);
  });

  it('keeps valid values (no silent rotation); --rotate replaces them and changes the key id', async () => {
    const f = await envFile('b.env', EXAMPLE_LIKE);
    await script('generate', '--file', f);
    const first = parse(await readFile(f, 'utf8'));
    const again = await script('generate', '--file', f);
    expect(again.out).toMatch(/SESSION_SECRET: kept/);
    expect(parse(await readFile(f, 'utf8'))).toEqual(first);
    await script('generate', '--file', f, '--rotate');
    const rotated = parse(await readFile(f, 'utf8'));
    expect(rotated['AUDIT_SIGNING_KEY']).not.toBe(first['AUDIT_SIGNING_KEY']);
    expect(rotated['AUDIT_SIGNING_KEY_ID']).not.toBe(first['AUDIT_SIGNING_KEY_ID']);
    expect(rotated['SESSION_SECRET']).not.toBe(first['SESSION_SECRET']);
    // --rotate never replaces a valid contact key (stored encrypted contacts would be lost)
    expect(rotated['CONTACT_ENCRYPTION_KEY']).toBe(first['CONTACT_ENCRYPTION_KEY']);
    await script('generate', '--file', f, '--rotate-contact-key');
    expect(parse(await readFile(f, 'utf8'))['CONTACT_ENCRYPTION_KEY']).not.toBe(
      first['CONTACT_ENCRYPTION_KEY'],
    );
  });
});

describe('local-env check', () => {
  it('reports problems by name only and never prints a value', async () => {
    const f = await envFile(
      'c.env',
      EXAMPLE_LIKE + 'AUDIT_SIGNING_KEY=replace-with-ed25519-or-hmac-key\n',
    );
    const r = await script('check', '--file', f);
    expect(r.code).toBe(1);
    expect(r.out).toContain('NOT READY');
    expect(r.out).toMatch(/SESSION_SECRET: placeholder or invalid/);
    expect(r.out).not.toContain('replace-with');
    expect(r.out).not.toContain('u:p@'); // URL credentials are never shown
    expect(r.out).toContain('localhost:55433/queuebridge');
  });

  it('a generated file passes the API and worker parsers with one shared audit key (needs pnpm build)', async () => {
    const f = await envFile(
      'd.env',
      EXAMPLE_LIKE + 'TEST_DATABASE_URL=postgres://u:p@localhost:55433/queuebridge_test\n',
    );
    await script('generate', '--file', f);
    const env = parse(await readFile(f, 'utf8'));
    const r = await script('check', '--file', f);
    expect(r.out).toMatch(/API and worker load the same audit key \(id local-dev-/);
    expect(r.out).toContain('READY');
    for (const k of ['SESSION_SECRET', 'CONTACT_ENCRYPTION_KEY', 'AUDIT_SIGNING_KEY']) {
      expect(r.out).not.toContain(env[k]);
    }
  });
});
