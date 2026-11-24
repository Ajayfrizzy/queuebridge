import { readFileSync } from 'node:fs';
import { buildApp } from '../../apps/api/dist/app.js';
import { uuidv7 } from '../../packages/contracts/dist/index.js';
import { client } from './demo-client.js';

export const profiles = {
  'owner-qa': {
    name: 'Harbor Operations Lab',
    services: ['Intake', 'Review'],
    desks: ['Intake Desk', 'Review Desk', 'Shared Desk'],
  },
  'judge-demo': {
    name: 'Willow Crossing Service Centre',
    services: ['Registration', 'Consultation'],
    desks: ['Welcome Desk', 'Consultation Desk', 'Relief Desk'],
  },
};
export const roles = [
  'org_admin',
  'facility_admin',
  'supervisor',
  'staff_reception',
  'staff_counter',
  'auditor',
];

export function readCredentials(profile) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    throw new Error('Supply a private credential envelope on stdin');
  }
  const secrets = roles.map((role) => input?.passwords?.[role]);
  if (
    input?.profile !== profile ||
    secrets.some((s) => typeof s !== 'string' || !/^[A-Za-z0-9_-]{32,64}$/.test(s)) ||
    new Set(secrets).size !== roles.length
  )
    throw new Error('Expected six distinct generated passwords for the selected profile');
  return input.passwords;
}

async function guardRotation(tx, org, facility) {
  // Local-only work cannot be inferred from a zero heartbeat. Close the session and
  // reconcile every participating device before the operator supplies this attestation.
  if (process.env.DEMO_DRAINED_FACILITY !== facility)
    throw new Error('Confirm the drained current facility');
  const [row] = await tx`select
    exists(select 1 from devices where organization_id=${org} and facility_id=${facility} and (reported_pending_count > 0 or (revoked_at is null and (last_seen_at is null or last_seen_at < now() - interval '5 minutes'))))
    or exists(select 1 from client_operations c join queue_sessions q on q.id=c.queue_session_id
      where c.organization_id=${org} and q.facility_id=${facility} and
      (c.status='pending' or (c.status='needs_review' and c.resolved_at is null))) as blocked`;
  if (row.blocked) throw new Error('Resolve outstanding offline operations before rotation');
}

async function populate(admin, accounts, base, config) {
  const desks = [];
  for (const name of config.desks)
    desks.push((await admin(base + '/counters', { name })).counter.id);
  for (const [index, name] of config.services.entries()) {
    const service = (await admin(base + '/services', { name })).service.id;
    await admin(
      base + '/services/' + service,
      { policy: { priority_order: ['priority', 'normal'] } },
      'PATCH',
    );
    for (const counter_id of [desks[index], desks[2]])
      await admin('/counter_service_capabilities', { service_id: service, counter_id });
    const queue = (await accounts.supervisor(base + '/queues', { service_id: service })).queue.id;
    const path = '/queues/' + queue;
    const walk = () => accounts.staff_reception(path + '/walk-ins', { operation_id: uuidv7() });
    const command = async (action, fields) => {
      const { outcome } = await accounts.staff_counter(path + '/commands', {
        action,
        operation_id: uuidv7(),
        ...fields,
      });
      if (outcome.disposition !== 'committed') throw new Error('Queue command did not commit');
      return outcome;
    };
    await walk();
    const { ticket_id } = await command('ticket.call_next', { counter_id: desks[index] });
    if (index === 0) {
      await command('ticket.serve', { ticket_id });
      await command('ticket.complete', { ticket_id });
      const { ticket } = await walk();
      const view = await accounts.supervisor(path, undefined, 'GET');
      const target = view.queue.tickets.find((t) => t.public_code === ticket.public_code);
      const { outcome } = await accounts.supervisor(
        '/tickets/' + target.id + '/priority-override',
        {
          operation_id: uuidv7(),
          to_class: 'priority',
          reason_code: 'accessibility_need',
          reason_text: 'Fictional assisted service appointment',
        },
      );
      if (outcome.disposition !== 'committed') throw new Error('Priority change did not commit');
    }
    await walk();
  }
}

export async function prepareProfile(tx, env, slug, passwords, mode, expected) {
  const config = profiles[slug];
  if (mode === 'reset' && slug !== 'judge-demo')
    throw new Error('Only Judge Demo supports rotation');
  await tx`select pg_advisory_xact_lock(hashtext(${'queuebridge:demo:' + slug}))`;
  const [org] = await tx`select id from organizations where slug=${slug}`;
  const marker = 'demo.prepared.' + slug;
  const generations = org
    ? await tx`select f.id,f.status from admin_events e join facilities f
    on f.id=e.facility_id and f.organization_id=e.organization_id where e.organization_id=${org.id}
    and e.event_type=${marker} order by e.created_at desc`
    : [];
  const current = generations[0];
  if (org && (!current || current.status !== 'active'))
    throw new Error('Unrecognized or inactive demonstration generation');
  if (mode === 'reset' && (!expected || current?.id !== expected))
    throw new Error('Expected current Judge Demo facility');
  const app = await buildApp(env, {
    db: Object.assign(tx, { begin: (callback) => tx.savepoint(callback) }),
  });
  try {
    const accounts = Object.fromEntries(roles.map((role) => [role, client(app)]));
    const admin = accounts.org_admin;
    const email = (role) => role + '@' + slug + '.example.invalid';
    const { user } = org
      ? await admin('/auth/login', {
          organization_slug: slug,
          email: email('org_admin'),
          password: passwords.org_admin,
        })
      : await admin('/organizations', {
          organization_name: config.name,
          organization_slug: slug,
          admin_display_name: 'Organization Administrator',
          admin_email: email('org_admin'),
          admin_password: passwords.org_admin,
        });
    if (
      user.organization.slug !== slug ||
      !user.roles.some((grant) => grant.role === 'org_admin') ||
      (org && user.organization.id !== org.id)
    )
      throw new Error('Organization mismatch');
    if (mode === 'seed' && current) {
      await admin('/auth/logout', {});
      return current.id;
    }
    if (current) await guardRotation(tx, org.id, current.id);
    const { facility } = await admin('/facilities', {
      name: config.name,
      slug: 'session-' + (generations.length + 1),
      timezone: 'Africa/Lagos',
    });
    const base = '/facilities/' + facility.id;
    for (const role of roles.slice(1)) {
      const { token } = await admin(base + '/invitations', { email: email(role), role });
      await accounts[role]('/invitations/accept', {
        token,
        password: passwords[role],
        display_name: role.replaceAll('_', ' '),
      });
    }
    await populate(admin, accounts, base, config);
    if (current)
      await tx`update facilities set status='inactive' where id=${current.id} and organization_id=${org.id}`;
    await tx`insert into admin_events(organization_id,facility_id,actor_id,event_type,target_type,target_id)
      values(${user.organization.id},${facility.id},${user.id},${marker},'facility',${facility.id})`;
    for (const call of Object.values(accounts)) await call('/auth/logout', {});
    return facility.id;
  } finally {
    await app.close();
  }
}
