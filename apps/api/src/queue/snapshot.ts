import { Role, type SyncSnapshot } from '@queuebridge/contracts';
import type { AuthContext } from '../auth/rbac.js';
import { loadRoles } from '../auth/session.js';
import type { Db } from '../db.js';
import type { Env } from '../env.js';
import { problems } from '../errors.js';
import { authoritySigningKey, coordinatorStatus, signAuthority } from './authority.js';
import { buildAuthority } from './coordinator.js';
import { findOwnDevice } from './devices.js';
import type { LockedSession } from './events.js';
import { staffQueueView } from './views.js';

/** Events returned per snapshot page; a device pages with `since_sequence` until caught up. */
export const SNAPSHOT_EVENT_LIMIT = 500;

interface SnapshotSession {
  id: string;
  facility_id: string;
  revision: number;
  last_sequence: number;
  coordinator_epoch: number;
  coordinator_device_id: string | null;
  coordinator_granted_at: Date | null;
  coordinator_expires_at: Date | null;
  coordinator_allowed_actions: string[];
  coordinator_granted_by: string | null;
  coordinator_label: string | null;
}

/**
 * Consistent view of a queue for a staff device: the staff projection, the committed events
 * after a cursor, and the coordinator state — all read in ONE repeatable-read snapshot so the
 * revision, events and tickets can never disagree. If the requesting device is the active
 * coordinator it also receives its signed, time-limited authority.
 */
export async function buildSnapshot(
  db: Db,
  env: Env,
  auth: AuthContext,
  queueId: string,
  deviceId: string | null,
  sinceSequence: number | null,
): Promise<SyncSnapshot> {
  const device = deviceId ? await findOwnDevice(db, auth, deviceId) : null;
  if (deviceId && !device) throw problems.deviceNotAuthorized();
  if (device?.revoked_at) throw problems.deviceRevoked();

  const snap = await db.begin('isolation level repeatable read read only', async (tx) => {
    const sessions = await tx<SnapshotSession[]>`
      SELECT qs.id, qs.facility_id, qs.revision, qs.last_sequence, qs.coordinator_epoch,
             qs.coordinator_device_id, qs.coordinator_granted_at, qs.coordinator_expires_at,
             qs.coordinator_allowed_actions, qs.coordinator_granted_by, d.label AS coordinator_label
        FROM queue_sessions qs LEFT JOIN devices d ON d.id = qs.coordinator_device_id
       WHERE qs.id = ${queueId} AND qs.organization_id = ${auth.organizationId}`;
    const session = sessions[0];
    if (!session) throw problems.notFound();
    if (device && device.facility_id !== session.facility_id) throw problems.deviceNotAuthorized();

    const queue = await staffQueueView(tx, auth.organizationId, queueId);
    if (!queue) throw problems.notFound();

    const events =
      sinceSequence === null
        ? []
        : await tx<
            {
              sequence: number;
              event_type: string;
              payload: Record<string, unknown>;
              committed_at: Date;
            }[]
          >`
            SELECT sequence, event_type, payload, committed_at FROM queue_events
             WHERE queue_session_id = ${queueId} AND sequence > ${sinceSequence}
             ORDER BY sequence LIMIT ${SNAPSHOT_EVENT_LIMIT + 1}`;
    const conflicts = await tx<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM client_operations
       WHERE queue_session_id = ${queueId} AND status = 'needs_review'`;
    const granterRoles = session.coordinator_granted_by
      ? await loadRoles(tx, session.coordinator_granted_by, auth.organizationId)
      : [];
    return { session, queue, events, conflicts: conflicts[0]?.n ?? 0, granterRoles };
  });

  const { session } = snap;
  const now = new Date();
  const status = coordinatorStatus(session, session.coordinator_label, now);
  const isThisDevice = device !== null && session.coordinator_device_id === device.id;

  let authority: string | null = null;
  if (isThisDevice && status.status === 'active' && session.coordinator_granted_by) {
    const issuerRole = snap.granterRoles.some(
      (g) => g.role === Role.SUPERVISOR && g.facility_id === session.facility_id,
    )
      ? Role.SUPERVISOR
      : snap.granterRoles.some((g) => g.role === Role.ORG_ADMIN)
        ? Role.SUPERVISOR
        : Role.FACILITY_ADMIN;
    const claims = buildAuthority(
      session as unknown as LockedSession,
      issuerRole,
      session.coordinator_granted_by,
    );
    // delivered_at is the SERVER's clock at hand-over: offline actions are timed from it
    if (claims) {
      authority = signAuthority(
        { ...claims, delivered_at: now.toISOString() },
        authoritySigningKey(env),
      );
    }
  }

  if (device) {
    await db`
      UPDATE devices SET last_seen_at = NOW() WHERE id = ${device.id}`;
    await db`
      INSERT INTO device_sync_cursors (device_id, queue_session_id, last_server_sequence, synced_at)
      VALUES (${device.id}, ${queueId}, ${session.last_sequence}, NOW())
      ON CONFLICT (device_id, queue_session_id)
      DO UPDATE SET last_server_sequence = GREATEST(device_sync_cursors.last_server_sequence, EXCLUDED.last_server_sequence),
                    synced_at = NOW()`;
  }

  const hasMore = snap.events.length > SNAPSHOT_EVENT_LIMIT;
  return {
    queue: snap.queue,
    revision: session.revision,
    last_sequence: session.last_sequence,
    events: snap.events.slice(0, SNAPSHOT_EVENT_LIMIT).map((e) => ({
      sequence: e.sequence,
      event_type: e.event_type,
      payload: e.payload,
      committed_at: e.committed_at.toISOString(),
    })),
    has_more_events: hasMore,
    coordinator: { ...status, is_this_device: isThisDevice },
    authority,
    open_conflicts: snap.conflicts,
    server_time: now.toISOString(),
  };
}
