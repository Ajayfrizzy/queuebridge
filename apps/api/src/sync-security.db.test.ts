import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueAction } from '@queuebridge/contracts';
import {
  assignCoordinator,
  createStaff,
  createTestApp,
  envelope,
  registerDevice,
  setupContinuity,
  signupOrg,
  snapshot,
  staffWithDevice,
  syncBatch,
  tempRef,
  TestClient,
  uuidv7Sync,
  type TestApp,
} from './testing/harness.js';

/**
 * Group 8 — security and access control for the continuity endpoints: authentication, RBAC,
 * tenant isolation, strict input validation and PII hygiene.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('authentication and CSRF', () => {
  it('every continuity endpoint requires a session (401) and the CSRF header on writes', async () => {
    const f = await setupContinuity(t.app);
    const anon = new TestClient(t.app);
    const id = uuidv7Sync();
    const calls: [string, string, unknown?][] = [
      ['POST', '/api/v1/devices', { facility_id: f.fid }],
      ['POST', `/api/v1/devices/${f.reception.deviceId}/heartbeat`, { pending_count: 0 }],
      ['POST', `/api/v1/devices/${f.reception.deviceId}/revoke`, { reason_code: 'lost' }],
      ['POST', '/api/v1/sync/batches', { commands: [{}] }],
      ['GET', `/api/v1/sync/queues/${f.queueId}/snapshot`],
      [
        'POST',
        `/api/v1/queues/${f.queueId}/coordinator`,
        { operation_id: id, device_id: f.counter.deviceId },
      ],
      [
        'POST',
        `/api/v1/queues/${f.queueId}/coordinator/failover`,
        { operation_id: id, device_id: f.counter.deviceId, reason_code: 'other' },
      ],
      [
        'POST',
        `/api/v1/queues/${f.queueId}/coordinator/revoke`,
        { operation_id: id, reason_code: 'other' },
      ],
      ['GET', `/api/v1/facilities/${f.fid}/operations/health`],
      ['GET', `/api/v1/facilities/${f.fid}/sync/conflicts`],
      [
        'POST',
        `/api/v1/sync/conflicts/${id}/resolve`,
        { resolution: 'dismiss', reason_code: 'other' },
      ],
    ];
    for (const [m, url, body] of calls) {
      const res = await anon.request(m as 'GET' | 'POST', url, body);
      expect(res.status, `${m} ${url}`).toBe(401);
    }
    // a signed-in user without the CSRF header is refused before anything is processed
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/sync/batches',
      headers: { origin: 'http://localhost:5173', cookie: f.reception.client.cookie ?? '' },
      payload: { commands: [{}] },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('tenant isolation (cross-tenant is 404 / uniformly refused)', () => {
  it('another organization cannot snapshot, register, revoke, review or sync into this facility', async () => {
    const f = await setupContinuity(t.app);
    const other = await signupOrg(t.app, 'Rival Org');
    const rivalFac = (
      await other.admin.post<{ facility: { id: string } }>('/api/v1/facilities', {
        name: 'Rival',
        slug: `r-${Date.now()}`,
        timezone: 'Africa/Lagos',
      })
    ).body.facility.id;
    const rivalStaff = await createStaff(t.app, other, rivalFac, 'staff_counter');
    const rivalDevice = await registerDevice(rivalStaff.client, rivalFac);

    expect((await snapshot(other.admin, f.queueId)).status).toBe(404);
    expect((await other.admin.post('/api/v1/devices', { facility_id: f.fid })).status).toBe(404);
    expect(
      (
        await other.admin.post(`/api/v1/devices/${f.counter.deviceId}/revoke`, {
          reason_code: 'lost',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await other.admin.post(`/api/v1/devices/${f.counter.deviceId}/heartbeat`, {
          pending_count: 1,
        })
      ).status,
    ).toBe(404);
    expect((await other.admin.get(`/api/v1/facilities/${f.fid}/operations/health`)).status).toBe(
      404,
    );

    // A rival device syncing a command for OUR queue: indistinguishable from a missing queue,
    // and no trace is written into our queue
    const forged = envelope({
      org: other,
      fid: f.fid,
      queueId: f.queueId,
      deviceId: rivalDevice,
      actorId: rivalStaff.userId,
      action: QueueAction.TICKET_CREATE,
      payload: { temporary_ref: tempRef() },
      clientSequence: 1,
    });
    const res = await syncBatch(rivalStaff.client, [forged]);
    expect(res.body.results[0]).toMatchObject({
      disposition: 'rejected',
      reason_code: 'queue_not_found',
    });
    // even with our real organization id in the envelope (the session decides, not the payload)
    const spoof = { ...forged, organization_id: f.org.organizationId, operation_id: uuidv7Sync() };
    expect((await syncBatch(rivalStaff.client, [spoof])).body.results[0]?.reason_code).toBe(
      'queue_not_found',
    );
    expect(
      await t.db`SELECT 1 FROM client_operations WHERE queue_session_id = ${f.queueId}`,
    ).toHaveLength(0);
    expect(await t.db`SELECT 1 FROM tickets WHERE queue_session_id = ${f.queueId}`).toHaveLength(0);
  });

  it('a device belonging to another user, another facility or another tenant is not usable', async () => {
    const f = await setupContinuity(t.app);
    // reception tries to submit commands on the counter's device
    const stolen = f.cmd(f.counter, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() });
    const res = await syncBatch(f.reception.client, [stolen]);
    expect(res.status).toBe(403);
    expect((res.body as { type?: string }).type).toMatch(/device-not-authorized/);
    // unknown device id looks the same
    const ghost = f.cmd(
      f.reception,
      QueueAction.TICKET_CREATE,
      { temporary_ref: tempRef() },
      { deviceId: uuidv7Sync().replace(/^(.{14})7/, '$14') },
    );
    const ghostRes = await syncBatch(f.reception.client, [ghost]);
    expect(ghostRes.status).toBe(403);
    expect((ghostRes.body as { type?: string }).type).toMatch(/device-not-authorized/);
    expect(await t.db`SELECT 1 FROM tickets WHERE queue_session_id = ${f.queueId}`).toHaveLength(0);
  });
});

describe('the session — not the envelope — decides identity', () => {
  it('refuses actions recorded by a different signed-in user instead of re-attributing them', async () => {
    const f = await setupContinuity(t.app);
    const asReception = f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() });
    // the counter user, on the SAME browser/device id, tries to push reception's queued action
    const own = await registerDevice(f.counter.client, f.fid);
    const res = await syncBatch(f.counter.client, [{ ...asReception, device_id: own }]);
    expect(res.body.results[0]).toMatchObject({
      disposition: 'rejected',
      reason_code: 'actor_mismatch',
    });
    expect(await t.db`SELECT 1 FROM tickets WHERE queue_session_id = ${f.queueId}`).toHaveLength(0);
  });

  it('a user with no role at the facility cannot reach its queues; a role is re-checked at sync time', async () => {
    const f = await setupContinuity(t.app);
    // staff of the SAME organization but a different facility
    const fac2 = (
      await f.org.admin.post<{ facility: { id: string } }>('/api/v1/facilities', {
        name: 'Second',
        slug: `s-${Date.now()}`,
        timezone: 'Africa/Lagos',
      })
    ).body.facility.id;
    const outsider = await staffWithDevice(t.app, f.org, fac2, 'staff_counter');
    const cmd = envelope({
      org: f.org,
      fid: f.fid,
      queueId: f.queueId,
      deviceId: outsider.deviceId,
      actorId: outsider.userId,
      action: QueueAction.TICKET_CREATE,
      payload: { temporary_ref: tempRef() },
      clientSequence: 1,
    });
    expect((await syncBatch(outsider.client, [cmd])).body.results[0]?.reason_code).toBe(
      'queue_not_found',
    );
    expect((await snapshot(outsider.client, f.queueId)).status).toBe(404);

    // Authority is not a permanent entitlement: a coordinator who loses the counter role is refused
    const { g1 } = await (async () => {
      const r = await syncBatch(f.reception.client, [
        f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() }),
      ]);
      return { g1: r.body.results[0]?.ticket_id ?? '' };
    })();
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const auth = await f.authorityFor(f.counter);
    const revoked = await f.org.admin.del(
      `/api/v1/facilities/${f.fid}/staff/${f.counter.userId}/roles/staff_counter`,
    );
    expect(revoked.status).toBeLessThan(300);
    const res = await syncBatch(
      f.counter.client,
      [
        f.cmd(
          f.counter,
          QueueAction.TICKET_CALL_NEXT,
          { counter_id: f.counterIds[0], ticket_id: g1 },
          { epoch: 1 },
        ),
      ],
      [auth],
    );
    expect(res.status === 200 ? res.body.results[0]?.disposition : 'denied').not.toBe('committed');
    const [tk] = await t.db<{ state: string }[]>`SELECT state FROM tickets WHERE id = ${g1}`;
    expect(tk?.state).toBe('waiting');
  });
});

describe('input validation', () => {
  it('rejects unknown fields, oversized batches and malformed transport at the boundary', async () => {
    const f = await setupContinuity(t.app);
    const c = f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() });
    expect(
      (await f.reception.client.post('/api/v1/sync/batches', { commands: [c], admin: true }))
        .status,
    ).toBe(400);
    expect((await f.reception.client.post('/api/v1/sync/batches', { commands: [] })).status).toBe(
      400,
    );
    expect(
      (await f.reception.client.post('/api/v1/sync/batches', { commands: Array(101).fill(c) }))
        .status,
    ).toBe(400);
    expect(
      (await f.reception.client.post('/api/v1/sync/batches', { commands: 'nope' })).status,
    ).toBe(400);
    // strict payloads: extra keys in an offline payload are refused, not ignored
    const extra = f.cmd(f.reception, QueueAction.TICKET_CREATE, {
      temporary_ref: tempRef(),
      phone: '+234 800 000 0000',
    });
    expect((await syncBatch(f.reception.client, [extra])).body.results[0]?.reason_code).toBe(
      'invalid_payload',
    );
    // the validation message never echoes submitted values
    const res = await syncBatch(f.reception.client, [
      { ...c, operation_id: 'not-a-uuid', actor_id: '+234 800 000 0000' },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('+234');
    // coordinator / device endpoints are strict too
    expect(
      (
        await f.supervisor.client.post(`/api/v1/queues/${f.queueId}/coordinator`, {
          operation_id: uuidv7Sync(),
          device_id: f.counter.deviceId,
          ttl_minutes: 100000,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.supervisor.client.post(`/api/v1/queues/${f.queueId}/coordinator`, {
          operation_id: uuidv7Sync(),
          device_id: f.counter.deviceId,
          organization_id: f.org.organizationId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.reception.client.post('/api/v1/devices', {
          facility_id: f.fid,
          staff_user_id: f.supervisor.userId,
        })
      ).status,
    ).toBe(400);
  });

  it('caps the number of live devices per user and facility', async () => {
    const f = await setupContinuity(t.app);
    const s = await createStaff(t.app, f.org, f.fid, 'staff_reception');
    for (let i = 0; i < 20; i++) await registerDevice(s.client, f.fid, `d${i}`);
    expect((await s.client.post('/api/v1/devices', { facility_id: f.fid })).status).toBe(409);
  });
});

describe('role-based access to continuity actions', () => {
  it('reception may capture but not advance; auditors are read-only; counters cannot manage devices', async () => {
    const f = await setupContinuity(t.app);
    const cap = await syncBatch(f.reception.client, [
      f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() }),
    ]);
    expect(cap.body.results[0]?.disposition).toBe('committed');
    const adv = await syncBatch(f.reception.client, [
      f.cmd(f.reception, QueueAction.TICKET_CALL_NEXT, { counter_id: f.counterIds[0] }),
    ]);
    expect(adv.body.results[0]?.disposition).toBe('rejected');

    const auditor = await createStaff(t.app, f.org, f.fid, 'auditor');
    expect((await auditor.client.get(`/api/v1/facilities/${f.fid}/operations/health`)).status).toBe(
      200,
    );
    expect((await auditor.client.get(`/api/v1/facilities/${f.fid}/sync/conflicts`)).status).toBe(
      200,
    );
    expect((await auditor.client.post('/api/v1/devices', { facility_id: f.fid })).status).toBe(403);
    expect(
      (
        await auditor.client.post(`/api/v1/devices/${f.counter.deviceId}/revoke`, {
          reason_code: 'lost',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await auditor.client.post(`/api/v1/queues/${f.queueId}/coordinator`, {
          operation_id: uuidv7Sync(),
          device_id: f.counter.deviceId,
        })
      ).status,
    ).toBe(403);
    expect(
      (await f.counter.client.get(`/api/v1/facilities/${f.fid}/operations/health`)).status,
    ).toBe(403);
  });
});

describe('PII hygiene', () => {
  it('stored operations and events contain only ids, codes and enums — no names, emails or phone-like values', async () => {
    const f = await setupContinuity(t.app);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const auth = await f.authorityFor(f.counter);
    const ref = tempRef();
    await syncBatch(
      f.counter.client,
      [
        f.cmd(f.counter, QueueAction.TICKET_CREATE, { temporary_ref: ref }, { epoch: 1 }),
        f.cmd(
          f.counter,
          QueueAction.TICKET_CALL_NEXT,
          { counter_id: f.counterIds[0], ticket_ref: ref },
          { epoch: 1 },
        ),
      ],
      [auth],
    );
    const dump = JSON.stringify([
      await t.db`SELECT payload FROM queue_events WHERE queue_session_id = ${f.queueId}`,
      await t.db`SELECT envelope, result_json FROM client_operations WHERE queue_session_id = ${f.queueId}`,
    ]);
    expect(dump).not.toMatch(/@example\.test/);
    expect(dump).not.toMatch(/Staff (staff_|supervisor)/);
    expect(dump).not.toMatch(/\+\d[\d ]{8,}\d|\b0[789]\d{9}\b/); // international / Nigerian mobile numbers
    expect(dump).not.toMatch(/status_token|password|secret/i);
  });

  it('the authority token carries ids, epoch, actions and expiry only', async () => {
    const f = await setupContinuity(t.app);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const token = await f.authorityFor(f.counter);
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString(),
    ) as Record<string, unknown>;
    expect(Object.keys(claims).sort()).toEqual([
      'allowed_actions',
      'delivered_at',
      'device_id',
      'epoch',
      'expires_at',
      'facility_id',
      'issued_at',
      'issued_by_actor_id',
      'issued_by_role',
      'queue_session_id',
    ]);
  });
});
