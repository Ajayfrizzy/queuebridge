import type postgres from 'postgres';

/**
 * M5.1 recovery-data retention (REQ-F4.15, design §15.14). Idempotent and bounded: each pass
 * removes at most `batch` rows per kind, so a large backlog never holds long locks. Logs counts
 * only — never ids, codes, hashes or secrets.
 *
 * - Status tokens: deleted 24 h after they expired or were revoked.
 * - Recovery-key HMAC: removed 24 h after the visit ended (the proof row is kept, without any key
 *   material). The key belongs to the ROOT ticket and follows transfers, so "ended" is judged on
 *   the CURRENT ticket of the transfer chain: completed or cancelled, or its queue session closed,
 *   for 24 h. A transferred root therefore keeps its key while the visit continues elsewhere.
 * - Staff grants: deleted 24 h after they expired, were redeemed or were revoked.
 * - Throttle windows: deleted 24 h after the window started (all windows are ≤ 15 minutes).
 */
export interface RetentionResult {
  tokens: number;
  keys: number;
  grants: number;
  throttle: number;
}

export async function runRecoveryRetention(
  sql: postgres.Sql,
  opts: { batch?: number } = {},
): Promise<RetentionResult> {
  const batch = opts.batch ?? 1000;
  const tokens = await sql`
    DELETE FROM ticket_recovery_credentials WHERE id IN (
      SELECT id FROM ticket_recovery_credentials
       WHERE expires_at < NOW() - INTERVAL '24 hours'
          OR revoked_at < NOW() - INTERVAL '24 hours'
       LIMIT ${batch})`;
  const keys = await sql`
    WITH RECURSIVE chain AS (
      SELECT p.ticket_id AS root_id, t.id, t.transferred_to_ticket_id, 0 AS depth
        FROM ticket_recovery_proofs p JOIN tickets t ON t.id = p.ticket_id
       WHERE p.key_hmac IS NOT NULL
      UNION ALL
      SELECT c.root_id, t.id, t.transferred_to_ticket_id, c.depth + 1
        FROM chain c JOIN tickets t ON t.id = c.transferred_to_ticket_id
       WHERE c.depth < 32
    ), ended AS (
      SELECT c.root_id FROM chain c
        JOIN tickets t ON t.id = c.id
        JOIN queue_sessions qs ON qs.id = t.queue_session_id
       WHERE c.transferred_to_ticket_id IS NULL
         AND ((t.state IN ('completed', 'cancelled')
               AND COALESCE(t.completed_at, t.updated_at) < NOW() - INTERVAL '24 hours')
              OR (qs.state = 'closed' AND qs.updated_at < NOW() - INTERVAL '24 hours'))
       LIMIT ${batch}
    )
    UPDATE ticket_recovery_proofs p SET key_hmac = NULL
      FROM ended e WHERE p.ticket_id = e.root_id AND p.key_hmac IS NOT NULL`;
  const grants = await sql`
    DELETE FROM ticket_recovery_grants WHERE id IN (
      SELECT id FROM ticket_recovery_grants
       WHERE expires_at < NOW() - INTERVAL '24 hours'
          OR redeemed_at < NOW() - INTERVAL '24 hours'
          OR revoked_at < NOW() - INTERVAL '24 hours'
       LIMIT ${batch})`;
  const throttle = await sql`
    DELETE FROM recovery_throttle WHERE (scope, key_hash) IN (
      SELECT scope, key_hash FROM recovery_throttle
       WHERE window_started_at < NOW() - INTERVAL '24 hours'
       LIMIT ${batch})`;
  return {
    tokens: tokens.count,
    keys: keys.count,
    grants: grants.count,
    throttle: throttle.count,
  };
}
