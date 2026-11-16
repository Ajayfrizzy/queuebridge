#!/usr/bin/env node
/**
 * QueueBridge local environment helper (DEVELOPMENT ONLY). Never prints, logs or copies a secret.
 *
 *   node infra/scripts/local-env.js check     [--file .env] [--db]
 *   node infra/scripts/local-env.js generate  [--file .env] [--rotate]
 *
 * check     Validates the file with the REAL API and worker parsers (build first: pnpm build),
 *           confirms both load the same audit key (by comparing fingerprints computed by each
 *           app's own code), reports database targets as host:port/name (no credentials) and,
 *           with --db, the identity of each QueueBridge database (read-only).
 * generate  Fills SESSION_SECRET, CONTACT_ENCRYPTION_KEY and AUDIT_SIGNING_KEY with fresh random
 *           values where they are missing, placeholders or invalid (valid values are kept unless
 *           --rotate; CONTACT_ENCRYPTION_KEY only with --rotate-contact-key, because stored
 *           encrypted contacts would become unreadable). A new audit key always gets a NEW
 *           AUDIT_SIGNING_KEY_ID, so checkpoints
 *           signed with an old key are reported "incomplete", never mistaken for tampering.
 *           The file is rewritten atomically with mode 0600; other lines are preserved.
 *           With --vapid, also creates a Web Push (VAPID, P-256) key pair where it is missing
 *           (M5.4; push is optional). An existing pair is replaced only with --rotate-vapid,
 *           because every browser subscription is bound to the public key and would have to
 *           opt in again. VAPID_SUBJECT (a contact URL) is never invented: set it yourself.
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const command = args[0];
const fileArg = args.indexOf('--file');
const FILE = resolve(ROOT, fileArg >= 0 ? args[fileArg + 1] : '.env');

/** Minimal dotenv parser: KEY=value lines; comments and blank lines are kept verbatim. */
function parse(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) values[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return values;
}

function setValue(text, key, value) {
  const re = new RegExp(`^(# ?)?${key}=.*$`, 'm');
  return re.test(text)
    ? text.replace(re, `${key}=${value}`)
    : `${text.replace(/\n?$/, '\n')}${key}=${value}\n`;
}

const PLACEHOLDER = /replace[-_]?with|change[-_]?me|placeholder|example|your[-_]/i;
const looksPlaceholder = (v) => PLACEHOLDER.test(v) || new Set(v).size < 8;

const RULES = {
  SESSION_SECRET: (v) => v.length >= 32 && !looksPlaceholder(v),
  CONTACT_ENCRYPTION_KEY: (v) => /^[0-9a-fA-F]{64}$/.test(v) && new Set(v.toLowerCase()).size >= 8,
  AUDIT_SIGNING_KEY: (v) => v.length >= 32 && !looksPlaceholder(v),
};
const hex32 = () => randomBytes(32).toString('hex');
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

/** host:port/database — never user or password. */
function describeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return '(not a valid URL)';
  }
}

async function generate() {
  const rotate = args.includes('--rotate');
  const text = await readFile(FILE, 'utf8');
  const env = parse(text);
  let next = text;
  const report = [];
  for (const key of ['SESSION_SECRET', 'CONTACT_ENCRYPTION_KEY', 'AUDIT_SIGNING_KEY']) {
    const current = env[key];
    const valid = current !== undefined && RULES[key](current);
    // Rotating the contact key would make every stored phone_ciphertext undecryptable: a VALID
    // contact key is only replaced with its own explicit flag (never by --rotate alone)
    const rotateThis =
      key === 'CONTACT_ENCRYPTION_KEY' ? args.includes('--rotate-contact-key') : rotate;
    if (valid && !rotateThis) {
      report.push(
        `${key}: kept (valid${rotate && key === 'CONTACT_ENCRYPTION_KEY' ? '; --rotate-contact-key to replace — destroys access to stored contacts' : ''})`,
      );
      continue;
    }
    next = setValue(next, key, hex32());
    report.push(
      `${key}: generated (${current === undefined ? 'was missing' : valid ? 'rotated' : 'was a placeholder or invalid'})`,
    );
    if (key === 'AUDIT_SIGNING_KEY') {
      const id = `local-dev-${today()}-${randomBytes(2).toString('hex')}`;
      next = setValue(next, 'AUDIT_SIGNING_KEY_ID', id);
      report.push(`AUDIT_SIGNING_KEY_ID: set to ${id} (new key ⇒ new id)`);
    }
  }
  if (args.includes('--vapid')) {
    const has = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
    if (has && !args.includes('--rotate-vapid')) {
      report.push(
        'VAPID key pair: kept (--rotate-vapid to replace — every visitor must opt in to push again)',
      );
    } else {
      const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const pub = publicKey.export({ format: 'jwk' });
      const priv = privateKey.export({ format: 'jwk' });
      const raw = Buffer.concat([
        Buffer.from([4]),
        Buffer.from(pub.x, 'base64url'),
        Buffer.from(pub.y, 'base64url'),
      ]);
      next = setValue(next, 'VAPID_PUBLIC_KEY', raw.toString('base64url'));
      next = setValue(next, 'VAPID_PRIVATE_KEY', priv.d);
      report.push(`VAPID key pair: generated (${has ? 'rotated' : 'was missing'})`);
    }
    if (!env.VAPID_SUBJECT) {
      report.push('VAPID_SUBJECT: not set — add a mailto: or https: contact before sending push');
    }
  }
  if (next !== text) {
    const tmp = `${FILE}.tmp-${process.pid}`;
    await writeFile(tmp, next, { mode: 0o600 });
    await rename(tmp, FILE);
  }
  await chmod(FILE, 0o600);
  console.log(`${FILE} (mode 600)`);
  for (const r of report) console.log(`  ${r}`);
}

async function check() {
  const env = { ...parse(await readFile(FILE, 'utf8')), NODE_ENV: 'development' };
  let ok = true;
  const fail = (m) => {
    ok = false;
    console.log(`  FAIL ${m}`);
  };
  console.log(`Checking ${FILE} (values are never shown)`);
  for (const [key, rule] of Object.entries(RULES)) {
    const v = env[key];
    if (v === undefined) fail(`${key}: missing`);
    else if (!rule(v)) fail(`${key}: placeholder or invalid (length ${v.length})`);
    else console.log(`  ok   ${key}: set, length ${v.length}`);
  }

  const load = async (rel) => import(pathToFileURL(join(ROOT, rel)).href);
  let api;
  let worker;
  try {
    api = {
      env: await load('apps/api/dist/env.js'),
      audit: await load('apps/api/dist/queue/audit.js'),
    };
    worker = {
      env: await load('apps/worker/dist/env.js'),
      cp: await load('apps/worker/dist/checkpoints.js'),
    };
  } catch {
    fail('apps are not built: run pnpm build, then check again');
  }
  if (api && worker) {
    let a;
    let w;
    try {
      a = api.env.parseEnv(env);
      console.log('  ok   API environment validates');
    } catch (e) {
      fail(`API environment: ${e.message.split('\n').slice(1).join('; ').trim()}`);
    }
    try {
      w = worker.env.parseEnv(env);
      console.log('  ok   worker environment validates');
    } catch (e) {
      fail(`worker environment: ${e.message.split('\n').slice(1).join('; ').trim()}`);
    }
    if (a && w) {
      if (!a.AUDIT_SIGNING_KEY || !w.AUDIT_SIGNING_KEY) {
        fail('audit signing key not configured (worker would write no checkpoints)');
      } else {
        const fa = api.audit.auditKeyFingerprint(a.AUDIT_SIGNING_KEY);
        const fw = worker.cp.auditKeyFingerprint(w.AUDIT_SIGNING_KEY);
        if (fa === fw && a.AUDIT_SIGNING_KEY_ID === w.AUDIT_SIGNING_KEY_ID) {
          console.log(
            `  ok   API and worker load the same audit key (id ${a.AUDIT_SIGNING_KEY_ID}, fingerprint ${fa})`,
          );
        } else {
          fail('API and worker would load DIFFERENT audit keys');
        }
      }
    }
  }

  // M5.4 Web Push is optional; if any VAPID value is set, the pair must be complete and match
  if (env.VAPID_PUBLIC_KEY || env.VAPID_PRIVATE_KEY || env.VAPID_SUBJECT) {
    try {
      const ch = await load('packages/channels/dist/index.js');
      ch.assertVapidKeys({
        publicKey: env.VAPID_PUBLIC_KEY ?? '',
        privateKey: env.VAPID_PRIVATE_KEY ?? '',
        subject: env.VAPID_SUBJECT ?? '',
      });
      console.log(
        '  ok   VAPID key pair and subject are valid (API and worker read the same file)',
      );
    } catch (e) {
      fail(`Web Push: ${e instanceof Error ? e.message : 'invalid VAPID configuration'}`);
    }
  } else {
    console.log('  info Web Push not configured (optional): the in-app alert still works');
  }

  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
    if (!env[key]) {
      fail(`${key}: missing`);
      continue;
    }
    console.log(`  info ${key} → ${describeUrl(env[key])}`);
  }
  if (env.DATABASE_URL && env.DATABASE_URL === env.TEST_DATABASE_URL) {
    fail('DATABASE_URL and TEST_DATABASE_URL must be different databases (tests write freely)');
  }

  if (args.includes('--db')) {
    const { default: postgres } = await import('postgres');
    const { inspectDatabase, listMigrationFiles } = await import('./db-identity.js');
    const files = await listMigrationFiles(join(ROOT, 'infra', 'migrations'));
    for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
      if (!env[key]) continue;
      const sql = postgres(env[key], { max: 1, onnotice: () => undefined, connect_timeout: 5 });
      try {
        const i = await inspectDatabase(sql, files);
        const line = `${key}: database "${i.database}" is ${i.kind}; applied ${i.applied.length}/${files.length}${i.pending.length ? `, pending ${i.pending.join(', ')}` : ''}`;
        if (i.kind === 'foreign' || i.kind === 'inconsistent') {
          fail(`${line} — ${i.reasons.join('; ')}`);
        } else if (key === 'DATABASE_URL' && i.pending.length > 0) {
          fail(`${line} — run pnpm db:migrate (M4 evidence: "Migrating the dev database")`);
        } else {
          console.log(`  ok   ${line}`);
        }
      } catch (e) {
        fail(`${key}: cannot connect (${e.code ?? 'error'})`);
      } finally {
        await sql.end({ timeout: 2 }).catch(() => undefined);
      }
    }
  }
  console.log(ok ? 'READY' : 'NOT READY');
  process.exitCode = ok ? 0 : 1;
}

if (command === 'generate') await generate();
else if (command === 'check') await check();
else {
  console.error(
    'Usage: node infra/scripts/local-env.js check [--db] | generate [--rotate] [--vapid [--rotate-vapid]] [--file .env]',
  );
  process.exitCode = 2;
}
