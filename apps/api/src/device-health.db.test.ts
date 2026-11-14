import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DeviceHeartbeatRequestSchema,
  QueueAction,
  type HealthAlert,
  type OperationsHealth,
  type OwnDeviceHealth,
} from '@queuebridge/contracts';
import {
  assertEventLogIntact,
  assignCoordinator,
  createStaff,
  createTestApp,
  failoverCoordinator,
  registerDevice,
  setupContinuity,
  setupQueue,
  snapshot,
  syncBatch,
  tempRef,
  visitorJoin,
  type ContinuityFixture,
  type TestApp,
  type TestClient,
} from './testing/harness.js';

/**
 * M5.3 device health through the API on real PostgreSQL (testing steering 8.D1, 8.D2, 8.D4,
 * 8.D5, 8.D6). Alert rows are written directly here; the worker's evaluator that raises them is
 * tested on its own in apps/worker (it is a separate process by design).
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const health = (
  c: TestClient,
  fid: string,
): Promise<{ status: number; body: { health?: OperationsHealth } }> =>
  c.get(`/api/v1/facilities/${fid}/operations/health`);
const ack = (
  c: TestClient,
  fid: string,
  id: string,
): Promise<{ status: number; body: { alert?: HealthAlert } }> =>
  c.post(`/api/v1/facilities/${fid}/health/alerts/${id}/acknowledge`, {});
const own = (
  c: TestClient,
  deviceId: string,
): Promise<{ status: number; body: { device?: OwnDeviceHealth } }> =>
  c.get(`/api/v1/devices/${deviceId}/health`);
const beat = (
  c: TestClient,
  deviceId: string,
  body: Record<string, unknown>,
): Promise<{ status: number }> => c.post(`/api/v1/devices/${deviceId}/heartbeat`, body);

async function openAlert(
  f: { org: { organizationId: string }; fid: string },
  kind: string,
  subject: { type: 'device' | 'queue' | 'facility'; id: string },
  severity = 'medium',
): Promise<string> {
  const [a] = await t.db<{ id: string }[]>`
    INSERT INTO health_alerts (organization_id, facility_id, kind, severity, subject_type, subject_id, details)
    VALUES (${f.org.organizationId}, ${f.fid}, ${kind}, ${severity}, ${subject.type}, ${subject.id}, '{"pending": 2}')
    RETURNING id`;
  return a?.id ?? '';
}

async function authoritative(f: ContinuityFixture): Promise<string> {
  return JSON.stringify([
    await t.db`SELECT row_to_json(qs)::text AS r FROM queue_sessions qs WHERE id = ${f.queueId}`,
    await t.db`SELECT row_to_json(x)::text AS r FROM tickets x WHERE queue_session_id = ${f.queueId} ORDER BY id`,
    await t.db`SELECT row_to_json(e)::text AS r FROM queue_events e WHERE queue_session_id = ${f.queueId} ORDER BY sequence`,
    await t.db`SELECT row_to_json(d)::text AS r FROM devices d WHERE facility_id = ${f.fid} ORDER BY id`,
  ]);
}

// ---------------------------------------------------------------------------------------------
// 8.D1 recipients and permissions
// ---------------------------------------------------------------------------------------------

describe('8.D1 who sees and who acknowledges alerts', () => {
  it('supervisor, facility admin and org admin see all alerts; only QUEUE_MANAGE acknowledges; auditors read only', async () => {
    const f = await setupContinuity(t.app);
    const facAdmin = await createStaff(t.app, f.org, f.fid, 'facility_admin');
    const auditor = await createStaff(t.app, f.org, f.fid, 'auditor');
    const id = await openAlert(f, 'device_stale_pending', {
      type: 'device',
      id: f.counter.deviceId,
    });
    for (const c of [f.supervisor.client, facAdmin.client, f.org.admin, auditor.client]) {
      const r = await health(c, f.fid);
      expect(r.status).toBe(200);
      expect(r.body.health?.alerts.map((a) => a.id)).toContain(id);
    }
    // auditors and staff without QUEUE_MANAGE cannot acknowledge
    expect((await ack(auditor.client, f.fid, id)).status).toBe(403);
    expect((await ack(f.counter.client, f.fid, id)).status).toBe(403);
    expect((await ack(f.reception.client, f.fid, id)).status).toBe(403);
    const [still] = await t.db<
      { acknowledged_at: Date | null }[]
    >`SELECT acknowledged_at FROM health_alerts WHERE id = ${id}`;
    expect(still?.acknowledged_at).toBeNull();
    // supervisor acknowledges
    const r = await ack(f.supervisor.client, f.fid, id);
    expect(r.status).toBe(200);
    expect(r.body.alert?.status).toBe('acknowledged');
    expect(r.body.alert?.acknowledged_by_name).toBe('Staff supervisor');
  });

  it('counter and reception staff do not see the alert list, only warnings about their OWN device', async () => {
    const f = await setupContinuity(t.app);
    await openAlert(f, 'sync_failing', { type: 'device', id: f.counter.deviceId });
    for (const c of [f.counter.client, f.reception.client]) {
      expect((await health(c, f.fid)).status).toBe(403);
      const s = await c.get<{ summary: { open: number } }>('/api/v1/health/alerts/summary');
      expect(s.body.summary.open).toBe(0);
    }
    expect((await own(f.counter.client, f.counter.deviceId)).status).toBe(200);
    // someone else's device: indistinguishable from a device that does not exist
    expect((await own(f.counter.client, f.reception.deviceId)).status).toBe(404);
    expect((await own(f.reception.client, f.counter.deviceId)).status).toBe(404);
  });

  it('cross-tenant: another organization sees nothing and cannot acknowledge (404)', async () => {
    const a = await setupContinuity(t.app);
    const b = await setupContinuity(t.app);
    const id = await openAlert(a, 'coordinator_offline', { type: 'queue', id: a.queueId }, 'high');
    expect((await health(b.supervisor.client, a.fid)).status).toBe(404);
    expect((await ack(b.supervisor.client, a.fid, id)).status).toBe(404);
    // even through its OWN facility path, another tenant's alert id is unknown
    expect((await ack(b.supervisor.client, b.fid, id)).status).toBe(404);
    expect((await own(b.counter.client, a.counter.deviceId)).status).toBe(404);
    const s = await b.org.admin.get<{ summary: { open: number } }>('/api/v1/health/alerts/summary');
    expect(s.body.summary.open).toBe(0);
    const [row] = await t.db<
      { acknowledged_at: Date | null }[]
    >`SELECT acknowledged_at FROM health_alerts WHERE id = ${id}`;
    expect(row?.acknowledged_at).toBeNull();
  });

  it('the banner summary counts unacknowledged open alerts per facility the caller may see', async () => {
    const f = await setupContinuity(t.app);
    const auditor = await createStaff(t.app, f.org, f.fid, 'auditor');
    const hi = await openAlert(f, 'coordinator_offline', { type: 'queue', id: f.queueId }, 'high');
    await openAlert(f, 'sync_failing', { type: 'device', id: f.counter.deviceId });
    for (const c of [f.supervisor.client, f.org.admin, auditor.client]) {
      const s = await c.get<{
        summary: { open: number; high: number; facilities: { facility_id: string }[] };
      }>('/api/v1/health/alerts/summary');
      expect(s.body.summary).toMatchObject({ open: 2, high: 1 });
      expect(s.body.summary.facilities.map((x) => x.facility_id)).toEqual([f.fid]);
    }
    await ack(f.supervisor.client, f.fid, hi);
    const after = await f.supervisor.client.get<{ summary: { open: number; high: number } }>(
      '/api/v1/health/alerts/summary',
    );
    expect(after.body.summary).toMatchObject({ open: 1, high: 0 });
  });
});

describe('8.D3 acknowledgement is audited, idempotent and changes nothing else', () => {
  it('one audit event with the kind only; a second acknowledgement changes nothing; a resolved alert is 409', async () => {
    const f = await setupContinuity(t.app);
    const id = await openAlert(f, 'coordinator_offline', { type: 'queue', id: f.queueId }, 'high');
    const before = await authoritative(f);
    expect((await ack(f.supervisor.client, f.fid, id)).status).toBe(200);
    expect((await ack(f.supervisor.client, f.fid, id)).status).toBe(200);
    const events = await t.db<
      { actor_id: string; details: Record<string, unknown>; target_id: string }[]
    >`
      SELECT actor_id, details, target_id FROM admin_events
       WHERE organization_id = ${f.org.organizationId} AND event_type = 'health_alert.acknowledge'`;
    expect(events).toEqual([
      { actor_id: f.supervisor.userId, details: { kind: 'coordinator_offline' }, target_id: id },
    ]);
    // the alert is NOT resolved by acknowledging, and no queue, coordinator or device changed
    const [row] = await t.db<
      { resolved_at: Date | null }[]
    >`SELECT resolved_at FROM health_alerts WHERE id = ${id}`;
    expect(row?.resolved_at).toBeNull();
    expect(await authoritative(f)).toBe(before);
    const id2 = await openAlert(f, 'sync_failing', { type: 'device', id: f.counter.deviceId });
    await t.db`UPDATE health_alerts SET resolved_at = NOW(), resolved_reason = 'condition_cleared' WHERE id = ${id2}`;
    expect((await ack(f.supervisor.client, f.fid, id2)).status).toBe(409);
  });
});

// ---------------------------------------------------------------------------------------------
// 8.D2 privacy
// ---------------------------------------------------------------------------------------------

describe('8.D2 privacy-minimal device data', () => {
  it('no column of devices or health_alerts can hold an IP, user agent, fingerprint or location', async () => {
    const cols = await t.db<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('devices', 'health_alerts', 'health_evaluations')`;
    const names = cols.map((c) => `${c.table_name}.${c.column_name}`);
    expect(
      names.filter((n) =>
        /ip|addr|agent|ua\b|finger|location|geo|lat|lon|browser|platform/i.test(n),
      ),
    ).toEqual([]);
  });

  it('the heartbeat is strict and minimal: extra fields (ip, user agent, location, device clock) are rejected', async () => {
    const f = await setupContinuity(t.app);
    for (const extra of [
      { ip: '203.0.113.9' },
      { user_agent: 'Mozilla/5.0' },
      { location: { lat: 6.5, lon: 3.4 } },
      { client_time: '2030-01-01T00:00:00Z' },
      { label: 'Ada Lovelace' },
    ]) {
      expect(
        (await beat(f.counter.client, f.counter.deviceId, { pending_count: 0, ...extra })).status,
      ).toBe(400);
    }
    expect(Object.keys(DeviceHeartbeatRequestSchema.shape).sort()).toEqual([
      'failure_code',
      'pending_count',
    ]);
    expect((await beat(f.counter.client, f.counter.deviceId, { pending_count: 1 })).status).toBe(
      204,
    );
  });

  it('the dashboard response carries no network or browser identifiers', async () => {
    const f = await setupContinuity(t.app);
    await openAlert(f, 'sync_failing', { type: 'device', id: f.counter.deviceId });
    const body = JSON.stringify((await health(f.supervisor.client, f.fid)).body);
    expect(body).not.toMatch(/127\.0\.0\.1|::1|lightMyRequest|user[-_]?agent|"ip"/i);
  });

  it('static check: device and health code never reads request addresses or user-agent headers', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of [
      'queue/devices.ts',
      'queue/health.ts',
      'queue/health-alerts.ts',
      '../../worker/src/health.ts',
    ]) {
      const src = readFileSync(resolve(here, file), 'utf8');
      expect(src, file).not.toMatch(/user-agent|req\.ip|remoteAddress|x-forwarded-for|headers\[/i);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 8.D6 states by server time
// ---------------------------------------------------------------------------------------------

describe('8.D6 states and thresholds by server time', () => {
  it('offline after 120 s, stale after 900 s, regardless of anything the device says', async () => {
    const f = await setupContinuity(t.app);
    const state = async (): Promise<string | undefined> =>
      (await health(f.supervisor.client, f.fid)).body.health?.devices.find(
        (d) => d.id === f.counter.deviceId,
      )?.health;
    await beat(f.counter.client, f.counter.deviceId, { pending_count: 0 });
    expect(await state()).toBe('healthy');
    await t.db`UPDATE devices SET last_seen_at = NOW() - INTERVAL '121 seconds' WHERE id = ${f.counter.deviceId}`;
    expect(await state()).toBe('offline');
    await t.db`UPDATE devices SET last_seen_at = NOW() - INTERVAL '901 seconds' WHERE id = ${f.counter.deviceId}`;
    expect(await state()).toBe('stale');
    // a heartbeat restores it; the server stamps the time, the device cannot
    await beat(f.counter.client, f.counter.deviceId, { pending_count: 0 });
    expect(await state()).toBe('healthy');
    const h = (await health(f.supervisor.client, f.fid)).body.health;
    expect(h?.stale_after_seconds).toBe(900);
    expect(h?.coordinator_expiry_warn_seconds).toBe(300);
  });

  it('configured thresholds are honoured', async () => {
    const custom = await createTestApp({
      DEVICE_STALE_AFTER_SECONDS: '200',
      COORDINATOR_EXPIRY_WARN_SECONDS: '900',
    });
    try {
      const f = await setupContinuity(custom.app);
      await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId, {
        ttl_minutes: 10,
      });
      await custom.db`UPDATE devices SET last_seen_at = NOW() - INTERVAL '201 seconds' WHERE id = ${f.counter.deviceId}`;
      const h = (await health(f.supervisor.client, f.fid)).body.health;
      const d = h?.devices.find((x) => x.id === f.counter.deviceId);
      expect(d?.health).toBe('stale');
      expect(d?.coordinator_for[0]?.expiring).toBe(true);
      expect(h?.stale_after_seconds).toBe(200);
    } finally {
      await custom.close();
    }
  });

  it('a coordinator authorization is expiring inside the window and expired after it, on read', async () => {
    const f = await setupContinuity(t.app);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const cond = async (): Promise<{ expiring: boolean; expired: boolean } | undefined> =>
      (await health(f.supervisor.client, f.fid)).body.health?.devices.find(
        (d) => d.id === f.counter.deviceId,
      )?.coordinator_for[0];
    expect(await cond()).toMatchObject({ expiring: false, expired: false });
    await t.db`UPDATE queue_sessions SET coordinator_expires_at = NOW() + INTERVAL '100 seconds' WHERE id = ${f.queueId}`;
    expect(await cond()).toMatchObject({ expiring: true, expired: false });
    await t.db`UPDATE queue_sessions SET coordinator_expires_at = NOW() - INTERVAL '1 second' WHERE id = ${f.queueId}`;
    expect(await cond()).toMatchObject({ expiring: false, expired: true });
  });

  it('"automatic alerts are paused" when the last evaluation is older than 3 intervals', async () => {
    const f = await setupContinuity(t.app);
    await t.db`
      INSERT INTO health_evaluations (id, last_evaluated_at) VALUES (TRUE, NOW())
      ON CONFLICT (id) DO UPDATE SET last_evaluated_at = NOW()`;
    expect((await health(f.supervisor.client, f.fid)).body.health?.evaluation.paused).toBe(false);
    // 3 intervals of 30 s: 89 s old is still running, 91 s old is paused
    await t.db`UPDATE health_evaluations SET last_evaluated_at = NOW() - INTERVAL '89 seconds'`;
    expect((await health(f.supervisor.client, f.fid)).body.health?.evaluation).toMatchObject({
      paused: false,
      interval_seconds: 30,
    });
    await t.db`UPDATE health_evaluations SET last_evaluated_at = NOW() - INTERVAL '91 seconds'`;
    expect((await health(f.supervisor.client, f.fid)).body.health?.evaluation.paused).toBe(true);
    await t.db`UPDATE health_evaluations SET last_evaluated_at = NOW()`;
  });
});

describe('sync_failing streak and own-device warnings', () => {
  it('the same failure three times in a row, from the device itself; a clean report or a sync resets it', async () => {
    const f = await setupContinuity(t.app);
    const streak = async (): Promise<number> =>
      (
        await t.db<
          { n: number }[]
        >`SELECT failure_streak AS n FROM devices WHERE id = ${f.counter.deviceId}`
      )[0]?.n ?? -1;
    const fail = (code: string): Promise<{ status: number }> =>
      beat(f.counter.client, f.counter.deviceId, { pending_count: 1, failure_code: code });
    await fail('sync_failed');
    await fail('sync_failed');
    expect(await streak()).toBe(2);
    await fail('storage_unavailable');
    expect(await streak()).toBe(1);
    await fail('storage_unavailable');
    await fail('storage_unavailable');
    expect(await streak()).toBe(3);
    const w = await own(f.counter.client, f.counter.deviceId);
    expect(w.body.device?.warnings.map((x) => x.kind)).toEqual(['sync_failing']);
    await beat(f.counter.client, f.counter.deviceId, { pending_count: 0 });
    expect(await streak()).toBe(0);
    await fail('sync_failed');
    // a successful sync batch also resets it
    await syncBatch(f.reception.client, [
      f.cmd(f.reception, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() }),
    ]);
    const r = await syncBatch(f.counter.client, [
      f.cmd(f.counter, QueueAction.TICKET_CREATE, { temporary_ref: tempRef() }),
    ]);
    expect(r.status).toBe(200);
    expect(await streak()).toBe(0);
  });

  it('the coordinator sees its own authorization expiring and expired', async () => {
    const f = await setupContinuity(t.app);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    expect((await own(f.counter.client, f.counter.deviceId)).body.device?.warnings).toEqual([]);
    await t.db`UPDATE queue_sessions SET coordinator_expires_at = NOW() + INTERVAL '60 seconds' WHERE id = ${f.queueId}`;
    const w = (await own(f.counter.client, f.counter.deviceId)).body.device?.warnings ?? [];
    expect(w).toMatchObject([
      { kind: 'coordinator_expiring', queue_id: f.queueId, severity: 'medium' },
    ]);
    await t.db`UPDATE queue_sessions SET coordinator_expires_at = NOW() - INTERVAL '5 seconds' WHERE id = ${f.queueId}`;
    expect((await own(f.counter.client, f.counter.deviceId)).body.device?.warnings).toMatchObject([
      { kind: 'coordinator_expired', severity: 'high' },
    ]);
    // nobody else's device gets this warning
    expect((await own(f.reception.client, f.reception.deviceId)).body.device?.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 8.D4 authority unchanged; 8.D5 lost devices
// ---------------------------------------------------------------------------------------------

describe('8.D4 health never changes coordinator authority; failover stays explicit', () => {
  it('an open coordinator_offline alert, acknowledged, leaves the coordinator in place until a supervisor fails over', async () => {
    const f = await setupContinuity(t.app);
    await visitorJoin(t.app, f.queueId);
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    await t.db`UPDATE devices SET last_seen_at = NOW() - INTERVAL '1 hour' WHERE id = ${f.counter.deviceId}`;
    const id = await openAlert(f, 'coordinator_offline', { type: 'queue', id: f.queueId }, 'high');
    const before = await authoritative(f);
    await ack(f.supervisor.client, f.fid, id);
    for (let i = 0; i < 3; i++) await health(f.supervisor.client, f.fid);
    await own(f.counter.client, f.counter.deviceId);
    expect(await authoritative(f)).toBe(before);
    const [s] = await t.db<{ coordinator_device_id: string; coordinator_epoch: number }[]>`
      SELECT coordinator_device_id, coordinator_epoch FROM queue_sessions WHERE id = ${f.queueId}`;
    expect(s?.coordinator_device_id).toBe(f.counter.deviceId);
    // the supervisor's explicit, audited failover is what changes authority (and fences)
    const fo = await failoverCoordinator(f.supervisor.client, f.queueId, f.supervisor.deviceId);
    expect(fo.status).toBe(200);
    expect(fo.body.coordinator?.epoch).toBe((s?.coordinator_epoch ?? 0) + 1);
    const types = await assertEventLogIntact(t.db, f.queueId);
    expect(types).toContain('coordinator.failover');
  });
});

describe('8.D5 lost, revoked and re-registered devices', () => {
  it('revoke as lost: last contact and pending count kept with the reason; syncs, heartbeats and own-health refused; re-registering gives a NEW device', async () => {
    const f = await setupContinuity(t.app);
    await beat(f.counter.client, f.counter.deviceId, { pending_count: 4 });
    await assignCoordinator(f.supervisor.client, f.queueId, f.counter.deviceId);
    const auth = await f.authorityFor(f.counter);
    const rv = await f.supervisor.client.post(`/api/v1/devices/${f.counter.deviceId}/revoke`, {
      reason_code: 'lost',
    });
    expect(rv.status).toBe(200);
    const d = (await health(f.supervisor.client, f.fid)).body.health?.devices.find(
      (x) => x.id === f.counter.deviceId,
    );
    expect(d).toMatchObject({ health: 'revoked', revoked_reason: 'lost', pending_count: 4 });
    expect(d?.last_seen_at).not.toBeNull();
    // revoking also ended its coordinator authority (M3, audited)
    const [s] = await t.db<{ coordinator_device_id: string | null }[]>`
      SELECT coordinator_device_id FROM queue_sessions WHERE id = ${f.queueId}`;
    expect(s?.coordinator_device_id).toBeNull();
    // its unsent actions can never be applied: the whole batch is refused
    const snap = await snapshot(f.supervisor.client, f.queueId, f.supervisor.deviceId);
    const res = await syncBatch(
      f.counter.client,
      [
        f.cmd(
          f.counter,
          QueueAction.TICKET_CALL_NEXT,
          { counter_id: f.counterIds[0] },
          { epoch: 1, baseRevision: snap.body.snapshot.revision },
        ),
      ],
      [auth],
    );
    expect(res.status).toBe(403);
    expect((res.body as unknown as { type?: string }).type).toMatch(/device-revoked/);
    expect((await beat(f.counter.client, f.counter.deviceId, { pending_count: 4 })).status).toBe(
      403,
    );
    expect((await own(f.counter.client, f.counter.deviceId)).status).toBe(403);
    // it stays revoked; the same person registers again and gets a different device
    const again = await registerDevice(f.counter.client, f.fid, 'Replacement tablet');
    expect(again).not.toBe(f.counter.deviceId);
    const [still] = await t.db<
      { revoked_at: Date | null }[]
    >`SELECT revoked_at FROM devices WHERE id = ${f.counter.deviceId}`;
    expect(still?.revoked_at).not.toBeNull();
    const audit = await t.db<{ details: Record<string, unknown> }[]>`
      SELECT details FROM admin_events WHERE event_type = 'device.revoke' AND target_id = ${f.counter.deviceId}`;
    expect(audit).toEqual([{ details: { reason_code: 'lost' } }]);
  });

  it('a revoked device row is retained (audit and operation history keep their references)', async () => {
    const q = await setupQueue(t.app, { counters: 1 });
    const sup = await createStaff(t.app, q.org, q.fid, 'supervisor');
    const dev = await registerDevice(sup.client, q.fid, 'Old phone');
    await sup.client.post(`/api/v1/devices/${dev}/revoke`, { reason_code: 'retired' });
    expect(await t.db`SELECT 1 FROM devices WHERE id = ${dev}`).toHaveLength(1);
  });
});
