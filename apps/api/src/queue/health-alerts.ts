import type { Role, AlertSummary, HealthAlert, OwnDeviceHealth } from '@queuebridge/contracts';
import { coordinatorCondition } from '@queuebridge/domain';
import { recordAdminEvent } from '../admin-events.js';
import {
  isOrgAdmin,
  Permission,
  requireFacilityPermission,
  type AuthContext,
} from '../auth/rbac.js';
import type { Db } from '../db.js';
import { problems } from '../errors.js';
import { findOwnDevice } from './devices.js';
import { facilityAlerts, type HealthConfig } from './health.js';

/**
 * M5.3 alert actions (REQ-F9.8). Reading is `OPERATIONS_VIEW` (supervisor, facility admin, org
 * admin; auditors read only); acknowledging is `QUEUE_MANAGE`. Every query is scoped by the
 * session's organization AND the facility; another tenant's alert is a 404.
 *
 * Acknowledging records who has seen it. It does NOT resolve the alert, change any queue,
 * coordinator, device or ticket, or silence the condition: the alert resolves only when the
 * evaluator sees the condition clear (twice).
 */
export async function acknowledgeAlert(
  db: Db,
  auth: AuthContext,
  facilityId: string,
  alertId: string,
): Promise<HealthAlert> {
  const f = await requireFacilityPermission(db, auth, facilityId, 'QUEUE_MANAGE');
  const result = await db.begin(async (tx) => {
    const [a] = await tx<
      { id: string; kind: string; acknowledged_at: Date | null; resolved_at: Date | null }[]
    >`
      SELECT id, kind, acknowledged_at, resolved_at FROM health_alerts
       WHERE id = ${alertId} AND organization_id = ${auth.organizationId} AND facility_id = ${f.id}
       FOR UPDATE`;
    if (!a) throw problems.notFound();
    if (a.resolved_at) {
      throw problems.conflict('This alert has already resolved; there is nothing to acknowledge.');
    }
    // Idempotent: the first acknowledgement is kept and audited once
    if (a.acknowledged_at) return { changed: false };
    await tx`
      UPDATE health_alerts SET acknowledged_at = NOW(), acknowledged_by = ${auth.staffUserId}
       WHERE id = ${a.id}`;
    await recordAdminEvent(tx, {
      organizationId: auth.organizationId,
      facilityId: f.id,
      actorId: auth.staffUserId,
      eventType: 'health_alert.acknowledge',
      targetType: 'health_alert',
      targetId: a.id,
      details: { kind: a.kind },
    });
    return { changed: true };
  });
  void result;
  const all = await facilityAlerts(db, auth.organizationId, f.id);
  const found = all.find((x) => x.id === alertId);
  if (!found) throw problems.notFound();
  return found;
}

/**
 * Open alerts across the facilities where the caller may see them (signed-in banner). Callers
 * without `OPERATIONS_VIEW` anywhere get an empty summary (never another person's alerts).
 */
export async function alertSummary(db: Db, auth: AuthContext): Promise<AlertSummary> {
  const viewRoles: readonly Role[] = Permission.OPERATIONS_VIEW;
  const facilityIds = auth.roles
    .filter((r) => r.facility_id !== null && viewRoles.includes(r.role))
    .map((r) => r.facility_id as string);
  const all = isOrgAdmin(auth);
  if (!all && facilityIds.length === 0) return { open: 0, high: 0, facilities: [] };
  const rows = await db<
    { facility_id: string; facility_name: string; open: number; high: number }[]
  >`
    SELECT a.facility_id, f.name AS facility_name, COUNT(*)::int AS open,
           COUNT(*) FILTER (WHERE a.severity = 'high')::int AS high
      FROM health_alerts a JOIN facilities f ON f.id = a.facility_id
     WHERE a.organization_id = ${auth.organizationId} AND f.organization_id = ${auth.organizationId}
       AND a.resolved_at IS NULL AND a.acknowledged_at IS NULL
       AND (${all} OR a.facility_id = ANY(${facilityIds}::uuid[]))
     GROUP BY a.facility_id, f.name
     ORDER BY high DESC, open DESC, f.name
     LIMIT 50`;
  return {
    open: rows.reduce((n, r) => n + r.open, 0),
    high: rows.reduce((n, r) => n + r.high, 0),
    facilities: rows,
  };
}

/**
 * Warnings about the caller's OWN device (REQ-F9.8), computed on read by server time so they are
 * right even when the alert worker is down. Only the owner can read them (404 otherwise).
 */
export async function ownDeviceHealth(
  db: Db,
  auth: AuthContext,
  deviceId: string,
  cfg: HealthConfig,
): Promise<OwnDeviceHealth> {
  const own = await findOwnDevice(db, auth, deviceId);
  if (!own) throw problems.notFound();
  const [d] = await db<
    {
      now: Date;
      revoked_at: Date | null;
      failure_streak: number;
    }[]
  >`
    SELECT NOW() AS now, revoked_at, failure_streak
      FROM devices WHERE id = ${own.id}`;
  if (!d) throw problems.notFound();
  if (d.revoked_at) throw problems.deviceRevoked();
  const now = d.now;
  const warnings: OwnDeviceHealth['warnings'] = [];
  const coordinated = await db<{ id: string; service_name: string; expires_at: Date }[]>`
    SELECT qs.id, s.name AS service_name, qs.coordinator_expires_at AS expires_at
      FROM queue_sessions qs JOIN services s ON s.id = qs.service_id
     WHERE qs.organization_id = ${auth.organizationId} AND qs.coordinator_device_id = ${own.id}
     ORDER BY qs.coordinator_expires_at`;
  for (const q of coordinated) {
    const c = coordinatorCondition(q.expires_at, now, cfg);
    if (c === 'expiring' || c === 'expired') {
      warnings.push({
        kind: c === 'expiring' ? 'coordinator_expiring' : 'coordinator_expired',
        severity: c === 'expiring' ? 'medium' : 'high',
        queue_id: q.id,
        service_name: q.service_name,
        expires_at: q.expires_at.toISOString(),
      });
    }
  }
  if (d.failure_streak >= 3) {
    warnings.push({
      kind: 'sync_failing',
      severity: 'medium',
      queue_id: null,
      service_name: null,
      expires_at: null,
    });
  }
  return { device_id: own.id, server_time: now.toISOString(), warnings };
}
