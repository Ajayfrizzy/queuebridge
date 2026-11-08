import {
  ADVANCE_ACTIONS,
  QueueAction,
  QueueSessionState,
  Role,
  type CoordinatorAuth,
  type CoordinatorStatus,
} from '@queuebridge/contracts';
import type { AuthContext } from '../auth/rbac.js';
import { loadRoles } from '../auth/session.js';
import type { Db } from '../db.js';
import { problems } from '../errors.js';
import { coordinatorStatus } from './authority.js';
import { appendEvent, lockSessions, type LockedSession } from './events.js';

export type CoordinatorKind = 'assign' | 'failover' | 'renew' | 'revoke';

const EVENT_FOR: Record<CoordinatorKind, string> = {
  assign: QueueAction.COORDINATOR_ASSIGN,
  failover: QueueAction.COORDINATOR_FAILOVER,
  renew: QueueAction.COORDINATOR_RENEW,
  revoke: QueueAction.COORDINATOR_REVOKE,
};

export interface CoordinatorCommandInput {
  auth: AuthContext;
  queueId: string;
  facilityId: string;
  kind: CoordinatorKind;
  operationId: string;
  deviceId?: string;
  ttlMinutes?: number;
  allowedActions?: readonly string[];
  reasonCode?: string;
}

export interface CoordinatorCommandResult {
  disposition: 'committed' | 'duplicate';
  coordinator: CoordinatorStatus;
  server_revision: number;
  server_sequence: number;
}

interface StoredCoordinatorOp {
  queue_session_id: string;
  action: string;
  actor_id: string | null;
  result_json: CoordinatorCommandResult;
}

/** Roles that may physically operate a counter (and therefore coordinate offline advancement). */
const COORDINATOR_CAPABLE: readonly Role[] = [
  Role.STAFF_COUNTER,
  Role.SUPERVISOR,
  Role.FACILITY_ADMIN,
];

/**
 * Assign, fail over, renew or revoke the single offline coordinator of a queue session.
 *
 * Authority rules (ADR-006), all enforced under the session row lock:
 *  - exactly one coordinator device per session; assign requires none, failover requires one;
 *  - assign / failover / revoke ADVANCE the epoch, which fences every older coordinator —
 *    their later syncs are held for supervisor review, never applied;
 *  - renew extends the expiry of the SAME epoch (no fencing) and changes nothing else;
 *  - a device may only coordinate if its owner may call visitors, and is active, unrevoked and
 *    in the same facility;
 *  - every change is a hash-chained queue event naming the supervisor, device, epoch and reason.
 * These are online-only supervisor actions: they are not in the offline vocabulary, so a
 * coordinator can never reassign itself while disconnected.
 */
export async function coordinatorCommand(
  db: Db,
  input: CoordinatorCommandInput,
): Promise<CoordinatorCommandResult> {
  const { auth } = input;
  const action = EVENT_FOR[input.kind];

  return db.begin(async (tx) => {
    const locked = await lockSessions(tx, auth.organizationId, [input.queueId]);
    const session = locked.get(input.queueId);
    if (!session || session.facility_id !== input.facilityId) throw problems.notFound();

    const prior = await tx<StoredCoordinatorOp[]>`
      SELECT queue_session_id, action, actor_id, result_json FROM client_operations
       WHERE organization_id = ${auth.organizationId} AND operation_id = ${input.operationId}`;
    if (prior[0]) {
      const p = prior[0];
      if (
        p.queue_session_id !== session.id ||
        p.action !== action ||
        p.actor_id !== auth.staffUserId
      ) {
        throw problems.conflict('This operation id was already used for a different command.');
      }
      return { ...p.result_json, disposition: 'duplicate' as const };
    }

    const hasCoordinator = session.coordinator_device_id !== null;
    if (input.kind === 'assign' && hasCoordinator) {
      throw problems.conflict(
        'A coordinator is already assigned. Use failover to replace it, or revoke it first.',
      );
    }
    if (input.kind !== 'assign' && !hasCoordinator) {
      throw problems.conflict(
        input.kind === 'failover'
          ? 'There is no coordinator to replace. Assign one instead.'
          : 'No coordinator is assigned to this queue.',
      );
    }
    if (
      (input.kind === 'assign' || input.kind === 'failover') &&
      session.state === QueueSessionState.CLOSED
    ) {
      throw problems.conflict('This queue is closed; reopen it before designating a coordinator.');
    }

    const previousEpoch = session.coordinator_epoch;
    const previousDeviceId = session.coordinator_device_id;
    let deviceLabel: string | null = null;
    let newDeviceId: string | null = session.coordinator_device_id;
    const actions =
      input.allowedActions && input.allowedActions.length > 0
        ? [...new Set(input.allowedActions)]
        : [...ADVANCE_ACTIONS];

    if (input.kind === 'assign' || input.kind === 'failover') {
      const device = await requireCoordinatorDevice(tx, auth, session, input.deviceId);
      if (input.kind === 'failover' && device.id === previousDeviceId) {
        throw problems.conflict('That device is already the coordinator. Renew it instead.');
      }
      newDeviceId = device.id;
      deviceLabel = device.label;
    }

    const ttl = input.ttlMinutes ?? 0;
    if (input.kind === 'assign' || input.kind === 'failover') {
      await tx`
        UPDATE queue_sessions
           SET coordinator_epoch = coordinator_epoch + 1, coordinator_device_id = ${newDeviceId},
               coordinator_granted_at = NOW(),
               coordinator_expires_at = NOW() + make_interval(mins => ${ttl}),
               coordinator_allowed_actions = ${tx.array(actions)}::text[],
               coordinator_granted_by = ${auth.staffUserId}, updated_at = NOW()
         WHERE id = ${session.id}`;
    } else if (input.kind === 'renew') {
      await tx`
        UPDATE queue_sessions
           SET coordinator_expires_at = NOW() + make_interval(mins => ${ttl}), updated_at = NOW()
         WHERE id = ${session.id}`;
    } else {
      await tx`
        UPDATE queue_sessions
           SET coordinator_epoch = coordinator_epoch + 1, coordinator_device_id = NULL,
               coordinator_granted_at = NULL, coordinator_expires_at = NULL,
               coordinator_allowed_actions = '{}', coordinator_granted_by = NULL, updated_at = NOW()
         WHERE id = ${session.id}`;
    }

    const fresh = await tx<
      {
        coordinator_epoch: number;
        coordinator_device_id: string | null;
        coordinator_granted_at: Date | null;
        coordinator_expires_at: Date | null;
        coordinator_allowed_actions: string[];
        label: string | null;
      }[]
    >`
      SELECT qs.coordinator_epoch, qs.coordinator_device_id, qs.coordinator_granted_at,
             qs.coordinator_expires_at, qs.coordinator_allowed_actions, d.label
        FROM queue_sessions qs LEFT JOIN devices d ON d.id = qs.coordinator_device_id
       WHERE qs.id = ${session.id}`;
    const row = fresh[0];
    if (!row) throw new Error('queue session vanished while locked');
    Object.assign(session, {
      coordinator_epoch: row.coordinator_epoch,
      coordinator_device_id: row.coordinator_device_id,
      coordinator_granted_at: row.coordinator_granted_at,
      coordinator_expires_at: row.coordinator_expires_at,
      coordinator_allowed_actions: row.coordinator_allowed_actions,
    });

    const ev = await appendEvent(tx, session, {
      eventType: action,
      actorId: auth.staffUserId,
      operationId: input.operationId,
      payload: {
        epoch: row.coordinator_epoch,
        previous_epoch: previousEpoch,
        device_id: row.coordinator_device_id ?? previousDeviceId,
        previous_device_id: previousDeviceId,
        expires_at: row.coordinator_expires_at?.toISOString() ?? null,
        allowed_actions: row.coordinator_allowed_actions,
        reason_code: input.reasonCode ?? null,
      },
    });

    const result: CoordinatorCommandResult = {
      disposition: 'committed',
      coordinator: coordinatorStatus(session, row.label ?? deviceLabel, new Date()),
      server_revision: ev.revision,
      server_sequence: ev.sequence,
    };
    await tx`
      INSERT INTO client_operations
        (organization_id, queue_session_id, device_id, actor_id, operation_id, client_sequence,
         action, status, result_json, source)
      VALUES (${auth.organizationId}, ${session.id}, NULL, ${auth.staffUserId}, ${input.operationId},
              0, ${action}, 'committed', ${tx.json(result as never)}, 'online')`;
    return result;
  });
}

interface CandidateDevice {
  id: string;
  label: string | null;
  staff_user_id: string;
}

async function requireCoordinatorDevice(
  tx: Db,
  auth: AuthContext,
  session: LockedSession,
  deviceId: string | undefined,
): Promise<CandidateDevice> {
  if (!deviceId) throw problems.notFound();
  const rows = await tx<
    (CandidateDevice & { facility_id: string; revoked_at: Date | null; user_status: string })[]
  >`
    SELECT d.id, d.label, d.staff_user_id, d.facility_id, d.revoked_at, u.status AS user_status
      FROM devices d JOIN staff_users u ON u.id = d.staff_user_id
     WHERE d.id = ${deviceId} AND d.organization_id = ${auth.organizationId}`;
  const d = rows[0];
  // Another facility's or tenant's device is indistinguishable from a missing one
  if (!d || d.facility_id !== session.facility_id) throw problems.notFound();
  if (d.revoked_at) throw problems.conflict('That device has been revoked.');
  if (d.user_status !== 'active') throw problems.conflict("That device's owner is not active.");

  const grants = await loadRoles(tx, d.staff_user_id, auth.organizationId);
  const capable = grants.some(
    (g) =>
      (g.role === Role.ORG_ADMIN && g.facility_id === null) ||
      (g.facility_id === session.facility_id && COORDINATOR_CAPABLE.includes(g.role)),
  );
  if (!capable) {
    throw problems.conflict(
      "That device's owner is not allowed to call visitors, so it cannot coordinate the queue.",
    );
  }
  return d;
}

/** The authorization a coordinator device receives (signed by the caller). */
export function buildAuthority(
  session: Pick<
    LockedSession,
    | 'id'
    | 'facility_id'
    | 'coordinator_epoch'
    | 'coordinator_device_id'
    | 'coordinator_granted_at'
    | 'coordinator_expires_at'
    | 'coordinator_allowed_actions'
  >,
  issuedByRole: typeof Role.SUPERVISOR | typeof Role.FACILITY_ADMIN,
  issuedByActorId: string,
): CoordinatorAuth | null {
  if (
    !session.coordinator_device_id ||
    !session.coordinator_expires_at ||
    !session.coordinator_granted_at
  ) {
    return null;
  }
  return {
    device_id: session.coordinator_device_id,
    facility_id: session.facility_id,
    queue_session_id: session.id,
    epoch: session.coordinator_epoch,
    allowed_actions: session.coordinator_allowed_actions as CoordinatorAuth['allowed_actions'],
    issued_at: session.coordinator_granted_at.toISOString(),
    expires_at: session.coordinator_expires_at.toISOString(),
    issued_by_role: issuedByRole,
    issued_by_actor_id: issuedByActorId,
  };
}
