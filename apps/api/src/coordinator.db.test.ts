import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueAction } from '@queuebridge/contracts';
import {
  assertEventLogIntact,
  assignCoordinator,
  createTestApp,
  failoverCoordinator,
  mintAuthority,
  queueCommand,
  revokeCoordinator,
  setupContinuity,
  signupOrg,
  snapshot,
  staffWithDevice,
  syncBatch,
  tempRef,
  timingFor,
  TestClient,
  visitorJoin,
  uuidv7Sync,
  type ContinuityFixture,
  type TestApp,
} from './testing/harness.js';

/**
 * Groups 3, 6 and the architecture acceptance gate: coordinator authority, fencing, partition
 * outcomes, revocation and supervisor failover — against real PostgreSQL.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const expireCoordinator = async (queueId: string): Promise<void> => {
  await t.db`UPDATE queue_sessions SET coordinator_expires_at = NOW() - interval '1 minute' WHERE id = ${queueId}`;
};

async function ticketId(queueId: string, code: string): Promise<string> {
  const rows = await t.db<{ id: string }[]>`
    SELECT id FROM tickets WHERE queue_session_id = ${queueId} AND public_code = ${code}`;
  if (!rows[0]) throw new Error(`ticket ${code} not found`);
  return rows[0].id;
}

/** Two visitors waiting online (G001, G002). Returns their ids. */
async function twoWaiting(f: ContinuityFixture): Promise<{ g1: string; g2: string }> {
  const a = await visitorJoin(t.app, f.queueId);
  const b = await visitorJoin(t.app, f.queueId);
  return {
    g1: await ticketId(f.queueId, a.body.ticket?.public_code ?? ''),
    g2: await ticketId(f.queueId, b.body.ticket?.public_code ?? ''),
  };
}

describe('who may designate a coordinator (REQ-F1.3, F1.4)', () => {
  it('only a supervisor / facility admin; others get 403, other tenants get 404', async () => {
    const f = await setupContinuity(t.app);
    const other = await signupOrg(t.app, 'Other Org');
    const url = `/api/v1/queues/${f.queueId}/coordinator`;
    const body = { operation_id: uuidv7Sync(), device_id: f.counter.deviceId };
    expect((await f.counter.client.post(url, body)).status).toBe(403);
    expect((await f.reception.client.post(url, body)).status).toBe(403);
    expect((await other.admin.post(url, body)).status).toBe(404);
    expect((await new TestClient(t.app).post(url, body)).status).toBe(401);
    const ok = await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    expect(ok.status).toBe(200);
    expect(ok.body.coordinator?.epoch).toBe(1);
    expect(ok.body.coordinator?.status).toBe('active');
  });

  it('refuses a second coordinator, an unqualified owner, a revoked or foreign device, a closed queue', async () => {
    const f = await setupContinuity(t.app);
    const a = await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    expect(a.status).toBe(200);
    const second = await assignCoordinator(f.supervisor.client, f.queueId, f.supervisor.deviceId);
    expect(second.status).toBe(409); // exactly one coordinator per queue

    const g = await setupContinuity(t.app);
    // reception cannot call visitors → cannot coordinate
    expect(
      (await assignCoordinator(g.supervisor.client, g.queueId, g.reception.deviceId)).status,
    ).toBe(409);
    // a device from another facility/tenant looks like a missing device
    expect(
      (await assignCoordinator(g.supervisor.client, g.queueId, f.counter.deviceId)).status,
    ).toBe(404);
    // revoked device
    await g.supervisor.client.post(`/api/v1/devices/${g.counter.deviceId}/revoke`, {
      reason_code: 'lost',
    });
    expect(
      (await assignCoordinator(g.supervisor.client, g.queueId, g.counter.deviceId)).status,
    ).toBe(409);
    // closed queue
    const h = await setupContinuity(t.app);
    await queueCommand(h.org.admin, h.queueId, { action: 'queue.close' });
    expect(
      (await assignCoordinator(h.supervisor.client, h.queueId, h.counter.deviceId)).status,
    ).toBe(409);
  });

  it('assignment, failover, renewal and revocation are hash-chained events naming the supervisor', async () => {
    const f = await setupContinuity(t.app);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    await failoverCoordinator(f.supervisor.client, f.queueId, f.supervisor.deviceId);
    await f.supervisor.client.post(`/api/v1/queues/${f.queueId}/coordinator/renew`, {
      operation_id: uuidv7Sync(),
      ttl_minutes: 60,
    });
    await revokeCoordinator(f.supervisor.client, f.queueId);
    const types = await assertEventLogIntact(t.db, f.queueId);
    expect(types.filter((x) => x.startsWith('coordinator.'))).toEqual([
      'coordinator.assign',
      'coordinator.failover',
      'coordinator.renew',
      'coordinator.revoke',
    ]);
    const evs = await t.db<
      { event_type: string; actor_id: string; payload: Record<string, unknown> }[]
    >`
      SELECT event_type, actor_id, payload FROM queue_events
       WHERE queue_session_id = ${f.queueId} AND event_type LIKE 'coordinator.%' ORDER BY sequence`;
    expect(evs.every((e) => e.actor_id === f.supervisor.userId)).toBe(true);
    expect(evs.map((e) => e.payload['epoch'])).toEqual([1, 2, 2, 3]);
    expect(evs[1]?.payload['reason_code']).toBe('device_lost');
    const [s] = await t.db<{ coordinator_epoch: number; coordinator_device_id: string | null }[]>`
      SELECT coordinator_epoch, coordinator_device_id FROM queue_sessions WHERE id = ${f.queueId}`;
    expect(s).toEqual({ coordinator_epoch: 3, coordinator_device_id: null });
  });

  it('assignment is idempotent by operation id; reusing it for another action conflicts', async () => {
    const f = await setupContinuity(t.app);
    const op = uuidv7Sync();
    const url = `/api/v1/queues/${f.queueId}/coordinator`;
    const a = await f.supervisor.client.post<{ disposition: string }>(url, {
      operation_id: op,
      device_id: f.counter.deviceId,
    });
    const b = await f.supervisor.client.post<{ disposition: string }>(url, {
      operation_id: op,
      device_id: f.counter.deviceId,
    });
    expect(a.body.disposition).toBe('committed');
    expect(b.body.disposition).toBe('duplicate');
    const [s] = await t.db<
      { coordinator_epoch: number }[]
    >`SELECT coordinator_epoch FROM queue_sessions WHERE id = ${f.queueId}`;
    expect(s?.coordinator_epoch).toBe(1);
    const c = await f.supervisor.client.post(`${url}/revoke`, {
      operation_id: op,
      reason_code: 'outage_over',
    });
    expect(c.status).toBe(409);
  });

  it('coordinator actions cannot be performed offline: a coordinator cannot reassign itself', async () => {
    const f = await setupContinuity(t.app);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const auth = await f.authorityFor(f.counter);
    for (const action of [
      QueueAction.COORDINATOR_ASSIGN,
      QueueAction.COORDINATOR_FAILOVER,
      QueueAction.COORDINATOR_REVOKE,
      QueueAction.TICKET_PRIORITY_OVERRIDE,
    ]) {
      const res = await syncBatch(
        f.counter.client,
        [f.cmd(f.counter, action, {}, { epoch: 1 })],
        [auth],
      );
      expect(res.body.results[0]?.disposition, action).toBe('rejected');
      expect(res.body.results[0]?.reason_code, action).toBe('action_not_offline');
    }
    const [s] = await t.db<
      { coordinator_epoch: number }[]
    >`SELECT coordinator_epoch FROM queue_sessions WHERE id = ${f.queueId}`;
    expect(s?.coordinator_epoch).toBe(1);
  });

  it('the database refuses to move an epoch backwards', async () => {
    const f = await setupContinuity(t.app);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    await expect(
      t.db`UPDATE queue_sessions SET coordinator_epoch = 0 WHERE id = ${f.queueId}`,
    ).rejects.toThrow(/must never decrease/);
  });
});

describe('offline advancement by the designated coordinator', () => {
  it('commits calls, serving and completion in order, attributed to the epoch', async () => {
    const f = await setupContinuity(t.app);
    const { g1 } = await twoWaiting(f);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const auth = await f.authorityFor(f.counter);
    const snap = await snapshot(f.counter.client, f.queueId, f.counter.deviceId);
    const base = snap.body.snapshot.revision;
    const res = await syncBatch(
      f.counter.client,
      [
        f.cmd(
          f.counter,
          QueueAction.TICKET_CALL_NEXT,
          { counter_id: f.counterIds[0], ticket_id: g1 },
          { epoch: 1, baseRevision: base },
        ),
        f.cmd(
          f.counter,
          QueueAction.TICKET_SERVE,
          { ticket_id: g1 },
          { epoch: 1, baseRevision: base },
        ),
        f.cmd(
          f.counter,
          QueueAction.TICKET_COMPLETE,
          { ticket_id: g1 },
          { epoch: 1, baseRevision: base },
        ),
      ],
      [auth],
    );
    expect(res.body.results.map((r) => r.disposition)).toEqual([
      'committed',
      'committed',
      'committed',
    ]);
    await assertEventLogIntact(t.db, f.queueId);
  });

  it('only the signed, current authority works: no token, tampered token, wrong device, disallowed action', async () => {
    const f = await setupContinuity(t.app);
    const { g1 } = await twoWaiting(f);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId, {
      allowed_actions: ['ticket.call_next'],
    });
    const auth = await f.authorityFor(f.counter);
    const call = (over = {}): Record<string, unknown> =>
      f.cmd(
        f.counter,
        QueueAction.TICKET_CALL_NEXT,
        { counter_id: f.counterIds[0], ticket_id: g1 },
        { epoch: 1, ...over },
      );

    // no token
    expect((await syncBatch(f.counter.client, [call()])).body.results[0]?.reason_code).toBe(
      'authority_token_missing',
    );
    // tampered token (payload edited, signature kept)
    const [v, p, s] = auth.split('.') as [string, string, string];
    const forged = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
    forged['allowed_actions'] = [
      'ticket.call_next',
      'ticket.complete',
      'ticket.serve',
      'ticket.miss',
    ];
    const tampered = `${v}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${s}`;
    expect(
      (await syncBatch(f.counter.client, [call()], [tampered])).body.results[0]?.reason_code,
    ).toBe('authority_token_missing');
    // garbage
    expect(
      (await syncBatch(f.counter.client, [call()], ['x.y.z'])).body.results[0]?.reason_code,
    ).toBe('authority_token_missing');
    // a token for another device does not authorize this one
    await revokeCoordinator(f.supervisor.client, f.queueId);
    await assignCoordinator(f.supervisor.client, f.queueId, f.supervisor.deviceId);
    const supAuth = await f.authorityFor(f.supervisor);
    expect(
      (await syncBatch(f.counter.client, [call({ epoch: 3 })], [supAuth])).body.results[0]
        ?.reason_code,
    ).toBe('authority_token_missing');
    // an action outside the grant
    await revokeCoordinator(f.supervisor.client, f.queueId);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId, {
      allowed_actions: ['ticket.call_next'],
    });
    const narrow = await f.authorityFor(f.counter);
    const serve = f.cmd(f.counter, QueueAction.TICKET_SERVE, { ticket_id: g1 }, { epoch: 5 });
    expect(
      (await syncBatch(f.counter.client, [serve], [narrow])).body.results[0]?.reason_code,
    ).toBe('action_not_allowed');
    // nothing above changed the queue
    const [row] = await t.db<{ state: string }[]>`SELECT state FROM tickets WHERE id = ${g1}`;
    expect(row?.state).toBe('waiting');
  });

  it('a non-coordinator device cannot advance even with a genuine token for the right epoch', async () => {
    const f = await setupContinuity(t.app);
    const { g1 } = await twoWaiting(f);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const auth = await f.authorityFor(f.counter);
    // supervisor's own device, claiming epoch 1 and presenting the counter's token
    const res = await syncBatch(
      f.supervisor.client,
      [
        f.cmd(
          f.supervisor,
          QueueAction.TICKET_CALL_NEXT,
          { counter_id: f.counterIds[0], ticket_id: g1 },
          { epoch: 1 },
        ),
      ],
      [auth],
    );
    expect(res.body.results[0]?.disposition).toBe('rejected');
    expect(res.body.results[0]?.reason_code).toBe('authority_token_missing');
  });

  it('renewal extends expiry within the same epoch; the earlier token stays valid', async () => {
    const f = await setupContinuity(t.app);
    await twoWaiting(f);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId, { ttl_minutes: 5 });
    const before = await snapshot(f.counter.client, f.queueId, f.counter.deviceId);
    const r = await f.supervisor.client.post<{
      coordinator: { epoch: number; expires_at: string };
    }>(`/api/v1/queues/${f.queueId}/coordinator/renew`, {
      operation_id: uuidv7Sync(),
      ttl_minutes: 120,
    });
    expect(r.body.coordinator.epoch).toBe(1);
    const after = await snapshot(f.counter.client, f.queueId, f.counter.deviceId);
    expect(Date.parse(after.body.snapshot.coordinator.expires_at ?? '')).toBeGreaterThan(
      Date.parse(before.body.snapshot.coordinator.expires_at ?? ''),
    );
    expect(after.body.snapshot.coordinator.epoch).toBe(1);
  });
});

describe('expired authority (REQ-F1.9)', () => {
  it('an action timed before expiry commits even when synced late; one timed after expiry is held', async () => {
    const f = await setupContinuity(t.app);
    const { g1, g2 } = await twoWaiting(f);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const min = 60_000;
    // Authority delivered 10 min ago, expired 1 min ago; the device syncs only now
    const token = await mintAuthority(t, f.queueId, {
      deliveredAt: new Date(Date.now() - 10 * min),
      expiresAt: new Date(Date.now() - 1 * min),
    });
    const res = await syncBatch(
      f.counter.client,
      [
        f.cmd(
          f.counter,
          QueueAction.TICKET_CALL_NEXT,
          { counter_id: f.counterIds[0], ticket_id: g1 },
          { epoch: 1, timing: timingFor(token, { elapsed_ms: 5 * min }) },
        ),
        f.cmd(
          f.counter,
          QueueAction.TICKET_CALL_NEXT,
          { counter_id: f.counterIds[1], ticket_id: g2 },
          { epoch: 1, timing: timingFor(token, { elapsed_ms: 9.5 * min }) },
        ),
      ],
      [token],
    );
    expect(res.body.results[0]?.disposition).toBe('committed');
    expect(res.body.results[1]).toMatchObject({
      disposition: 'needs_review',
      reason_code: 'authority_expired',
    });
    const [row] = await t.db<{ state: string }[]>`SELECT state FROM tickets WHERE id = ${g2}`;
    expect(row?.state).toBe('waiting');
    // an expired authority is not delivered to the device again
    const snap = await snapshot(f.counter.client, f.queueId, f.counter.deviceId);
    expect(snap.body.snapshot.coordinator.status).toBe('expired');
    expect(snap.body.snapshot.authority).toBeNull();
  });
});

describe('server-side coordinator fence (online advancement)', () => {
  it('blocks online advancement while a coordinator is designated, then allows it after revocation', async () => {
    const f = await setupContinuity(t.app);
    await twoWaiting(f);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const blocked = await queueCommand(f.counter.client, f.queueId, {
      action: 'ticket.call_next',
      counter_id: f.counterIds[0],
    });
    expect(blocked.status).toBe(409);
    expect((blocked.body as { type?: string }).type).toMatch(/coordinator-active/);
    // the block is not a recorded disposition: nothing was consumed
    expect(
      await t.db`SELECT 1 FROM client_operations WHERE queue_session_id = ${f.queueId} AND action = 'ticket.call_next'`,
    ).toHaveLength(0);
    // visitors can still join; reception can still register walk-ins; queue controls still work
    expect((await visitorJoin(t.app, f.queueId)).status).toBe(201);
    expect(
      (await queueCommand(f.supervisor.client, f.queueId, { action: 'queue.pause' })).status,
    ).toBe(200);
    await queueCommand(f.supervisor.client, f.queueId, { action: 'queue.open' });

    await revokeCoordinator(f.supervisor.client, f.queueId);
    const ok = await queueCommand(f.counter.client, f.queueId, {
      action: 'ticket.call_next',
      counter_id: f.counterIds[0],
    });
    expect(ok.status).toBe(200);
    await assertEventLogIntact(t.db, f.queueId);
  });

  it('the fence also holds after the authority expires — until a supervisor acts', async () => {
    const f = await setupContinuity(t.app);
    await twoWaiting(f);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    await expireCoordinator(f.queueId);
    const blocked = await queueCommand(f.supervisor.client, f.queueId, {
      action: 'ticket.call_next',
      counter_id: f.counterIds[0],
    });
    expect(blocked.status).toBe(409);
  });
});

describe('partition simulation: two independent Call Next operations (ADR-006/007)', () => {
  // For both arrival orders, exactly one of the two competing calls commits.
  for (const order of ['stale-first', 'current-first'] as const) {
    it(`failover during an outage — ${order}: only the current epoch's call commits; the other is held, not applied`, async () => {
      const f = await setupContinuity(t.app);
      const { g1 } = await twoWaiting(f);
      await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
      const tokenD1 = await f.authorityFor(f.counter);
      const base1 = (await snapshot(f.counter.client, f.queueId, f.counter.deviceId)).body.snapshot
        .revision;

      // Partition: D1 (epoch 1) calls g1 at counter 1 locally and keeps the command in its outbox.
      const callD1 = f.cmd(
        f.counter,
        QueueAction.TICKET_CALL_NEXT,
        { counter_id: f.counterIds[0], ticket_id: g1 },
        { epoch: 1, baseRevision: base1 },
      );

      // Supervisor cannot reach D1: explicit failover to D2 (epoch 2).
      expect(
        (await failoverCoordinator(f.supervisor.client, f.queueId, f.supervisor.deviceId)).status,
      ).toBe(200);
      const tokenD2 = await f.authorityFor(f.supervisor);
      const base2 = (await snapshot(f.supervisor.client, f.queueId, f.supervisor.deviceId)).body
        .snapshot.revision;
      const callD2 = f.cmd(
        f.supervisor,
        QueueAction.TICKET_CALL_NEXT,
        { counter_id: f.counterIds[1], ticket_id: g1 },
        { epoch: 2, baseRevision: base2 },
      );

      const syncD1 = (): ReturnType<typeof syncBatch> =>
        syncBatch(f.counter.client, [callD1], [tokenD1]);
      const syncD2 = (): ReturnType<typeof syncBatch> =>
        syncBatch(f.supervisor.client, [callD2], [tokenD2]);
      const [r1, r2] =
        order === 'stale-first'
          ? [await syncD1(), await syncD2()]
          : [await syncD2(), await syncD1()];
      const d1 = order === 'stale-first' ? r1 : r2;
      const d2 = order === 'stale-first' ? r2 : r1;

      expect(d2.body.results[0]?.disposition).toBe('committed');
      expect(d1.body.results[0]?.disposition).toBe('needs_review');
      expect(d1.body.results[0]?.reason_code).toBe('stale_epoch');

      const calls = await t.db<{ payload: Record<string, unknown> }[]>`
        SELECT payload FROM queue_events WHERE queue_session_id = ${f.queueId} AND event_type = 'ticket.call_next'`;
      expect(calls).toHaveLength(1); // never two calls for the same ticket
      expect(calls[0]?.payload['counter_id']).toBe(f.counterIds[1]);
      expect(calls[0]?.payload['coordinator_epoch']).toBe(2);
      const [tk] = await t.db<
        { state: string; current_counter_id: string }[]
      >`SELECT state, current_counter_id FROM tickets WHERE id = ${g1}`;
      expect(tk).toEqual({ state: 'called', current_counter_id: f.counterIds[1] });

      // the conflict is visible, audited, and replays stably
      const types = await assertEventLogIntact(t.db, f.queueId);
      expect(types).toContain('sync.conflict_detected');
      const replay = await syncBatch(f.counter.client, [callD1], [tokenD1]);
      expect(replay.body.results[0]?.disposition).toBe('needs_review');
      const conflicts = await f.supervisor.client.get<{
        conflicts: { operation_id: string; reason_code: string; status: string }[];
      }>(`/api/v1/facilities/${f.fid}/sync/conflicts`);
      expect(
        conflicts.body.conflicts.map((c) => [c.operation_id, c.reason_code, c.status]),
      ).toEqual([[callD1['operation_id'], 'stale_epoch', 'needs_review']]);
    });
  }

  it('both coordinators syncing at the same instant: exactly one commits, the log stays gap-free', async () => {
    for (let round = 0; round < 3; round++) {
      const f = await setupContinuity(t.app);
      const { g1 } = await twoWaiting(f);
      await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
      const tokenD1 = await f.authorityFor(f.counter);
      const base = (await snapshot(f.counter.client, f.queueId, f.counter.deviceId)).body.snapshot
        .revision;
      const callD1 = f.cmd(
        f.counter,
        QueueAction.TICKET_CALL_NEXT,
        { counter_id: f.counterIds[0], ticket_id: g1 },
        { epoch: 1, baseRevision: base },
      );
      await failoverCoordinator(f.supervisor.client, f.queueId, f.supervisor.deviceId);
      const tokenD2 = await f.authorityFor(f.supervisor);
      const callD2 = f.cmd(
        f.supervisor,
        QueueAction.TICKET_CALL_NEXT,
        { counter_id: f.counterIds[1], ticket_id: g1 },
        { epoch: 2, baseRevision: base + 1 },
      );
      const [a, b] = await Promise.all([
        syncBatch(f.counter.client, [callD1], [tokenD1]),
        syncBatch(f.supervisor.client, [callD2], [tokenD2]),
      ]);
      const committed = [a, b].filter((r) => r.body.results[0]?.disposition === 'committed');
      expect(committed).toHaveLength(1);
      expect(
        await t.db`SELECT 1 FROM queue_events WHERE queue_session_id = ${f.queueId} AND event_type = 'ticket.call_next'`,
      ).toHaveLength(1);
      await assertEventLogIntact(t.db, f.queueId);
    }
  });

  it('a lost coordinator suspends offline advancement; an unrelated device cannot take over', async () => {
    const f = await setupContinuity(t.app);
    await twoWaiting(f);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    await revokeCoordinator(f.supervisor.client, f.queueId, 'device_lost');
    // nobody holds authority: the old token is fenced and no new token exists
    const snapSup = await snapshot(f.supervisor.client, f.queueId, f.supervisor.deviceId);
    expect(snapSup.body.snapshot.coordinator.status).toBe('none');
    expect(snapSup.body.snapshot.authority).toBeNull();
  });
});

describe('reconnecting with a revoked device', () => {
  it('is refused with a clear error; revocation strips coordinator authority and is audited', async () => {
    const f = await setupContinuity(t.app);
    const { g1 } = await twoWaiting(f);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const auth = await f.authorityFor(f.counter);
    const pending = f.cmd(
      f.counter,
      QueueAction.TICKET_CALL_NEXT,
      { counter_id: f.counterIds[0], ticket_id: g1 },
      { epoch: 1 },
    );

    // Only supervisors / admins may revoke
    expect(
      (
        await f.counter.client.post(`/api/v1/devices/${f.counter.deviceId}/revoke`, {
          reason_code: 'lost',
        })
      ).status,
    ).toBe(403);
    const rev = await f.supervisor.client.post<{ device: { revoked_at: string } }>(
      `/api/v1/devices/${f.counter.deviceId}/revoke`,
      { reason_code: 'stolen' },
    );
    expect(rev.status).toBe(200);
    expect(rev.body.device.revoked_at).toBeTruthy();
    // idempotent
    expect(
      (
        await f.supervisor.client.post(`/api/v1/devices/${f.counter.deviceId}/revoke`, {
          reason_code: 'stolen',
        })
      ).status,
    ).toBe(200);

    const res = await syncBatch(f.counter.client, [pending], [auth]);
    expect(res.status).toBe(403);
    expect((res.body as { type?: string }).type).toMatch(/device-revoked/);
    const [tk] = await t.db<{ state: string }[]>`SELECT state FROM tickets WHERE id = ${g1}`;
    expect(tk?.state).toBe('waiting');
    expect((await snapshot(f.counter.client, f.queueId, f.counter.deviceId)).status).toBe(403);

    const [s] = await t.db<{ coordinator_epoch: number; coordinator_device_id: string | null }[]>`
      SELECT coordinator_epoch, coordinator_device_id FROM queue_sessions WHERE id = ${f.queueId}`;
    expect(s).toEqual({ coordinator_epoch: 2, coordinator_device_id: null });
    const types = await assertEventLogIntact(t.db, f.queueId);
    expect(types.filter((x) => x === 'coordinator.revoke')).toHaveLength(1);
    const audit =
      await t.db`SELECT 1 FROM admin_events WHERE event_type = 'device.revoke' AND target_id = ${f.counter.deviceId}`;
    expect(audit).toHaveLength(1);
  });
});

describe('queue session closed during an outage (ADR-007)', () => {
  it('holds a captured ticket for review instead of silently placing it; a supervisor can apply it after reopening', async () => {
    const f = await setupContinuity(t.app);
    const ref = tempRef();
    const captured = f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: ref });
    // the supervisor closes the (empty) queue while the reception device is offline
    expect(
      (await queueCommand(f.supervisor.client, f.queueId, { action: 'queue.close' })).status,
    ).toBe(200);

    const res = await syncBatch(f.reception.client, [captured]);
    expect(res.body.results[0]?.disposition).toBe('needs_review');
    expect(res.body.results[0]?.reason_code).toBe('queue_closed');
    expect(await t.db`SELECT 1 FROM tickets WHERE queue_session_id = ${f.queueId}`).toHaveLength(0);

    // still cannot be applied while closed
    const opId = captured['operation_id'] as string;
    const early = await f.supervisor.client.post(`/api/v1/sync/conflicts/${opId}/resolve`, {
      resolution: 'apply',
      reason_code: 'supervisor_accepted',
    });
    expect(early.status).toBe(409);
    expect(await t.db`SELECT 1 FROM tickets WHERE queue_session_id = ${f.queueId}`).toHaveLength(0);

    await queueCommand(f.supervisor.client, f.queueId, { action: 'queue.open' });
    const ok = await f.supervisor.client.post<{
      result: { resolution: string; already_resolved: boolean };
    }>(`/api/v1/sync/conflicts/${opId}/resolve`, {
      resolution: 'apply',
      reason_code: 'supervisor_accepted',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.result).toMatchObject({ resolution: 'applied', already_resolved: false });
    const tk = await t.db<
      { public_code: string; created_by: string }[]
    >`SELECT public_code, created_by FROM tickets WHERE queue_session_id = ${f.queueId}`;
    expect(tk).toHaveLength(1);
    expect(tk[0]?.created_by).toBe(f.reception.userId); // attributed to the original capturer

    // The device later learns the outcome by replaying the same operation: now a duplicate of a committed one
    const replay = await syncBatch(f.reception.client, [captured]);
    expect(replay.body.results[0]?.disposition).toBe('duplicate');
    expect(replay.body.results[0]?.public_code).toBe(tk[0]?.public_code);
    await assertEventLogIntact(t.db, f.queueId);
  });
});

describe('supervisor conflict review', () => {
  async function conflicted(): Promise<{ f: ContinuityFixture; opId: string }> {
    const f = await setupContinuity(t.app);
    await queueCommand(f.supervisor.client, f.queueId, { action: 'queue.pause' });
    const c = f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() });
    const r = await syncBatch(f.reception.client, [c]);
    expect(r.body.results[0]?.reason_code).toBe('queue_paused');
    return { f, opId: c['operation_id'] as string };
  }

  it('dismiss: becomes rejected, names who and why, is audited, and cannot be flipped', async () => {
    const { f, opId } = await conflicted();
    const url = `/api/v1/sync/conflicts/${opId}/resolve`;
    const body = { resolution: 'dismiss', reason_code: 'visitor_left' };
    expect((await f.supervisor.client.post(url, body)).status).toBe(200);
    const again = await f.supervisor.client.post<{ result: { already_resolved: boolean } }>(
      url,
      body,
    );
    expect(again.body.result.already_resolved).toBe(true);
    expect(
      (
        await f.supervisor.client.post(url, {
          resolution: 'apply',
          reason_code: 'supervisor_accepted',
        })
      ).status,
    ).toBe(409);

    const [op] = await t.db<
      { status: string; resolution: string; resolved_by: string; resolution_reason_code: string }[]
    >`
      SELECT status, resolution, resolved_by, resolution_reason_code FROM client_operations WHERE operation_id = ${opId}`;
    expect(op).toEqual({
      status: 'rejected',
      resolution: 'dismissed',
      resolved_by: f.supervisor.userId,
      resolution_reason_code: 'visitor_left',
    });
    expect(await t.db`SELECT 1 FROM tickets WHERE queue_session_id = ${f.queueId}`).toHaveLength(0);
    // The device learns the outcome by replaying its original command: refused, stably
    const original = (
      await t.db<{ envelope: Record<string, unknown> }[]>`
      SELECT envelope FROM client_operations WHERE operation_id = ${opId}`
    )[0]?.envelope;
    const replay = await syncBatch(f.reception.client, [original]);
    expect(replay.body.results[0]).toMatchObject({
      disposition: 'rejected',
      reason_code: 'dismissed_by_supervisor',
    });
    const types = await assertEventLogIntact(t.db, f.queueId);
    expect(types).toContain('sync.conflict_resolved');
  });

  it('only supervisors/admins may resolve; auditors may view; other tenants see nothing', async () => {
    const { f, opId } = await conflicted();
    const url = `/api/v1/sync/conflicts/${opId}/resolve`;
    const body = { resolution: 'dismiss', reason_code: 'other' };
    expect((await f.counter.client.post(url, body)).status).toBe(403);
    expect((await f.reception.client.post(url, body)).status).toBe(403);
    const auditor = await staffWithDevice(t.app, f.org, f.fid, 'auditor').catch(() => null);
    expect(auditor).toBeNull(); // auditors cannot even register a device (read-only role)
    const other = await signupOrg(t.app, 'Other');
    expect((await other.admin.post(url, body)).status).toBe(404);
    expect((await other.admin.get(`/api/v1/facilities/${f.fid}/sync/conflicts`)).status).toBe(404);
    expect((await new TestClient(t.app).post(url, body)).status).toBe(401);
    // unchanged
    const [op] = await t.db<
      { status: string }[]
    >`SELECT status FROM client_operations WHERE operation_id = ${opId}`;
    expect(op?.status).toBe('needs_review');
  });

  it('lists open conflicts with context and, on request, resolved/refused ones', async () => {
    const { f, opId } = await conflicted();
    const open = await f.supervisor.client.get<{ conflicts: Record<string, unknown>[] }>(
      `/api/v1/facilities/${f.fid}/sync/conflicts`,
    );
    expect(open.body.conflicts).toHaveLength(1);
    expect(open.body.conflicts[0]).toMatchObject({
      operation_id: opId,
      action: 'ticket.create',
      reason_code: 'queue_paused',
      status: 'needs_review',
      device_label: 'Reception phone',
    });
    await f.supervisor.client.post(`/api/v1/sync/conflicts/${opId}/resolve`, {
      resolution: 'dismiss',
      reason_code: 'other',
    });
    expect(
      (
        await f.supervisor.client.get<{ conflicts: unknown[] }>(
          `/api/v1/facilities/${f.fid}/sync/conflicts`,
        )
      ).body.conflicts,
    ).toHaveLength(0);
    const all = await f.supervisor.client.get<{ conflicts: { resolution: string }[] }>(
      `/api/v1/facilities/${f.fid}/sync/conflicts?include=all`,
    );
    expect(all.body.conflicts[0]?.resolution).toBe('dismissed');
  });
});

describe('snapshots and the connectivity dashboard (F9)', () => {
  it('delivers signed authority only to the active coordinator device, with events after a cursor', async () => {
    const f = await setupContinuity(t.app);
    await twoWaiting(f);
    const none = await snapshot(f.counter.client, f.queueId, f.counter.deviceId, 0);
    expect(none.body.snapshot.authority).toBeNull();
    expect(none.body.snapshot.events.length).toBeGreaterThan(0);
    expect(none.body.snapshot.events[0]?.sequence).toBe(1);

    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const mine = await snapshot(
      f.counter.client,
      f.queueId,
      f.counter.deviceId,
      none.body.snapshot.last_sequence,
    );
    expect(mine.body.snapshot.authority).toMatch(/^v1\./);
    expect(mine.body.snapshot.coordinator.is_this_device).toBe(true);
    expect(mine.body.snapshot.events.map((e) => e.event_type)).toEqual(['coordinator.assign']);
    const theirs = await snapshot(f.supervisor.client, f.queueId, f.supervisor.deviceId);
    expect(theirs.body.snapshot.authority).toBeNull();
    expect(theirs.body.snapshot.coordinator.is_this_device).toBe(false);
    // a device belonging to someone else is refused
    expect((await snapshot(f.supervisor.client, f.queueId, f.counter.deviceId)).status).toBe(403);
    // cursor recorded
    const cur = await t.db<{ last_server_sequence: number }[]>`
      SELECT last_server_sequence FROM device_sync_cursors WHERE device_id = ${f.counter.deviceId}`;
    expect(cur[0]?.last_server_sequence).toBe(mine.body.snapshot.last_sequence);
  });

  it('reports each device’s last contact, pending count, sync health and coordinator status', async () => {
    const f = await setupContinuity(t.app);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    await f.reception.client.post(`/api/v1/devices/${f.reception.deviceId}/heartbeat`, {
      pending_count: 3,
    });
    const h = await f.supervisor.client.get<{
      health: {
        devices: {
          id: string;
          health: string;
          pending_count: number;
          coordinator_for: unknown[];
          last_seen_at: string | null;
        }[];
        queues: { coordinator: { status: string } }[];
      };
    }>(`/api/v1/facilities/${f.fid}/operations/health`);
    expect(h.status).toBe(200);
    const byId = Object.fromEntries(h.body.health.devices.map((d) => [d.id, d]));
    expect(byId[f.reception.deviceId]).toMatchObject({ health: 'pending', pending_count: 3 });
    expect(byId[f.counter.deviceId]?.coordinator_for).toHaveLength(1);
    expect(h.body.health.queues[0]?.coordinator.status).toBe('active');
    // devices not heard from are shown offline after 120 s (M3) and, since M5.3 (REQ-F9.6),
    // stale after 900 s
    const stateAfter = async (silence: string): Promise<string | undefined> => {
      await t.db`UPDATE devices SET last_seen_at = NOW() - ${silence}::interval WHERE id = ${f.reception.deviceId}`;
      const r = await f.supervisor.client.get<{
        health: { devices: { id: string; health: string }[] };
      }>(`/api/v1/facilities/${f.fid}/operations/health`);
      return r.body.health.devices.find((d) => d.id === f.reception.deviceId)?.health;
    };
    expect(await stateAfter('5 minutes')).toBe('offline');
    expect(await stateAfter('1 hour')).toBe('stale');
    // staff without supervisor rights cannot see device health
    expect(
      (await f.counter.client.get(`/api/v1/facilities/${f.fid}/operations/health`)).status,
    ).toBe(403);
  });
});
