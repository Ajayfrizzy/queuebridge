import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QueueAction } from '@queuebridge/contracts';
import {
  assertEventLogIntact,
  assignCoordinator,
  createTestApp,
  failoverCoordinator,
  mintAuthority,
  setupContinuity,
  syncBatch,
  timingFor,
  uuidv7Sync,
  visitorJoin,
  type ContinuityFixture,
  type TestApp,
} from './testing/harness.js';

/**
 * Offline authority TIMING against untrusted device clocks (Groups 3, 5, 6).
 *
 * Each case mints a server-signed authority with a chosen delivery and expiry time (exactly what
 * the snapshot endpoint would have issued at that moment) and submits the timing evidence a
 * device would produce in the scenario. Nothing is mocked: real sync endpoint, real PostgreSQL.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const MIN = 60_000;
/**
 * One clock reading per test. Every minted delivery/expiry time is derived from it, so window
 * lengths are EXACT (two separate Date.now() reads can differ by milliseconds on a slow runner,
 * which would silently move a boundary case to the other side of the boundary). The server's own
 * "now" is later than the anchor only by the test's runtime; every non-boundary case keeps at
 * least a minute of margin from that.
 */
let anchor = Date.now();
beforeEach(() => {
  anchor = Date.now();
});
const ago = (m: number): Date => new Date(anchor - m * MIN);
const ahead = (m: number): Date => new Date(anchor + m * MIN);

interface World {
  f: ContinuityFixture;
  g: string[];
  call: (
    i: number,
    timing: Record<string, unknown> | null,
    over?: Record<string, unknown>,
  ) => Record<string, unknown>;
}

async function world(waiting = 2): Promise<World> {
  const f = await setupContinuity(t.app, { counters: Math.max(2, waiting) });
  const g: string[] = [];
  for (let i = 0; i < waiting; i++) {
    const j = await visitorJoin(t.app, f.queueId);
    const [row] = await t.db<{ id: string }[]>`
      SELECT id FROM tickets WHERE queue_session_id = ${f.queueId} AND public_code = ${j.body.ticket?.public_code ?? ''}`;
    g.push(row?.id ?? '');
  }
  await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
  return {
    f,
    g,
    call: (i, timing, over = {}) =>
      f.cmd(
        f.counter,
        QueueAction.TICKET_CALL_NEXT,
        { counter_id: f.counterIds[i], ticket_id: g[i] },
        { epoch: 1, timing, ...over },
      ),
  };
}

const sync = async (
  w: World,
  cmds: unknown[],
  tokens: string[],
): Promise<{ d: string; r?: string }[]> =>
  (await syncBatch(w.f.counter.client, cmds, tokens)).body.results.map((x) => ({
    d: x.disposition,
    ...(x.reason_code ? { r: x.reason_code } : {}),
  }));

const ticketState = async (id: string): Promise<string | undefined> =>
  (await t.db<{ state: string }[]>`SELECT state FROM tickets WHERE id = ${id}`)[0]?.state;

describe('the reported issue: a device clock set backwards', () => {
  it('created_at_client is ignored — an action timed after expiry is held however early its wall-clock stamp', async () => {
    const w = await world();
    const token = await mintAuthority(t, w.f.queueId, { deliveredAt: ago(30), expiresAt: ago(10) });
    // The device clock was wound back to before expiry: its wall-clock stamp claims "25 min ago",
    // but its monotonic evidence says the action happened 25 min after receipt (= 5 min ago).
    const r = await sync(
      w,
      [
        w.call(0, timingFor(token, { elapsed_ms: 25 * MIN }), {
          createdAtClient: ago(25).toISOString(),
        }),
      ],
      [token],
    );
    expect(r).toEqual([{ d: 'needs_review', r: 'authority_expired' }]);
    expect(await ticketState(w.g[0] ?? '')).toBe('waiting');
  });

  it('a far-future wall-clock stamp does not block an action that the evidence places inside the window', async () => {
    const w = await world();
    const token = await mintAuthority(t, w.f.queueId, { deliveredAt: ago(30), expiresAt: ago(10) });
    const r = await sync(
      w,
      [
        w.call(0, timingFor(token, { elapsed_ms: 5 * MIN }), {
          createdAtClient: '2099-01-01T00:00:00.000Z',
        }),
      ],
      [token],
    );
    expect(r).toEqual([{ d: 'committed' }]);
  });

  it('a device that detected its clock moving backwards is held for review, even inside the window', async () => {
    const w = await world();
    const token = await mintAuthority(t, w.f.queueId, {
      deliveredAt: ago(5),
      expiresAt: ahead(30),
    });
    const r = await sync(
      w,
      [w.call(0, timingFor(token, { elapsed_ms: 2 * MIN, rollback_detected: true }))],
      [token],
    );
    expect(r).toEqual([{ d: 'needs_review', r: 'clock_rollback' }]);
    expect(await ticketState(w.g[0] ?? '')).toBe('waiting');
  });

  it('elapsed time that goes backwards between two actions of the same authority is held', async () => {
    const w = await world();
    const token = await mintAuthority(t, w.f.queueId, {
      deliveredAt: ago(20),
      expiresAt: ahead(30),
    });
    const r = await sync(
      w,
      [
        w.call(0, timingFor(token, { elapsed_ms: 15 * MIN })),
        w.call(1, timingFor(token, { elapsed_ms: 3 * MIN })), // later in client_sequence, "earlier" in time
      ],
      [token],
    );
    expect(r).toEqual([
      { d: 'committed' },
      { d: 'needs_review', r: 'authority_timing_unverifiable' },
    ]);
  });
});

describe('delayed synchronization (valid offline work is preserved)', () => {
  it('monotonic evidence inside the window commits even when the sync arrives long after expiry', async () => {
    const w = await world(2);
    const token = await mintAuthority(t, w.f.queueId, {
      deliveredAt: ago(240),
      expiresAt: ago(120),
    });
    const r = await sync(
      w,
      [
        w.call(0, timingFor(token, { elapsed_ms: 60 * MIN })),
        w.call(1, timingFor(token, { elapsed_ms: 119 * MIN })),
      ],
      [token],
    );
    expect(r).toEqual([{ d: 'committed' }, { d: 'committed' }]);
    await assertEventLogIntact(t.db, w.f.queueId);
  });

  it('the action at the exact expiry instant, or after it, is held', async () => {
    const w = await world(2);
    const token = await mintAuthority(t, w.f.queueId, { deliveredAt: ago(60), expiresAt: ago(30) });
    // exactly 30 min between delivery and expiry (same anchor), so +30 min IS the expiry instant
    expect(ago(30).getTime() - ago(60).getTime()).toBe(30 * MIN);
    const r = await sync(
      w,
      [
        w.call(0, timingFor(token, { elapsed_ms: 30 * MIN })),
        w.call(1, timingFor(token, { elapsed_ms: 45 * MIN })),
      ],
      [token],
    );
    expect(r).toEqual([
      { d: 'needs_review', r: 'authority_expired' },
      { d: 'needs_review', r: 'authority_expired' },
    ]);
  });

  it('a device whose wall clock jumped forward is conservative: it is treated as later, never earlier', async () => {
    const w = await world();
    const token = await mintAuthority(t, w.f.queueId, { deliveredAt: ago(40), expiresAt: ago(10) });
    // monotonic floor 20 min (inside), wall clock says 35 min (outside): the larger estimate is used
    const r = await sync(
      w,
      [w.call(0, timingFor(token, { floor_ms: 20 * MIN, elapsed_ms: 35 * MIN }))],
      [token],
    );
    expect(r).toEqual([{ d: 'needs_review', r: 'authority_expired' }]);
  });
});

describe('restarts (reload / browser restart while offline)', () => {
  it('a restarted device commits when the server receives the action before expiry (provable)', async () => {
    const w = await world();
    const token = await mintAuthority(t, w.f.queueId, {
      deliveredAt: ago(20),
      expiresAt: ahead(10),
    });
    const r = await sync(
      w,
      [
        w.call(
          0,
          timingFor(token, { floor_ms: 5 * MIN, elapsed_ms: 18 * MIN, source: 'restarted' }),
        ),
      ],
      [token],
    );
    expect(r).toEqual([{ d: 'committed' }]);
  });

  it('a restarted device syncing after expiry is held: the closed-app gap is only wall-clock evidence', async () => {
    const w = await world();
    const token = await mintAuthority(t, w.f.queueId, { deliveredAt: ago(60), expiresAt: ago(10) });
    // Evidence claims inside the window — but it could be a wound-back wall clock during the restart
    const r = await sync(
      w,
      [
        w.call(
          0,
          timingFor(token, { floor_ms: 10 * MIN, elapsed_ms: 30 * MIN, source: 'restarted' }),
        ),
      ],
      [token],
    );
    expect(r).toEqual([{ d: 'needs_review', r: 'authority_timing_unverifiable' }]);
    expect(await ticketState(w.g[0] ?? '')).toBe('waiting');
  });

  it('when even the persisted lower bound is past expiry, it is plainly expired', async () => {
    const w = await world();
    const token = await mintAuthority(t, w.f.queueId, { deliveredAt: ago(60), expiresAt: ago(30) });
    const r = await sync(
      w,
      [
        w.call(
          0,
          timingFor(token, { floor_ms: 40 * MIN, elapsed_ms: 40 * MIN, source: 'restarted' }),
        ),
      ],
      [token],
    );
    expect(r).toEqual([{ d: 'needs_review', r: 'authority_expired' }]);
  });
});

describe('unverifiable or forged evidence', () => {
  it('no evidence at all → held (never committed on the strength of the token alone)', async () => {
    const w = await world();
    const token = await mintAuthority(t, w.f.queueId, {
      deliveredAt: ago(1),
      expiresAt: ahead(30),
    });
    expect(await sync(w, [w.call(0, null)], [token])).toEqual([
      { d: 'needs_review', r: 'authority_timing_unverifiable' },
    ]);
  });

  it('evidence relative to a token that was not presented → held', async () => {
    const w = await world();
    const presented = await mintAuthority(t, w.f.queueId, {
      deliveredAt: ago(1),
      expiresAt: ahead(30),
    });
    const other = await mintAuthority(t, w.f.queueId, {
      deliveredAt: ago(2),
      expiresAt: ahead(30),
      alsoSetSessionExpiry: false,
    });
    expect(await sync(w, [w.call(0, timingFor(other, { elapsed_ms: MIN }))], [presented])).toEqual([
      { d: 'needs_review', r: 'authority_timing_unverifiable' },
    ]);
  });

  it('a forged delivered_at in the evidence cannot shift the timeline (it must match a signed token)', async () => {
    const w = await world();
    const token = await mintAuthority(t, w.f.queueId, { deliveredAt: ago(60), expiresAt: ago(10) });
    const forged = {
      ...timingFor(token, { elapsed_ms: MIN }),
      delivered_at: new Date().toISOString(),
    };
    expect(await sync(w, [w.call(0, forged)], [token])).toEqual([
      { d: 'needs_review', r: 'authority_timing_unverifiable' },
    ]);
  });

  it('an action claiming a time later than the server’s own clock → held', async () => {
    const w = await world();
    const token = await mintAuthority(t, w.f.queueId, {
      deliveredAt: ago(1),
      expiresAt: ahead(120),
    });
    expect(await sync(w, [w.call(0, timingFor(token, { elapsed_ms: 30 * MIN }))], [token])).toEqual(
      [{ d: 'needs_review', r: 'authority_timing_unverifiable' }],
    );
  });

  it('a lower bound greater than the estimate is inconsistent → held', async () => {
    const w = await world();
    const token = await mintAuthority(t, w.f.queueId, {
      deliveredAt: ago(10),
      expiresAt: ahead(30),
    });
    expect(
      await sync(
        w,
        [w.call(0, timingFor(token, { floor_ms: 5 * MIN, elapsed_ms: 2 * MIN }))],
        [token],
      ),
    ).toEqual([{ d: 'needs_review', r: 'authority_timing_unverifiable' }]);
  });

  it('malformed evidence is rejected at validation, not trusted', async () => {
    const w = await world();
    const token = await mintAuthority(t, w.f.queueId, {
      deliveredAt: ago(1),
      expiresAt: ahead(30),
    });
    const bad = w.call(0, { ...timingFor(token), elapsed_ms: -5 });
    const r = await sync(w, [bad], [token]);
    expect(r).toEqual([{ d: 'rejected', r: 'invalid_command' }]);
  });
});

describe('interaction with renewal and failover', () => {
  it('renewal while the device was offline does not retro-extend what the device was told', async () => {
    const w = await world();
    // Device holds a token expiring 10 min ago; the supervisor later renewed the session to +60 min
    const token = await mintAuthority(t, w.f.queueId, {
      deliveredAt: ago(40),
      expiresAt: ago(10),
      alsoSetSessionExpiry: false,
    });
    await t.db`UPDATE queue_sessions SET coordinator_expires_at = ${ahead(60)} WHERE id = ${w.f.queueId}`;
    expect(await sync(w, [w.call(0, timingFor(token, { elapsed_ms: 35 * MIN }))], [token])).toEqual(
      [{ d: 'needs_review', r: 'authority_expired' }],
    );
  });

  it('a supervisor shortening authority is honoured for actions after the new expiry', async () => {
    const w = await world();
    const token = await mintAuthority(t, w.f.queueId, {
      deliveredAt: ago(40),
      expiresAt: ahead(60),
      alsoSetSessionExpiry: false,
    });
    await t.db`UPDATE queue_sessions SET coordinator_expires_at = ${ago(20)} WHERE id = ${w.f.queueId}`;
    expect(await sync(w, [w.call(0, timingFor(token, { elapsed_ms: 30 * MIN }))], [token])).toEqual(
      [{ d: 'needs_review', r: 'authority_expired' }],
    );
  });

  it('failover fences first: perfect timing from the replaced coordinator is still stale_epoch', async () => {
    const w = await world();
    const old = await mintAuthority(t, w.f.queueId, { deliveredAt: ago(5), expiresAt: ahead(60) });
    await failoverCoordinator(w.f.supervisor.client, w.f.queueId, w.f.supervisor.deviceId);
    expect(await sync(w, [w.call(0, timingFor(old, { elapsed_ms: MIN }))], [old])).toEqual([
      { d: 'needs_review', r: 'stale_epoch' },
    ]);
  });

  it('a supervisor can still apply a timing-held action deliberately, and the device then sees it as synced', async () => {
    const w = await world();
    const token = await mintAuthority(t, w.f.queueId, { deliveredAt: ago(60), expiresAt: ago(10) });
    const c = w.call(
      0,
      timingFor(token, { floor_ms: 10 * MIN, elapsed_ms: 30 * MIN, source: 'restarted' }),
    );
    expect(await sync(w, [c], [token])).toEqual([
      { d: 'needs_review', r: 'authority_timing_unverifiable' },
    ]);
    // Coordinator authority must be ended before an online decision is made about advancement
    await w.f.supervisor.client.post(`/api/v1/queues/${w.f.queueId}/coordinator/revoke`, {
      operation_id: uuidv7Sync(),
      reason_code: 'outage_over',
    });
    const res = await w.f.supervisor.client.post(
      `/api/v1/sync/conflicts/${c['operation_id'] as string}/resolve`,
      { resolution: 'apply', reason_code: 'supervisor_accepted' },
    );
    expect(res.status).toBe(200);
    expect(await ticketState(w.g[0] ?? '')).toBe('called');
    expect(await sync(w, [c], [token])).toEqual([{ d: 'duplicate' }]);
    await assertEventLogIntact(t.db, w.f.queueId);
  });
});
