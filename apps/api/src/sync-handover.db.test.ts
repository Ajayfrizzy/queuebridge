import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { QueueAction } from '@queuebridge/contracts';
import { buildApp } from './app.js';
import { createDb, type Db } from './db.js';
import {
  createFacility,
  queueCommand,
  registerDevice,
  setupContinuity,
  signupOrg,
  staffWithDevice,
  syncBatch,
  tempRef,
  testEnv,
  ticketStatus,
  type ContinuityFixture,
} from './testing/harness.js';

/**
 * Offline capture → confirmed ticket → one-time visitor status credential.
 * Runs with TRACE logging into a captured stream so we can prove credentials never reach logs.
 */

let app: FastifyInstance;
let db: Db;
const logs: string[] = [];
beforeAll(async () => {
  const env = testEnv({ LOG_LEVEL: 'trace' });
  db = createDb(env);
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      logs.push(chunk.toString());
      cb();
    },
  });
  app = await buildApp(env, { db, logStream: stream });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.end({ timeout: 5 });
});

const valid = async (code: string, token: string | undefined): Promise<boolean> =>
  (await ticketStatus(app, code, token)).status === 200;

async function everywhereElse(f: ContinuityFixture, token: string): Promise<string> {
  return JSON.stringify([
    await db`SELECT envelope, result_json FROM client_operations WHERE queue_session_id = ${f.queueId}`,
    await db`SELECT payload FROM queue_events WHERE queue_session_id = ${f.queueId}`,
    await db`SELECT details FROM admin_events WHERE organization_id = ${f.org.organizationId}`,
    await db`SELECT credential_hash FROM ticket_recovery_credentials`,
    (await f.org.admin.get(`/api/v1/public/facilities/${f.org.slug}/${f.facilitySlug}/board`)).body,
    (await f.org.admin.get(`/api/v1/queues/${f.queueId}`)).body,
    (await f.org.admin.get(`/api/v1/facilities/${f.fid}/sync/conflicts?include=all`)).body,
    logs.join(''),
  ]).includes(token)
    ? 'LEAKED'
    : 'clean';
}

describe('successful sync', () => {
  it('returns a working status credential for the CONFIRMED code only, once, and nowhere else', async () => {
    const f = await setupContinuity(app);
    const ref = tempRef();
    const res = await syncBatch(f.reception.client, [
      f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: ref }),
    ]);
    const r = res.body.results[0];
    expect(r?.disposition).toBe('committed');
    expect(r?.public_code).toMatch(/^[A-Z]{1,3}\d{3}$/);
    expect(r?.status_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await valid(r?.public_code ?? '', r?.status_token)).toBe(true);
    // the temporary reference is never a valid ticket address
    expect(await valid(ref, r?.status_token)).toBe(false);
    expect(await everywhereElse(f, r?.status_token ?? 'x')).toBe('clean');
  });

  it('advancement results never carry a credential', async () => {
    const f = await setupContinuity(app);
    const res = await syncBatch(f.reception.client, [
      f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() }),
      f.cmd(f.reception, QueueAction.TICKET_CALL_NEXT, { counter_id: f.counterIds[0] }),
    ]);
    expect(res.body.results[1]?.status_token).toBeUndefined();
  });
});

describe('lost acknowledgement and duplicate retries', () => {
  it('a retry after a lost response returns duplicate with a NEW credential; the unseen one stops working', async () => {
    const f = await setupContinuity(app);
    const c = f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() });
    const lost = (await syncBatch(f.reception.client, [c])).body.results[0]; // response "never arrived"
    const retry = (await syncBatch(f.reception.client, [c])).body.results[0];
    expect(retry?.disposition).toBe('duplicate');
    expect(retry?.public_code).toBe(lost?.public_code);
    expect(retry?.status_token).not.toBe(lost?.status_token);
    expect(await valid(retry?.public_code ?? '', retry?.status_token)).toBe(true);
    expect(await valid(lost?.public_code ?? '', lost?.status_token)).toBe(false);
    expect(await db`SELECT 1 FROM tickets WHERE queue_session_id = ${f.queueId}`).toHaveLength(1);
    expect(await everywhereElse(f, retry?.status_token ?? 'x')).toBe('clean');
  });

  it('concurrent duplicate retries: one ticket, and exactly one credential remains valid', async () => {
    const f = await setupContinuity(app);
    const c = f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() });
    await syncBatch(f.reception.client, [c]);
    const many = await Promise.all(
      Array.from({ length: 6 }, () => syncBatch(f.reception.client, [c])),
    );
    const results = many.map((m) => m.body.results[0]);
    expect(results.every((r) => r?.disposition === 'duplicate')).toBe(true);
    const code = results[0]?.public_code ?? '';
    const validity = await Promise.all(results.map((r) => valid(code, r?.status_token)));
    expect(validity.filter(Boolean)).toHaveLength(1);
    expect(
      await db`SELECT 1 FROM ticket_recovery_credentials rc JOIN tickets t ON t.id = rc.ticket_id WHERE t.queue_session_id = ${f.queueId}`,
    ).toHaveLength(1);
  });
});

describe('who can obtain a credential', () => {
  it('only the capturing user on the capturing device; others get no credential and change nothing', async () => {
    const f = await setupContinuity(app);
    const c = f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() });
    const first = (await syncBatch(f.reception.client, [c])).body.results[0];

    // the same person, a different (own) device
    const second = await registerDevice(f.reception.client, f.fid, 'Second phone');
    const otherDev = (await syncBatch(f.reception.client, [{ ...c, device_id: second }])).body
      .results[0];
    expect(otherDev).toMatchObject({ disposition: 'rejected', reason_code: 'operation_id_reused' });
    expect(otherDev?.status_token).toBeUndefined();

    // another staff member (even a supervisor) replaying the operation id on their own device
    const sup = (
      await syncBatch(f.supervisor.client, [
        { ...c, device_id: f.supervisor.deviceId, actor_id: f.supervisor.userId },
      ])
    ).body.results[0];
    expect(sup?.status_token).toBeUndefined();
    expect(sup?.disposition).toBe('rejected');

    // another tenant
    const rival = await signupOrg(app, 'Rival');
    const rf = (await createFacility(rival, 'Rival Clinic')).id;
    const rs = await staffWithDevice(app, rival, rf, 'staff_reception');
    const cross = (
      await syncBatch(rs.client, [
        {
          ...c,
          device_id: rs.deviceId,
          actor_id: rs.userId,
          organization_id: rival.organizationId,
        },
      ])
    ).body.results[0];
    expect(cross?.status_token).toBeUndefined();

    // none of that rotated the visitor's credential
    expect(await valid(first?.public_code ?? '', first?.status_token)).toBe(true);
  });

  it('a held capture yields no credential; after a supervisor applies it, the capturing device gets one on replay', async () => {
    const f = await setupContinuity(app);
    await queueCommand(f.supervisor.client, f.queueId, { action: 'queue.pause' });
    const c = f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() });
    const held = (await syncBatch(f.reception.client, [c])).body.results[0];
    expect(held?.disposition).toBe('needs_review');
    expect(held?.status_token).toBeUndefined();
    expect(held?.public_code).toBeUndefined(); // no code is presented for an unconfirmed ticket
    await queueCommand(f.supervisor.client, f.queueId, { action: 'queue.open' });
    const applied = await f.supervisor.client.post<Record<string, unknown>>(
      `/api/v1/sync/conflicts/${c['operation_id'] as string}/resolve`,
      { resolution: 'apply', reason_code: 'supervisor_accepted' },
    );
    expect(JSON.stringify(applied.body)).not.toMatch(/status_token/); // supervisor never sees it
    const replay = (await syncBatch(f.reception.client, [c])).body.results[0];
    expect(replay?.disposition).toBe('duplicate');
    expect(await valid(replay?.public_code ?? '', replay?.status_token)).toBe(true);
    expect(await everywhereElse(f, replay?.status_token ?? 'x')).toBe('clean');
  });
});
