import { createHash } from 'node:crypto';
import {
  QueueAction,
  SystemActor,
  TicketState,
  normalizeRecoveryKey,
  recoveryPolicyOf,
  type CommandOutcome,
  type RecoveredTicket,
  type RecoveryAssistRequest,
  type RecoveryAssistResponse,
  type RecoveryKeyResponse,
  type RecoveryRequestStatus,
  type RecoveryRequestSummary,
  type RecoveryRevokeAllRequest,
  type RevokeOtherDevicesResponse,
} from '@queuebridge/contracts';
import { recordAdminEvent } from '../admin-events.js';
import type { AuthContext } from '../auth/rbac.js';
import type { Db } from '../db.js';
import { ApiProblem, problems } from '../errors.js';
import { CommandRejected, executeSystemTransition } from '../queue/commands.js';
import type { ResolvedStatusTicket } from '../queue/views.js';
import {
  clearRecoveryKey,
  issueStatusToken,
  lockProof,
  recoveryPath,
  revokePendingGrants,
  revokeStatusTokens,
  rootTicketOf,
  setRecoveryKey,
} from './credentials.js';
import type { RecoveryCrypto } from './crypto.js';
import {
  admitSource,
  admitTarget,
  recordFailure,
  targetKeys,
  type ThrottleLimits,
} from './throttle.js';

/**
 * M5.1 ticket recovery flows (design §15, ADR-015). Identity plane only: no queue-session lock,
 * no queue event, no change of ticket state, position or waiting age — except `rejoin`, which is
 * a queue transition and goes through the standard command machinery.
 */

/** Staff grants are valid for this long and only once. */
export const GRANT_TTL_MINUTES = 10;
/** Staff-assisted limits (design §15.5a). */
export const GRANTS_PER_TICKET_PER_HOUR = 3;
export const GRANTS_PER_STAFF_PER_10_MIN = 5;

const NIL_TICKET = '00000000-0000-0000-0000-000000000000';
const TERMINAL: ReadonlySet<string> = new Set([TicketState.COMPLETED, TicketState.CANCELLED]);

/** The ONE failure every unsuccessful recovery returns: unknown, wrong, expired or ended alike. */
export const recoveryFailed = (): ApiProblem =>
  new ApiProblem(404, 'recovery-failed', 'Recovery failed', {
    detail:
      'We could not open a ticket with these details. Check the ticket code and recovery key, or ask a member of staff.',
  });

export const recoveryUnavailable = (): ApiProblem =>
  new ApiProblem(503, 'recovery-unavailable', 'Recovery unavailable', {
    detail: 'Ticket recovery is not available here right now. Please ask a member of staff.',
  });

interface CurrentTicket {
  id: string;
  organization_id: string;
  queue_session_id: string;
  public_code: string;
  state: string;
  service_name: string;
  facility_name: string;
  facility_id: string;
}

/** Follow transfers forward from the ROOT ticket to the visitor's current ticket. */
async function currentTicketOf(
  db: Db,
  organizationId: string,
  rootId: string,
): Promise<CurrentTicket | null> {
  let id = rootId;
  for (let hop = 0; hop <= 10; hop++) {
    const rows = await db<(CurrentTicket & { transferred_to_ticket_id: string | null })[]>`
      SELECT t.id, t.organization_id, t.queue_session_id, t.public_code, t.state,
             t.transferred_to_ticket_id, s.name AS service_name, f.name AS facility_name,
             f.id AS facility_id
        FROM tickets t
        JOIN queue_sessions qs ON qs.id = t.queue_session_id
        JOIN services s ON s.id = qs.service_id
        JOIN facilities f ON f.id = qs.facility_id
       WHERE t.id = ${id} AND t.organization_id = ${organizationId}`;
    const row = rows[0];
    if (!row) return null;
    if (!row.transferred_to_ticket_id) return row;
    id = row.transferred_to_ticket_id;
  }
  return null;
}

const recoveredTicket = (t: CurrentTicket, token: string): RecoveredTicket => ({
  public_code: t.public_code as RecoveredTicket['public_code'],
  status_token: token,
  status_path: `/ticket/${t.public_code}`,
  service_name: t.service_name,
  facility_name: t.facility_name,
});

// ---------------------------------------------------------------------------
// Self-service recovery with the recovery key
// ---------------------------------------------------------------------------

export interface KeyRecoveryInput {
  orgSlug: string;
  facilitySlug: string;
  ticketCode: string;
  rawKey: string;
  /** Request source (IPv4, or IPv6 /64) — never stored in clear */
  source: string;
}

export async function recoverWithKey(
  db: Db,
  crypto: RecoveryCrypto,
  limits: ThrottleLimits,
  input: KeyRecoveryInput,
): Promise<RecoveredTicket> {
  // Throttle first, keyed on public identifiers and the source — never on the guess
  const keys = targetKeys(crypto, input, input.source);
  await admitSource(db, keys.source, limits);
  await admitTarget(db, keys);

  // The same lookups and one HMAC are done whether or not anything matches (no oracle)
  const normalized = normalizeRecoveryKey(input.rawKey);
  const facility = (
    await db<{ id: string; organization_id: string }[]>`
      SELECT f.id, f.organization_id FROM facilities f
        JOIN organizations o ON o.id = f.organization_id
       WHERE o.slug = ${input.orgSlug} AND f.slug = ${input.facilitySlug} AND f.status = 'active'`
  )[0];
  const found = (
    await db<{ id: string }[]>`
      SELECT t.id FROM tickets t
        JOIN queue_sessions qs ON qs.id = t.queue_session_id
        JOIN facilities f ON f.id = qs.facility_id
       WHERE qs.facility_id = ${facility?.id ?? NIL_TICKET}
         AND qs.operational_date = (NOW() AT TIME ZONE f.timezone)::date
         AND t.public_code = ${input.ticketCode}
         AND t.provisional_source_op_id IS NULL
       LIMIT 1`
  )[0];
  const rootId =
    found && facility ? await rootTicketOf(db, facility.organization_id, found.id) : null;
  const proof = (
    await db<{ key_hmac: string | null }[]>`
      SELECT key_hmac FROM ticket_recovery_proofs WHERE ticket_id = ${rootId ?? NIL_TICKET}`
  )[0];
  const current =
    rootId && facility ? await currentTicketOf(db, facility.organization_id, rootId) : null;
  const computed = crypto.keyHmac(rootId ?? NIL_TICKET, normalized ?? '0'.repeat(32));
  const expected = proof?.key_hmac ?? crypto.keyHmac(NIL_TICKET, 'unmatchable');
  const matches = crypto.equal(computed, expected);
  const ok =
    matches &&
    normalized !== null &&
    typeof proof?.key_hmac === 'string' &&
    current !== null &&
    !TERMINAL.has(current.state);

  if (ok && rootId && current) {
    const issued = await db.begin(async (tx) => {
      // Re-check under the ticket's credential lock: a key replaced a moment ago no longer works
      const locked = await lockProof(tx, rootId);
      if (!locked?.key_hmac || !crypto.equal(locked.key_hmac, computed)) return null;
      const token = await issueStatusToken(tx, rootId, 'recovery');
      await recordAdminEvent(tx, {
        organizationId: current.organization_id,
        facilityId: current.facility_id,
        actorId: null,
        eventType: 'ticket_recovery.recovered',
        targetType: 'ticket',
        targetId: rootId,
        details: { method: 'recovery_key' },
      });
      return token;
    });
    if (issued) return recoveredTicket(current, issued);
  }

  const reached = await recordFailure(db, keys);
  if (facility && (reached.targetThresholdReached || reached.facilityThresholdReached)) {
    await recordAdminEvent(db, {
      organizationId: facility.organization_id,
      facilityId: facility.id,
      actorId: null,
      eventType: 'ticket_recovery.abuse_detected',
      targetType: reached.targetThresholdReached && rootId ? 'ticket' : 'facility',
      targetId: reached.targetThresholdReached && rootId ? rootId : facility.id,
      details: { scope: reached.targetThresholdReached ? 'ticket' : 'facility' },
    });
  }
  throw recoveryFailed();
}

// ---------------------------------------------------------------------------
// Redeeming a staff grant (on the visitor's own device)
// ---------------------------------------------------------------------------

export async function recoverWithGrant(
  db: Db,
  crypto: RecoveryCrypto,
  limits: ThrottleLimits,
  input: { rawGrant: string; source: string },
): Promise<RecoveredTicket> {
  await admitSource(db, crypto.throttleKey('source', input.source), limits);
  const grant = normalizeRecoveryKey(input.rawGrant);
  const hmac = crypto.grantHmac(grant ?? '0'.repeat(32));
  const issued = await db.begin(async (tx) => {
    // Lock order is ticket (proof row) THEN grant row, the same order as staff revoke-all, which
    // locks the proof and then revokes the ticket's pending grants. The grant is first read
    // WITHOUT a lock only to learn its ticket; it is then locked and re-checked. (Before the M5
    // hardening pass this locked the grant first, which could deadlock with revoke-all.)
    const [probe] = await tx<{ ticket_id: string }[]>`
      SELECT ticket_id FROM ticket_recovery_grants WHERE grant_hmac = ${hmac}`;
    if (!grant || !probe) return null;
    await lockProof(tx, probe.ticket_id);
    const rows = await tx<
      {
        id: string;
        ticket_id: string;
        organization_id: string;
        facility_id: string;
        assurance: string;
        usable: boolean;
      }[]
    >`
      SELECT id, ticket_id, organization_id, facility_id, assurance,
             (redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
               AND (assurance <> 'basic' OR approved_at IS NOT NULL)) AS usable
        FROM ticket_recovery_grants WHERE grant_hmac = ${hmac}
         FOR UPDATE`;
    const g = rows[0];
    if (!g?.usable || g.ticket_id !== probe.ticket_id) return null;
    const current = await currentTicketOf(tx, g.organization_id, g.ticket_id);
    if (!current || TERMINAL.has(current.state)) return null;
    await tx`UPDATE ticket_recovery_grants SET redeemed_at = NOW() WHERE id = ${g.id}`;
    const token = await issueStatusToken(tx, g.ticket_id, 'staff');
    await recordAdminEvent(tx, {
      organizationId: g.organization_id,
      facilityId: g.facility_id,
      actorId: null,
      eventType: 'ticket_recovery.recovered',
      targetType: 'ticket',
      targetId: g.ticket_id,
      details: { method: 'staff_grant', assurance: g.assurance },
    });
    return recoveredTicket(current, token);
  });
  if (!issued) throw recoveryFailed();
  return issued;
}

// ---------------------------------------------------------------------------
// Visitor actions with their current status token
// ---------------------------------------------------------------------------

async function slugsOf(db: Db, facilityId: string): Promise<{ org: string; facility: string }> {
  const [r] = await db<{ org: string; facility: string }[]>`
    SELECT o.slug AS org, f.slug AS facility FROM facilities f
      JOIN organizations o ON o.id = f.organization_id WHERE f.id = ${facilityId}`;
  return r ?? { org: '', facility: '' };
}

function ensureNotEnded(resolved: ResolvedStatusTicket): void {
  if (TERMINAL.has(resolved.ticket.state)) {
    throw new ApiProblem(409, 'ticket-ended', 'Ticket ended', {
      detail: 'This ticket has ended, so there is nothing to recover.',
    });
  }
}

/** "Get a new recovery key": the old key stops working at once. */
export async function regenerateRecoveryKey(
  db: Db,
  crypto: RecoveryCrypto,
  resolved: ResolvedStatusTicket,
): Promise<RecoveryKeyResponse> {
  ensureNotEnded(resolved);
  const key = await db.begin(async (tx) => {
    const k = await setRecoveryKey(tx, crypto, resolved.rootTicketId);
    await recordAdminEvent(tx, {
      organizationId: resolved.ticket.organization_id,
      facilityId: resolved.facilityId,
      actorId: null,
      eventType: 'ticket_recovery.key_regenerated',
      targetType: 'ticket',
      targetId: resolved.rootTicketId,
      details: { by: 'visitor' },
    });
    return k;
  });
  if (!key) throw recoveryUnavailable();
  const s = await slugsOf(db, resolved.facilityId);
  return {
    recovery_key: key,
    recovery_path: recoveryPath(s.org, s.facility, resolved.originalCode),
  };
}

/** "Sign out other devices": every other token and pending grant revoked; a new key issued. */
export async function revokeOtherDevices(
  db: Db,
  crypto: RecoveryCrypto | null,
  resolved: ResolvedStatusTicket,
): Promise<RevokeOtherDevicesResponse> {
  const result = await db.begin(async (tx) => {
    await lockProof(tx, resolved.rootTicketId);
    const revoked = await revokeStatusTokens(
      tx,
      resolved.rootTicketId,
      'signed_out_elsewhere',
      resolved.tokenId,
    );
    const grants = await revokePendingGrants(tx, resolved.rootTicketId);
    const key = await setRecoveryKey(tx, crypto, resolved.rootTicketId);
    await recordAdminEvent(tx, {
      organizationId: resolved.ticket.organization_id,
      facilityId: resolved.facilityId,
      actorId: null,
      eventType: 'ticket_recovery.sessions_revoked',
      targetType: 'ticket',
      targetId: resolved.rootTicketId,
      details: { revoked_tokens: revoked, revoked_grants: grants, by: 'visitor' },
    });
    return { revoked, key };
  });
  const s = await slugsOf(db, resolved.facilityId);
  return {
    revoked_tokens: result.revoked,
    recovery_key: result.key,
    recovery_path: recoveryPath(s.org, s.facility, resolved.originalCode),
  };
}

/** `self_resume`: return the visitor's own missed ticket to the queue inside the grace window. */
export async function rejoin(
  db: Db,
  resolved: ResolvedStatusTicket,
  operationId: string,
): Promise<CommandOutcome> {
  const t = resolved.ticket;
  return executeSystemTransition(db, {
    organizationId: t.organization_id,
    queueId: t.queue_session_id,
    ticketId: t.id,
    operationId,
    actor: SystemActor.VISITOR_SELF,
    action: QueueAction.TICKET_RESUME,
    payload: { reason_code: 'visitor_rejoined' },
    preconditions: async (tx, session, ticket) => {
      if (ticket.state !== TicketState.MISSED) {
        throw new CommandRejected(
          'invalid_state',
          'Only a ticket whose turn was missed can rejoin the queue.',
        );
      }
      if (recoveryPolicyOf(session.policy).rejoin_policy !== 'self_resume') {
        throw new CommandRejected(
          'rejoin_not_allowed',
          'This service does not allow rejoining from your phone. Please speak to a member of staff.',
        );
      }
      // Database time, not this instance's clock
      const [g] = await tx<{ open: boolean }[]>`
        SELECT (missed_at IS NOT NULL
                AND NOW() <= missed_at + make_interval(secs => ${session.policy.grace_window_seconds})) AS open
          FROM tickets WHERE id = ${ticket.id}`;
      if (!g?.open) {
        throw new CommandRejected(
          'grace_window_expired',
          'The time to rejoin has passed. Please join the queue again.',
        );
      }
      return ['grace_window_active', 'self_resume_allowed'];
    },
  });
}

// ---------------------------------------------------------------------------
// Staff-assisted recovery (design §15.5a): a restricted procedure
// ---------------------------------------------------------------------------

export interface StaffTicketRef {
  queueId: string;
  facilityId: string;
  ticketId: string;
}

async function staffTicket(
  db: Db,
  auth: AuthContext,
  ref: StaffTicketRef,
): Promise<{ rootId: string; state: string; staffRecovery: boolean }> {
  const [row] = await db<{ state: string; policy: Record<string, unknown> }[]>`
    SELECT t.state, s.policy FROM tickets t
      JOIN queue_sessions qs ON qs.id = t.queue_session_id
      JOIN services s ON s.id = qs.service_id
     WHERE t.id = ${ref.ticketId} AND t.queue_session_id = ${ref.queueId}
       AND t.organization_id = ${auth.organizationId} AND qs.facility_id = ${ref.facilityId}`;
  if (!row) throw problems.notFound();
  const rootId = await rootTicketOf(db, auth.organizationId, ref.ticketId);
  if (!rootId) throw problems.notFound();
  return {
    rootId,
    state: row.state,
    staffRecovery: recoveryPolicyOf(row.policy).staff_recovery,
  };
}

/**
 * Advisory-lock key serializing ONE staff member's assisted-recovery requests (per-staff limit).
 * Tenant-scoped: it includes the organization id. A signed 64-bit integer as a decimal string
 * (SHA-256 prefix), so it can be bound as a parameter and compared in tests.
 */
export function assistLockKey(organizationId: string, staffUserId: string): string {
  const h = createHash('sha256')
    .update(`qb:recovery:assist:v1|${organizationId}|${staffUserId}`)
    .digest();
  return h.readBigInt64BE(0).toString();
}
const assistLimit = (detail: string): ApiProblem =>
  new ApiProblem(429, 'staff-recovery-limit', 'Too many recovery requests', { detail });

export async function staffAssist(
  db: Db,
  crypto: RecoveryCrypto | null,
  auth: AuthContext,
  ref: StaffTicketRef,
  body: RecoveryAssistRequest,
): Promise<RecoveryAssistResponse> {
  const t = await staffTicket(db, auth, ref);
  if (!t.staffRecovery) {
    throw new ApiProblem(409, 'staff-recovery-disabled', 'Staff-assisted recovery is off', {
      detail: 'This service does not allow staff-assisted recovery. Offer a new ticket instead.',
    });
  }
  if (TERMINAL.has(t.state) || t.state === TicketState.TRANSFERRED) {
    throw new ApiProblem(409, 'ticket-ended', 'Ticket ended', {
      detail: 'This ticket has ended or moved; help the visitor with their current ticket.',
    });
  }
  const audit = {
    organizationId: auth.organizationId,
    facilityId: ref.facilityId,
    actorId: auth.staffUserId,
    targetType: 'ticket',
    targetId: t.rootId,
  };
  if (!body.account_matches) {
    // No verified factor: restricted assistance only. No credential of any kind is created.
    await recordAdminEvent(db, {
      ...audit,
      eventType: 'ticket_recovery.restricted_assistance',
      details: {
        reason_code: body.reason_code,
        account_matches: false,
        asked_before_revealing: true,
      },
    });
    return { outcome: 'restricted_assistance' };
  }
  if (!crypto) throw recoveryUnavailable();
  try {
    return await assistTransaction(db, crypto, auth, ref, body, t, audit);
  } catch (err) {
    // A lock wait that timed out (another request of this staff member, or of this ticket, is
    // still running): nothing was written; the request can simply be repeated.
    if ((err as { code?: string }).code === LOCK_TIMEOUT) {
      throw new ApiProblem(503, 'recovery-busy', 'Recovery is busy', {
        detail: 'Another recovery request is still being processed. Try again in a moment.',
        retryable: true,
      });
    }
    throw err;
  }
}

/** PostgreSQL `lock_not_available` (raised when `lock_timeout` expires). */
const LOCK_TIMEOUT = '55P03';
/** Upper bound on waiting for the per-staff or per-ticket lock. */
const ASSIST_LOCK_TIMEOUT = '3s';

async function assistTransaction(
  db: Db,
  crypto: RecoveryCrypto,
  auth: AuthContext,
  ref: StaffTicketRef,
  body: RecoveryAssistRequest,
  t: { rootId: string },
  audit: {
    organizationId: string;
    facilityId: string;
    actorId: string;
    targetType: string;
    targetId: string;
  },
): Promise<RecoveryAssistResponse> {
  return db.begin(async (tx) => {
    // Lock order (documented in M5-evidence.md, "per-staff limit"): staff, then ticket.
    //  1. A per-STAFF advisory lock (organization + staff id) makes "count my recent grants,
    //     then insert" atomic for one person, whichever tickets the requests are for. Different
    //     staff never contend; nothing is locked globally.
    //  2. The ticket's proof row serializes the per-ticket limit (unchanged).
    // No other code path takes this advisory lock, so no cycle with the ticket lock is possible.
    await tx.unsafe(`SET LOCAL lock_timeout = '${ASSIST_LOCK_TIMEOUT}'`);
    await tx`SELECT pg_advisory_xact_lock(${assistLockKey(auth.organizationId, auth.staffUserId)}::bigint)`;
    await lockProof(tx, t.rootId); // serializes the per-ticket limit
    const [perTicket] = await tx<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM ticket_recovery_grants
       WHERE ticket_id = ${t.rootId} AND created_at > NOW() - INTERVAL '1 hour'`;
    if ((perTicket?.n ?? 0) >= GRANTS_PER_TICKET_PER_HOUR) {
      throw assistLimit(
        'This ticket had several recovery requests in the last hour. Offer a new ticket.',
      );
    }
    const [perStaff] = await tx<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM ticket_recovery_grants
       WHERE created_by = ${auth.staffUserId} AND created_at > NOW() - INTERVAL '10 minutes'`;
    if ((perStaff?.n ?? 0) >= GRANTS_PER_STAFF_PER_10_MIN) {
      throw assistLimit(
        'You made several recovery requests in the last 10 minutes. Try again later.',
      );
    }
    const grant = crypto.newSecret();
    const [row] = await tx<{ id: string; expires_at: Date }[]>`
      INSERT INTO ticket_recovery_grants
        (ticket_id, organization_id, facility_id, grant_hmac, assurance, reason_code, created_by, expires_at)
      VALUES (${t.rootId}, ${auth.organizationId}, ${ref.facilityId}, ${crypto.grantHmac(grant)},
              'basic', ${body.reason_code}, ${auth.staffUserId},
              NOW() + make_interval(mins => ${GRANT_TTL_MINUTES}))
      RETURNING id, expires_at`;
    if (!row) throw new Error('grant insert returned no row');
    await recordAdminEvent(tx, {
      ...audit,
      eventType: 'ticket_recovery.assist',
      details: {
        reason_code: body.reason_code,
        account_matches: true,
        asked_before_revealing: true,
        assurance: 'basic',
        approval: 'required',
      },
    });
    return {
      outcome: 'approval_required' as const,
      request_id: row.id,
      grant,
      expires_at: row.expires_at.toISOString(),
    };
  });
}

/** Second-person approval of a low-assurance request. The requester can never approve it. */
export async function approveRecovery(
  db: Db,
  auth: AuthContext,
  ref: StaffTicketRef,
  requestId: string,
): Promise<{ status: RecoveryRequestStatus }> {
  const t = await staffTicket(db, auth, ref);
  const [g] = await db<{ created_by: string; reason_code: string }[]>`
    SELECT created_by, reason_code FROM ticket_recovery_grants
     WHERE id = ${requestId} AND ticket_id = ${t.rootId} AND facility_id = ${ref.facilityId}
       AND organization_id = ${auth.organizationId}`;
  if (!g) throw problems.notFound();
  if (g.created_by === auth.staffUserId) {
    throw new ApiProblem(403, 'second-person-required', 'Second person required', {
      detail: 'Another supervisor or administrator must approve a request you made.',
    });
  }
  const updated = await db`
    UPDATE ticket_recovery_grants SET approved_by = ${auth.staffUserId}, approved_at = NOW()
     WHERE id = ${requestId} AND approved_at IS NULL AND redeemed_at IS NULL
       AND revoked_at IS NULL AND expires_at > NOW()
    RETURNING id`;
  if (updated.length === 0) {
    throw new ApiProblem(409, 'request-not-pending', 'Request not pending', {
      detail: 'This request has expired, was revoked or was already approved.',
    });
  }
  await recordAdminEvent(db, {
    organizationId: auth.organizationId,
    facilityId: ref.facilityId,
    actorId: auth.staffUserId,
    eventType: 'ticket_recovery.approved',
    targetType: 'ticket',
    targetId: t.rootId,
    details: { reason_code: g.reason_code, assurance: 'basic' },
  });
  return { status: 'approved' };
}

const statusOf = (r: {
  redeemed_at: Date | null;
  revoked_at: Date | null;
  approved_at: Date | null;
  live: boolean;
}): RecoveryRequestStatus =>
  r.redeemed_at
    ? 'redeemed'
    : r.revoked_at || !r.live
      ? 'expired'
      : r.approved_at
        ? 'approved'
        : 'pending';

export async function recoveryRequestStatus(
  db: Db,
  auth: AuthContext,
  ref: StaffTicketRef,
  requestId: string,
  canManage: boolean,
): Promise<{ status: RecoveryRequestStatus }> {
  const t = await staffTicket(db, auth, ref);
  const [r] = await db<
    {
      created_by: string;
      redeemed_at: Date | null;
      revoked_at: Date | null;
      approved_at: Date | null;
      live: boolean;
    }[]
  >`
    SELECT created_by, redeemed_at, revoked_at, approved_at, expires_at > NOW() AS live
      FROM ticket_recovery_grants
     WHERE id = ${requestId} AND ticket_id = ${t.rootId} AND facility_id = ${ref.facilityId}
       AND organization_id = ${auth.organizationId}`;
  if (!r || (r.created_by !== auth.staffUserId && !canManage)) throw problems.notFound();
  return { status: statusOf(r) };
}

/** Requests of a facility that are pending, or were decided in the last 10 minutes. */
export async function listRecoveryRequests(
  db: Db,
  auth: AuthContext,
  facilityId: string,
): Promise<RecoveryRequestSummary[]> {
  const rows = await db<
    {
      id: string;
      ticket_id: string;
      public_code: string;
      service_name: string;
      reason_code: RecoveryRequestSummary['reason_code'];
      requested_by_name: string;
      created_by: string;
      redeemed_at: Date | null;
      revoked_at: Date | null;
      approved_at: Date | null;
      live: boolean;
      created_at: Date;
      expires_at: Date;
    }[]
  >`
    SELECT g.id, g.ticket_id, t.public_code, s.name AS service_name, g.reason_code,
           u.display_name AS requested_by_name, g.created_by, g.redeemed_at, g.revoked_at,
           g.approved_at, g.expires_at > NOW() AS live, g.created_at, g.expires_at
      FROM ticket_recovery_grants g
      JOIN tickets t ON t.id = g.ticket_id
      JOIN queue_sessions qs ON qs.id = t.queue_session_id
      JOIN services s ON s.id = qs.service_id
      JOIN staff_users u ON u.id = g.created_by
     WHERE g.facility_id = ${facilityId} AND g.organization_id = ${auth.organizationId}
       AND g.created_at > NOW() - INTERVAL '30 minutes'
     ORDER BY g.created_at DESC
     LIMIT 50`;
  return rows.map((r) => ({
    request_id: r.id,
    ticket_id: r.ticket_id,
    public_code: r.public_code,
    service_name: r.service_name,
    reason_code: r.reason_code,
    requested_by_name: r.requested_by_name,
    requested_by_me: r.created_by === auth.staffUserId,
    status: statusOf(r),
    created_at: r.created_at.toISOString(),
    expires_at: r.expires_at.toISOString(),
  }));
}

/** Lost or stolen phone: every token and pending grant revoked, the recovery key removed. */
export async function staffRevokeAll(
  db: Db,
  auth: AuthContext,
  ref: StaffTicketRef,
  body: RecoveryRevokeAllRequest,
): Promise<{ revoked_tokens: number }> {
  const t = await staffTicket(db, auth, ref);
  return db.begin(async (tx) => {
    await lockProof(tx, t.rootId);
    const revoked = await revokeStatusTokens(tx, t.rootId, 'staff_revoked');
    const grants = await revokePendingGrants(tx, t.rootId);
    await clearRecoveryKey(tx, t.rootId);
    await recordAdminEvent(tx, {
      organizationId: auth.organizationId,
      facilityId: ref.facilityId,
      actorId: auth.staffUserId,
      eventType: 'ticket_recovery.revoke_all',
      targetType: 'ticket',
      targetId: t.rootId,
      details: { reason_code: body.reason_code, revoked_tokens: revoked, revoked_grants: grants },
    });
    return { revoked_tokens: revoked };
  });
}
