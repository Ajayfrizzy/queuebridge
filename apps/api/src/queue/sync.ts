import {
  CommandEnvelopeSchema,
  isAdvanceAction,
  ADVANCEMENT_EVENT_TYPES,
  OfflineActionSchema,
  parseOfflinePayload,
  QueueAction,
  QueueSessionState,
  type CommandDisposition,
  type CommandEnvelope,
  type CommandResult,
  type CoordinatorAuth,
  type QueueCommandRequest,
  type SyncBatchResponse,
  type SyncBatchTransport,
} from '@queuebridge/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { TransactionSql } from 'postgres';
import { Permission, queueActorRoles, type AuthContext } from '../auth/rbac.js';
import type { Db } from '../db.js';
import type { Env } from '../env.js';
import { ApiProblem, isUniqueViolation, problems } from '../errors.js';
import { authoritySigningKey, verifyAuthority } from './authority.js';
import { applyCommand, CommandRejected } from './commands.js';
import { appendEvent, lockSessions, type LockedSession } from './events.js';
import { assessTiming } from './timing.js';
import { setRecoveryKey } from '../recovery/credentials.js';
import { createRecoveryCrypto, type RecoveryCrypto } from '../recovery/crypto.js';
import { issueStatusToken, issueTicket } from './tickets.js';

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

/**
 * Plain-language explanation for each machine-readable reason. Shown to staff in the outbox
 * and the conflict-review screen. Never includes personal data or internal identifiers.
 */
export const SYNC_REASON_MESSAGES: Record<string, string> = {
  stale_epoch:
    "This device's coordinator authority was replaced while it was offline. A supervisor must review this action; it was not applied.",
  authority_expired:
    'This action was recorded after the coordinator authority had expired. A supervisor must review it.',
  authority_timing_unverifiable:
    "The server could not confirm this action happened while the coordinator authority was valid (the device's clock cannot be trusted for that). A supervisor must review it.",
  clock_rollback:
    "This device's clock was moved backwards, so the time of this action cannot be trusted. A supervisor must review it.",
  base_revision_ahead:
    'This device believed the queue was further ahead than the server knows. A supervisor must review this action.',
  concurrent_advancement:
    'The queue was advanced by another authority after this device last synced. A supervisor must review this action.',
  queue_closed:
    'The queue was closed before this action synced. Tickets are not moved automatically; a supervisor must review it.',
  queue_paused: 'The queue was paused before this action synced. A supervisor must review it.',
  service_unavailable:
    'The service or facility is no longer active. A supervisor must review this action.',
  unresolved_ticket_ref:
    'The ticket this action refers to was not confirmed by the server, so the action could not be applied.',
  call_mismatch:
    'The ticket called offline is not the one the queue would call now. A supervisor must review this action.',
  not_coordinator: 'This device is not the designated coordinator for this queue.',
  action_not_allowed: 'The coordinator authority does not include this action.',
  authority_token_missing:
    'This device did not present valid coordinator authority for this queue.',
  authority_token_invalid:
    'The coordinator authority presented by this device is not valid for this action.',
  epoch_from_future: 'This device claimed an authority epoch the server has never issued.',
  forbidden: 'Your role does not permit this action.',
  not_found: 'The ticket or counter for this action was not found.',
  invalid_payload: 'The recorded action is malformed.',
  action_not_offline: 'This action cannot be recorded offline.',
  device_facility_mismatch: 'This device is registered to a different facility.',
  queue_not_found: 'This queue was not found.',
  actor_mismatch: 'This action was recorded by a different signed-in user.',
  operation_id_reused: 'This operation id was already used for a different action.',
  invalid_command: 'The recorded action is malformed.',
  temporary_ref_reused: 'This temporary reference was already used by another action.',
  dismissed_by_supervisor: 'A supervisor reviewed this action and chose not to apply it.',
};

const messageFor = (reason: string, fallback?: string): string =>
  SYNC_REASON_MESSAGES[reason] ?? fallback ?? 'The action could not be applied.';

// ---------------------------------------------------------------------------
// Evaluation model
// ---------------------------------------------------------------------------

/** Fields of a committed result that are stored for replay (never the one-time status token). */
export interface StoredResult {
  disposition: CommandDisposition;
  server_revision?: number;
  server_sequence?: number;
  ticket_mapping?: { temporary_ref: string; public_code: string; ticket_id?: string };
  ticket_id?: string;
  public_code?: string;
  reason_code?: string;
  rejection_reason?: string;
}

type Evaluation =
  | { kind: 'committed'; result: StoredResult; statusToken?: string; recoveryKey?: string }
  | { kind: 'needs_review' | 'rejected'; reason: string; message?: string };

const nr = (reason: string, message?: string): Evaluation => ({
  kind: 'needs_review',
  reason,
  ...(message ? { message } : {}),
});
const rj = (reason: string, message?: string): Evaluation => ({
  kind: 'rejected',
  reason,
  ...(message ? { message } : {}),
});

export interface DeviceRef {
  id: string;
  facility_id: string;
  label: string | null;
}

interface BatchContext {
  auth: AuthContext;
  devices: Map<string, DeviceRef>;
  /** Verified coordinator tokens keyed `${queue}:${device}:${epoch}:${delivered_at}` */
  authorities: Map<string, CoordinatorAuth>;
  log: FastifyBaseLogger;
  /** M5.1: recovery keys for tickets confirmed by this batch (null: recovery not configured) */
  recovery?: RecoveryCrypto | null;
}

const tokenKey = (queue: string, device: string, epoch: number, delivered = ''): string =>
  `${queue}:${device}:${epoch}:${delivered}`;
const epochPrefix = (queue: string, device: string, epoch: number): string =>
  `${queue}:${device}:${epoch}:`;

interface StoredOp {
  queue_session_id: string;
  action: string;
  actor_id: string | null;
  device_id: string | null;
  status: string;
  result_json: StoredResult;
}

// ---------------------------------------------------------------------------
// Batch entry point
// ---------------------------------------------------------------------------

/**
 * Process an offline sync batch.
 *
 * - Commands are processed in `client_sequence` order (ties by position), each in its OWN
 *   transaction under the queue-session row lock, so one conflicted or malformed command never
 *   discards the valid ones, and a crash mid-batch leaves every finished command committed
 *   exactly once (the retry sees `duplicate`).
 * - Tenant, facility, actor and roles come from the authenticated session, never the envelope.
 * - The envelope's `created_at_client` never affects ordering or authorization. Offline
 *   advancement is timed from server-signed `delivered_at` plus device elapsed-time evidence
 *   (see ./timing.ts); anything that cannot be timed safely is held for review.
 * - Results are returned in submission order.
 */
export async function processSyncBatch(
  db: Db,
  env: Env,
  auth: AuthContext,
  transport: SyncBatchTransport,
  log: FastifyBaseLogger,
): Promise<SyncBatchResponse> {
  type Slot = { index: number; raw: unknown; envelope: CommandEnvelope | null; problem?: string };
  const slots: Slot[] = transport.commands.map((raw, index) => {
    const parsed = CommandEnvelopeSchema.safeParse(raw);
    return parsed.success
      ? { index, raw, envelope: parsed.data }
      : {
          index,
          raw,
          envelope: null,
          // Field paths only: the submitted values are never echoed back
          problem: [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(command)'))]
            .slice(0, 6)
            .join(', '),
        };
  });

  // ---- Device gate (whole batch): ownership, tenant, revocation --------------------------------
  const deviceIds = [...new Set(slots.flatMap((s) => (s.envelope ? [s.envelope.device_id] : [])))];
  const devices = new Map<string, DeviceRef>();
  if (deviceIds.length > 0) {
    const rows = await db<(DeviceRef & { staff_user_id: string; revoked_at: Date | null })[]>`
      SELECT id, facility_id, label, staff_user_id, revoked_at FROM devices
       WHERE id = ANY(${deviceIds}::uuid[]) AND organization_id = ${auth.organizationId}`;
    for (const id of deviceIds) {
      const row = rows.find((r) => r.id === id);
      // Unknown, foreign-user and cross-tenant devices are indistinguishable
      if (!row || row.staff_user_id !== auth.staffUserId) throw problems.deviceNotAuthorized();
      if (row.revoked_at) throw problems.deviceRevoked();
      devices.set(id, { id: row.id, facility_id: row.facility_id, label: row.label });
    }
  }

  const key = authoritySigningKey(env);
  const authorities = new Map<string, CoordinatorAuth>();
  for (const token of transport.authorities ?? []) {
    const a = verifyAuthority(token, key);
    if (a) {
      authorities.set(tokenKey(a.queue_session_id, a.device_id, a.epoch, a.delivered_at ?? ''), a);
    }
  }
  const ctx: BatchContext = {
    auth,
    devices,
    authorities,
    log,
    recovery: createRecoveryCrypto(env),
  };

  // ---- Process in client_sequence order ------------------------------------------------------
  const results: CommandResult[] = new Array<CommandResult>(slots.length);
  const touched = new Set<string>();
  const ordered = slots
    .filter((s): s is Slot & { envelope: CommandEnvelope } => s.envelope !== null)
    .sort((a, b) => a.envelope.client_sequence - b.envelope.client_sequence || a.index - b.index);

  for (const slot of slots) {
    if (slot.envelope) continue;
    const raw = slot.raw as { operation_id?: unknown; client_sequence?: unknown } | null;
    const opId =
      raw && typeof raw.operation_id === 'string' && /^[0-9a-f-]{36}$/i.test(raw.operation_id)
        ? raw.operation_id
        : null;
    results[slot.index] = {
      index: slot.index,
      operation_id: opId,
      client_sequence:
        raw && typeof raw.client_sequence === 'number' && Number.isInteger(raw.client_sequence)
          ? Math.max(0, raw.client_sequence)
          : 0,
      disposition: 'rejected',
      reason_code: 'invalid_command',
      rejection_reason: `${messageFor('invalid_command')} Check: ${slot.problem ?? ''}`.trim(),
    };
  }

  for (const slot of ordered) {
    const res = await processOne(db, ctx, slot.envelope, slot.index);
    results[slot.index] = res;
    touched.add(slot.envelope.queue_session_id);
  }

  // ---- Device health ---------------------------------------------------------------------------
  const ids = [...devices.keys()];
  if (ids.length > 0) {
    const pending = transport.device_report?.pending_count;
    await db`
      UPDATE devices
         SET last_seen_at = NOW(), last_sync_at = NOW(),
             reported_pending_count = ${pending !== undefined && ids.length === 1 ? pending : db`reported_pending_count`},
             last_failure_code = NULL
       WHERE id = ANY(${ids}::uuid[])`;
  }

  const queue_revisions: Record<string, number> = {};
  if (touched.size > 0) {
    const revs = await db<{ id: string; revision: number }[]>`
      SELECT id, revision FROM queue_sessions
       WHERE id = ANY(${[...touched]}::uuid[]) AND organization_id = ${auth.organizationId}`;
    for (const r of revs) queue_revisions[r.id] = r.revision;
  }

  return { results, queue_revisions, processed_at: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// One command
// ---------------------------------------------------------------------------

async function processOne(
  db: Db,
  ctx: BatchContext,
  env: CommandEnvelope,
  index: number,
): Promise<CommandResult> {
  const run = (): Promise<CommandResult> => db.begin((tx) => processInTx(tx, ctx, env, index));
  try {
    return await run();
  } catch (err) {
    // The same operation id raced in another transaction: the stored row decides (exactly once)
    if (isUniqueViolation(err, 'client_operations_org_op_idx')) return run();
    throw err;
  }
}

const unrecorded = (env: CommandEnvelope, index: number, reason: string): CommandResult => ({
  index,
  operation_id: env.operation_id,
  client_sequence: env.client_sequence,
  disposition: 'rejected',
  reason_code: reason,
  rejection_reason: messageFor(reason),
});

function fromStored(
  stored: StoredResult,
  env: CommandEnvelope,
  index: number,
  disposition: CommandDisposition,
): CommandResult {
  return {
    index,
    operation_id: env.operation_id,
    client_sequence: env.client_sequence,
    disposition,
    ...(stored.server_revision !== undefined ? { server_revision: stored.server_revision } : {}),
    ...(stored.server_sequence !== undefined ? { server_sequence: stored.server_sequence } : {}),
    ...(stored.ticket_mapping ? { ticket_mapping: stored.ticket_mapping } : {}),
    ...(stored.ticket_id ? { ticket_id: stored.ticket_id } : {}),
    ...(stored.public_code ? { public_code: stored.public_code } : {}),
    ...(stored.reason_code ? { reason_code: stored.reason_code } : {}),
    ...(stored.rejection_reason ? { rejection_reason: stored.rejection_reason } : {}),
  };
}

async function processInTx(
  tx: TransactionSql,
  ctx: BatchContext,
  env: CommandEnvelope,
  index: number,
): Promise<CommandResult> {
  const { auth } = ctx;

  // Envelope identity is advisory. A different tenant or a different signed-in user than the
  // one that recorded the action is refused outright — never re-attributed.
  if (env.organization_id !== auth.organizationId) return unrecorded(env, index, 'queue_not_found');
  if (env.actor_id !== auth.staffUserId) return unrecorded(env, index, 'actor_mismatch');

  const locked = await lockSessions(tx, auth.organizationId, [env.queue_session_id]);
  const session = locked.get(env.queue_session_id);
  if (!session) return unrecorded(env, index, 'queue_not_found');
  const roles = queueActorRoles(auth, session.facility_id);
  // No role at the facility ⇒ indistinguishable from a queue that does not exist
  if (roles.length === 0 || env.facility_id !== session.facility_id) {
    return unrecorded(env, index, 'queue_not_found');
  }

  // ---- Deduplicate ---------------------------------------------------------------------------
  const prior = await tx<StoredOp[]>`
    SELECT queue_session_id, action, actor_id, device_id, status, result_json
      FROM client_operations
     WHERE organization_id = ${auth.organizationId} AND operation_id = ${env.operation_id}`;
  const existing = prior[0];
  if (existing) {
    if (
      existing.queue_session_id !== session.id ||
      existing.action !== env.action ||
      existing.actor_id !== auth.staffUserId ||
      // Offline operations replay only from the device that recorded them (status credentials
      // are re-issued on replay, so this also binds them to the capturing device)
      (existing.device_id !== null && existing.device_id !== env.device_id)
    ) {
      return unrecorded(env, index, 'operation_id_reused');
    }
    const disposition: CommandDisposition =
      existing.status === 'committed' ? 'duplicate' : (existing.status as CommandDisposition);
    const res = fromStored(existing.result_json, env, index, disposition);
    // A lost-response replay of a confirmed capture re-issues the visitor status credential to
    // the SAME staff member on the SAME device that captured it. Issuing rotates the credential:
    // any earlier link stops working, so at most one link is ever valid. The raw token is
    // returned in this response only — never stored (only its hash), logged or put in events.
    if (
      existing.status === 'committed' &&
      existing.action === QueueAction.TICKET_CREATE &&
      existing.result_json.ticket_id
    ) {
      res.status_token = await issueStatusToken(tx, existing.result_json.ticket_id);
      const key = await setRecoveryKey(tx, ctx.recovery ?? null, existing.result_json.ticket_id);
      if (key) res.recovery_key = key;
    }
    return res;
  }

  // ---- Evaluate --------------------------------------------------------------------------------
  const device = ctx.devices.get(env.device_id) as DeviceRef;
  const evaluation = await evaluate(tx, ctx, session, locked, roles, env, device, {
    review: false,
  });

  // ---- Record ----------------------------------------------------------------------------------
  const baseEnvelope = { ...env, payload: env.payload };
  if (evaluation.kind === 'committed') {
    await insertOperation(
      tx,
      ctx,
      session.id,
      env,
      device.id,
      'committed',
      evaluation.result,
      null,
      baseEnvelope,
    );
    return {
      ...fromStored(evaluation.result, env, index, 'committed'),
      ...(evaluation.statusToken ? { status_token: evaluation.statusToken } : {}),
      ...(evaluation.recoveryKey ? { recovery_key: evaluation.recoveryKey } : {}),
    };
  }

  const message = evaluation.message ?? messageFor(evaluation.reason);
  const stored: StoredResult = {
    disposition: evaluation.kind,
    reason_code: evaluation.reason,
    rejection_reason: message,
  };
  if (evaluation.kind === 'needs_review') {
    // The conflict itself is an audited, hash-chained event (REQ-F8.4)
    const ev = await appendEvent(tx, session, {
      eventType: QueueAction.SYNC_CONFLICT_DETECTED,
      actorId: auth.staffUserId,
      operationId: env.operation_id,
      payload: {
        operation_id: env.operation_id,
        action: env.action,
        reason_code: evaluation.reason,
        device_id: env.device_id,
        claimed_epoch: env.coordinator_epoch,
        current_epoch: session.coordinator_epoch,
      },
    });
    stored.server_revision = ev.revision;
  } else {
    stored.server_revision = session.revision;
    // Security-relevant refusals are logged without payload content
    if (
      [
        'not_coordinator',
        'authority_token_missing',
        'authority_token_invalid',
        'epoch_from_future',
        'forbidden',
      ].includes(evaluation.reason)
    ) {
      ctx.log.warn(
        {
          reason: evaluation.reason,
          action: env.action,
          device_id: env.device_id,
          queue_session_id: session.id,
        },
        'Offline command refused',
      );
    }
  }
  await insertOperation(
    tx,
    ctx,
    session.id,
    env,
    device.id,
    evaluation.kind,
    stored,
    evaluation.reason,
    baseEnvelope,
  );
  return fromStored(stored, env, index, evaluation.kind);
}

async function insertOperation(
  tx: TransactionSql,
  ctx: BatchContext,
  sessionId: string,
  env: CommandEnvelope,
  deviceId: string,
  status: CommandDisposition,
  result: StoredResult,
  reason: string | null,
  envelope: unknown,
): Promise<void> {
  await tx`
    INSERT INTO client_operations
      (organization_id, queue_session_id, device_id, actor_id, operation_id, client_sequence,
       action, status, result_json, source, envelope, reason_code)
    VALUES (${ctx.auth.organizationId}, ${sessionId}, ${deviceId}, ${ctx.auth.staffUserId},
            ${env.operation_id}, ${env.client_sequence}, ${env.action}, ${status},
            ${tx.json(result as never)}, 'offline_sync', ${tx.json(envelope as never)}, ${reason})`;
}

// ---------------------------------------------------------------------------
// Evaluation (shared by sync and supervisor "apply")
// ---------------------------------------------------------------------------

export interface EvaluateOptions {
  /**
   * Supervisor review "apply": skip the offline-authority checks (epoch, token, expiry,
   * base revision, concurrent advancement) — the supervisor IS the authority now — but keep
   * every state, role and policy check.
   */
  review: boolean;
  /** Actor to record on the resulting event when it differs from the session user (review) */
  originalActorId?: string;
}

export async function evaluate(
  tx: TransactionSql,
  ctx: Pick<BatchContext, 'auth' | 'authorities' | 'recovery'>,
  session: LockedSession,
  locked: Map<string, LockedSession>,
  roles: ReturnType<typeof queueActorRoles>,
  env: CommandEnvelope,
  device: DeviceRef,
  opts: EvaluateOptions,
): Promise<Evaluation> {
  if (device.facility_id !== session.facility_id) return rj('device_facility_mismatch');

  if (!OfflineActionSchema.safeParse(env.action).success) return rj('action_not_offline');
  const parsed = parseOfflinePayload(env.action, env.payload);
  if (!parsed.ok)
    return rj('invalid_payload', `${messageFor('invalid_payload')} ${parsed.message}`);

  session.eventExtra = {
    origin: opts.review ? 'review_apply' : 'offline_sync',
    device_id: device.id,
    ...(opts.review
      ? { reviewed_by: ctx.auth.staffUserId, original_actor_id: opts.originalActorId ?? null }
      : { coordinator_epoch: env.coordinator_epoch }),
  };
  try {
    // ---- Provisional ticket capture: any registered device of an authorized staff user -----
    if (parsed.action === QueueAction.TICKET_CREATE) {
      const allowed: readonly string[] = Permission.WALK_IN;
      if (!roles.some((r) => allowed.includes(r))) return rj('forbidden');
      if (session.facility_status !== 'active' || session.service_status !== 'active') {
        return nr('service_unavailable');
      }
      if (session.state === QueueSessionState.CLOSED) return nr('queue_closed');
      if (session.state === QueueSessionState.PAUSED) return nr('queue_paused');

      const ref = parsed.data.temporary_ref;
      const clash = await tx`
        SELECT 1 FROM client_operations
         WHERE device_id = ${device.id} AND action = ${QueueAction.TICKET_CREATE}
           AND result_json -> 'ticket_mapping' ->> 'temporary_ref' = ${ref}
           AND operation_id <> ${env.operation_id} LIMIT 1`;
      if (clash.length > 0) return rj('temporary_ref_reused');

      session.eventExtra = { ...session.eventExtra, temporary_ref: ref };
      const issued = await issueTicket(tx, session, {
        channel: 'staff',
        actorId: ctx.auth.staffUserId,
        operationId: env.operation_id,
        createdBy: opts.originalActorId ?? ctx.auth.staffUserId,
      });
      const token = await issueStatusToken(tx, issued.ticketId);
      const key = await setRecoveryKey(tx, ctx.recovery ?? null, issued.ticketId);
      return {
        kind: 'committed',
        statusToken: token,
        ...(key ? { recoveryKey: key } : {}),
        result: {
          disposition: 'committed',
          server_revision: session.revision,
          server_sequence: issued.sequence,
          ticket_id: issued.ticketId,
          public_code: issued.publicCode,
          ticket_mapping: {
            temporary_ref: ref,
            public_code: issued.publicCode,
            ticket_id: issued.ticketId,
          },
        },
      };
    }

    // ---- Advancement: designated coordinator only -------------------------------------------
    if (!isAdvanceAction(parsed.action)) return rj('action_not_offline');

    if (!opts.review) {
      const prefix = epochPrefix(session.id, device.id, env.coordinator_epoch);
      const anyToken = [...ctx.authorities.entries()].find(([k]) => k.startsWith(prefix))?.[1];
      if (!anyToken) return rj('authority_token_missing');
      if (anyToken.facility_id !== session.facility_id) return rj('authority_token_invalid');
      // The token the device measured its timing from (it must have been presented)
      const token = env.authority_timing
        ? ctx.authorities.get(
            tokenKey(
              session.id,
              device.id,
              env.coordinator_epoch,
              env.authority_timing.delivered_at,
            ),
          )
        : undefined;

      // Fencing: a genuine (signed) but replaced coordinator is held for review, never applied
      if (env.coordinator_epoch < session.coordinator_epoch) return nr('stale_epoch');
      if (env.coordinator_epoch > session.coordinator_epoch) return rj('epoch_from_future');
      if (session.coordinator_device_id !== device.id) return rj('not_coordinator');
      const grant = (token ?? anyToken).allowed_actions as string[];
      if (
        !session.coordinator_allowed_actions.includes(env.action) ||
        !grant.includes(env.action)
      ) {
        return rj('action_not_allowed');
      }

      // Timing: never from the device's wall clock (created_at_client is diagnostic only)
      const previous = env.authority_timing
        ? await tx<{ elapsed: string | null }[]>`
            SELECT envelope -> 'authority_timing' ->> 'elapsed_ms' AS elapsed FROM client_operations
             WHERE device_id = ${device.id} AND queue_session_id = ${session.id}
               AND envelope -> 'authority_timing' ->> 'delivered_at' = ${env.authority_timing.delivered_at}
               AND client_sequence < ${env.client_sequence}
             ORDER BY client_sequence DESC LIMIT 1`
        : [];
      const prevElapsed = previous[0]?.elapsed;
      const verdict = assessTiming({
        timing: env.authority_timing,
        token,
        sessionExpiresAt: session.coordinator_expires_at,
        nowMs: Date.now(),
        previousElapsedMs:
          prevElapsed !== null && prevElapsed !== undefined ? Number(prevElapsed) : undefined,
      });
      if (!verdict.ok) return nr(verdict.reason);

      if (env.base_revision > session.revision) return nr('base_revision_ahead');
      const foreign = await tx`
        SELECT 1 FROM queue_events
         WHERE queue_session_id = ${session.id} AND sequence > ${env.base_revision}
           AND event_type = ANY(${ADVANCEMENT_EVENT_TYPES as string[]})
           AND COALESCE(payload ->> 'coordinator_epoch', '') <> ${String(env.coordinator_epoch)}
         LIMIT 1`;
      if (foreign.length > 0) return nr('concurrent_advancement');
    }

    // Resolve a temporary reference to the confirmed ticket created earlier by this device
    const target = parsed.data as { ticket_id?: string; ticket_ref?: string; counter_id?: string };
    let ticketId = target.ticket_id;
    if (!ticketId && target.ticket_ref) {
      const rows = await tx<{ ticket_id: string | null }[]>`
        SELECT result_json ->> 'ticket_id' AS ticket_id FROM client_operations
         WHERE device_id = ${device.id} AND action = ${QueueAction.TICKET_CREATE}
           AND status = 'committed' AND queue_session_id = ${session.id}
           AND result_json -> 'ticket_mapping' ->> 'temporary_ref' = ${target.ticket_ref}
         LIMIT 1`;
      ticketId = rows[0]?.ticket_id ?? undefined;
      if (!ticketId) return nr('unresolved_ticket_ref');
    }

    const command = {
      operation_id: env.operation_id,
      action: parsed.action,
      ...(parsed.action === QueueAction.TICKET_CALL_NEXT
        ? { counter_id: target.counter_id }
        : { ticket_id: ticketId }),
    } as QueueCommandRequest;

    const mem = {
      state: session.state,
      revision: session.revision,
      last_sequence: session.last_sequence,
      ticket_prefix: session.ticket_prefix,
    };
    try {
      const outcome = await tx.savepoint(async (sp) => {
        const o = await applyCommand(sp, session, locked, null, roles, ctx.auth, command, {
          viaCoordinatorSync: true,
        });
        // An offline "call next" names the ticket the coordinator called. If the queue would call
        // a different one now, that is a disagreement to surface, not to paper over.
        if (
          parsed.action === QueueAction.TICKET_CALL_NEXT &&
          ticketId &&
          o.ticket_id !== ticketId
        ) {
          throw new CommandRejected('call_mismatch', messageFor('call_mismatch'));
        }
        return o;
      });
      return {
        kind: 'committed',
        result: {
          disposition: 'committed',
          server_revision: outcome.server_revision,
          ...(outcome.server_sequence !== null ? { server_sequence: outcome.server_sequence } : {}),
          ...(outcome.ticket_id ? { ticket_id: outcome.ticket_id } : {}),
          ...(outcome.public_code ? { public_code: outcome.public_code } : {}),
        },
      };
    } catch (err) {
      // The savepoint rolled the database back; put the in-memory session back to match
      Object.assign(session, mem);
      if (err instanceof CommandRejected) return nr(err.reasonCode, err.message);
      if (err instanceof ApiProblem) {
        if (err.status === 403) return rj('forbidden');
        if (err.status === 404) return rj('not_found');
      }
      throw err;
    }
  } finally {
    delete session.eventExtra;
  }
}
