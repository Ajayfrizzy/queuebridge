import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueAction } from '@queuebridge/contracts';
import {
  assertEventLogIntact,
  assignCoordinator,
  createTestApp,
  failoverCoordinator,
  queueCommand,
  registerDevice,
  setupContinuity,
  snapshot,
  syncBatch,
  tempRef,
  ticketStatus,
  visitorJoin,
  type TestApp,
} from './testing/harness.js';

/**
 * Architecture §16 / ADR-006 acceptance gate (M3 blocker). One end-to-end check per question,
 * against real PostgreSQL. Detailed variants live in coordinator / sync-* test files.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const ticketIdOf = async (queueId: string, code: string): Promise<string> =>
  (
    await t.db<
      { id: string }[]
    >`SELECT id FROM tickets WHERE queue_session_id = ${queueId} AND public_code = ${code}`
  )[0]?.id ?? '';

describe('Q1 — who may advance the queue when the internet disappears?', () => {
  it('only the one device a supervisor designated, with a signed, unexpired authority for that queue', async () => {
    const f = await setupContinuity(t.app);
    const j = await visitorJoin(t.app, f.queueId);
    const g1 = await ticketIdOf(f.queueId, j.body.ticket?.public_code ?? '');
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const token = await f.authorityFor(f.counter);
    const call = (who: typeof f.counter, epoch = 1): Record<string, unknown> =>
      f.cmd(
        who,
        QueueAction.TICKET_CALL_NEXT,
        { counter_id: f.counterIds[0], ticket_id: g1 },
        { epoch },
      );

    // reception, supervisor device and counter without token: refused, nothing applied
    for (const [who, tok] of [
      [f.reception, []],
      [f.supervisor, [token]],
      [f.counter, []],
    ] as const) {
      const r = await syncBatch(who.client, [call(who)], [...tok]);
      expect(r.body.results[0]?.disposition).toBe('rejected');
    }
    // the designated coordinator with its token: committed
    const ok = await syncBatch(f.counter.client, [call(f.counter)], [token]);
    expect(ok.body.results[0]?.disposition).toBe('committed');
    // online advancement by anyone else is blocked while authority exists
    expect(
      (
        await queueCommand(f.supervisor.client, f.queueId, {
          action: 'ticket.serve',
          ticket_id: g1,
        })
      ).status,
    ).toBe(409);
  });
});

describe('Q2 — which progress is local only vs globally confirmed?', () => {
  it('nothing reaches the server or visitors until a committed disposition; visitors only ever see committed state', async () => {
    const f = await setupContinuity(t.app);
    const j = await visitorJoin(t.app, f.queueId);
    const code = j.body.ticket?.public_code ?? '';
    // (An offline call recorded on a device has, by construction, produced no server row yet.)
    const st = await ticketStatus(t.app, code, j.body.ticket?.status_token);
    expect(st.body.status?.['sync_status']).toBe('committed');
    expect(st.body.status?.state).toBe('waiting');
    // every committed state change is a server queue_event behind it (invariant 6)
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const token = await f.authorityFor(f.counter);
    const g1 = await ticketIdOf(f.queueId, code);
    const r = await syncBatch(
      f.counter.client,
      [
        f.cmd(
          f.counter,
          QueueAction.TICKET_CALL_NEXT,
          { counter_id: f.counterIds[0], ticket_id: g1 },
          { epoch: 1 },
        ),
      ],
      [token],
    );
    const seq = r.body.results[0]?.server_sequence;
    const ev =
      await t.db`SELECT 1 FROM queue_events WHERE queue_session_id = ${f.queueId} AND sequence = ${seq ?? -1} AND event_type = 'ticket.call_next'`;
    expect(ev).toHaveLength(1);
    expect((await ticketStatus(t.app, code, j.body.ticket?.status_token)).body.status?.state).toBe(
      'called',
    );
  });
});

describe('Q3 — what happens when two devices or a server disagree?', () => {
  it('the server sequence wins; the other decision is held as needs_review, never applied or merged', async () => {
    const f = await setupContinuity(t.app);
    const j = await visitorJoin(t.app, f.queueId);
    const g1 = await ticketIdOf(f.queueId, j.body.ticket?.public_code ?? '');
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const token = await f.authorityFor(f.counter);
    const base = (await snapshot(f.counter.client, f.queueId, f.counter.deviceId)).body.snapshot
      .revision;
    const offlineCall = f.cmd(
      f.counter,
      QueueAction.TICKET_CALL_NEXT,
      { counter_id: f.counterIds[0], ticket_id: g1 },
      { epoch: 1, baseRevision: base },
    );
    // server-side: supervisor fails over to their own device, which calls g1 at counter 2
    await failoverCoordinator(f.supervisor.client, f.queueId, f.supervisor.deviceId);
    const t2 = await f.authorityFor(f.supervisor);
    const won = await syncBatch(
      f.supervisor.client,
      [
        f.cmd(
          f.supervisor,
          QueueAction.TICKET_CALL_NEXT,
          { counter_id: f.counterIds[1], ticket_id: g1 },
          { epoch: 2 },
        ),
      ],
      [t2],
    );
    expect(won.body.results[0]?.disposition).toBe('committed');
    const lost = await syncBatch(f.counter.client, [offlineCall], [token]);
    expect(lost.body.results[0]).toMatchObject({
      disposition: 'needs_review',
      reason_code: 'stale_epoch',
    });
    expect(
      await t.db`SELECT 1 FROM queue_events WHERE queue_session_id = ${f.queueId} AND event_type = 'ticket.call_next'`,
    ).toHaveLength(1);
    await assertEventLogIntact(t.db, f.queueId);
  });
});

describe('Q4 — can duplicate requests change queue state twice?', () => {
  it('no: the same operation id yields one commit and then duplicates, sequentially and concurrently', async () => {
    const f = await setupContinuity(t.app);
    const c = f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() });
    const all = await Promise.all(
      Array.from({ length: 6 }, () => syncBatch(f.reception.client, [c])),
    );
    const again = await syncBatch(f.reception.client, [c]);
    const d = [...all, again].map((r) => r.body.results[0]?.disposition);
    expect(d.filter((x) => x === 'committed')).toHaveLength(1);
    expect(d.filter((x) => x === 'duplicate')).toHaveLength(6);
    expect(await t.db`SELECT 1 FROM tickets WHERE queue_session_id = ${f.queueId}`).toHaveLength(1);
  });
});

describe('Q5 — what if a coordinator loses its device or storage?', () => {
  it('advancement is suspended until explicit failover; the lost device is fenced; a wiped device starts over with no authority', async () => {
    const f = await setupContinuity(t.app);
    const j = await visitorJoin(t.app, f.queueId);
    const g1 = await ticketIdOf(f.queueId, j.body.ticket?.public_code ?? '');
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const oldToken = await f.authorityFor(f.counter);

    // Lost: nobody else can advance (online fence) until the supervisor acts
    expect(
      (
        await queueCommand(f.supervisor.client, f.queueId, {
          action: 'ticket.call_next',
          counter_id: f.counterIds[1],
        })
      ).status,
    ).toBe(409);

    // Storage wiped on the coordinator: the browser registers as a NEW device, which holds no authority
    const fresh = await registerDevice(f.counter.client, f.fid, 'Same tablet, storage cleared');
    const s = await snapshot(f.counter.client, f.queueId, fresh);
    expect(s.body.snapshot.coordinator.is_this_device).toBe(false);
    expect(s.body.snapshot.authority).toBeNull();

    // Explicit, audited failover to the fresh device
    const fo = await failoverCoordinator(f.supervisor.client, f.queueId, fresh, {
      reason_code: 'device_lost',
    });
    expect(fo.body.coordinator?.epoch).toBe(2);
    const newToken =
      (await snapshot(f.counter.client, f.queueId, fresh)).body.snapshot.authority ?? '';
    const ok = await syncBatch(
      f.counter.client,
      [
        f.cmd(
          { ...f.counter, deviceId: fresh },
          QueueAction.TICKET_CALL_NEXT,
          { counter_id: f.counterIds[0], ticket_id: g1 },
          { epoch: 2 },
        ),
      ],
      [newToken],
    );
    expect(ok.body.results[0]?.disposition).toBe('committed');

    // The old device's leftover work is fenced, not applied
    const stale = await syncBatch(
      f.counter.client,
      [f.cmd(f.counter, QueueAction.TICKET_SERVE, { ticket_id: g1 }, { epoch: 1 })],
      [oldToken],
    );
    expect(stale.body.results[0]?.disposition).toBe('needs_review');
    const types = await assertEventLogIntact(t.db, f.queueId);
    expect(types).toContain('coordinator.failover');
  });
});

describe('Q6 — how can staff recognise and resolve a conflicted operation?', () => {
  it('it is listed with a plain reason for supervisors, resolved explicitly with a reason, audited, and the device learns the outcome', async () => {
    const f = await setupContinuity(t.app);
    await queueCommand(f.supervisor.client, f.queueId, { action: 'queue.pause' });
    const c = f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() });
    expect((await syncBatch(f.reception.client, [c])).body.results[0]?.disposition).toBe(
      'needs_review',
    );

    const list = await f.supervisor.client.get<{
      conflicts: { operation_id: string; message: string }[];
    }>(`/api/v1/facilities/${f.fid}/sync/conflicts`);
    expect(list.body.conflicts[0]?.operation_id).toBe(c['operation_id']);
    expect(list.body.conflicts[0]?.message).toMatch(/paused/);

    await queueCommand(f.supervisor.client, f.queueId, { action: 'queue.open' });
    const res = await f.supervisor.client.post(
      `/api/v1/sync/conflicts/${c['operation_id'] as string}/resolve`,
      { resolution: 'apply', reason_code: 'supervisor_accepted' },
    );
    expect(res.status).toBe(200);
    const replay = await syncBatch(f.reception.client, [c]);
    expect(replay.body.results[0]?.disposition).toBe('duplicate');
    expect(replay.body.results[0]?.public_code).toMatch(/^[A-Z]+\d{3}$/);
    const types = await assertEventLogIntact(t.db, f.queueId);
    expect(types).toEqual(
      expect.arrayContaining(['sync.conflict_detected', 'sync.conflict_resolved', 'ticket.create']),
    );
  });
});
