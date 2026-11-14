import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALERT_SEVERITY, HEALTH_ALERT_KINDS, uuidv7 } from '@queuebridge/contracts';
import { evaluateDeviceHealth, HEALTH_CHANNEL, runHealthRetention } from './health.js';

/**
 * M5.3 device-health evaluation against REAL PostgreSQL (testing steering 8.D3, 8.D4, 8.D6).
 *
 * The file runs in its own throwaway database with every migration applied: the evaluator scans
 * every facility, so alert counts in a shared database would depend on other suites' rows. The
 * fixtures are written with SQL so that times (last contact, expiry, conflict age) can be placed
 * exactly; the evaluator under test is the real one the worker runs. API-level behaviour
 * (permissions, acknowledgement, own-device warnings) is covered in apps/api.
 */

const URL_ = process.env['TEST_DATABASE_URL'] ?? '';
const MIGRATIONS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'infra',
  'migrations',
);
const DB_NAME = `qb_health_${randomBytes(6).toString('hex')}`;
let admin: Sql;
let sql: Sql;
let dbUrl = '';
beforeAll(async () => {
  admin = postgres(URL_, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
  const u = new URL(URL_);
  u.pathname = `/${DB_NAME}`;
  dbUrl = u.toString();
  sql = postgres(dbUrl, { max: 4, onnotice: () => undefined });
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql')).sort()) {
    await sql.unsafe(await readFile(join(MIGRATIONS, f), 'utf8'));
  }
});
afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin?.end({ timeout: 5 });
});

const hex = (n = 4): string => randomBytes(n).toString('hex');
const secondsAgo = (s: number): Date => new Date(Date.now() - s * 1000);
let dayOffset = 1;

interface Facility {
  orgId: string;
  facilityId: string;
  serviceId: string;
  staffId: string;
  device: (o?: {
    lastSeenAgo?: number | null;
    pending?: number;
    streak?: number;
    revoked?: boolean;
  }) => Promise<string>;
  queue: (o?: {
    coordinator?: string;
    expiresIn?: number;
    state?: 'open' | 'paused' | 'closed';
    waiting?: number;
    called?: number;
  }) => Promise<string>;
  conflict: (queueId: string, deviceId: string, ageSeconds: number) => Promise<void>;
}

async function facility(): Promise<Facility> {
  const tag = hex();
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES ('Health', ${`h-${tag}`}) RETURNING id`;
  const orgId = org?.id ?? '';
  const [fac] = await sql<{ id: string }[]>`
    INSERT INTO facilities (organization_id, name, slug, timezone)
    VALUES (${orgId}, 'Clinic', ${`c-${tag}`}, 'UTC') RETURNING id`;
  const facilityId = fac?.id ?? '';
  const [svc] = await sql<{ id: string }[]>`
    INSERT INTO services (organization_id, facility_id, name) VALUES (${orgId}, ${facilityId}, 'General') RETURNING id`;
  const serviceId = svc?.id ?? '';
  const [staff] = await sql<{ id: string }[]>`
    INSERT INTO staff_users (organization_id, email, password_hash, display_name)
    VALUES (${orgId}, ${`s-${tag}@example.test`}, 'x', 'Staff') RETURNING id`;
  const staffId = staff?.id ?? '';
  let seq = 0;
  return {
    orgId,
    facilityId,
    serviceId,
    staffId,
    device: async (o = {}) => {
      const seen = o.lastSeenAgo === null ? null : secondsAgo(o.lastSeenAgo ?? 5);
      const [d] = await sql<{ id: string }[]>`
        INSERT INTO devices (facility_id, organization_id, staff_user_id, public_key_or_session, label,
                             last_seen_at, reported_pending_count, failure_streak, last_failure_code,
                             revoked_at, revoked_reason_code)
        VALUES (${facilityId}, ${orgId}, ${staffId}, 'session-bound', ${`Tablet ${hex(2)}`}, ${seen},
                ${o.pending ?? 0}, ${o.streak ?? 0}, ${o.streak ? 'sync_failed' : null},
                ${o.revoked ? new Date() : null}, ${o.revoked ? 'lost' : null})
        RETURNING id`;
      return d?.id ?? '';
    },
    queue: async (o = {}) => {
      const expires = o.coordinator ? new Date(Date.now() + (o.expiresIn ?? 3600) * 1000) : null;
      const [q] = await sql<{ id: string }[]>`
        INSERT INTO queue_sessions (facility_id, organization_id, service_id, operational_date, state,
                                    coordinator_epoch, coordinator_device_id, coordinator_granted_at,
                                    coordinator_expires_at, coordinator_allowed_actions, coordinator_granted_by)
        VALUES (${facilityId}, ${orgId}, ${serviceId}, CURRENT_DATE - ${dayOffset++}::int, ${o.state ?? 'open'},
                ${o.coordinator ? 1 : 0}, ${o.coordinator ?? null}, ${o.coordinator ? new Date() : null},
                ${expires}, ${o.coordinator ? sql.array(['ticket.call_next']) : sql.array([] as string[])},
                ${o.coordinator ? staffId : null})
        RETURNING id`;
      const queueId = q?.id ?? '';
      for (const [state, n] of [
        ['waiting', o.waiting ?? 0],
        ['called', o.called ?? 0],
      ] as const) {
        for (let i = 0; i < n; i++) {
          seq += 1;
          await sql`
            INSERT INTO tickets (queue_session_id, organization_id, public_code, state, issued_sequence)
            VALUES (${queueId}, ${orgId}, ${`G${String(seq).padStart(3, '0')}`}, ${state}, ${seq})`;
        }
      }
      return queueId;
    },
    conflict: async (queueId, deviceId, ageSeconds) => {
      await sql`
        INSERT INTO client_operations (organization_id, queue_session_id, device_id, operation_id,
                                       client_sequence, action, status, result_json, source, created_at)
        VALUES (${orgId}, ${queueId}, ${deviceId}, ${uuidv7()}, 1, 'ticket.call_next', 'needs_review',
                '{}', 'offline_sync', ${secondsAgo(ageSeconds)})`;
    },
  };
}

interface AlertRow {
  id: string;
  kind: string;
  severity: string;
  subject_type: string;
  subject_id: string;
  details: Record<string, number>;
  clear_count: number;
  resolved_at: Date | null;
  resolved_reason: string | null;
  acknowledged_at: Date | null;
  last_seen_at: Date;
}
const alertsOf = (f: Facility, open = true): Promise<AlertRow[]> =>
  sql<AlertRow[]>`
    SELECT id, kind, severity, subject_type, subject_id, details, clear_count, resolved_at,
           resolved_reason, acknowledged_at, last_seen_at
      FROM health_alerts WHERE facility_id = ${f.facilityId}
       AND (${!open} OR resolved_at IS NULL)
     ORDER BY kind, opened_at`;
const evaluate = (
  o: Parameters<typeof evaluateDeviceHealth>[1] = {},
): ReturnType<typeof evaluateDeviceHealth> => evaluateDeviceHealth(sql, o);

// ---------------------------------------------------------------------------------------------

describe('8.D3 the eight alert kinds', () => {
  it('a healthy facility raises nothing', async () => {
    const f = await facility();
    const d = await f.device({ lastSeenAgo: 5 });
    await f.queue({ coordinator: d, expiresIn: 3600, waiting: 3 });
    await f.device({ lastSeenAgo: 2000, pending: 0 }); // stale but nothing pending: no alert
    await evaluate();
    expect(await alertsOf(f)).toEqual([]);
  });

  it('coordinator_offline (high): offline or stale coordinator while its queue has waiting or called tickets', async () => {
    const f = await facility();
    const offline = await f.device({ lastSeenAgo: 200 });
    const stale = await f.device({ lastSeenAgo: 2000 });
    const busy1 = await f.queue({ coordinator: offline, waiting: 2 });
    const busy2 = await f.queue({ coordinator: stale, called: 1 });
    const quiet = await f.device({ lastSeenAgo: 200 });
    await f.queue({ coordinator: quiet }); // empty queue: the silence harms nobody yet
    await evaluate();
    const a = (await alertsOf(f)).filter((x) => x.kind === 'coordinator_offline');
    expect(a.map((x) => x.subject_id).sort()).toEqual([busy1, busy2].sort());
    expect(a.every((x) => x.severity === 'high' && x.subject_type === 'queue')).toBe(true);
    expect(a.find((x) => x.subject_id === busy1)?.details).toEqual({ waiting: 2, called: 0 });
  });

  it('coordinator_expiring (medium) inside 300 s and coordinator_expired (high) after the end', async () => {
    const f = await facility();
    const d1 = await f.device();
    const d2 = await f.device();
    const d3 = await f.device();
    const expiring = await f.queue({ coordinator: d1, expiresIn: 200 });
    const expired = await f.queue({ coordinator: d2, expiresIn: -60 });
    await f.queue({ coordinator: d3, expiresIn: 400 }); // outside the window
    await evaluate();
    const a = await alertsOf(f);
    expect(a.map((x) => [x.kind, x.subject_id, x.severity])).toEqual([
      ['coordinator_expired', expired, 'high'],
      ['coordinator_expiring', expiring, 'medium'],
    ]);
  });

  it('device_stale_pending (medium) and sync_failing (medium) with counts only', async () => {
    const f = await facility();
    const stale = await f.device({ lastSeenAgo: 901, pending: 4 });
    await f.device({ lastSeenAgo: 899, pending: 4 }); // offline, not yet stale
    const failing = await f.device({ streak: 3 });
    await f.device({ streak: 2 }); // not yet 3 in a row
    await f.device({ lastSeenAgo: 5000, pending: 9, revoked: true }); // revoked devices are not monitored
    await evaluate();
    const a = await alertsOf(f);
    expect(a.map((x) => [x.kind, x.subject_id, x.details])).toEqual([
      ['device_stale_pending', stale, { pending: 4 }],
      ['sync_failing', failing, { reports: 3 }],
    ]);
  });

  it('conflicts_unreviewed (medium): needs_review older than 900 s, per queue', async () => {
    const f = await facility();
    const d = await f.device();
    const q = await f.queue();
    const fresh = await f.queue();
    await f.conflict(q, d, 1000);
    await f.conflict(q, d, 950);
    await f.conflict(fresh, d, 60);
    await evaluate();
    const a = await alertsOf(f);
    expect(a.map((x) => [x.kind, x.subject_id, x.details])).toEqual([
      ['conflicts_unreviewed', q, { conflicts: 2 }],
    ]);
  });

  it('recovery_abuse (medium) from a recent L3/L4 signal; older signals do not alert', async () => {
    const f = await facility();
    const g = await facility();
    await sql`
      INSERT INTO admin_events (organization_id, facility_id, event_type, target_type, target_id, details)
      VALUES (${f.orgId}, ${f.facilityId}, 'ticket_recovery.abuse_detected', 'facility', ${f.facilityId}, '{"scope":"facility"}')`;
    await sql`
      INSERT INTO admin_events (organization_id, facility_id, event_type, target_type, target_id, details, created_at)
      VALUES (${g.orgId}, ${g.facilityId}, 'ticket_recovery.abuse_detected', 'facility', ${g.facilityId},
              '{"scope":"facility"}', ${secondsAgo(2000)})`;
    await evaluate();
    expect(
      (await alertsOf(f)).map((x) => [x.kind, x.subject_type, x.subject_id, x.details]),
    ).toEqual([['recovery_abuse', 'facility', f.facilityId, { signals: 1 }]]);
    expect(await alertsOf(g)).toEqual([]);
  });

  it('alert_pipeline_failing (low) at 10 failed turn alerts in the last hour', async () => {
    const f = await facility();
    const q = await f.queue({ waiting: 1 });
    const [t] = await sql<{ id: string }[]>`SELECT id FROM tickets WHERE queue_session_id = ${q}`;
    const fail = async (n: number): Promise<void> => {
      for (let i = 0; i < n; i++) {
        await sql`
          INSERT INTO notifications (organization_id, ticket_id, channel, template_key, status)
          VALUES (${f.orgId}, ${t?.id ?? ''}, 'in_app', 'ticket.called', 'failed')`;
      }
    };
    await fail(9);
    await evaluate();
    expect(await alertsOf(f)).toEqual([]);
    await fail(1);
    await evaluate();
    expect((await alertsOf(f)).map((x) => [x.kind, x.severity, x.details])).toEqual([
      ['alert_pipeline_failing', 'low', { failed: 10 }],
    ]);
  });

  it('every kind has the severity of design §17.4', () => {
    expect(HEALTH_ALERT_KINDS).toHaveLength(8);
    expect(ALERT_SEVERITY).toEqual({
      coordinator_offline: 'high',
      coordinator_expiring: 'medium',
      coordinator_expired: 'high',
      device_stale_pending: 'medium',
      sync_failing: 'medium',
      conflicts_unreviewed: 'medium',
      recovery_abuse: 'medium',
      alert_pipeline_failing: 'low',
    });
  });
});

describe('8.D3 one open alert per (facility, kind, subject)', () => {
  it('repeated evaluations refresh the same alert instead of adding new ones', async () => {
    const f = await facility();
    await f.device({ lastSeenAgo: 2000, pending: 1 });
    await evaluate();
    const [first] = await alertsOf(f);
    await evaluate();
    await evaluate();
    const all = await alertsOf(f, false);
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(first?.id);
    expect(all[0]!.last_seen_at.getTime()).toBeGreaterThanOrEqual(first!.last_seen_at.getTime());
  });

  it('8 concurrent evaluators on separate connections (no try-lock): still exactly one alert per subject', async () => {
    const f = await facility();
    const devices = await Promise.all(
      [1, 2, 3].map(() => f.device({ lastSeenAgo: 2000, pending: 2 })),
    );
    const pools = Array.from({ length: 8 }, () =>
      postgres(dbUrl, { max: 1, onnotice: () => undefined }),
    );
    try {
      const results = await Promise.all(
        pools.map((p) => evaluateDeviceHealth(p, { exclusive: false })),
      );
      expect(results.every((r) => !r.skipped)).toBe(true);
    } finally {
      await Promise.all(pools.map((p) => p.end({ timeout: 5 })));
    }
    const open = await alertsOf(f);
    expect(open).toHaveLength(3);
    expect(new Set(open.map((a) => a.subject_id))).toEqual(new Set(devices));
  });

  it('concurrent evaluators with the try-lock: the others skip instead of waiting', async () => {
    const f = await facility();
    await f.device({ lastSeenAgo: 2000, pending: 2 });
    const pools = Array.from({ length: 6 }, () =>
      postgres(dbUrl, { max: 1, onnotice: () => undefined }),
    );
    try {
      const results = await Promise.all(pools.map((p) => evaluateDeviceHealth(p)));
      expect(results.filter((r) => !r.skipped).length).toBeGreaterThanOrEqual(1);
    } finally {
      await Promise.all(pools.map((p) => p.end({ timeout: 5 })));
    }
    expect(await alertsOf(f)).toHaveLength(1);
  });

  it('with waitForLock every evaluator really evaluates (none skips): what `--once` relies on', async () => {
    const pools = Array.from({ length: 4 }, () =>
      postgres(dbUrl, { max: 1, onnotice: () => undefined }),
    );
    try {
      const results = await Promise.all(
        pools.map((p) => evaluateDeviceHealth(p, { waitForLock: true })),
      );
      expect(results.every((r) => !r.skipped)).toBe(true);
    } finally {
      await Promise.all(pools.map((p) => p.end({ timeout: 5 })));
    }
  });

  it('waiting is bounded: a stuck evaluation cannot keep another waiting indefinitely, and nothing changes', async () => {
    const f = await facility();
    await f.device({ streak: 3 });
    const holder = postgres(dbUrl, { max: 1, onnotice: () => undefined });
    let release: () => void = () => undefined;
    const released = new Promise<void>((r) => (release = r));
    // another evaluator "hangs" while holding the evaluation lock
    const held = holder.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${0x71_62_68_65_61_6c_74_68n.toString()}::bigint)`;
      await released;
    });
    try {
      await expect
        .poll(
          async () =>
            (
              await sql<{ n: number }[]>`
              SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`
            )[0]?.n,
        )
        .toBeGreaterThanOrEqual(1);
      const started = Date.now();
      await expect(evaluate({ waitForLock: true, timeoutMs: 500 })).rejects.toThrow(
        /lock timeout/i,
      );
      expect(Date.now() - started).toBeLessThan(5000);
      // the try-lock path does not wait at all
      expect((await evaluate()).skipped).toBe(true);
      expect(await alertsOf(f)).toEqual([]);
    } finally {
      release();
      await held.catch(() => undefined);
      await holder.end({ timeout: 5 });
    }
    // once the stuck evaluator is gone, the next pass works normally
    expect((await evaluate({ waitForLock: true })).skipped).toBe(false);
    expect((await alertsOf(f)).map((a) => a.kind)).toEqual(['sync_failing']);
  });

  it('the database itself refuses a second open alert for the same subject', async () => {
    const f = await facility();
    const d = await f.device();
    const ins = (): Promise<unknown> =>
      sql`INSERT INTO health_alerts (organization_id, facility_id, kind, severity, subject_type, subject_id)
          VALUES (${f.orgId}, ${f.facilityId}, 'sync_failing', 'medium', 'device', ${d})`;
    await ins();
    await expect(ins()).rejects.toThrow(/health_alerts_one_open_idx/);
  });
});

describe('8.D3 resolution with damping, acknowledgement and recurrence', () => {
  it('resolves only after the condition was clear in two evaluations; flapping does not resolve', async () => {
    const f = await facility();
    const d = await f.device({ lastSeenAgo: 2000, pending: 1 });
    await evaluate();
    // the device comes back (a delayed heartbeat arrives)
    await sql`UPDATE devices SET last_seen_at = NOW(), reported_pending_count = 0 WHERE id = ${d}`;
    await evaluate();
    let [a] = await alertsOf(f);
    expect(a?.clear_count).toBe(1);
    expect(a?.resolved_at).toBeNull();
    // it goes silent again before the second clear evaluation: the counter restarts
    await sql`UPDATE devices SET last_seen_at = NOW() - INTERVAL '1 hour', reported_pending_count = 1 WHERE id = ${d}`;
    await evaluate();
    [a] = await alertsOf(f);
    expect(a?.clear_count).toBe(0);
    // now clear twice in a row
    await sql`UPDATE devices SET last_seen_at = NOW(), reported_pending_count = 0 WHERE id = ${d}`;
    await evaluate();
    await evaluate();
    expect(await alertsOf(f)).toEqual([]);
    const [resolved] = await alertsOf(f, false);
    expect(resolved?.resolved_reason).toBe('condition_cleared');
  });

  it('a condition that returns after resolution opens a NEW alert (not acknowledged)', async () => {
    const f = await facility();
    const d = await f.device({ streak: 3 });
    await evaluate();
    const [first] = await alertsOf(f);
    await sql`UPDATE health_alerts SET acknowledged_at = NOW() WHERE id = ${first?.id ?? ''}`;
    await sql`UPDATE devices SET failure_streak = 0 WHERE id = ${d}`;
    await evaluate();
    await evaluate();
    await sql`UPDATE devices SET failure_streak = 4 WHERE id = ${d}`;
    await evaluate();
    const [again] = await alertsOf(f);
    expect(again?.id).not.toBe(first?.id);
    expect(again?.acknowledged_at).toBeNull();
    expect(await alertsOf(f, false)).toHaveLength(2);
  });

  it('acknowledged alerts stay acknowledged while the condition lasts', async () => {
    const f = await facility();
    await f.device({ streak: 3 });
    await evaluate();
    const [a] = await alertsOf(f);
    await sql`UPDATE health_alerts SET acknowledged_at = NOW() WHERE id = ${a?.id ?? ''}`;
    await evaluate();
    const [b] = await alertsOf(f);
    expect(b?.id).toBe(a?.id);
    expect(b?.acknowledged_at).not.toBeNull();
  });

  it('a revoked device or a closed queue resolves its alerts at once (subject gone)', async () => {
    const f = await facility();
    const d = await f.device({ lastSeenAgo: 2000, pending: 2 });
    const c = await f.device();
    const q = await f.queue();
    await f.conflict(q, c, 1000);
    await evaluate();
    expect(await alertsOf(f)).toHaveLength(2);
    await sql`UPDATE devices SET revoked_at = NOW(), revoked_reason_code = 'lost' WHERE id = ${d}`;
    await sql`UPDATE queue_sessions SET state = 'closed' WHERE id = ${q}`;
    await evaluate();
    // the conflict alert stays (closed queues keep their conflicts until a supervisor decides);
    // the revoked device's alert is resolved immediately
    const open = await alertsOf(f);
    expect(open.map((x) => x.kind)).toEqual(['conflicts_unreviewed']);
    const gone = (await alertsOf(f, false)).find((x) => x.subject_id === d);
    expect(gone?.resolved_reason).toBe('subject_gone');
  });

  it('a failing evaluation changes nothing (no spurious resolve)', async () => {
    const f = await facility();
    await f.device({ streak: 3 });
    await evaluate();
    const before = await alertsOf(f);
    await expect(evaluate({ conflictReviewWarnSeconds: Number.NaN })).rejects.toThrow();
    expect(await alertsOf(f)).toEqual(before);
  });
});

describe('8.D4 observational only: nothing about authority, queues, tickets, events or devices changes', () => {
  it('evaluation leaves every authoritative row byte-for-byte unchanged, including coordinator epoch/device/expiry', async () => {
    const f = await facility();
    const coord = await f.device({ lastSeenAgo: 2000, pending: 3, streak: 4 });
    const q1 = await f.queue({ coordinator: coord, expiresIn: -10, waiting: 2, called: 1 });
    const other = await f.device();
    const q2 = await f.queue({ coordinator: other, expiresIn: 100, waiting: 1 });
    await f.conflict(q1, coord, 5000);
    const snapshot = async (): Promise<string> =>
      JSON.stringify([
        await sql`SELECT row_to_json(qs)::text AS r FROM queue_sessions qs WHERE facility_id = ${f.facilityId} ORDER BY id`,
        await sql`SELECT row_to_json(t)::text AS r FROM tickets t WHERE queue_session_id IN (${q1}, ${q2}) ORDER BY id`,
        await sql`SELECT row_to_json(e)::text AS r FROM queue_events e WHERE queue_session_id IN (${q1}, ${q2}) ORDER BY id`,
        await sql`SELECT row_to_json(d)::text AS r FROM devices d WHERE facility_id = ${f.facilityId} ORDER BY id`,
        await sql`SELECT row_to_json(co)::text AS r FROM client_operations co WHERE queue_session_id IN (${q1}, ${q2}) ORDER BY id`,
        await sql`SELECT row_to_json(ae)::text AS r FROM admin_events ae WHERE organization_id = ${f.orgId} ORDER BY id`,
      ]);
    const before = await snapshot();
    for (let i = 0; i < 3; i++) await evaluate();
    expect(await snapshot()).toBe(before);
    // ...while it did raise its alerts
    expect((await alertsOf(f)).map((a) => a.kind)).toEqual([
      'conflicts_unreviewed',
      'coordinator_expired',
      'coordinator_expiring',
      'coordinator_offline',
      'device_stale_pending',
      'sync_failing',
    ]);
  });
});

describe('8.D6 thresholds by server time', () => {
  it('configured thresholds are honoured (stale after 200 s, expiry warning 900 s)', async () => {
    const f = await facility();
    const d = await f.device({ lastSeenAgo: 300, pending: 1 });
    const c = await f.device();
    const q = await f.queue({ coordinator: c, expiresIn: 600 });
    await evaluate();
    expect(await alertsOf(f)).toEqual([]);
    await evaluate({ deviceStaleAfterSeconds: 200, coordinatorExpiryWarnSeconds: 900 });
    expect((await alertsOf(f)).map((a) => [a.kind, a.subject_id])).toEqual([
      ['coordinator_expiring', q],
      ['device_stale_pending', d],
    ]);
  });
});

describe('evaluation status, change signal and retention', () => {
  it('records the last evaluation and signals each facility whose alerts changed (no data in the signal)', async () => {
    const f = await facility();
    await f.device({ streak: 5 });
    const listener = postgres(dbUrl, { max: 1, onnotice: () => undefined });
    const got: string[] = [];
    try {
      await listener.listen(HEALTH_CHANNEL, (payload) => got.push(payload));
      const r = await evaluate();
      expect(r.opened).toBeGreaterThanOrEqual(1);
      await expect.poll(() => got.some((p) => JSON.parse(p).f === f.facilityId)).toBe(true);
      for (const p of got) expect(Object.keys(JSON.parse(p))).toEqual(['f']);
    } finally {
      await listener.end({ timeout: 5 });
    }
    const [e] = await sql<{ age: number }[]>`
      SELECT EXTRACT(EPOCH FROM NOW() - last_evaluated_at)::float AS age FROM health_evaluations`;
    expect(e?.age).toBeLessThan(5);
  });

  it('resolved alerts are deleted after 30 days; open ones never; the purge is idempotent', async () => {
    const f = await facility();
    const d = await f.device();
    const ins = (resolvedDaysAgo: number | null, kind: string): Promise<unknown> =>
      sql`INSERT INTO health_alerts (organization_id, facility_id, kind, severity, subject_type, subject_id,
                                     opened_at, resolved_at, resolved_reason)
          VALUES (${f.orgId}, ${f.facilityId}, ${kind}, 'medium', 'device', ${d},
                  NOW() - INTERVAL '60 days',
                  ${resolvedDaysAgo === null ? null : new Date(Date.now() - resolvedDaysAgo * 86_400_000)},
                  ${resolvedDaysAgo === null ? null : 'condition_cleared'})`;
    await ins(31, 'sync_failing');
    await ins(29, 'sync_failing');
    await ins(null, 'device_stale_pending');
    await runHealthRetention(sql);
    const left = await sql<{ resolved_at: Date | null }[]>`
      SELECT resolved_at FROM health_alerts WHERE facility_id = ${f.facilityId}`;
    expect(left).toHaveLength(2);
    expect(left.filter((r) => r.resolved_at === null)).toHaveLength(1);
    expect(await runHealthRetention(sql)).toBe(0);
  });
});
