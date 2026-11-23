// Run from the release root after building the API. No network listener is opened.
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { assertQueueBridge } from './db-identity.js';
import { buildApp } from '../../apps/api/dist/app.js';
import { parseEnv } from '../../apps/api/dist/env.js';
import { uuidv7 } from '../../packages/contracts/dist/index.js';

const slug = 'willow-crossing-demo';
const adminEmail = 'admin@example.invalid';
const staffEmail = 'counter@example.invalid';

function client(app) {
  let cookie = '';
  return async (path, payload) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: { cookie, 'x-qb-csrf': '1' },
      payload,
    });
    if (response.statusCode >= 400)
      throw new Error(`Demo request ${path} returned ${response.statusCode}`);
    const session = response.cookies.find((c) => c.name === 'qb_session');
    if (session) cookie = 'qb_session=' + session.value;
    return response.statusCode === 204 ? null : response.json();
  };
}

async function prepare(tx, env, mode, expected) {
  await tx`select pg_advisory_xact_lock(hashtext('queuebridge:willow-crossing-demo'))`;
  const [org] = await tx`select id from organizations where slug=${slug}`;
  const previous = org
    ? await tx`select facility_id from admin_events where organization_id=${org.id}
    and event_type='demo.prepared' order by created_at desc`
    : [];
  if (org && !previous.length) throw new Error('Demo slug belongs to an unmarked organization');
  if (mode === 'reset' && (!expected || expected !== previous[0]?.facility_id))
    throw new Error('Reset requires the current marked facility ID');
  if (mode === 'seed' && org) return previous[0].facility_id;

  // Each real API transaction becomes a savepoint in the operator's atomic seed.
  const app = await buildApp(env, {
    db: Object.assign(tx, { begin: (callback) => tx.savepoint(callback) }),
  });
  try {
    const admin = client(app);
    const staff = client(app);
    const password = process.env.DEMO_ADMIN_PASSWORD;
    const staffPassword = process.env.DEMO_STAFF_PASSWORD;
    if (!password || !staffPassword || password === staffPassword)
      throw new Error('Supply distinct administrator and staff credentials');
    const { user } = org
      ? await admin('/auth/login', { organization_slug: slug, email: adminEmail, password })
      : await admin('/organizations', {
          organization_name: 'Willow Crossing Demonstration',
          organization_slug: slug,
          admin_email: adminEmail,
          admin_display_name: 'Demo Administrator',
          admin_password: password,
        });
    if (org && user.organization.id !== org.id) throw new Error('Unexpected organization');
    const fid = (
      await admin('/facilities', {
        name: 'Willow Reception',
        slug: 'reception-' + (previous.length + 1),
        timezone: 'Africa/Lagos',
      })
    ).facility.id;
    const base = '/facilities/' + fid;
    const invitation = await admin(base + '/invitations', {
      email: staffEmail,
      role: 'staff_counter',
    });
    await staff('/invitations/accept', {
      token: invitation.token,
      display_name: 'Demo Counter Staff',
      password: staffPassword,
    });
    for (const name of ['Consultation', 'Registration']) {
      const service = (await admin(base + '/services', { name })).service.id;
      const counter = (await admin(base + '/counters', { name: name + ' desk' })).counter.id;
      await admin('/counter_service_capabilities', { service_id: service, counter_id: counter });
      const queue = (await admin(base + '/queues', { service_id: service })).queue.id;
      await admin('/queues/' + queue + '/walk-ins', { operation_id: uuidv7() });
      if (name === 'Consultation') {
        const device = (await admin('/devices', { facility_id: fid, label: 'Demo intake' })).device
          .id;
        const command = {
          operation_id: uuidv7(),
          organization_id: user.organization.id,
          facility_id: fid,
          queue_session_id: queue,
          device_id: device,
          actor_id: user.id,
          coordinator_epoch: 0,
          base_revision: 0,
          client_sequence: 1,
          action: 'ticket.create',
          payload: { temporary_ref: 'P-DE0001' },
          created_at_client: new Date().toISOString(),
          schema_version: 1,
        };
        for (const disposition of ['committed', 'duplicate']) {
          const reply = await admin('/sync/batches', { commands: [command] });
          if (reply.results[0]?.disposition !== disposition)
            throw new Error('Unexpected reconciliation disposition');
        }
        await staff('/queues/' + queue + '/commands', {
          operation_id: uuidv7(),
          action: 'ticket.call_next',
          counter_id: counter,
        });
      }
    }
    if (previous.length)
      await tx`update facilities set status='inactive' where id=${expected} and organization_id=${user.organization.id}`;
    await tx`insert into admin_events(organization_id,facility_id,actor_id,event_type,target_type,target_id)
      values(${user.organization.id},${fid},${user.id},'demo.prepared','facility',${fid})`;
    await staff('/auth/logout', {});
    await admin('/auth/logout', {});
    return fid;
  } finally {
    await app.close();
  }
}

async function main() {
  const [mode, expected, ...extra] = process.argv.slice(2);
  if (!['seed', 'reset'].includes(mode) || extra.length || (mode === 'seed' && expected))
    throw new Error('Use seed or reset CURRENT_DEMO_FACILITY_ID');
  const env = parseEnv({ ...process.env, LOG_LEVEL: 'silent', AUTO_MISS_SWEEP_SECONDS: '0' });
  if (!process.env.DEMO_DATABASE_NAME) throw new Error('Explicit target database name required');
  const db = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const info = await assertQueueBridge(
      db,
      fileURLToPath(new URL('../migrations/', import.meta.url)),
      { requireFullyMigrated: true },
    );
    if (info.database !== process.env.DEMO_DATABASE_NAME)
      throw new Error('Target database mismatch');
    const facility = await db.begin((tx) => prepare(tx, env, mode, expected));
    const [row] =
      await db`select f.slug from facilities f join organizations o on o.id=f.organization_id where f.id=${facility} and o.slug=${slug}`;
    console.log('Join path', '/join/' + slug + '/' + row.slug);
    console.log('Current demo facility', facility);
  } finally {
    await db.end();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
