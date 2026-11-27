import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './db.js';
import { assistLockKey } from './recovery/service.js';
import {
  TEST_ORIGIN,
  createStaff,
  createTestApp,
  queueCommand,
  setupQueue,
  visitorJoin,
  type QueueFixture,
  type TestApp,
  type TestClient,
} from './testing/harness.js';

/**
 * M5 hardening (security follow-up to M5.1; recorded separately from M5.3 device health).
 *
 * The per-staff limit on staff-assisted recovery (5 grants per staff member per 10 minutes) must
 * hold under concurrent requests, not only sequentially. Real PostgreSQL, real HTTP requests,
 * separate pooled connections; nothing is mocked.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

async function tickets(q: QueueFixture, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const j = await visitorJoin(t.app, q.queueId);
    const code = j.body.ticket?.public_code ?? '';
    const [row] = await t.db<{ id: string }[]>`
      SELECT id FROM tickets WHERE queue_session_id = ${q.queueId} AND public_code = ${code}`;
    ids.push(row?.id ?? '');
  }
  return ids;
}

const assist = (
  c: TestClient,
  q: QueueFixture,
  ticketId: string,
): Promise<{ status: number; body: Record<string, unknown> }> =>
  c.post(`/api/v1/queues/${q.queueId}/tickets/${ticketId}/recovery/assist`, {
    reason_code: 'lost_device',
    account_matches: true,
    asked_before_revealing: true,
  });

const grantsBy = async (staffUserId: string): Promise<number> =>
  (
    await t.db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM ticket_recovery_grants WHERE created_by = ${staffUserId}`
  )[0]?.n ?? -1;

/**
 * Run `lock` in a transaction on its OWN connection and keep it open until released. Resolves
 * `ready` with that backend's pid only once the lock is actually held, so tests never infer it
 * from global lock tables (other suites running in parallel hold similar locks).
 */
function holdLock(lock: (tx: Db) => Promise<unknown>): {
  ready: Promise<number>;
  release: () => void;
  done: Promise<unknown>;
  end: () => Promise<void>;
} {
  const conn = createDb(t.env);
  let release: () => void = () => undefined;
  const released = new Promise<void>((r) => (release = r));
  let signal: (pid: number) => void = () => undefined;
  const ready = new Promise<number>((r) => (signal = r));
  const done = conn.begin(async (tx) => {
    const [me] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await lock(tx);
    signal(me?.pid ?? 0);
    await released;
  });
  return { ready, release, done, end: () => conn.end({ timeout: 5 }) };
}

/** True once some backend is waiting on a lock held by `holderPid` (and only by that). */
const blockedBy = async (holderPid: number): Promise<boolean> =>
  (
    await t.db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM pg_stat_activity
       WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))`
  )[0]!.n > 0;

describe('per-staff assisted-recovery limit is atomic under concurrency', () => {
  it('20 simultaneous requests by ONE staff member for 20 different tickets: exactly 5 succeed', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const ids = await tickets(q, 20);
    const results = await Promise.all(ids.map((id) => assist(counter.client, q, id)));
    const ok = results.filter((r) => r.status === 200 && r.body['outcome'] === 'approval_required');
    const limited = results.filter((r) => r.status === 429);
    expect(ok).toHaveLength(5);
    expect(limited).toHaveLength(15);
    expect(results.every((r) => r.status === 200 || r.status === 429)).toBe(true);
    for (const r of limited) expect(r.body['type']).toMatch(/staff-recovery-limit/);
    expect(await grantsBy(counter.userId)).toBe(5);
  });

  it('repeated bursts never exceed the limit (5 rounds of 12 parallel requests, fresh staff each round)', async () => {
    for (let round = 0; round < 5; round++) {
      const q = await setupQueue(t.app, { counters: 1 });
      const staff = await createStaff(t.app, q.org, q.fid, 'staff_reception');
      const ids = await tickets(q, 12);
      const results = await Promise.all(ids.map((id) => assist(staff.client, q, id)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(5);
      expect(await grantsBy(staff.userId)).toBe(5);
    }
  });

  it('different staff members are not blocked by one another', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const a = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const b = await createStaff(t.app, q.org, q.fid, 'staff_reception');
    const [ta, tb] = await tickets(q, 2);
    // Another connection holds staff A's lock, as if one of A's requests were mid-transaction
    const h = holdLock(
      (tx) =>
        tx`SELECT pg_advisory_xact_lock(${assistLockKey(q.org.organizationId, a.userId)}::bigint)`,
    );
    try {
      const holderPid = await h.ready;
      const pendingA = assist(a.client, q, ta ?? '');
      let aSettled = false;
      void pendingA.then(() => (aSettled = true));
      // A is genuinely waiting on THIS holder (not merely slow)
      await expect.poll(() => blockedBy(holderPid)).toBe(true);
      // B is a different person: completes while A's lock is held
      const rb = await assist(b.client, q, tb ?? '');
      expect(rb.status).toBe(200);
      expect(aSettled).toBe(false);
      h.release();
      await h.done;
      const ra = await pendingA;
      expect(ra.status).toBe(200);
    } finally {
      h.release();
      await h.done.catch(() => undefined);
      await h.end();
    }
  });

  it('a request that cannot get its lock in time fails safely as retryable 503, creating nothing', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const a = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const [ta] = await tickets(q, 1);
    const h = holdLock(
      (tx) =>
        tx`SELECT pg_advisory_xact_lock(${assistLockKey(q.org.organizationId, a.userId)}::bigint)`,
    );
    try {
      await h.ready;
      const r = await assist(a.client, q, ta ?? '');
      expect(r.status).toBe(503);
      expect(r.body['retryable']).toBe(true);
      expect(await grantsBy(a.userId)).toBe(0);
    } finally {
      h.release();
      await h.done.catch(() => undefined);
      await h.end();
    }
  });

  it('the lock key is tenant-scoped: the same staff id in another organization is a different key', () => {
    const staff = '0193a1b2-0000-7000-8000-000000000001';
    const orgA = '0193a1b2-0000-7000-8000-00000000000a';
    const orgB = '0193a1b2-0000-7000-8000-00000000000b';
    expect(assistLockKey(orgA, staff)).not.toBe(assistLockKey(orgB, staff));
    expect(assistLockKey(orgA, staff)).toBe(assistLockKey(orgA, staff));
    expect(BigInt(assistLockKey(orgA, staff))).toBeLessThanOrEqual(2n ** 63n - 1n);
  });

  it('the per-ticket limit (3 per hour) stays exact under concurrency', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const staff = await Promise.all(
      Array.from({ length: 6 }, () => createStaff(t.app, q.org, q.fid, 'staff_counter')),
    );
    const [only] = await tickets(q, 1);
    const results = await Promise.all(staff.map((s) => assist(s.client, q, only ?? '')));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    const [n] = await t.db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM ticket_recovery_grants WHERE ticket_id = ${only ?? ''}`;
    expect(n?.n).toBe(3);
    // (the queue itself was never touched)
    const r = await queueCommand(q.org.admin, q.queueId, { action: 'queue.pause' });
    expect(r.status).toBe(200);
  });
});

describe('lock order: grant redemption and staff revoke-all never deadlock', () => {
  it('deterministic: while redemption waits for the ticket lock it holds NO lock on the grant row', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
    const sup = await createStaff(t.app, q.org, q.fid, 'supervisor');
    const [ticketId] = await tickets(q, 1);
    const base = `/api/v1/queues/${q.queueId}/tickets/${ticketId}/recovery`;
    const a = await counter.client.post<{ grant: string; request_id: string }>(`${base}/assist`, {
      reason_code: 'lost_device',
      account_matches: true,
      asked_before_revealing: true,
    });
    await sup.client.post(`${base}/approve`, { request_id: a.body.request_id });
    // Hold the ticket's proof row, as staff revoke-all does first
    const h = holdLock(
      (tx) =>
        tx`SELECT 1 FROM ticket_recovery_proofs WHERE ticket_id = ${ticketId ?? ''} FOR UPDATE`,
    );
    const probe = createDb(t.env);
    try {
      const holderPid = await h.ready;
      const redeem = t.app.inject({
        method: 'POST',
        url: '/api/v1/tickets/recover',
        headers: { origin: TEST_ORIGIN, 'x-qb-csrf': '1' },
        payload: { grant: a.body.grant },
        remoteAddress: `10.78.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
      });
      // the redemption is now waiting for the ticket lock held by THIS holder
      await expect.poll(() => blockedBy(holderPid)).toBe(true);
      // revoke-all's NEXT step (locking the ticket's grants) must not be blocked by it
      const grantFree = await probe.begin(async (tx) => {
        try {
          await tx`SELECT 1 FROM ticket_recovery_grants WHERE id = ${a.body.request_id} FOR UPDATE NOWAIT`;
          return true;
        } catch {
          return false;
        }
      });
      expect(grantFree).toBe(true);
      h.release();
      await h.done;
      expect((await redeem).statusCode).toBe(200);
    } finally {
      h.release();
      await h.done.catch(() => undefined);
      await h.end();
      await probe.end({ timeout: 5 });
    }
  });

  it('25 rounds of a simultaneous redemption and revoke-all on one ticket: no server error, one consistent outcome', async () => {
    for (let i = 0; i < 25; i++) {
      const q = await setupQueue(t.app, { counters: 1 });
      const counter = await createStaff(t.app, q.org, q.fid, 'staff_counter');
      const sup = await createStaff(t.app, q.org, q.fid, 'supervisor');
      const [ticketId] = await tickets(q, 1);
      const base = `/api/v1/queues/${q.queueId}/tickets/${ticketId}/recovery`;
      const a = await counter.client.post<{ grant: string; request_id: string }>(`${base}/assist`, {
        reason_code: 'lost_device',
        account_matches: true,
        asked_before_revealing: true,
      });
      expect(
        (await sup.client.post(`${base}/approve`, { request_id: a.body.request_id })).status,
      ).toBe(200);
      const [redeem, revoke] = await Promise.all([
        t.app.inject({
          method: 'POST',
          url: '/api/v1/tickets/recover',
          headers: { origin: TEST_ORIGIN, 'x-qb-csrf': '1' },
          payload: { grant: a.body.grant },
          remoteAddress: `10.77.${i}.1`,
        }),
        sup.client.post<{ revoked_tokens: number }>(`${base}/revoke-all`, {
          reason_code: 'lost_device',
        }),
      ]);
      // Before the fix a PostgreSQL deadlock surfaced as a 500 in about 1 round in 12
      expect([200, 404]).toContain(redeem.statusCode);
      expect(revoke.status).toBe(200);
      // Either order is legitimate, and the end state is the same: no live token for the ticket
      const [live] = await t.db<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM ticket_recovery_credentials
         WHERE ticket_id = ${ticketId ?? ''} AND revoked_at IS NULL`;
      if (redeem.statusCode === 200) {
        // redeemed first, then revoke-all ended it
        expect(revoke.body.revoked_tokens).toBeGreaterThanOrEqual(1);
      }
      expect(live?.n).toBe(0);
    }
  });
});
