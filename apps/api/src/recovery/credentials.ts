import { generateToken, hashToken } from '../auth/tokens.js';
import type { Db } from '../db.js';
import type { RecoveryCrypto } from './crypto.js';

/**
 * Ticket access credentials (design §15.3–§15.6).
 *
 * Every credential change of a ticket (issue, rotate, revoke) first locks the ticket's row in
 * `ticket_recovery_proofs`, so concurrent recoveries, key regenerations and sign-outs are
 * serialized and a revoked credential can never reappear. Credentials belong to the ROOT ticket
 * (the one created at join); a transferred visitor's status follows the transfer chain.
 *
 * This is the identity plane: nothing here takes a queue-session lock, appends a queue event or
 * changes a ticket's state, position or waiting age.
 */

/** Validity of a ticket status token. */
export const STATUS_TOKEN_TTL_HOURS = 24;
/** A ticket holds at most this many active status tokens (REQ-F4.8). */
export const MAX_ACTIVE_STATUS_TOKENS = 3;

export type TokenSource = 'join' | 'recovery' | 'staff';
export type TokenRevocation = 'join_replayed' | 'cap' | 'signed_out_elsewhere' | 'staff_revoked';

/** Public path where a recovery key is entered. Contains public identifiers only. */
export const recoveryPath = (orgSlug: string, facilitySlug: string, code: string): string =>
  `/recover/${orgSlug}/${facilitySlug}/${code}`;

/**
 * Lock (creating it if needed) the recovery row of a ROOT ticket. Returns the current key HMAC
 * (null = no valid key). Tickets created before M5.1 get their row on first use.
 */
export async function lockProof(
  tx: Db,
  rootTicketId: string,
): Promise<{ key_hmac: string | null } | null> {
  await tx`
    INSERT INTO ticket_recovery_proofs (ticket_id, organization_id, facility_id)
    SELECT t.id, t.organization_id, qs.facility_id
      FROM tickets t JOIN queue_sessions qs ON qs.id = t.queue_session_id
     WHERE t.id = ${rootTicketId}
    ON CONFLICT (ticket_id) DO NOTHING`;
  const rows = await tx<{ key_hmac: string | null }[]>`
    SELECT key_hmac FROM ticket_recovery_proofs WHERE ticket_id = ${rootTicketId} FOR UPDATE`;
  return rows[0] ?? null;
}

/**
 * Issue a status token for a ROOT ticket; returns the raw token exactly once.
 * - `join` (first join or a join replayed by its original requester): earlier `join` tokens are
 *   revoked, so a replay rotates the device credential instead of accumulating tokens.
 * - `recovery` / `staff`: added alongside existing tokens; the oldest beyond the cap is revoked.
 */
export async function issueStatusToken(
  tx: Db,
  rootTicketId: string,
  source: TokenSource = 'join',
): Promise<string> {
  await lockProof(tx, rootTicketId);
  if (source === 'join') {
    await tx`
      UPDATE ticket_recovery_credentials
         SET revoked_at = NOW(), revoked_reason = 'join_replayed'
       WHERE ticket_id = ${rootTicketId} AND source = 'join' AND revoked_at IS NULL`;
  }
  const token = generateToken();
  await tx`
    INSERT INTO ticket_recovery_credentials (ticket_id, credential_hash, expires_at, source)
    VALUES (${rootTicketId}, ${hashToken(token)},
            NOW() + make_interval(hours => ${STATUS_TOKEN_TTL_HOURS}), ${source})`;
  await tx`
    UPDATE ticket_recovery_credentials
       SET revoked_at = NOW(), revoked_reason = 'cap'
     WHERE id IN (
       SELECT id FROM ticket_recovery_credentials
        WHERE ticket_id = ${rootTicketId} AND revoked_at IS NULL AND expires_at > NOW()
        ORDER BY created_at DESC, id DESC
        OFFSET ${MAX_ACTIVE_STATUS_TOKENS})`;
  await revokePushForRevokedTokens(tx, rootTicketId);
  return token;
}

/**
 * M5.4 (design §12.13): a push subscription is bound to the status token it was created with.
 * When that token is revoked (cap, join replay, "sign out other devices", staff revoke-all),
 * the subscription is revoked too and its encrypted endpoint and keys are erased at once, so a
 * signed-out device stops receiving turn alerts. Caller holds lockProof.
 */
export async function revokePushForRevokedTokens(tx: Db, rootTicketId: string): Promise<void> {
  await tx`
    UPDATE push_subscriptions ps
       SET revoked_at = NOW(), revoke_reason = 'credentials_revoked', endpoint_ct = NULL, keys_ct = NULL
      FROM ticket_recovery_credentials c
     WHERE ps.credential_id = c.id AND c.ticket_id = ${rootTicketId}
       AND c.revoked_at IS NOT NULL AND ps.revoked_at IS NULL`;
}

/** Revoke a ROOT ticket's active status tokens (optionally keeping one). Caller holds lockProof. */
export async function revokeStatusTokens(
  tx: Db,
  rootTicketId: string,
  reason: TokenRevocation,
  keepTokenId?: string,
): Promise<number> {
  const rows = await tx`
    UPDATE ticket_recovery_credentials
       SET revoked_at = NOW(), revoked_reason = ${reason}
     WHERE ticket_id = ${rootTicketId} AND revoked_at IS NULL
       AND (${keepTokenId ?? null}::uuid IS NULL OR id <> ${keepTokenId ?? null}::uuid)
    RETURNING id`;
  await revokePushForRevokedTokens(tx, rootTicketId);
  return rows.length;
}

/** Revoke every not-yet-redeemed staff grant of a ROOT ticket. Caller holds lockProof. */
export async function revokePendingGrants(tx: Db, rootTicketId: string): Promise<number> {
  const rows = await tx`
    UPDATE ticket_recovery_grants SET revoked_at = NOW()
     WHERE ticket_id = ${rootTicketId} AND redeemed_at IS NULL AND revoked_at IS NULL
    RETURNING id`;
  return rows.length;
}

/**
 * Give a ROOT ticket a new recovery key (replacing any previous one, which stops working at
 * once). Returns the raw key exactly once, or null when recovery is not configured. Caller holds
 * lockProof or calls this inside the transaction that created the ticket.
 */
export async function setRecoveryKey(
  tx: Db,
  crypto: RecoveryCrypto | null,
  rootTicketId: string,
): Promise<string | null> {
  const proof = await lockProof(tx, rootTicketId);
  if (!crypto) return null;
  const key = crypto.newSecret();
  await tx`
    UPDATE ticket_recovery_proofs
       SET key_hmac = ${crypto.keyHmac(rootTicketId, key)},
           rotated_at = ${proof?.key_hmac ? new Date() : null}
     WHERE ticket_id = ${rootTicketId}`;
  return key;
}

/** Remove a ROOT ticket's recovery key without issuing a new one (staff revoke-all). */
export async function clearRecoveryKey(tx: Db, rootTicketId: string): Promise<void> {
  await tx`
    UPDATE ticket_recovery_proofs SET key_hmac = NULL, rotated_at = NOW()
     WHERE ticket_id = ${rootTicketId}`;
}

/** Walk back through `transferred_from_ticket_id` to the ticket the credentials belong to. */
export async function rootTicketOf(
  db: Db,
  organizationId: string,
  ticketId: string,
): Promise<string | null> {
  let current = ticketId;
  for (let hop = 0; hop <= 10; hop++) {
    const rows = await db<{ id: string; transferred_from_ticket_id: string | null }[]>`
      SELECT id, transferred_from_ticket_id FROM tickets
       WHERE id = ${current} AND organization_id = ${organizationId}`;
    const row = rows[0];
    if (!row) return null;
    if (!row.transferred_from_ticket_id) return row.id;
    current = row.transferred_from_ticket_id;
  }
  return null;
}
