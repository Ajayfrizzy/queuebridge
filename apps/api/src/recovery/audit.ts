import type {
  RecoveryAuditActor,
  RecoveryAuditEntry,
  RecoveryAuditKind,
  RecoveryAuditPage,
  RecoveryReasonCode,
} from '@queuebridge/contracts';
import { RecoveryReasonCodeSchema } from '@queuebridge/contracts';
import type { Db } from '../db.js';

/**
 * Recovery activity audit view (design §15.9a; ADR-015 amendment 1). READ-ONLY: it selects the
 * existing `ticket_recovery.*` admin_events of one queue session's tickets and never writes,
 * rewrites or backfills anything. Recovery still writes no queue events.
 *
 * Attribution: staff events name the account behind the event's immutable `actor_id` with its
 * CURRENT display name (a label, not a snapshot); visitor actions are the visitor's device and
 * are never attributed to staff; an event without a recorded actor is "not recorded". Details are
 * copied through an allow-list, so no key, grant, token, hash, link, email or id leaves here.
 */

const KIND: Record<string, RecoveryAuditKind> = {
  'ticket_recovery.assist': 'request',
  'ticket_recovery.restricted_assistance': 'restricted_assistance',
  'ticket_recovery.approved': 'approval',
  'ticket_recovery.recovered': 'recovered',
  'ticket_recovery.key_regenerated': 'key_regenerated',
  'ticket_recovery.sessions_revoked': 'sessions_revoked',
  'ticket_recovery.revoke_all': 'access_ended',
  'ticket_recovery.abuse_detected': 'abuse_detected',
};
/** Who performs each kind of event (by design of the recovery service) */
const PERFORMER: Record<RecoveryAuditKind, 'staff' | 'visitor_device' | 'system'> = {
  request: 'staff',
  restricted_assistance: 'staff',
  approval: 'staff',
  access_ended: 'staff',
  recovered: 'visitor_device',
  key_regenerated: 'visitor_device',
  sessions_revoked: 'visitor_device',
  abuse_detected: 'system',
};
const EVENT_TYPES = Object.keys(KIND);

interface Row {
  id: string;
  created_at: Date;
  event_type: string;
  details: Record<string, unknown>;
  public_code: string;
  has_actor: boolean;
  actor_name: string | null;
  actor_status: 'active' | 'inactive' | 'suspended' | null;
}

function performer(kind: RecoveryAuditKind, r: Row): RecoveryAuditActor {
  const who = PERFORMER[kind];
  if (who !== 'staff') return { kind: who };
  if (!r.has_actor || r.actor_name === null || r.actor_status === null) {
    return { kind: 'not_recorded' };
  }
  return { kind: 'staff', name: r.actor_name, account_status: r.actor_status };
}

const reasonOf = (v: unknown): RecoveryReasonCode | null => {
  const p = RecoveryReasonCodeSchema.safeParse(v);
  return p.success ? p.data : null;
};
const methodOf = (v: unknown): RecoveryAuditEntry['method'] =>
  v === 'recovery_key' || v === 'staff_grant' ? v : null;
const countOf = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

export async function recoveryAuditPage(
  db: Db,
  scope: { organizationId: string; facilityId: string; queueId: string },
  page: { after?: string | undefined; limit: number },
): Promise<RecoveryAuditPage> {
  const rows = await db<Row[]>`
    SELECT e.id, e.created_at, e.event_type, e.details, t.public_code,
           (e.actor_id IS NOT NULL) AS has_actor,
           u.display_name AS actor_name, u.status AS actor_status
      FROM admin_events e
      JOIN tickets t ON t.id = e.target_id AND t.organization_id = e.organization_id
      LEFT JOIN staff_users u ON u.id = e.actor_id AND u.organization_id = e.organization_id
     WHERE e.organization_id = ${scope.organizationId}
       AND e.facility_id = ${scope.facilityId}
       AND e.target_type = 'ticket'
       AND e.event_type = ANY(${EVENT_TYPES})
       AND t.queue_session_id = ${scope.queueId}
       AND (${page.after ?? null}::uuid IS NULL OR (e.created_at, e.id) > (
             SELECT a.created_at, a.id FROM admin_events a
              WHERE a.id = ${page.after ?? null}::uuid
                AND a.organization_id = ${scope.organizationId}))
     ORDER BY e.created_at, e.id
     LIMIT ${page.limit + 1}`;
  const more = rows.length > page.limit;
  const shown = more ? rows.slice(0, page.limit) : rows;
  const entries: RecoveryAuditEntry[] = shown.map((r) => {
    const kind = KIND[r.event_type] as RecoveryAuditKind;
    const d = r.details ?? {};
    return {
      at: r.created_at.toISOString(),
      ticket_code: r.public_code,
      kind,
      performed_by: performer(kind, r),
      reason_code: reasonOf(d['reason_code']),
      assurance: d['assurance'] === 'basic' ? 'basic' : null,
      method: methodOf(d['method']),
      revoked_devices: countOf(d['revoked_tokens']),
    };
  });
  return { entries, next_after: more ? (shown[shown.length - 1]?.id ?? null) : null };
}
