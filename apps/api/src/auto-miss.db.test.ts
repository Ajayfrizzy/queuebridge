import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QueueAction, SystemActor, TicketState, uuidv7 } from '@queuebridge/contracts';
import { createDb, type Db } from './db.js';
import { ApiProblem } from './errors.js';
import { autoMissOperationId, runAutoMissSweep, type SweepResult } from './queue/auto-miss.js';
import { executeSystemTransition } from './queue/commands.js';
import {
  assertEventLogIntact,
  assignCoordinator,
  createTestApp,
  queueCommand,
  revokeCoordinator,
  setupContinuity,
  setupQueue,
  snapshot,
  syncBatch,
  ticketStatus,
  visitorJoin,
  type QueueFixture,
  type TestApp,
} from './testing/harness.js';

/**
 * M5.1 automatic no-show on real PostgreSQL (testing steering 8.R9 and 8.R12; REQ-F4.14;
 * design §15.8; ADR-015). The sweep is called directly (the in-process timer is disabled in
 * tests) with `testClockOffsetSeconds`, because queue events are append-only and a call cannot be
 * backdated: the sweep's "now" moves forward instead. Nothing else is simulated.
 */

let t: TestApp;
const silent = { warn: (): void => undefined, info: (): void => undefined };
/** A long interval: a single test never looks like an outage unless it sets one up. */
const sweep = (
  offset: number,
  extra: { intervalSeconds?: number; db?: Db } = {},
): Promise<SweepResult> =>
  runAutoMissSweep(extra.db ?? t.db, silent, {
    intervalSeconds: extra.intervalSeconds ?? 3600,
    batchSize: 1000,
    testClockOffsetSeconds: offset,
  });

const enabledServices: string[] = [];
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  // A healthy sweeper history: the previous pass was just now and no outage is on record
  await t.db`
    INSERT INTO auto_miss_sweeps (id, last_pass_at, outage_end_at) VALUES (TRUE, NOW(), NULL)
    ON CONFLICT (id) DO UPDATE SET last_pass_at = NOW(), outage_end_at = NULL`;
});
afterEach(async () => {
  // Never leave a service with the feature on: later sweeps (with large offsets) scan every queue
  for (const id of enabledServices.splice(0)) {
    await t.db`UPDATE services SET policy = jsonb_set(policy, '{auto_miss}', '{"enabled": false}') WHERE id = ${id}`;
  }
});

async function enable(q: QueueFixture, afterSeconds = 120): Promise<void> {
  const r = await q.org.admin.patch(`/api/v1/facilities/${q.fid}/services/${q.serviceId}`, {
    policy: { auto_miss: { enabled: true, after_seconds: afterSeconds } },
  });
  expect(r.status).toBe(200);
  enabledServices.push(q.serviceId);
}

interface Called {
  ticketId: string;
  code: string;
  token: string;
  callSequence: number;
}
/** Join and call the ticket at the first counter that is not already busy with a call. */
async function calledTicket(q: QueueFixture, client = q.org.admin): Promise<Called> {
  const j = await visitorJoin(t.app, q.queueId);
  const code = j.body.ticket?.public_code ?? '';
  const [busy] = await t.db<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM tickets
     WHERE queue_session_id = ${q.queueId} AND state IN ('called', 'serving')`;
  const c = await queueCommand(client, q.queueId, {
    action: 'ticket.call_next',
    counter_id: q.counterIds[busy?.n ?? 0],
  });
  expect(c.body.outcome?.disposition).toBe('committed');
  const [row] = await t.db<{ id: string }[]>`
    SELECT id FROM tickets WHERE queue_session_id = ${q.queueId} AND public_code = ${code}`;
  return {
    ticketId: row?.id ?? '',
    code,
    token: j.body.ticket?.status_token ?? '',
    callSequence: c.body.outcome?.server_sequence ?? 0,
  };
}
const stateOf = async (ticketId: string): Promise<string | undefined> =>
  (await t.db<{ state: string }[]>`SELECT state FROM tickets WHERE id = ${ticketId}`)[0]?.state;
interface MissEvent {
  actor_id: string | null;
  operation_id: string;
  payload: Record<string, unknown>;
}
const missEvents = (queueId: string): Promise<MissEvent[]> =>
  t.db<MissEvent[]>`
    SELECT actor_id, operation_id, payload FROM queue_events
     WHERE queue_session_id = ${queueId} AND event_type = 'ticket.miss' ORDER BY sequence`;

// ---------------------------------------------------------------------------
// 8.R9 — semantics
// ---------------------------------------------------------------------------

describe('8.R9 automatic no-show semantics', () => {
  it('is disabled by default: a called ticket is never missed by the sweep', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await calledTicket(q);
    const [s] = await t.db<{ policy: { auto_miss: unknown } }[]>`
      SELECT policy FROM services WHERE id = ${q.serviceId}`;
    expect(s?.policy.auto_miss).toEqual({ enabled: false });
    await sweep(86_400);
    expect(await stateOf(v.ticketId)).toBe('called');
    expect(await missEvents(q.queueId)).toHaveLength(0);
  });

  it('enabling requires explicit seconds within 60–3600', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const url = `/api/v1/facilities/${q.fid}/services/${q.serviceId}`;
    for (const auto_miss of [
      { enabled: true },
      { enabled: true, after_seconds: 59 },
      { enabled: true, after_seconds: 3601 },
      { enabled: true, after_seconds: 90.5 },
    ]) {
      expect((await q.org.admin.patch(url, { policy: { auto_miss } })).status).toBe(400);
    }
    const [s] = await t.db<{ policy: { auto_miss: unknown } }[]>`
      SELECT policy FROM services WHERE id = ${q.serviceId}`;
    expect(s?.policy.auto_miss).toEqual({ enabled: false });
    for (const after_seconds of [60, 3600]) {
      expect(
        (await q.org.admin.patch(url, { policy: { auto_miss: { enabled: true, after_seconds } } }))
          .status,
      ).toBe(200);
    }
    enabledServices.push(q.serviceId);
  });

  it('the visitor-facing rule is in the ticket status only while enabled', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await calledTicket(q);
    const rule = async (): Promise<unknown> =>
      (
        (await ticketStatus(t.app, v.code, v.token)).body.status?.['recovery'] as Record<
          string,
          unknown
        >
      )['auto_miss_after_seconds'];
    expect(await rule()).toBeNull();
    await enable(q, 180);
    expect(await rule()).toBe(180);
  });

  it('fires only after the elapsed time since the committed call, through the authoritative path', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await calledTicket(q);
    await enable(q, 120);
    await sweep(0);
    await sweep(100);
    await sweep(118);
    expect(await stateOf(v.ticketId)).toBe('called');
    expect(await missEvents(q.queueId)).toHaveLength(0);

    await sweep(125);
    expect(await stateOf(v.ticketId)).toBe('missed');
    const [ev, ...more] = await missEvents(q.queueId);
    expect(more).toHaveLength(0);
    const [svc] = await t.db<{ policy: { version: string } }[]>`
      SELECT policy FROM services WHERE id = ${q.serviceId}`;
    expect(ev?.actor_id).toBeNull();
    expect(ev?.payload).toMatchObject({
      actor_kind: 'system',
      reason_code: 'call_window_elapsed',
      call_sequence: v.callSequence,
      policy_version: svc?.policy.version,
      from_state: 'called',
      to_state: 'missed',
    });
    // a deterministic operation id and the same records a staff miss leaves behind
    const [{ called_at } = { called_at: new Date(0) }] = await t.db<{ called_at: Date }[]>`
      SELECT committed_at AS called_at FROM queue_events
       WHERE queue_session_id = ${q.queueId} AND sequence = ${v.callSequence}`;
    expect(ev?.operation_id).toBe(autoMissOperationId(v.ticketId, v.callSequence, called_at));
    const ops = await t.db<{ status: string; actor_id: string | null; source: string }[]>`
      SELECT status, actor_id, source FROM client_operations
       WHERE organization_id = ${q.org.organizationId} AND operation_id = ${ev?.operation_id ?? ''}`;
    expect(ops).toEqual([{ status: 'committed', actor_id: null, source: 'online' }]);
    const [tr] = await t.db<{ from_state: string; to_state: string }[]>`
      SELECT tt.from_state, tt.to_state FROM ticket_transitions tt
        JOIN queue_events e ON e.id = tt.queue_event_id
       WHERE tt.ticket_id = ${v.ticketId} ORDER BY e.sequence DESC LIMIT 1`;
    expect(tr).toEqual({ from_state: 'called', to_state: 'missed' });
    const types = await assertEventLogIntact(t.db, q.queueId);
    expect(types.at(-1)).toBe('ticket.miss');

    // a later pass changes nothing (the ticket is no longer called)
    await sweep(500);
    expect(await missEvents(q.queueId)).toHaveLength(1);
  });

  it('a sweep that runs late misses only after the deadline, never earlier, and only once', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await calledTicket(q);
    await enable(q, 60);
    await sweep(59); // early pass: nothing
    expect(await stateOf(v.ticketId)).toBe('called');
    await sweep(3000); // very late pass (but no gap of 3 intervals): still exactly one miss
    expect(await stateOf(v.ticketId)).toBe('missed');
    expect(await missEvents(q.queueId)).toHaveLength(1);
  });

  it('is not applied while serving, after a staff action, when disabled, or when the rule changed', async () => {
    const q = await setupQueue(t.app, { counters: 3 });
    await enable(q, 120);
    // serving
    const a = await calledTicket(q);
    expect(
      (
        await queueCommand(q.org.admin, q.queueId, {
          action: 'ticket.serve',
          ticket_id: a.ticketId,
        })
      ).status,
    ).toBe(200);
    await sweep(500);
    expect(await stateOf(a.ticketId)).toBe('serving');
    // the facility disables the feature again
    await t.db`UPDATE services SET policy = jsonb_set(policy, '{auto_miss}', '{"enabled": false}') WHERE id = ${q.serviceId}`;
    const q2 = await setupQueue(t.app, {
      counters: 1,
      org: q.org,
      fid: q.fid,
      facilitySlug: q.facilitySlug,
    });
    const b = await calledTicket(q2);
    await enable(q2, 120);
    await q2.org.admin.patch(`/api/v1/facilities/${q2.fid}/services/${q2.serviceId}`, {
      policy: { auto_miss: { enabled: false } },
    });
    await sweep(500);
    expect(await stateOf(b.ticketId)).toBe('called');
    // the rule changed to a longer window: the new value governs
    await enable(q2, 900);
    await sweep(500);
    expect(await stateOf(b.ticketId)).toBe('called');
    await sweep(905);
    expect(await stateOf(b.ticketId)).toBe('missed');
    expect(await missEvents(q.queueId)).toHaveLength(0);
  });

  it('is not applied when the queue is not open', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await calledTicket(q);
    await enable(q, 120);
    expect((await queueCommand(q.org.admin, q.queueId, { action: 'queue.pause' })).status).toBe(
      200,
    );
    await sweep(500);
    expect(await stateOf(v.ticketId)).toBe('called');
    expect(await missEvents(q.queueId)).toHaveLength(0);
  });

  it('every call is its own window: a re-called ticket is missed again under a different operation id', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await calledTicket(q);
    await enable(q, 120);
    await sweep(125);
    expect(await stateOf(v.ticketId)).toBe('missed');
    // staff return it to the queue and call it again: a new call sequence
    expect(
      (
        await queueCommand(q.org.admin, q.queueId, {
          action: 'ticket.resume',
          ticket_id: v.ticketId,
        })
      ).status,
    ).toBe(200);
    const again = await queueCommand(q.org.admin, q.queueId, {
      action: 'ticket.call_next',
      counter_id: q.counterIds[0],
    });
    expect(again.body.outcome?.ticket_id).toBe(v.ticketId);
    await sweep(125);
    const evs = await missEvents(q.queueId);
    expect(evs).toHaveLength(2);
    expect(evs[0]?.operation_id).not.toBe(evs[1]?.operation_id);
    expect(evs[1]?.payload['call_sequence']).toBe(again.body.outcome?.server_sequence);
    await assertEventLogIntact(t.db, q.queueId);
  });

  it('a race with a staff serve resolves by the locks: one outcome, coherent log', async () => {
    for (let round = 0; round < 5; round++) {
      const q = await setupQueue(t.app, { counters: 1 });
      const v = await calledTicket(q);
      await enable(q, 120);
      const [serve] = await Promise.all([
        queueCommand(q.org.admin, q.queueId, { action: 'ticket.serve', ticket_id: v.ticketId }),
        sweep(500),
      ]);
      const state = await stateOf(v.ticketId);
      const misses = await missEvents(q.queueId);
      if (state === 'serving') {
        expect(serve.status).toBe(200);
        expect(misses).toHaveLength(0);
      } else {
        expect(state).toBe('missed');
        expect(serve.status).toBe(409);
        expect(misses).toHaveLength(1);
      }
      await assertEventLogIntact(t.db, q.queueId);
    }
  });
});

// ---------------------------------------------------------------------------
// 8.R12 — execution safety
// ---------------------------------------------------------------------------

describe('8.R12 automatic no-show execution safety', () => {
  it('(a) produces the same event, transition, hash-chain and operation records as a staff miss', async () => {
    const q = await setupQueue(t.app, { counters: 2 });
    const staff = await calledTicket(q);
    expect(
      (
        await queueCommand(q.org.admin, q.queueId, {
          action: 'ticket.miss',
          ticket_id: staff.ticketId,
        })
      ).status,
    ).toBe(200);
    const auto = await calledTicket(q);
    await enable(q, 120);
    await sweep(125);
    const evs = await t.db<
      {
        event_type: string;
        payload: Record<string, unknown>;
        prev_hash: string;
        event_hash: string;
      }[]
    >`
      SELECT event_type, payload, prev_hash, event_hash FROM queue_events
       WHERE queue_session_id = ${q.queueId} AND event_type = 'ticket.miss' ORDER BY sequence`;
    expect(evs).toHaveLength(2);
    const keys = (p: Record<string, unknown>): string[] =>
      Object.keys(p)
        .filter((k) => !['actor_kind', 'reason_code', 'call_sequence'].includes(k))
        .sort();
    expect(keys(evs[1]!.payload)).toEqual(keys(evs[0]!.payload));
    expect(evs[1]?.payload['ticket_id']).toBe(auto.ticketId);
    const ops = await t.db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM client_operations
       WHERE queue_session_id = ${q.queueId} AND action = 'ticket.miss' AND status = 'committed'`;
    expect(ops[0]?.n).toBe(2);
    await assertEventLogIntact(t.db, q.queueId);
  });

  it('(b) concurrent sweepers on separate connections produce exactly one miss per ticket', async () => {
    const q = await setupQueue(t.app, { counters: 3 });
    const tickets = [await calledTicket(q), await calledTicket(q), await calledTicket(q)];
    await enable(q, 120);
    const pools = Array.from({ length: 4 }, () => createDb(t.env));
    try {
      const results = await Promise.all(pools.map((db) => sweep(125, { db })));
      expect(results.reduce((n, r) => n + r.missed, 0)).toBe(3);
    } finally {
      await Promise.all(pools.map((p) => p.end({ timeout: 5 })));
    }
    const evs = await missEvents(q.queueId);
    expect(evs).toHaveLength(3);
    expect(new Set(evs.map((e) => e.payload['ticket_id']))).toEqual(
      new Set(tickets.map((x) => x.ticketId)),
    );
    for (const tk of tickets) {
      const [{ n } = { n: -1 }] = await t.db<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM client_operations
         WHERE organization_id = ${q.org.organizationId} AND action = 'ticket.miss'
           AND result_json ->> 'ticket_id' = ${tk.ticketId}`;
      expect(n).toBe(1);
    }
    await assertEventLogIntact(t.db, q.queueId);
  });

  it('(b) a replayed deterministic operation id returns duplicate, never a second miss', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await calledTicket(q);
    await enable(q, 120);
    await sweep(125);
    const [ev] = await missEvents(q.queueId);
    const again = await executeSystemTransition(t.db, {
      organizationId: q.org.organizationId,
      queueId: q.queueId,
      ticketId: v.ticketId,
      operationId: ev?.operation_id ?? '',
      actor: SystemActor.SYSTEM,
      action: QueueAction.TICKET_MISS,
      preconditions: async () => ['auto_miss_due'],
    });
    expect(again.disposition).toBe('duplicate');
    expect(await missEvents(q.queueId)).toHaveLength(1);
  });

  it('(c) refused while a coordinator is assigned (also when its authorization expired); coordinator state untouched', async () => {
    const f = await setupContinuity(t.app, { counters: 1 });
    const v = await calledTicket(f, f.supervisor.client);
    await enable(f, 120);
    expect(
      (await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId)).status,
    ).toBe(200);
    const coordState = async (): Promise<unknown> =>
      (
        await t.db`
          SELECT coordinator_epoch, coordinator_device_id, coordinator_allowed_actions, revision, last_sequence
            FROM queue_sessions WHERE id = ${f.queueId}`
      )[0];
    const coordOps = async (): Promise<unknown> =>
      t.db`SELECT operation_id, status FROM client_operations
            WHERE queue_session_id = ${f.queueId} ORDER BY operation_id`;
    const before = [await coordState(), await coordOps()];
    await sweep(10_000);
    // expired authorization: the device is still designated, so the fence still holds
    await t.db`UPDATE queue_sessions SET coordinator_expires_at = NOW() - INTERVAL '1 hour' WHERE id = ${f.queueId}`;
    await sweep(10_000);
    expect(await stateOf(v.ticketId)).toBe('called');
    expect([await coordState(), await coordOps()]).toEqual(before);
    // and the executor itself refuses, independent of the sweep's candidate filter
    await expect(
      executeSystemTransition(t.db, {
        organizationId: f.org.organizationId,
        queueId: f.queueId,
        ticketId: v.ticketId,
        operationId: uuidv7(),
        actor: SystemActor.SYSTEM,
        action: QueueAction.TICKET_MISS,
        preconditions: async () => ['auto_miss_due'],
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ApiProblem && e.status === 409);
    expect([await coordState(), await coordOps()]).toEqual(before);
  });

  it('(c) a ticket the coordinator served offline is not missed, and the late sync still lands', async () => {
    const f = await setupContinuity(t.app, { counters: 1 });
    const v = await calledTicket(f, f.supervisor.client);
    await enable(f, 120);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const auth = await f.authorityFor(f.counter);
    const snap = await snapshot(f.counter.client, f.queueId, f.counter.deviceId);
    // (the outage) long past the call: the coordinator holds the queue, so no miss
    await sweep(5_000);
    expect(await stateOf(v.ticketId)).toBe('called');
    const res = await syncBatch(
      f.counter.client,
      [
        f.cmd(
          f.counter,
          QueueAction.TICKET_SERVE,
          { ticket_id: v.ticketId },
          { epoch: 1, baseRevision: snap.body.snapshot.revision },
        ),
      ],
      [auth],
    );
    expect(res.body.results[0]?.disposition).toBe('committed');
    expect(await stateOf(v.ticketId)).toBe(TicketState.SERVING);
    expect(await missEvents(f.queueId)).toHaveLength(0);
    await assertEventLogIntact(t.db, f.queueId);
  });

  it('(c) the clock restarts after the last coordinator event', async () => {
    const f = await setupContinuity(t.app, { counters: 1 });
    const v = await calledTicket(f, f.supervisor.client);
    await enable(f, 120);
    const [{ called_at } = { called_at: new Date(0) }] = await t.db<{ called_at: Date }[]>`
      SELECT committed_at AS called_at FROM queue_events
       WHERE queue_session_id = ${f.queueId} AND sequence = ${v.callSequence}`;
    // Real database time must pass between the call and the coordinator events (events are
    // append-only, so this gap cannot be created any other way). This is not synchronization.
    await t.db`SELECT pg_sleep(1.5)`;
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    expect((await revokeCoordinator(f.supervisor.client, f.queueId)).status).toBe(200);
    const [{ last } = { last: new Date(0) }] = await t.db<{ last: Date }[]>`
      SELECT MAX(committed_at) AS last FROM queue_events
       WHERE queue_session_id = ${f.queueId} AND event_type LIKE 'coordinator.%'`;
    expect(last.getTime() - called_at.getTime()).toBeGreaterThanOrEqual(1500);
    // 121 s after the CALL but before 120 s after the last coordinator event: not yet
    const [{ now } = { now: new Date(0) }] = await t.db<{ now: Date }[]>`SELECT NOW() AS now`;
    const sinceLast = (now.getTime() - last.getTime()) / 1000;
    const sinceCall = (now.getTime() - called_at.getTime()) / 1000;
    const early = 120 - sinceLast - 0.7; // ≥ 0.8 s after the call's deadline, ~0.7 s before the new one
    expect(sinceCall + early).toBeGreaterThan(120);
    await sweep(early);
    expect(await stateOf(v.ticketId)).toBe('called');
    await sweep(121);
    expect(await stateOf(v.ticketId)).toBe('missed');
  });

  it('(d) a fresh process with no memory behaves identically', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await calledTicket(q);
    await enable(q, 120);
    await sweep(100);
    const fresh = await createTestApp();
    try {
      await runAutoMissSweep(fresh.db, silent, {
        intervalSeconds: 3600,
        batchSize: 1000,
        testClockOffsetSeconds: 100,
      });
      expect(await stateOf(v.ticketId)).toBe('called');
      const r = await runAutoMissSweep(fresh.db, silent, {
        intervalSeconds: 3600,
        batchSize: 1000,
        testClockOffsetSeconds: 125,
      });
      expect(r.missed).toBeGreaterThanOrEqual(1);
    } finally {
      await fresh.close();
    }
    expect(await stateOf(v.ticketId)).toBe('missed');
    expect(await missEvents(q.queueId)).toHaveLength(1);
  });

  it('(e) a detected outage (gap over 3 intervals) restarts the clock for every called ticket', async () => {
    const q = await setupQueue(t.app, { counters: 2 });
    const a = await calledTicket(q);
    const b = await calledTicket(q);
    await enable(q, 120);
    // the last pass was long ago: the sweeper (or the whole API) was down
    await t.db`UPDATE auto_miss_sweeps SET last_pass_at = NOW() - INTERVAL '10 minutes' WHERE id`;
    const r = await sweep(500, { intervalSeconds: 15 });
    expect(r.outageDetected).toBe(true);
    expect(r.missed).toBe(0);
    expect([await stateOf(a.ticketId), await stateOf(b.ticketId)]).toEqual(['called', 'called']);
    // the visitors get a full window counted from the end of the outage
    expect((await sweep(610, { intervalSeconds: 3600 })).missed).toBe(0);
    await sweep(625, { intervalSeconds: 3600 });
    expect([await stateOf(a.ticketId), await stateOf(b.ticketId)]).toEqual(['missed', 'missed']);
  });

  it('(e) the very first pass ever (no history) counts as an outage', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const v = await calledTicket(q);
    await enable(q, 120);
    await t.db`DELETE FROM auto_miss_sweeps`;
    const r = await sweep(500);
    expect(r.outageDetected).toBe(true);
    expect(await stateOf(v.ticketId)).toBe('called');
  });

  it('(f) outcomes are identical whether alerts succeeded, failed, are absent or erroring', async () => {
    const outcomes: string[][] = [];
    for (const alert of ['absent', 'delivered', 'failed', 'pending', 'unknown'] as const) {
      const q = await setupQueue(t.app, { counters: 2 });
      const answered = await calledTicket(q);
      const silentVisitor = await calledTicket(q);
      if (alert !== 'absent') {
        for (const tk of [answered, silentVisitor]) {
          const [n] = await t.db<{ id: string }[]>`
            INSERT INTO notifications (organization_id, ticket_id, channel, template_key, status)
            VALUES (${q.org.organizationId}, ${tk.ticketId}, 'in_app', 'ticket.called', ${alert})
            RETURNING id`;
          await t.db`
            INSERT INTO notification_outbox (notification_id, dedup_key, attempt_count)
            VALUES (${n?.id ?? ''}, ${`test:${uuidv7()}`}, ${alert === 'failed' ? 5 : 0})`;
        }
      }
      await enable(q, 120);
      await queueCommand(q.org.admin, q.queueId, {
        action: 'ticket.serve',
        ticket_id: answered.ticketId,
      });
      await sweep(100);
      const early = [await stateOf(answered.ticketId), await stateOf(silentVisitor.ticketId)];
      await sweep(125);
      outcomes.push([
        ...early.map(String),
        String(await stateOf(answered.ticketId)),
        String(await stateOf(silentVisitor.ticketId)),
      ]);
    }
    for (const o of outcomes) expect(o).toEqual(['serving', 'called', 'serving', 'missed']);
  });

  it('(f) static check: the sweep has no import path to notification, push, SMS or outbox code', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const seen = new Set<string>();
    const external = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1] ?? '';
        if (!spec.startsWith('.')) {
          external.add(spec);
          continue;
        }
        const target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
        if (existsSync(target)) walk(target);
      }
    };
    walk(resolve(here, 'queue/auto-miss.ts'));
    const files = [...seen].map((f) => f.slice(here.length + 1));
    expect(files).toContain('queue/auto-miss.ts');
    expect(files).toContain('queue/commands.ts');
    // `queue/notifier.ts` is the SSE "queue changed" pg_notify channel shared by every command
    // (no visitor alert, no delivery state); it is checked by the same walk for what it imports
    const alertish = files.filter(
      (f) => f !== 'queue/notifier.ts' && /notif|outbox|push|sms|alert|deliver/i.test(f),
    );
    expect(alertish).toEqual([]);
    expect([...external].filter((s) => /channels|web-push/.test(s))).toEqual([]);
    const sweepSrc = readFileSync(resolve(here, 'queue/auto-miss.ts'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/)/.test(l))
      .join('\n');
    expect(sweepSrc).not.toMatch(/notification|outbox|push_|sms|deliver/i);
  });
});

describe('autoMissOperationId', () => {
  it('is a deterministic UUID v7 tied to the ticket and the call', () => {
    const at = new Date('2026-11-12T10:00:00.123Z');
    const a = autoMissOperationId('0193a1b2-0000-7000-8000-000000000001', 7, at);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(autoMissOperationId('0193a1b2-0000-7000-8000-000000000001', 7, at)).toBe(a);
    expect(autoMissOperationId('0193a1b2-0000-7000-8000-000000000001', 8, at)).not.toBe(a);
    expect(autoMissOperationId('0193a1b2-0000-7000-8000-000000000002', 7, at)).not.toBe(a);
    expect(parseInt(a.replace(/-/g, '').slice(0, 12), 16)).toBe(at.getTime());
  });
});
