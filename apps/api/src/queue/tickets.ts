import { PriorityClass, QueueAction, TicketState } from '@queuebridge/contracts';
import { generateToken, hashToken } from '../auth/tokens.js';
import type { Db } from '../db.js';
import { appendEvent, type LockedSession } from './events.js';

/** Validity of a ticket status token. Recovery of lost tokens is M5 (F4). */
export const STATUS_TOKEN_TTL_HOURS = 24;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Assign a facility-unique ticket-code prefix to a service if it has none (first ASCII letter of
 * the name when free, otherwise the first free letter, then two letters). Serialized per
 * facility by locking the facility row; the unique index is the final guarantee.
 */
export async function ensureTicketPrefix(
  tx: Db,
  facilityId: string,
  serviceId: string,
): Promise<string> {
  await tx`SELECT id FROM facilities WHERE id = ${facilityId} FOR UPDATE`;
  const svc = await tx<{ name: string; ticket_prefix: string | null }[]>`
    SELECT name, ticket_prefix FROM services WHERE id = ${serviceId} AND facility_id = ${facilityId}`;
  const current = svc[0];
  if (!current) throw new Error('service not found for prefix assignment');
  if (current.ticket_prefix) return current.ticket_prefix;

  const used = new Set(
    (
      await tx<{ ticket_prefix: string }[]>`
        SELECT ticket_prefix FROM services
         WHERE facility_id = ${facilityId} AND ticket_prefix IS NOT NULL`
    ).map((r) => r.ticket_prefix),
  );
  const first = current.name
    .normalize('NFKD')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .charAt(0);
  const candidates = [
    ...(first ? [first] : []),
    ...LETTERS.split(''),
    ...LETTERS.split('').flatMap((a) => LETTERS.split('').map((b) => a + b)),
  ];
  const prefix = candidates.find((c) => !used.has(c));
  if (!prefix) throw new Error('no ticket prefix available');
  await tx`UPDATE services SET ticket_prefix = ${prefix}, updated_at = NOW() WHERE id = ${serviceId}`;
  return prefix;
}

export function formatTicketCode(prefix: string, issued: number): string {
  return `${prefix}${String(issued).padStart(3, '0')}`;
}

export interface IssueTicketInput {
  channel: 'web' | 'staff' | 'transfer';
  actorId: string | null;
  operationId: string | null;
  createdBy: string | null;
  /** Original join time — preserved across transfers */
  joinedAt?: Date;
  transferredFromTicketId?: string;
  sourceQueueId?: string;
}

export interface IssuedTicket {
  ticketId: string;
  publicCode: string;
  issuedSequence: number;
  sequence: number;
}

/** Create a confirmed waiting ticket in a LOCKED session and append its ticket.create event. */
export async function issueTicket(
  tx: Db,
  session: LockedSession,
  input: IssueTicketInput,
): Promise<IssuedTicket> {
  const prefix =
    session.ticket_prefix ??
    (await ensureTicketPrefix(tx, session.facility_id, session.service_id));
  session.ticket_prefix = prefix;
  const next = await tx<{ n: number }[]>`
    SELECT COALESCE(MAX(issued_sequence), 0)::int + 1 AS n FROM tickets WHERE queue_session_id = ${session.id}`;
  const issuedSequence = next[0]?.n ?? 1;
  const publicCode = formatTicketCode(prefix, issuedSequence);
  const joinedAt = input.joinedAt ?? new Date();

  const rows = await tx<{ id: string }[]>`
    INSERT INTO tickets
      (queue_session_id, organization_id, public_code, state, priority_class, issued_sequence,
       joined_at, created_channel, created_by, transferred_from_ticket_id)
    VALUES (${session.id}, ${session.organization_id}, ${publicCode}, ${TicketState.WAITING},
            ${PriorityClass.NORMAL}, ${issuedSequence}, ${joinedAt}, ${input.channel},
            ${input.createdBy}, ${input.transferredFromTicketId ?? null})
    RETURNING id`;
  const ticketId = rows[0]?.id;
  if (!ticketId) throw new Error('ticket insert returned no row');

  const ev = await appendEvent(tx, session, {
    eventType: QueueAction.TICKET_CREATE,
    actorId: input.actorId,
    operationId: input.operationId,
    payload: {
      ticket_id: ticketId,
      public_code: publicCode,
      issued_sequence: issuedSequence,
      priority_class: PriorityClass.NORMAL,
      channel: input.channel,
      policy_version: session.policy.version,
      ...(input.transferredFromTicketId
        ? {
            transferred_from_ticket_id: input.transferredFromTicketId,
            source_queue_id: input.sourceQueueId,
          }
        : {}),
    },
    transition: { ticketId, from: 'none', to: TicketState.WAITING },
  });
  return { ticketId, publicCode, issuedSequence, sequence: ev.sequence };
}

/** Issue (or rotate) the status credential for a ticket; returns the raw token exactly once. */
export async function issueStatusToken(tx: Db, ticketId: string): Promise<string> {
  const token = generateToken();
  await tx`
    INSERT INTO ticket_recovery_credentials (ticket_id, credential_hash, expires_at)
    VALUES (${ticketId}, ${hashToken(token)}, NOW() + make_interval(hours => ${STATUS_TOKEN_TTL_HOURS}))
    ON CONFLICT (ticket_id) DO UPDATE
      SET credential_hash = EXCLUDED.credential_hash, expires_at = EXCLUDED.expires_at, attempts = 0`;
  return token;
}
