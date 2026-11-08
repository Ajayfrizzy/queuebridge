import {
  CommandDisposition,
  SyncStatus,
  type CommandResult,
  type SyncBatchRequest,
  type SyncBatchResponse,
} from '@queuebridge/contracts';
import {
  isUnsynced,
  toEnvelope,
  toLocalResult,
  type OutboxOperation,
  type OutboxStore,
} from './outbox.js';

export interface ConflictInfo {
  operation_id: string;
  disposition: CommandDisposition;
  reason: string | undefined;
}

export interface ReconcileResult {
  updated: OutboxOperation[];
  conflicts: ConflictInfo[];
}

/** Local status corresponding to a server disposition. Exhaustive by construction. */
export function statusForDisposition(d: CommandDisposition): SyncStatus {
  switch (d) {
    case CommandDisposition.COMMITTED:
      return SyncStatus.COMMITTED;
    case CommandDisposition.DUPLICATE:
      return SyncStatus.DUPLICATE;
    case CommandDisposition.NEEDS_REVIEW:
      return SyncStatus.NEEDS_REVIEW;
    case CommandDisposition.REJECTED:
      return SyncStatus.REJECTED;
  }
}

/**
 * Reconcile local operations against per-command server dispositions (pure).
 *
 * - An operation only becomes `committed` / `duplicate` when the SERVER said so for its
 *   operation id; an operation with no result stays exactly as it was (never "assumed synced").
 * - `needs_review` and `rejected` are surfaced as conflicts for staff.
 * - Results are matched by operation id (the response order is not trusted).
 */
export function reconcileBatch(
  localOps: readonly OutboxOperation[],
  serverResults: readonly CommandResult[],
): ReconcileResult {
  const byOp = new Map<string, CommandResult>();
  for (const r of serverResults) if (r.operation_id !== null) byOp.set(r.operation_id, r);

  const conflicts: ConflictInfo[] = [];
  const updated = localOps.map((op) => {
    const result = byOp.get(op.operation_id);
    if (!result) return op;
    const status = statusForDisposition(result.disposition);
    if (status === SyncStatus.NEEDS_REVIEW || status === SyncStatus.REJECTED) {
      conflicts.push({
        operation_id: op.operation_id,
        disposition: result.disposition,
        reason: result.rejection_reason,
      });
    }
    return {
      ...op,
      status,
      result: toLocalResult(result),
      last_error: null,
    } satisfies OutboxOperation;
  });
  return { updated, conflicts };
}

/** Operations to (re)send: unsent ones, plus `needs_review` ones so a resolution is learned. */
export function getPendingOperations(ops: readonly OutboxOperation[]): OutboxOperation[] {
  return ops.filter((o) => isUnsynced(o) || o.status === SyncStatus.NEEDS_REVIEW);
}

/** Submission order is `client_sequence`, never wall-clock time. */
export function orderForSubmission(ops: readonly OutboxOperation[]): OutboxOperation[] {
  return [...ops].sort((a, b) => a.client_sequence - b.client_sequence);
}

// ---------------------------------------------------------------------------
// Flush loop (I/O injected)
// ---------------------------------------------------------------------------

export const MAX_BATCH = 100;

export type FlushErrorKind =
  /** no response: the outcome of the in-flight batch is UNKNOWN — keep pending, retry */
  | 'network'
  /** 5xx / 429: retry later */
  | 'server'
  /** 401: session ended — nothing can sync until the same user signs in again */
  | 'auth'
  /** 403 device-revoked: this device may never sync again */
  | 'device_revoked'
  /** any other 4xx: a client bug or incompatible app version — do not hammer the server */
  | 'client';

export class SyncTransportError extends Error {
  public constructor(
    public readonly kind: FlushErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'SyncTransportError';
  }
}

export interface FlushDeps {
  store: OutboxStore;
  /** Sends one batch. Throws SyncTransportError on any failure. */
  send: (
    batch: SyncBatchRequest,
    meta: { pending_count: number; authorities: string[] },
  ) => Promise<SyncBatchResponse>;
  /** Authority tokens to present (one per queue the device advances) */
  authorities?: () => string[];
  nowMs?: () => number;
}

/**
 * A visitor status credential for a ticket captured offline, returned by the server once per
 * committed (or replayed) capture. Held IN MEMORY ONLY by the caller for a one-time hand-over;
 * never written to the outbox, logs or any store.
 */
export interface StatusHandover {
  operation_id: string;
  queue_session_id: string;
  /** Server-confirmed public code (never a temporary reference) */
  public_code: string;
  status_token: string;
}

/** Extract hand-over credentials from server results for this device's captures. */
export function extractHandovers(
  ops: readonly OutboxOperation[],
  results: readonly CommandResult[],
): StatusHandover[] {
  const byId = new Map(ops.map((o) => [o.operation_id, o]));
  const out: StatusHandover[] = [];
  for (const r of results) {
    const op = r.operation_id ? byId.get(r.operation_id) : undefined;
    if (
      op?.action === 'ticket.create' &&
      (r.disposition === 'committed' || r.disposition === 'duplicate') &&
      r.status_token &&
      r.public_code
    ) {
      out.push({
        operation_id: op.operation_id,
        queue_session_id: op.queue_session_id,
        public_code: r.public_code,
        status_token: r.status_token,
      });
    }
  }
  return out;
}

export interface FlushReport {
  sent: number;
  committed: number;
  duplicate: number;
  needs_review: number;
  rejected: number;
  /** Operations still waiting to reach the server after this flush */
  remaining: number;
  error: { kind: FlushErrorKind; message: string } | null;
  conflicts: ConflictInfo[];
  /** One-time visitor status credentials for confirmed captures (memory only) */
  handovers: StatusHandover[];
}

/**
 * Send everything this user has pending, in client_sequence order, in batches.
 *
 * Safety properties (all tested):
 *  - Only the owner's operations are sent; another user's queued actions are never re-attributed.
 *  - Before sending, operations become `pending_sync` and the attempt is persisted, so a
 *    crash mid-send leaves them pending (never lost, never "synced").
 *  - If the response is lost, operations stay `pending_sync` and are re-sent with the SAME
 *    operation ids; the server answers `duplicate` and state is unchanged.
 *  - Results are persisted per operation id before the next batch is sent.
 *  - A transport failure stops the flush; nothing is marked synced.
 */
export async function flushOutbox(ownerUserId: string, deps: FlushDeps): Promise<FlushReport> {
  const now = deps.nowMs ?? Date.now;
  const report: FlushReport = {
    sent: 0,
    committed: 0,
    duplicate: 0,
    needs_review: 0,
    rejected: 0,
    remaining: 0,
    error: null,
    conflicts: [],
    handovers: [],
  };

  let firstPass = true;
  for (;;) {
    const all = await deps.store.list({ owner_user_id: ownerUserId });
    const unsynced = orderForSubmission(all.filter(isUnsynced));
    // First pass also re-polls `needs_review` operations so a supervisor's resolution is learned
    const source = firstPass ? orderForSubmission(getPendingOperations(all)) : unsynced;
    firstPass = false;
    report.remaining = unsynced.length;
    const batch = source.slice(0, MAX_BATCH);
    if (batch.length === 0) return report;

    const attempting = batch.map((o) => ({
      ...o,
      status: isUnsynced(o) ? ('pending_sync' as const) : o.status,
      attempts: o.attempts + 1,
      last_attempt_at: new Date(now()).toISOString(),
    }));
    await deps.store.putMany(attempting);

    let response: SyncBatchResponse;
    try {
      response = await deps.send(
        { commands: batch.map(toEnvelope) },
        { pending_count: unsynced.length, authorities: deps.authorities?.() ?? [] },
      );
    } catch (e) {
      const err =
        e instanceof SyncTransportError ? e : new SyncTransportError('network', String(e));
      await deps.store.putMany(attempting.map((o) => ({ ...o, last_error: err.kind })));
      report.error = { kind: err.kind, message: err.message };
      return report;
    }

    const { updated, conflicts } = reconcileBatch(attempting, response.results);
    await deps.store.putMany(updated);
    report.conflicts.push(...conflicts);
    report.handovers.push(...extractHandovers(attempting, response.results));
    for (const r of response.results) {
      report.sent++;
      if (r.disposition === 'committed') report.committed++;
      else if (r.disposition === 'duplicate') report.duplicate++;
      else if (r.disposition === 'needs_review') report.needs_review++;
      else report.rejected++;
    }
    // Operations the server did not answer stay pending: report an error rather than loop forever
    const unanswered = updated.filter((o) => isUnsynced(o));
    if (unanswered.length > 0 && updated.length === unanswered.length) {
      report.remaining = unanswered.length;
      report.error = { kind: 'client', message: 'The server did not answer these actions.' };
      return report;
    }
  }
}
