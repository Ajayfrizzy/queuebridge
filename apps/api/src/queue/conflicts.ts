import {
  CommandEnvelopeSchema,
  QueueAction,
  type ResolveConflictRequest,
  type SyncConflict,
} from '@queuebridge/contracts';
import { queueActorRoles, requireFacilityPermission, type AuthContext } from '../auth/rbac.js';
import type { Db } from '../db.js';
import { problems } from '../errors.js';
import { appendEvent, lockSessions } from './events.js';
import { evaluate, SYNC_REASON_MESSAGES, type StoredResult } from './sync.js';

interface ConflictRow {
  operation_id: string;
  queue_id: string;
  service_name: string;
  action: string;
  status: SyncConflict['status'];
  reason_code: string | null;
  message: string | null;
  device_id: string | null;
  device_label: string | null;
  actor_name: string | null;
  client_created_at: string | null;
  received_at: Date;
  ticket_code: string | null;
  temporary_ref: string | null;
  resolution: 'applied' | 'dismissed' | null;
  resolution_reason_code: string | null;
  resolved_by_name: string | null;
  resolved_at: Date | null;
}

/**
 * Offline operations a supervisor may need to look at: the open `needs_review` queue and,
 * with `includeResolved`, refused and already-resolved operations for the facility.
 */
export async function listConflicts(
  db: Db,
  organizationId: string,
  facilityId: string,
  includeResolved: boolean,
): Promise<SyncConflict[]> {
  const rows = await db<ConflictRow[]>`
    SELECT co.operation_id, co.queue_session_id AS queue_id, s.name AS service_name, co.action,
           co.status, co.reason_code, co.result_json ->> 'rejection_reason' AS message,
           co.device_id, d.label AS device_label, u.display_name AS actor_name,
           co.envelope ->> 'created_at_client' AS client_created_at, co.created_at AS received_at,
           COALESCE(co.result_json ->> 'public_code', t.public_code) AS ticket_code,
           COALESCE(co.envelope -> 'payload' ->> 'temporary_ref', co.envelope -> 'payload' ->> 'ticket_ref') AS temporary_ref,
           co.resolution, co.resolution_reason_code, ru.display_name AS resolved_by_name, co.resolved_at
      FROM client_operations co
      JOIN queue_sessions qs ON qs.id = co.queue_session_id
      JOIN services s ON s.id = qs.service_id
      LEFT JOIN devices d ON d.id = co.device_id
      LEFT JOIN staff_users u ON u.id = co.actor_id
      LEFT JOIN staff_users ru ON ru.id = co.resolved_by
      LEFT JOIN tickets t ON t.id::text = co.envelope -> 'payload' ->> 'ticket_id'
     WHERE co.organization_id = ${organizationId} AND qs.facility_id = ${facilityId}
       AND co.source = 'offline_sync'
       AND (co.status = 'needs_review'
            OR (${includeResolved} AND (co.status = 'rejected' OR co.resolution IS NOT NULL)))
     ORDER BY (co.status = 'needs_review') DESC, co.created_at DESC
     LIMIT 200`;
  return rows.map((r) => ({
    ...r,
    received_at: r.received_at.toISOString(),
    resolved_at: r.resolved_at?.toISOString() ?? null,
  }));
}

interface OpRow {
  operation_id: string;
  queue_session_id: string;
  actor_id: string | null;
  device_id: string | null;
  status: string;
  reason_code: string | null;
  envelope: unknown;
  resolution: string | null;
  facility_id: string;
}

export interface ResolveResult {
  operation_id: string;
  resolution: 'applied' | 'dismissed';
  already_resolved: boolean;
  server_revision: number;
}

/**
 * Supervisor resolution of a `needs_review` operation. Never edits history:
 *  - dismiss: the operation becomes `rejected`; a `sync.conflict_resolved` event records who/why;
 *  - apply:   the command is re-validated against CURRENT server state (every state, role and
 *             policy check, minus the offline-authority checks the supervisor now stands in for).
 *             If it still cannot be applied the request fails (409) and nothing changes.
 * Resolving twice with the same choice is idempotent; the opposite choice is refused.
 */
export async function resolveConflict(
  db: Db,
  auth: AuthContext,
  operationId: string,
  body: ResolveConflictRequest,
): Promise<ResolveResult> {
  const found = await db<OpRow[]>`
    SELECT co.operation_id, co.queue_session_id, co.actor_id, co.device_id, co.status, co.reason_code,
           co.envelope, co.resolution, qs.facility_id
      FROM client_operations co JOIN queue_sessions qs ON qs.id = co.queue_session_id
     WHERE co.organization_id = ${auth.organizationId} AND co.operation_id = ${operationId}
       AND co.source = 'offline_sync'`;
  const op = found[0];
  if (!op) throw problems.notFound();
  await requireFacilityPermission(db, auth, op.facility_id, 'QUEUE_MANAGE');

  const wanted = body.resolution === 'apply' ? 'applied' : 'dismissed';

  return db.begin(async (tx) => {
    const locked = await lockSessions(tx, auth.organizationId, [op.queue_session_id]);
    const session = locked.get(op.queue_session_id);
    if (!session) throw problems.notFound();

    const current = await tx<{ status: string; resolution: string | null }[]>`
      SELECT status, resolution FROM client_operations
       WHERE organization_id = ${auth.organizationId} AND operation_id = ${operationId} FOR UPDATE`;
    const row = current[0];
    if (!row) throw problems.notFound();
    if (row.status !== 'needs_review') {
      if (row.resolution === wanted) {
        return {
          operation_id: operationId,
          resolution: wanted,
          already_resolved: true,
          server_revision: session.revision,
        };
      }
      throw problems.conflict(
        row.resolution
          ? 'This operation was already resolved differently.'
          : 'This operation is not waiting for review.',
      );
    }

    let stored: StoredResult;
    let newStatus: 'committed' | 'rejected';
    if (body.resolution === 'dismiss') {
      newStatus = 'rejected';
      stored = {
        disposition: 'rejected',
        reason_code: 'dismissed_by_supervisor',
        rejection_reason: SYNC_REASON_MESSAGES['dismissed_by_supervisor'] ?? 'Dismissed.',
        server_revision: session.revision,
      };
    } else {
      const envelope = CommandEnvelopeSchema.safeParse(op.envelope);
      if (!envelope.success || !op.device_id) {
        throw problems.conflict('The recorded command cannot be re-applied.');
      }
      const dev = await tx<{ id: string; facility_id: string; label: string | null }[]>`
        SELECT id, facility_id, label FROM devices
         WHERE id = ${op.device_id} AND organization_id = ${auth.organizationId}`;
      if (!dev[0]) throw problems.conflict('The recorded command cannot be re-applied.');
      const roles = queueActorRoles(auth, session.facility_id);
      const evaluation = await evaluate(
        tx,
        { auth, authorities: new Map() },
        session,
        locked,
        roles,
        envelope.data,
        dev[0],
        { review: true, ...(op.actor_id ? { originalActorId: op.actor_id } : {}) },
      );
      if (evaluation.kind !== 'committed') {
        throw problems.conflict(
          `Still cannot be applied: ${evaluation.message ?? SYNC_REASON_MESSAGES[evaluation.reason] ?? evaluation.reason}`,
        );
      }
      newStatus = 'committed';
      stored = evaluation.result;
    }

    const ev = await appendEvent(tx, session, {
      eventType: QueueAction.SYNC_CONFLICT_RESOLVED,
      actorId: auth.staffUserId,
      operationId: null,
      payload: {
        operation_id: operationId,
        resolution: wanted,
        reason_code: body.reason_code,
        original_reason_code: op.reason_code,
        original_actor_id: op.actor_id,
        device_id: op.device_id,
      },
    });
    await tx`
      UPDATE client_operations
         SET status = ${newStatus}, result_json = ${tx.json(stored as never)},
             resolution = ${wanted}, resolution_reason_code = ${body.reason_code},
             resolved_by = ${auth.staffUserId}, resolved_at = NOW()
       WHERE organization_id = ${auth.organizationId} AND operation_id = ${operationId}`;
    return {
      operation_id: operationId,
      resolution: wanted,
      already_resolved: false,
      server_revision: ev.revision,
    };
  });
}
