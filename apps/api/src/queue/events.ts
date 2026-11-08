import type { QueueSessionState, ServicePolicy } from '@queuebridge/contracts';
import type { Db } from '../db.js';
import { computeEventHash, GENESIS_HASH } from './hash.js';
import { QUEUE_CHANNEL, type QueueSignal } from './notifier.js';

/** A queue session row locked FOR UPDATE for the duration of a transaction. */
export interface LockedSession {
  id: string;
  organization_id: string;
  facility_id: string;
  service_id: string;
  operational_date: string;
  state: QueueSessionState;
  revision: number;
  last_sequence: number;
  service_name: string;
  service_status: 'active' | 'inactive';
  ticket_prefix: string | null;
  policy: ServicePolicy;
  facility_status: string;
}

/**
 * Lock queue sessions (in ascending id order, so concurrent multi-session commands such as
 * transfers in opposite directions cannot deadlock) and return them keyed by id.
 * Every lookup is scoped by organization_id from the authenticated principal.
 */
export async function lockSessions(
  tx: Db,
  organizationId: string,
  sessionIds: string[],
): Promise<Map<string, LockedSession>> {
  const ids = [...new Set(sessionIds)].sort();
  const out = new Map<string, LockedSession>();
  for (const id of ids) {
    const rows = await tx<LockedSession[]>`
      SELECT qs.id, qs.organization_id, qs.facility_id, qs.service_id,
             to_char(qs.operational_date, 'YYYY-MM-DD') AS operational_date,
             qs.state, qs.revision, qs.last_sequence,
             s.name AS service_name, s.status AS service_status, s.ticket_prefix, s.policy,
             f.status AS facility_status
        FROM queue_sessions qs
        JOIN services s ON s.id = qs.service_id AND s.organization_id = qs.organization_id
        JOIN facilities f ON f.id = qs.facility_id AND f.organization_id = qs.organization_id
       WHERE qs.id = ${id} AND qs.organization_id = ${organizationId}
         FOR UPDATE OF qs`;
    const row = rows[0];
    if (row) out.set(id, row);
  }
  return out;
}

export interface AppendEventInput {
  eventType: string;
  actorId: string | null;
  operationId: string | null;
  /** Never contains personal data: ids, codes, states and policy references only. */
  payload: Record<string, unknown>;
  transition?: { ticketId: string; from: string; to: string };
}

/**
 * Append one authoritative event to a LOCKED session: next sequence, hash-chained to the
 * previous event, revision incremented, transition history recorded, and a change signal
 * queued with pg_notify (delivered only if the transaction commits).
 * Mutates `session.revision` / `session.last_sequence` to reflect the write.
 */
export async function appendEvent(
  tx: Db,
  session: LockedSession,
  input: AppendEventInput,
): Promise<{ eventId: string; sequence: number; revision: number }> {
  const sequence = session.last_sequence + 1;
  const prev = await tx<{ event_hash: string }[]>`
    SELECT event_hash FROM queue_events
     WHERE queue_session_id = ${session.id}
     ORDER BY sequence DESC LIMIT 1`;
  const prevHash = prev[0]?.event_hash ?? GENESIS_HASH;
  const committedAt = new Date().toISOString();
  const body = {
    organization_id: session.organization_id,
    queue_session_id: session.id,
    sequence,
    event_type: input.eventType,
    actor_id: input.actorId,
    operation_id: input.operationId,
    payload: input.payload,
    committed_at: committedAt,
  };
  const eventHash = computeEventHash(prevHash, body);

  const inserted = await tx<{ id: string }[]>`
    INSERT INTO queue_events
      (organization_id, queue_session_id, sequence, actor_id, operation_id, event_type,
       payload, prev_hash, event_hash, committed_at)
    VALUES (${session.organization_id}, ${session.id}, ${sequence}, ${input.actorId},
            ${input.operationId}, ${input.eventType}, ${tx.json(input.payload as never)},
            ${prevHash}, ${eventHash}, ${committedAt})
    RETURNING id`;
  const eventId = inserted[0]?.id;
  if (!eventId) throw new Error('queue event insert returned no row');

  const updated = await tx<{ revision: number }[]>`
    UPDATE queue_sessions
       SET revision = revision + 1, last_sequence = ${sequence}, updated_at = NOW()
     WHERE id = ${session.id} AND last_sequence = ${session.last_sequence}
    RETURNING revision`;
  if (updated.length !== 1) throw new Error('queue session sequence moved while locked');
  session.revision = updated[0]?.revision ?? session.revision + 1;
  session.last_sequence = sequence;

  if (input.transition) {
    await tx`
      INSERT INTO ticket_transitions (ticket_id, from_state, to_state, queue_event_id)
      VALUES (${input.transition.ticketId}, ${input.transition.from}, ${input.transition.to}, ${eventId})`;
  }

  const signal: QueueSignal = { f: session.facility_id, s: session.id, r: session.revision };
  await tx`SELECT pg_notify(${QUEUE_CHANNEL}, ${JSON.stringify(signal)})`;
  return { eventId, sequence, revision: session.revision };
}
