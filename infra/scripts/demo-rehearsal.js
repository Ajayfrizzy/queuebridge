// Explicit, local-only operator regression. Start with a fresh migrated scratch database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { profiles, roles } from './demo-profiles.js';
import { client } from './demo-client.js';
import { buildApp } from '../../apps/api/dist/app.js';
import { parseEnv } from '../../apps/api/dist/env.js';

const target = new URL(process.env.DATABASE_URL);
if (
  process.env.NODE_ENV !== 'test' ||
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/queuebridge_demo_rehearsal'
)
  throw new Error('Requires a local disposable queuebridge_demo_rehearsal database');
const env = {
  ...process.env,
  DEMO_DATABASE_NAME: 'queuebridge_demo_rehearsal',
  AUTH_RATE_LIMIT_MAX: '100',
  SESSION_SECRET: randomBytes(32).toString('hex'),
  LOG_LEVEL: 'silent',
  AUTO_MISS_SWEEP_SECONDS: '0',
};
const sql = postgres(target.href, { max: 1 });
const inputs = {};
for (const profile of Object.keys(profiles))
  inputs[profile] = {
    profile,
    passwords: Object.fromEntries(
      roles.map((role) => [role, randomBytes(32).toString('base64url')]),
    ),
  };
async function seed(profile, mode = 'seed', id) {
  const child = spawn(
    process.execPath,
    ['infra/scripts/demo.js', profile, mode, ...(id ? [id] : [])],
    { env: { ...env, DEMO_DRAINED_FACILITY: id ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let out = '',
    err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve(out.match(/Current demo facility ([\w-]+)/)?.[1])
        : reject(new Error(err.trim())),
    );
  });
  child.stdin.end(JSON.stringify(inputs[profile]));
  return done;
}
try {
  assert.equal(
    (await sql`select count(*)::int as n from organizations`)[0].n,
    0,
    'Requires empty rehearsal tenants',
  );
  const [owner, judge, o2, j2] = await Promise.all(
    ['owner-qa', 'judge-demo', 'owner-qa', 'judge-demo'].map((p) => seed(p)),
  );
  assert.ok(owner && judge && owner !== judge);
  assert.equal(owner, o2);
  assert.equal(judge, j2);
  const app = await buildApp(parseEnv(env), { db: sql });
  try {
    let counter;
    for (const [profile, fid, foreign] of [
      ['owner-qa', owner, judge],
      ['judge-demo', judge, owner],
    ]) {
      for (const role of roles) {
        const call = client(app);
        const { user } = await call('/auth/login', {
          organization_slug: profile,
          email: role + '@' + profile + '.example.invalid',
          password: inputs[profile].passwords[role],
        });
        assert.equal(user.organization.slug, profile);
        assert.ok(
          user.roles.some(
            (g) => g.role === role && (role === 'org_admin' || g.facility_id === fid),
          ),
        );
        await call('/facilities/' + fid + '/queues', undefined, 'GET');
        await assert.rejects(
          call('/facilities/' + foreign + '/queues', undefined, 'GET'),
          /returned 404/,
        );
        if (role === 'auditor')
          await assert.rejects(
            call('/facilities/' + fid + '/services', { name: 'Denied' }),
            /returned 403/,
          );
        if (role === 'staff_counter' && profile === 'judge-demo') counter = call;
        else await call('/auth/logout', {});
      }
    }
    const counts = async (fid) =>
      sql`select t.state,t.priority_class,count(*)::int as n from tickets t join queue_sessions q on q.id=t.queue_session_id where q.facility_id=${fid} group by 1,2 order by 1,2`;
    const initial = Array.from(await counts(owner));
    assert.deepEqual(
      initial.map((r) => [r.state, r.priority_class, r.n]).sort(),
      [
        ['called', 'normal', 1],
        ['completed', 'normal', 1],
        ['waiting', 'normal', 2],
        ['waiting', 'priority', 1],
      ].sort(),
    );
    const { device } = await counter('/devices', { facility_id: judge, label: 'Rehearsal' });
    const heartbeat = (pending_count) =>
      counter('/devices/' + device.id + '/heartbeat', { pending_count });
    await heartbeat(1);
    await assert.rejects(seed('judge-demo', 'reset', judge), /offline operations/);
    await heartbeat(0);
    await assert.rejects(seed('judge-demo', 'reset', owner), /current Judge Demo/);
    await assert.rejects(seed('owner-qa', 'reset', owner), /Only Judge Demo/);
    const fresh = await seed('judge-demo', 'reset', judge);
    assert.notEqual(fresh, judge);
    assert.equal(await seed('judge-demo'), fresh);
    await assert.rejects(seed('judge-demo', 'reset', judge), /current Judge Demo/);
    assert.deepEqual(Array.from(await counts(owner)), initial);
    assert.deepEqual(Array.from(await counts(judge)), initial);
    assert.deepEqual(Array.from(await counts(fresh)), initial);
    assert.equal((await sql`select count(*)::int as n from staff_users`)[0].n, 12);
    for (const profile of Object.keys(profiles)) {
      const call = client(app);
      await call('/auth/login', {
        organization_slug: profile,
        email: 'auditor@' + profile + '.example.invalid',
        password: inputs[profile].passwords.auditor,
      });
      const queues =
        await sql`select q.id from queue_sessions q join organizations o on o.id=q.organization_id where o.slug=${profile}`;
      for (const q of queues) {
        const { verification } = await call('/queues/' + q.id + '/audit/verify', undefined, 'GET');
        assert.equal(verification.chain.valid, true);
      }
    }
    console.log(
      'Dual-tenant provisioning, 12 logins, isolation, guarded rotation, queue states and audit chains passed',
    );
  } finally {
    await app.close();
  }
} finally {
  await sql.end();
}
