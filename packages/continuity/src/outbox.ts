import {
  type CommandDisposition,
  QueueAction,
  SyncStatus,
  temporaryRefFor,
  uuidv7,
  type AuthorityTiming,
  type CommandEnvelope,
  type CommandResult,
  type OfflineAction,
} from '@queuebridge/contracts';

/**
 * The durable command outbox (REQ-F1.2).
 *
 * Every offline action is written to durable storage BEFORE it is acknowledged to the person
 * who performed it, and carries a stable operation id so that retrying after a lost response is
 * safe. This module is storage-agnostic and I/O-free: apps/web supplies an IndexedDB-backed
 * `OutboxStore`; tests use `MemoryOutboxStore`.
 */

/** Server outcome kept with the local operation (never contains secrets). */
export interface LocalResult {
  disposition: CommandDisposition;
  reason_code?: string;
  message?: string;
  public_code?: string;
  ticket_id?: string;
  server_revision?: number;
  server_sequence?: number;
  ticket_mapping?: { temporary_ref: string; public_code: string; ticket_id?: string | undefined };
}

export interface OutboxOperation {
  operation_id: string;
  /** The signed-in user who performed the action; only that user's session may sync it */
  owner_user_id: string;
  organization_id: string;
  facility_id: string;
  queue_session_id: string;
  device_id: string;
  coordinator_epoch: number;
  base_revision: number;
  /** Monotonic per device, persisted: the server's processing order for this device's actions */
  client_sequence: number;
  action: OfflineAction;
  payload: Record<string, unknown>;
  /** Device clock at recording. Diagnostic only — never used for ordering or authorization */
  created_at_client: string;
  /** Elapsed-time evidence for advancement (see AuthorityTimingSchema); null for capture */
  authority_timing: AuthorityTiming | null;
  status: SyncStatus;
  attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  result: LocalResult | null;
  /** For ticket.create: the temporary reference shown to staff until the server confirms a code */
  temporary_ref: string | null;
}

export interface OutboxFilter {
  owner_user_id?: string;
  queue_session_id?: string;
  statuses?: readonly SyncStatus[];
}

export interface OutboxStore {
  /** Durably write one operation. MUST reject (never silently succeed) if it cannot persist. */
  put(op: OutboxOperation): Promise<void>;
  putMany(ops: readonly OutboxOperation[]): Promise<void>;
  get(operationId: string): Promise<OutboxOperation | undefined>;
  list(filter?: OutboxFilter): Promise<OutboxOperation[]>;
  remove(operationId: string): Promise<void>;
  /** Atomically allocate the next client_sequence for a device (1, 2, 3, …), persisted. */
  nextClientSequence(deviceId: string): Promise<number>;
}

/** Raised when an operation could not be made durable: the action MUST NOT be acknowledged. */
export class StorageUnavailableError extends Error {
  public constructor(message = 'This browser could not save the action on this device.') {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

export interface RecordInput {
  owner_user_id: string;
  organization_id: string;
  facility_id: string;
  queue_session_id: string;
  device_id: string;
  coordinator_epoch: number;
  base_revision: number;
  action: OfflineAction;
  payload: Record<string, unknown>;
  authority_timing?: AuthorityTiming | null;
  /** Injected for tests; defaults to the current time */
  nowMs?: number;
  operation_id?: string;
}

/**
 * Create and durably persist an offline operation. Resolves only after the store has
 * accepted the write; any storage failure is raised as StorageUnavailableError so the caller
 * can say so instead of showing success.
 */
export async function recordLocalOperation(
  store: OutboxStore,
  input: RecordInput,
): Promise<OutboxOperation> {
  const nowMs = input.nowMs ?? Date.now();
  const operationId = input.operation_id ?? uuidv7(nowMs);
  let sequence: number;
  try {
    sequence = await store.nextClientSequence(input.device_id);
  } catch (e) {
    throw new StorageUnavailableError(e instanceof Error ? e.message : undefined);
  }
  const op: OutboxOperation = {
    operation_id: operationId,
    owner_user_id: input.owner_user_id,
    organization_id: input.organization_id,
    facility_id: input.facility_id,
    queue_session_id: input.queue_session_id,
    device_id: input.device_id,
    coordinator_epoch: input.coordinator_epoch,
    base_revision: input.base_revision,
    client_sequence: sequence,
    action: input.action,
    payload: input.payload,
    created_at_client: new Date(nowMs).toISOString(),
    authority_timing: input.authority_timing ?? null,
    status: SyncStatus.LOCAL_ONLY,
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
    result: null,
    temporary_ref:
      input.action === QueueAction.TICKET_CREATE
        ? String((input.payload as { temporary_ref?: unknown }).temporary_ref ?? '')
        : null,
  };
  try {
    await store.put(op);
  } catch (e) {
    throw new StorageUnavailableError(e instanceof Error ? e.message : undefined);
  }
  return op;
}

/** Payload for a capture, with a temporary reference derived from the (future) operation id. */
type CaptureBase = Omit<
  RecordInput,
  'action' | 'payload' | 'operation_id' | 'owner_user_id' | 'organization_id'
> &
  Partial<Pick<RecordInput, 'owner_user_id' | 'organization_id'>>;

export function newCaptureInput<T extends CaptureBase>(
  base: T,
): T & {
  nowMs: number;
  operation_id: string;
  action: OfflineAction;
  payload: Record<string, unknown>;
} {
  const nowMs = base.nowMs ?? Date.now();
  const operation_id = uuidv7(nowMs);
  return {
    ...base,
    nowMs,
    operation_id,
    action: QueueAction.TICKET_CREATE as OfflineAction,
    payload: { temporary_ref: temporaryRefFor(operation_id) },
  };
}

/** Build the wire envelope for an operation. Identity fields are advisory; the server re-derives. */
export function toEnvelope(op: OutboxOperation): CommandEnvelope {
  return {
    operation_id: op.operation_id,
    organization_id: op.organization_id,
    facility_id: op.facility_id,
    queue_session_id: op.queue_session_id,
    device_id: op.device_id,
    actor_id: op.owner_user_id,
    coordinator_epoch: op.coordinator_epoch,
    base_revision: op.base_revision,
    client_sequence: op.client_sequence,
    action: op.action,
    payload: op.payload,
    created_at_client: op.created_at_client,
    ...(op.authority_timing ? { authority_timing: op.authority_timing } : {}),
    schema_version: 1,
  };
}

// ---------------------------------------------------------------------------
// Status model
// ---------------------------------------------------------------------------

/** Operations that still need to reach the server. */
export const UNSYNCED_STATUSES: readonly SyncStatus[] = [
  SyncStatus.LOCAL_ONLY,
  SyncStatus.PENDING_SYNC,
];

export const isUnsynced = (op: Pick<OutboxOperation, 'status'>): boolean =>
  UNSYNCED_STATUSES.includes(op.status);

/** Labels shown to people for each state (REQ-F1.7): Local, Pending Sync, Synced, Needs Review. */
export const STATUS_LABEL: Record<SyncStatus, string> = {
  [SyncStatus.LOCAL_ONLY]: 'Local',
  [SyncStatus.PENDING_SYNC]: 'Pending sync',
  [SyncStatus.COMMITTED]: 'Synced',
  [SyncStatus.DUPLICATE]: 'Synced',
  [SyncStatus.NEEDS_REVIEW]: 'Needs review',
  [SyncStatus.REJECTED]: 'Rejected',
};

export interface OutboxSummary {
  total: number;
  local_only: number;
  pending_sync: number;
  /** local_only + pending_sync: what the device still has to send */
  unsynced: number;
  committed: number;
  duplicate: number;
  needs_review: number;
  rejected: number;
}

export function summarizeOutbox(ops: readonly OutboxOperation[]): OutboxSummary {
  const s: OutboxSummary = {
    total: ops.length,
    local_only: 0,
    pending_sync: 0,
    unsynced: 0,
    committed: 0,
    duplicate: 0,
    needs_review: 0,
    rejected: 0,
  };
  for (const op of ops) {
    switch (op.status) {
      case SyncStatus.LOCAL_ONLY:
        s.local_only++;
        break;
      case SyncStatus.PENDING_SYNC:
        s.pending_sync++;
        break;
      case SyncStatus.COMMITTED:
        s.committed++;
        break;
      case SyncStatus.DUPLICATE:
        s.duplicate++;
        break;
      case SyncStatus.NEEDS_REVIEW:
        s.needs_review++;
        break;
      case SyncStatus.REJECTED:
        s.rejected++;
        break;
    }
  }
  s.unsynced = s.local_only + s.pending_sync;
  return s;
}

export function toLocalResult(r: CommandResult): LocalResult {
  return {
    disposition: r.disposition,
    ...(r.reason_code ? { reason_code: r.reason_code } : {}),
    ...(r.rejection_reason ? { message: r.rejection_reason } : {}),
    ...(r.public_code ? { public_code: r.public_code } : {}),
    ...(r.ticket_id ? { ticket_id: r.ticket_id } : {}),
    ...(r.server_revision !== undefined ? { server_revision: r.server_revision } : {}),
    ...(r.server_sequence !== undefined ? { server_sequence: r.server_sequence } : {}),
    ...(r.ticket_mapping ? { ticket_mapping: r.ticket_mapping } : {}),
    // NOTE: `status_token` (a visitor secret) is deliberately NOT copied
  };
}

// ---------------------------------------------------------------------------
// In-memory store (tests and non-browser use)
// ---------------------------------------------------------------------------

/** Operations are plain JSON, so a JSON round-trip is a faithful deep copy. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class MemoryOutboxStore implements OutboxStore {
  private readonly ops = new Map<string, OutboxOperation>();
  private readonly sequences = new Map<string, number>();
  /** Test hook: make every write fail, as a full or blocked browser store would */
  public failWrites = false;

  public put(op: OutboxOperation): Promise<void> {
    if (this.failWrites) return Promise.reject(new Error('QuotaExceededError'));
    this.ops.set(op.operation_id, clone(op));
    return Promise.resolve();
  }
  public async putMany(ops: readonly OutboxOperation[]): Promise<void> {
    if (this.failWrites) throw new Error('QuotaExceededError');
    for (const op of ops) await this.put(op);
  }
  public get(id: string): Promise<OutboxOperation | undefined> {
    const op = this.ops.get(id);
    return Promise.resolve(op ? clone(op) : undefined);
  }
  public list(filter: OutboxFilter = {}): Promise<OutboxOperation[]> {
    const out = [...this.ops.values()]
      .filter(
        (o) =>
          (filter.owner_user_id === undefined || o.owner_user_id === filter.owner_user_id) &&
          (filter.queue_session_id === undefined ||
            o.queue_session_id === filter.queue_session_id) &&
          (filter.statuses === undefined || filter.statuses.includes(o.status)),
      )
      .sort((a, b) => a.client_sequence - b.client_sequence);
    return Promise.resolve(clone(out));
  }
  public remove(id: string): Promise<void> {
    this.ops.delete(id);
    return Promise.resolve();
  }
  public nextClientSequence(deviceId: string): Promise<number> {
    if (this.failWrites) return Promise.reject(new Error('QuotaExceededError'));
    const n = (this.sequences.get(deviceId) ?? 0) + 1;
    this.sequences.set(deviceId, n);
    return Promise.resolve(n);
  }
}
