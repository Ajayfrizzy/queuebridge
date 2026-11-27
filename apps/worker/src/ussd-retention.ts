import type postgres from 'postgres';

/**
 * M6.2 USSD session retention (REQ-F12.3). Idempotent and bounded per pass; counts only.
 * - 10 minutes after a session expired, its last screen (encrypted; it may hold a recovery key
 *   shown once) and its menu state are cleared: no provider retry arrives that late.
 * - 1 hour after it expired, the row is deleted. Until then it counts towards the per-phone join
 *   limit (`joined_at`, keyed phone hash only).
 * The webhook nonces are removed with the SMS ones (24 hours, `purgeSmsData`).
 * The worker never touches tickets, queue sessions or events here.
 */
export interface UssdRetentionResult {
  cleared: number;
  deleted: number;
}

export async function purgeUssdSessions(
  sql: postgres.Sql,
  opts: { batch?: number } = {},
): Promise<UssdRetentionResult> {
  const batch = opts.batch ?? 1000;
  const cleared = await sql`
    UPDATE ussd_sessions SET last_response_ct = NULL, state = '{}'::jsonb, updated_at = NOW()
     WHERE id IN (
       SELECT id FROM ussd_sessions
        WHERE expires_at < NOW() - INTERVAL '10 minutes'
          AND (last_response_ct IS NOT NULL OR state <> '{}'::jsonb)
        LIMIT ${batch})`;
  const deleted = await sql`
    DELETE FROM ussd_sessions WHERE id IN (
      SELECT id FROM ussd_sessions WHERE expires_at < NOW() - INTERVAL '1 hour' LIMIT ${batch})`;
  return { cleared: cleared.count, deleted: deleted.count };
}
