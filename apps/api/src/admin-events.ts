import type { Db } from './db.js';

export interface AdminEventInput {
  organizationId: string;
  facilityId: string | null;
  actorId: string | null;
  eventType: string;
  targetType: string;
  targetId: string | null;
  /** Must not contain emails, names, passwords, tokens or phone numbers. */
  details?: Record<string, string | number | boolean | null>;
}

/** Append an administrative audit event (table is append-only at the database level). */
export async function recordAdminEvent(db: Db, e: AdminEventInput): Promise<void> {
  await db`
    INSERT INTO admin_events (organization_id, facility_id, actor_id, event_type, target_type, target_id, details)
    VALUES (${e.organizationId}, ${e.facilityId}, ${e.actorId}, ${e.eventType}, ${e.targetType},
            ${e.targetId}, ${db.json(e.details ?? {})})`;
}
