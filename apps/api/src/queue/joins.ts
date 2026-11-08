import { timingSafeEqual } from 'node:crypto';
import { QueueAction, QueueSessionState, type JoinQueueResponse } from '@queuebridge/contracts';
import { hashToken } from '../auth/tokens.js';
import type { Db } from '../db.js';
import { isUniqueViolation, problems } from '../errors.js';
import { lockSessions } from './events.js';
import { issueStatusToken, issueTicket } from './tickets.js';

interface JoinResultJson {
  ticket_id: string;
  public_code: string;
  service_name: string;
  facility_name: string;
}

interface StoredJoin {
  queue_session_id: string;
  action: string;
  proof_hash: string | null;
  actor_id: string | null;
  result_json: JoinResultJson;
}

export interface JoinInput {
  organizationId: string;
  queueId: string;
  operationId: string;
  /** Visitor joins: hash of the client's join proof. Staff walk-ins: null. */
  proofHash: string | null;
  /** Staff walk-ins: the staff user. Visitor joins: null. */
  staffUserId: string | null;
}

const statusPath = (code: string): string => `/ticket/${code}`;

function sameHash(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Create a confirmed ticket (visitor web join or staff walk-in), idempotently.
 *
 * - First request: issues the ticket, status token and ticket.create event in one transaction.
 * - Replay of the same operation id (e.g. response lost): returns `duplicate` for the SAME ticket
 *   and rotates its status token, but only if the caller proves it is the original requester
 *   (visitor: same join proof; staff: same staff user). Anyone else gets a uniform conflict.
 */
export async function joinQueue(db: Db, input: JoinInput): Promise<JoinQueueResponse> {
  const run = (): Promise<JoinQueueResponse> =>
    db.begin(async (tx) => {
      const locked = await lockSessions(tx, input.organizationId, [input.queueId]);
      const session = locked.get(input.queueId);
      if (!session) throw problems.notFound();

      const prior = await tx<StoredJoin[]>`
        SELECT queue_session_id, action, proof_hash, actor_id, result_json FROM client_operations
         WHERE organization_id = ${input.organizationId} AND operation_id = ${input.operationId}`;
      const existing = prior[0];
      if (existing) {
        const owner =
          existing.queue_session_id === session.id &&
          existing.action === QueueAction.TICKET_CREATE &&
          (input.proofHash !== null
            ? sameHash(existing.proof_hash, input.proofHash)
            : existing.actor_id !== null && existing.actor_id === input.staffUserId);
        if (!owner)
          throw problems.conflict('This request could not be completed. Start a new join.');
        const token = await issueStatusToken(tx, existing.result_json.ticket_id);
        return {
          disposition: 'duplicate' as const,
          public_code: existing.result_json.public_code,
          status_token: token,
          status_path: statusPath(existing.result_json.public_code),
          service_name: existing.result_json.service_name,
          facility_name: existing.result_json.facility_name,
        };
      }

      if (session.facility_status !== 'active' || session.service_status !== 'active') {
        throw problems.conflict('This service is not accepting visitors right now.');
      }
      if (session.state !== QueueSessionState.OPEN) {
        throw problems.conflict(
          session.state === QueueSessionState.PAUSED
            ? 'This queue is paused and is not accepting new visitors right now.'
            : 'This queue is closed.',
        );
      }

      const issued = await issueTicket(tx, session, {
        channel: input.staffUserId ? 'staff' : 'web',
        actorId: input.staffUserId,
        operationId: input.operationId,
        createdBy: input.staffUserId,
      });
      const token = await issueStatusToken(tx, issued.ticketId);
      const facility = await tx<
        { name: string }[]
      >`SELECT name FROM facilities WHERE id = ${session.facility_id}`;
      const result: JoinResultJson = {
        ticket_id: issued.ticketId,
        public_code: issued.publicCode,
        service_name: session.service_name,
        facility_name: facility[0]?.name ?? '',
      };
      await tx`
        INSERT INTO client_operations
          (organization_id, queue_session_id, device_id, actor_id, operation_id, client_sequence,
           action, status, result_json, source, proof_hash)
        VALUES (${input.organizationId}, ${session.id}, NULL, ${input.staffUserId}, ${input.operationId},
                0, ${QueueAction.TICKET_CREATE}, 'committed', ${tx.json(result as never)}, 'online',
                ${input.proofHash})`;
      return {
        disposition: 'committed' as const,
        public_code: issued.publicCode,
        status_token: token,
        status_path: statusPath(issued.publicCode),
        service_name: result.service_name,
        facility_name: result.facility_name,
      };
    });

  try {
    return await run();
  } catch (err) {
    // The same operation id raced on another queue: the stored row decides (once).
    if (isUniqueViolation(err, 'client_operations_org_op_idx')) return run();
    throw err;
  }
}

export const hashJoinProof = (proof: string): string => hashToken(proof);
