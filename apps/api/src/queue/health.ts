import {
  type DeviceHealth,
  type DeviceHealthState,
  type OperationsHealth,
  type QueueHealth,
} from '@queuebridge/contracts';
import type { Db } from '../db.js';
import { coordinatorStatus } from './authority.js';

/** A device not heard from for this long is shown as offline. */
export const OFFLINE_AFTER_SECONDS = 120;

interface DeviceRow {
  id: string;
  label: string | null;
  owner_name: string;
  last_seen_at: Date | null;
  last_sync_at: Date | null;
  reported_pending_count: number;
  last_failure_code: string | null;
  revoked_at: Date | null;
  needs_review_count: number;
  rejected_count: number;
}

interface QueueRow {
  id: string;
  service_name: string;
  state: string;
  revision: number;
  coordinator_epoch: number;
  coordinator_device_id: string | null;
  coordinator_granted_at: Date | null;
  coordinator_expires_at: Date | null;
  coordinator_allowed_actions: string[];
  coordinator_label: string | null;
  open_conflicts: number;
}

export function deviceHealthState(
  d: Pick<
    DeviceRow,
    'revoked_at' | 'needs_review_count' | 'last_seen_at' | 'reported_pending_count'
  >,
  now: Date,
): DeviceHealthState {
  if (d.revoked_at) return 'revoked';
  if (d.needs_review_count > 0) return 'needs_review';
  if (!d.last_seen_at || now.getTime() - d.last_seen_at.getTime() > OFFLINE_AFTER_SECONDS * 1000) {
    return 'offline';
  }
  return d.reported_pending_count > 0 ? 'pending' : 'healthy';
}

/**
 * Connectivity and recovery dashboard data for a facility (F9). Server API health is a separate
 * signal (/health/ready); this reports what the SERVER knows about each device — and says so:
 * pending counts are reported by the devices, so they are approximate.
 */
export async function operationsHealth(
  db: Db,
  organizationId: string,
  facilityId: string,
): Promise<OperationsHealth> {
  const now = new Date();
  const devices = await db<DeviceRow[]>`
    SELECT d.id, d.label, u.display_name AS owner_name, d.last_seen_at, d.last_sync_at,
           d.reported_pending_count, d.last_failure_code, d.revoked_at,
           (SELECT COUNT(*)::int FROM client_operations co
             WHERE co.device_id = d.id AND co.status = 'needs_review') AS needs_review_count,
           (SELECT COUNT(*)::int FROM client_operations co
             WHERE co.device_id = d.id AND co.status = 'rejected') AS rejected_count
      FROM devices d JOIN staff_users u ON u.id = d.staff_user_id
     WHERE d.organization_id = ${organizationId} AND d.facility_id = ${facilityId}
     ORDER BY (d.revoked_at IS NOT NULL), d.last_seen_at DESC NULLS LAST, d.created_at DESC
     LIMIT 200`;

  const queues = await db<QueueRow[]>`
    SELECT qs.id, s.name AS service_name, qs.state, qs.revision, qs.coordinator_epoch,
           qs.coordinator_device_id, qs.coordinator_granted_at, qs.coordinator_expires_at,
           qs.coordinator_allowed_actions, d.label AS coordinator_label,
           (SELECT COUNT(*)::int FROM client_operations co
             WHERE co.queue_session_id = qs.id AND co.status = 'needs_review') AS open_conflicts
      FROM queue_sessions qs
      JOIN services s ON s.id = qs.service_id
      JOIN facilities f ON f.id = qs.facility_id
      LEFT JOIN devices d ON d.id = qs.coordinator_device_id
     WHERE qs.organization_id = ${organizationId} AND qs.facility_id = ${facilityId}
       AND (qs.operational_date = (NOW() AT TIME ZONE f.timezone)::date
            OR qs.coordinator_device_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM client_operations co
                        WHERE co.queue_session_id = qs.id AND co.status = 'needs_review'))
     ORDER BY s.name, qs.operational_date DESC`;

  const queueHealth: QueueHealth[] = queues.map((q) => ({
    queue_id: q.id,
    service_name: q.service_name,
    state: q.state,
    revision: q.revision,
    coordinator: coordinatorStatus(q, q.coordinator_label, now),
    open_conflicts: q.open_conflicts,
  }));

  const deviceHealth: DeviceHealth[] = devices.map((d) => ({
    id: d.id,
    label: d.label,
    owner_name: d.owner_name,
    last_seen_at: d.last_seen_at?.toISOString() ?? null,
    last_sync_at: d.last_sync_at?.toISOString() ?? null,
    pending_count: d.reported_pending_count,
    needs_review_count: d.needs_review_count,
    rejected_count: d.rejected_count,
    health: deviceHealthState(d, now),
    last_failure_code: d.last_failure_code,
    revoked_at: d.revoked_at?.toISOString() ?? null,
    coordinator_for: queues
      .filter((q) => q.coordinator_device_id === d.id && q.coordinator_expires_at)
      .map((q) => ({
        queue_id: q.id,
        service_name: q.service_name,
        epoch: q.coordinator_epoch,
        expires_at: (q.coordinator_expires_at as Date).toISOString(),
        expired: (q.coordinator_expires_at as Date).getTime() <= now.getTime(),
      })),
  }));

  return {
    server_time: now.toISOString(),
    offline_after_seconds: OFFLINE_AFTER_SECONDS,
    devices: deviceHealth,
    queues: queueHealth,
    open_conflicts: queueHealth.reduce((n, q) => n + q.open_conflicts, 0),
  };
}
