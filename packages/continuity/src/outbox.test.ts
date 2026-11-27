import { describe, expect, it } from 'vitest';
import { QueueAction, SyncStatus, temporaryRefFor, uuidv7 } from '@queuebridge/contracts';
import {
  MemoryOutboxStore,
  newCaptureInput,
  recordLocalOperation,
  StorageUnavailableError,
  summarizeOutbox,
  STATUS_LABEL,
  toEnvelope,
  toLocalResult,
  type RecordInput,
} from './outbox.js';

const base = {
  owner_user_id: '550e8400-e29b-41d4-a716-446655440010',
  organization_id: '550e8400-e29b-41d4-a716-446655440011',
  facility_id: '550e8400-e29b-41d4-a716-446655440012',
  queue_session_id: '550e8400-e29b-41d4-a716-446655440013',
  device_id: '550e8400-e29b-41d4-a716-446655440014',
  coordinator_epoch: 0,
  base_revision: 4,
};

describe('recordLocalOperation (REQ-F1.2: persisted before acknowledged)', () => {
  it('is durable by the time it resolves, starts as Local, and carries a UUID v7 id', async () => {
    const store = new MemoryOutboxStore();
    const op = await recordLocalOperation(store, newCaptureInput(base));
    const stored = await store.get(op.operation_id);
    expect(stored).toEqual(op);
    expect(op.status).toBe(SyncStatus.LOCAL_ONLY);
    expect(op.operation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(op.temporary_ref).toBe(temporaryRefFor(op.operation_id));
    expect(op.payload).toEqual({ temporary_ref: op.temporary_ref });
  });

  it('refuses to acknowledge when storage fails — raises instead of pretending', async () => {
    const store = new MemoryOutboxStore();
    store.failWrites = true;
    await expect(recordLocalOperation(store, newCaptureInput(base))).rejects.toBeInstanceOf(
      StorageUnavailableError,
    );
    store.failWrites = false;
    expect(await store.list()).toHaveLength(0);
  });

  it('allocates strictly increasing client sequences per device, independent of wall-clock time', async () => {
    const store = new MemoryOutboxStore();
    const clockGoingBackwards = [3_000_000, 2_000_000, 1_000_000];
    const ops = [];
    for (const nowMs of clockGoingBackwards) {
      ops.push(await recordLocalOperation(store, newCaptureInput({ ...base, nowMs })));
    }
    expect(ops.map((o) => o.client_sequence)).toEqual([1, 2, 3]);
    const other = await recordLocalOperation(
      store,
      newCaptureInput({ ...base, device_id: 'other-device' }),
    );
    expect(other.client_sequence).toBe(1);
  });

  it('builds a schema-valid wire envelope', async () => {
    const store = new MemoryOutboxStore();
    const op = await recordLocalOperation(store, {
      ...base,
      action: QueueAction.TICKET_CALL_NEXT,
      payload: { counter_id: '550e8400-e29b-41d4-a716-446655440020' },
    } as RecordInput);
    const env = toEnvelope(op);
    expect(env).toMatchObject({
      actor_id: base.owner_user_id,
      schema_version: 1,
      base_revision: 4,
    });
    const { CommandEnvelopeSchema } = await import('@queuebridge/contracts');
    expect(CommandEnvelopeSchema.safeParse(env).success).toBe(true);
  });
});

describe('summaries and labels', () => {
  it('counts every state and exposes the four required labels', async () => {
    const store = new MemoryOutboxStore();
    const statuses = [
      SyncStatus.LOCAL_ONLY,
      SyncStatus.PENDING_SYNC,
      SyncStatus.COMMITTED,
      SyncStatus.DUPLICATE,
      SyncStatus.NEEDS_REVIEW,
      SyncStatus.REJECTED,
    ];
    for (const status of statuses) {
      const op = await recordLocalOperation(store, newCaptureInput(base));
      await store.put({ ...op, status });
    }
    const s = summarizeOutbox(await store.list());
    expect(s).toMatchObject({
      total: 6,
      unsynced: 2,
      needs_review: 1,
      rejected: 1,
      committed: 1,
      duplicate: 1,
    });
    expect(STATUS_LABEL[SyncStatus.LOCAL_ONLY]).toBe('Local');
    expect(STATUS_LABEL[SyncStatus.PENDING_SYNC]).toBe('Pending sync');
    expect(STATUS_LABEL[SyncStatus.COMMITTED]).toBe('Synced');
    expect(STATUS_LABEL[SyncStatus.NEEDS_REVIEW]).toBe('Needs review');
  });

  it('never keeps a visitor status token from a server result', () => {
    const local = toLocalResult({
      operation_id: uuidv7(),
      client_sequence: 1,
      disposition: 'committed',
      public_code: 'G001',
      status_token: 'SECRET-TOKEN-VALUE',
    });
    expect(JSON.stringify(local)).not.toContain('SECRET');
    expect(local.public_code).toBe('G001');
  });
});
