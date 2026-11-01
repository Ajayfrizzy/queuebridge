import {
  CommandDisposition,
  type CommandEnvelope,
  type CommandResult,
  SyncStatus,
} from '@queuebridge/contracts';

export interface LocalOperation {
  operation_id: string;
  client_sequence: number;
  envelope: CommandEnvelope;
  local_status: SyncStatus;
  /** Set after server response */
  server_result?: CommandResult;
}

export interface ReconcileResult {
  updated: LocalOperation[];
  conflicts: ConflictInfo[];
  newRevision: number;
}

export interface ConflictInfo {
  operation_id: string;
  disposition: CommandDisposition;
  reason: string | undefined;
}

/**
 * Reconcile local operations against server batch dispositions.
 *
 * - Updates each local operation's status based on server result.
 * - Surfaces conflicts (needs_review, rejected) for supervisor attention.
 * - Returns the updated operations list and any conflicts.
 *
 * Pure function — no I/O.
 */
export function reconcileBatch(
  localOps: LocalOperation[],
  serverResults: CommandResult[],
  serverRevision: number,
): ReconcileResult {
  const resultsByOpId = new Map<string, CommandResult>(
    serverResults.map((r) => [r.operation_id, r]),
  );

  const conflicts: ConflictInfo[] = [];
  const updated: LocalOperation[] = localOps.map((op) => {
    const result = resultsByOpId.get(op.operation_id);
    if (!result) return op;

    let newStatus: SyncStatus;
    switch (result.disposition) {
      case CommandDisposition.COMMITTED:
        newStatus = SyncStatus.COMMITTED;
        break;
      case CommandDisposition.DUPLICATE:
        newStatus = SyncStatus.DUPLICATE;
        break;
      case CommandDisposition.NEEDS_REVIEW:
        newStatus = SyncStatus.NEEDS_REVIEW;
        conflicts.push({
          operation_id: op.operation_id,
          disposition: CommandDisposition.NEEDS_REVIEW,
          reason: result.rejection_reason,
        });
        break;
      case CommandDisposition.REJECTED:
        newStatus = SyncStatus.REJECTED;
        conflicts.push({
          operation_id: op.operation_id,
          disposition: CommandDisposition.REJECTED,
          reason: result.rejection_reason,
        });
        break;
      default:
        // Exhaustive check — all CommandDisposition values are handled above
        newStatus = SyncStatus.REJECTED;
        break;
    }

    return { ...op, local_status: newStatus, server_result: result };
  });

  return { updated, conflicts, newRevision: serverRevision };
}

/**
 * Filter local operations that still need to be synced.
 */
export function getPendingOperations(localOps: LocalOperation[]): LocalOperation[] {
  return localOps.filter(
    (op) =>
      op.local_status === SyncStatus.LOCAL_ONLY || op.local_status === SyncStatus.PENDING_SYNC,
  );
}

/**
 * Sort pending operations in client_sequence order for submission.
 */
export function orderForSubmission(ops: LocalOperation[]): LocalOperation[] {
  return [...ops].sort((a, b) => a.client_sequence - b.client_sequence);
}
