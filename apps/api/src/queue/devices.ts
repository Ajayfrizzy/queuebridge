import {
  QueueAction,
  type Device,
  type DeviceHeartbeatRequest,
  type RegisterDeviceRequest,
  type RevokeDeviceRequest,
} from '@queuebridge/contracts';
import { recordAdminEvent } from '../admin-events.js';
import { requireFacilityPermission, type AuthContext } from '../auth/rbac.js';
import type { Db } from '../db.js';
import { problems } from '../errors.js';
import { appendEvent, lockSessions } from './events.js';

/** A staff user may hold this many live devices per facility (stops runaway registration). */
export const MAX_ACTIVE_DEVICES_PER_USER = 20;

export interface DeviceRow {
  id: string;
  organization_id: string;
  facility_id: string;
  staff_user_id: string;
  label: string | null;
  created_at: Date;
  revoked_at: Date | null;
}

const toDevice = (d: DeviceRow): Device => ({
  id: d.id,
  facility_id: d.facility_id,
  label: d.label,
  created_at: d.created_at.toISOString(),
  revoked_at: d.revoked_at?.toISOString() ?? null,
});

/**
 * Register the calling browser profile as a device of the authenticated staff user.
 * The device holds no secret: it is authenticated by its owner's session on every request, and
 * the server checks ownership, tenant, facility and revocation each time.
 */
export async function registerDevice(
  db: Db,
  auth: AuthContext,
  body: RegisterDeviceRequest,
): Promise<Device> {
  const facility = await requireFacilityPermission(db, auth, body.facility_id, 'WALK_IN');
  const live = await db<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM devices
     WHERE staff_user_id = ${auth.staffUserId} AND facility_id = ${facility.id} AND revoked_at IS NULL`;
  if ((live[0]?.n ?? 0) >= MAX_ACTIVE_DEVICES_PER_USER) {
    throw problems.conflict(
      'Too many registered devices for this facility. Ask a supervisor to revoke unused devices.',
    );
  }
  const rows = await db<DeviceRow[]>`
    INSERT INTO devices (facility_id, organization_id, staff_user_id, public_key_or_session, label, last_seen_at)
    VALUES (${facility.id}, ${auth.organizationId}, ${auth.staffUserId}, 'session-bound',
            ${body.label ?? null}, NOW())
    RETURNING id, organization_id, facility_id, staff_user_id, label, created_at, revoked_at`;
  const device = rows[0];
  if (!device) throw new Error('device insert returned no row');
  await recordAdminEvent(db, {
    organizationId: auth.organizationId,
    facilityId: facility.id,
    actorId: auth.staffUserId,
    eventType: 'device.register',
    targetType: 'device',
    targetId: device.id,
  });
  return toDevice(device);
}

/** The caller's own, tenant-scoped device (any state), or null — never another user's. */
export async function findOwnDevice(
  db: Db,
  auth: AuthContext,
  deviceId: string,
): Promise<DeviceRow | null> {
  const rows = await db<DeviceRow[]>`
    SELECT id, organization_id, facility_id, staff_user_id, label, created_at, revoked_at
      FROM devices
     WHERE id = ${deviceId} AND organization_id = ${auth.organizationId}
       AND staff_user_id = ${auth.staffUserId}`;
  return rows[0] ?? null;
}

/** Record a device's self-reported health. Display only: never used to decide correctness. */
export async function recordHeartbeat(
  db: Db,
  auth: AuthContext,
  deviceId: string,
  body: DeviceHeartbeatRequest,
): Promise<void> {
  const device = await findOwnDevice(db, auth, deviceId);
  if (!device) throw problems.notFound();
  if (device.revoked_at) throw deviceRevoked();
  // M5.3: `failure_streak` counts identical consecutive failure reports (`sync_failing`); the
  // rule is `nextFailureStreak` in @queuebridge/domain, applied here atomically in SQL
  const code = body.failure_code ?? null;
  await db`
    UPDATE devices
       SET last_seen_at = NOW(), reported_pending_count = ${body.pending_count},
           failure_streak = CASE
             WHEN ${code}::text IS NULL THEN 0
             WHEN last_failure_code = ${code}::text THEN failure_streak + 1
             ELSE 1 END,
           last_failure_code = ${code}
     WHERE id = ${device.id}`;
}

export function deviceRevoked(): Error {
  return problems.deviceRevoked();
}

/**
 * Revoke a device (supervisor / facility admin). Any queue it coordinates loses authority in
 * the same transaction (epoch advances, so its pending offline work is fenced into review),
 * and both the revocation and each coordinator loss are audited. Idempotent.
 */
export async function revokeDevice(
  db: Db,
  auth: AuthContext,
  deviceId: string,
  body: RevokeDeviceRequest,
): Promise<Device> {
  const found = await db<DeviceRow[]>`
    SELECT id, organization_id, facility_id, staff_user_id, label, created_at, revoked_at
      FROM devices WHERE id = ${deviceId} AND organization_id = ${auth.organizationId}`;
  const target = found[0];
  if (!target) throw problems.notFound();
  await requireFacilityPermission(db, auth, target.facility_id, 'QUEUE_MANAGE');

  const result = await db.begin(async (tx) => {
    const locked = await tx<DeviceRow[]>`
      SELECT id, organization_id, facility_id, staff_user_id, label, created_at, revoked_at
        FROM devices WHERE id = ${target.id} AND organization_id = ${auth.organizationId} FOR UPDATE`;
    const device = locked[0];
    if (!device) throw problems.notFound();
    if (device.revoked_at) return { device, changed: false };

    const updated = await tx<DeviceRow[]>`
      UPDATE devices SET revoked_at = NOW(), revoked_by = ${auth.staffUserId},
             revoked_reason_code = ${body.reason_code}
       WHERE id = ${device.id}
      RETURNING id, organization_id, facility_id, staff_user_id, label, created_at, revoked_at`;

    const coordinated = await tx<{ id: string }[]>`
      SELECT id FROM queue_sessions
       WHERE coordinator_device_id = ${device.id} AND organization_id = ${auth.organizationId}
       ORDER BY id`;
    const sessions = await lockSessions(
      tx,
      auth.organizationId,
      coordinated.map((c) => c.id),
    );
    for (const s of sessions.values()) {
      // Re-check under the lock: a failover may have replaced this device meanwhile
      if (s.coordinator_device_id !== device.id) continue;
      const previousEpoch = s.coordinator_epoch;
      await tx`
        UPDATE queue_sessions
           SET coordinator_epoch = coordinator_epoch + 1, coordinator_device_id = NULL,
               coordinator_granted_at = NULL, coordinator_expires_at = NULL,
               coordinator_allowed_actions = '{}', coordinator_granted_by = NULL, updated_at = NOW()
         WHERE id = ${s.id}`;
      await appendEvent(tx, s, {
        eventType: QueueAction.COORDINATOR_REVOKE,
        actorId: auth.staffUserId,
        operationId: null,
        payload: {
          device_id: device.id,
          previous_epoch: previousEpoch,
          epoch: previousEpoch + 1,
          reason_code: 'device_revoked',
        },
      });
    }
    await tx`
      INSERT INTO admin_events (organization_id, facility_id, actor_id, event_type, target_type, target_id, details)
      VALUES (${auth.organizationId}, ${device.facility_id}, ${auth.staffUserId}, 'device.revoke',
              'device', ${device.id}, ${tx.json({ reason_code: body.reason_code })})`;
    return { device: updated[0] ?? device, changed: true };
  });
  return toDevice(result.device);
}
