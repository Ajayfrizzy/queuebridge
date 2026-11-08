import { describe, expect, it } from 'vitest';
import {
  QueueAction,
  SyncStatus,
  type CommandEnvelope,
  type CommandResult,
  type SyncBatchRequest,
  type SyncBatchResponse,
} from '@queuebridge/contracts';
import {
  flushOutbox,
  MemoryOutboxStore,
  newCaptureInput,
  recordLocalOperation,
  extractHandovers,
  reconcileBatch,
  SyncTransportError,
  type FlushDeps,
  type OutboxOperation,
} from './index.js';

const base = {
  owner_user_id: 'user-a',
  organization_id: '550e8400-e29b-41d4-a716-446655440011',
  facility_id: '550e8400-e29b-41d4-a716-446655440012',
  queue_session_id: '550e8400-e29b-41d4-a716-446655440013',
  device_id: '550e8400-e29b-41d4-a716-446655440014',
  coordinator_epoch: 0,
  base_revision: 0,
};

/** A tiny server stand-in with the real contract: dedupe by operation id, stable dispositions. */
class FakeServer {
  public readonly committed = new Map<string, CommandResult>();
  public readonly received: string[] = [];
  public dropNextResponses = 0;
  public rejectIds = new Set<string>();
  public reviewIds = new Set<string>();
  private seq = 0;

  public handle = (batch: SyncBatchRequest): Promise<SyncBatchResponse> => {
    const results = batch.commands.map((c: CommandEnvelope, index) => {
      this.received.push(c.operation_id);
      const prior = this.committed.get(c.operation_id);
      if (prior)
        return {
          ...prior,
          index,
          disposition:
            prior.disposition === 'committed' ? ('duplicate' as const) : prior.disposition,
        };
      const r: CommandResult = this.rejectIds.has(c.operation_id)
        ? {
            index,
            operation_id: c.operation_id,
            client_sequence: c.client_sequence,
            disposition: 'rejected',
            reason_code: 'forbidden',
            rejection_reason: 'no',
          }
        : this.reviewIds.has(c.operation_id)
          ? {
              index,
              operation_id: c.operation_id,
              client_sequence: c.client_sequence,
              disposition: 'needs_review',
              reason_code: 'stale_epoch',
              rejection_reason: 'held',
            }
          : {
              index,
              operation_id: c.operation_id,
              client_sequence: c.client_sequence,
              disposition: 'committed',
              server_sequence: ++this.seq,
              public_code: `G${String(this.seq).padStart(3, '0')}`,
            };
      this.committed.set(c.operation_id, r);
      return r;
    });
    if (this.dropNextResponses > 0) {
      this.dropNextResponses--;
      return Promise.reject(new SyncTransportError('network', 'response lost'));
    }
    return Promise.resolve({
      results,
      queue_revisions: {},
      processed_at: new Date().toISOString(),
    });
  };
}

async function setup(n: number): Promise<{
  store: MemoryOutboxStore;
  server: FakeServer;
  deps: FlushDeps;
  ops: OutboxOperation[];
}> {
  const store = new MemoryOutboxStore();
  const server = new FakeServer();
  const ops: OutboxOperation[] = [];
  for (let i = 0; i < n; i++) ops.push(await recordLocalOperation(store, newCaptureInput(base)));
  return { store, server, ops, deps: { store, send: server.handle } };
}

describe('flushOutbox', () => {
  it('sends in client_sequence order and marks results from the server only', async () => {
    const { store, server, deps, ops } = await setup(5);
    const report = await flushOutbox('user-a', deps);
    expect(server.received).toEqual(ops.map((o) => o.operation_id));
    expect(report).toMatchObject({ committed: 5, remaining: 0, error: null });
    const after = await store.list();
    expect(after.every((o) => o.status === SyncStatus.COMMITTED)).toBe(true);
    expect(after[0]?.result?.public_code).toBe('G001');
  });

  it('a network failure keeps everything pending — nothing is marked synced', async () => {
    const { store, deps } = await setup(3);
    const failing: FlushDeps = {
      ...deps,
      send: () => Promise.reject(new SyncTransportError('network', 'offline')),
    };
    const report = await flushOutbox('user-a', failing);
    expect(report.error?.kind).toBe('network');
    expect(report.remaining).toBe(3);
    const after = await store.list();
    expect(after.map((o) => o.status)).toEqual(Array(3).fill(SyncStatus.PENDING_SYNC));
    expect(after.every((o) => o.attempts === 1)).toBe(true);
  });

  it('LOST ACK: the server committed but the response never arrived — retry gets duplicate, state unchanged', async () => {
    const { store, server, deps } = await setup(4);
    server.dropNextResponses = 1;
    const first = await flushOutbox('user-a', deps);
    expect(first.error?.kind).toBe('network');
    expect(server.committed.size).toBe(4); // the server DID commit
    expect((await store.list()).every((o) => o.status === SyncStatus.PENDING_SYNC)).toBe(true);

    const second = await flushOutbox('user-a', deps);
    expect(second).toMatchObject({ duplicate: 4, committed: 0, remaining: 0, error: null });
    expect(server.committed.size).toBe(4); // no second commit
    const after = await store.list();
    expect(after.every((o) => o.status === SyncStatus.DUPLICATE)).toBe(true);
    expect(after.every((o) => o.attempts === 2)).toBe(true);
  });

  it('surfaces needs_review and rejected without marking them synced', async () => {
    const { store, server, deps, ops } = await setup(3);
    server.reviewIds.add(ops[1]?.operation_id ?? '');
    server.rejectIds.add(ops[2]?.operation_id ?? '');
    const report = await flushOutbox('user-a', deps);
    expect(report).toMatchObject({ committed: 1, needs_review: 1, rejected: 1 });
    expect(report.conflicts.map((c) => c.disposition).sort()).toEqual(['needs_review', 'rejected']);
    const byId = Object.fromEntries((await store.list()).map((o) => [o.operation_id, o.status]));
    expect(byId[ops[0]?.operation_id ?? '']).toBe(SyncStatus.COMMITTED);
    expect(byId[ops[1]?.operation_id ?? '']).toBe(SyncStatus.NEEDS_REVIEW);
    expect(byId[ops[2]?.operation_id ?? '']).toBe(SyncStatus.REJECTED);
  });

  it('re-polls needs_review operations so a supervisor resolution is learned', async () => {
    const { store, server, deps, ops } = await setup(1);
    const id = ops[0]?.operation_id ?? '';
    server.reviewIds.add(id);
    await flushOutbox('user-a', deps);
    expect((await store.get(id))?.status).toBe(SyncStatus.NEEDS_REVIEW);
    // supervisor applied it server-side
    server.committed.set(id, {
      index: 0,
      operation_id: id,
      client_sequence: 1,
      disposition: 'committed',
      public_code: 'G077',
    });
    await flushOutbox('user-a', deps);
    const op = await store.get(id);
    expect(op?.status).toBe(SyncStatus.DUPLICATE);
    expect(op?.result?.public_code).toBe('G077');
  });

  it('never sends another user’s queued actions under this user’s session', async () => {
    const { store, server, deps } = await setup(2);
    await recordLocalOperation(store, newCaptureInput({ ...base, owner_user_id: 'user-b' }));
    await flushOutbox('user-a', deps);
    expect(server.received).toHaveLength(2);
    const foreign = (await store.list({ owner_user_id: 'user-b' }))[0];
    expect(foreign?.status).toBe(SyncStatus.LOCAL_ONLY);
    expect(foreign?.attempts).toBe(0);
  });

  it('batches of at most 100, preserving order across batches', async () => {
    const { server, deps, ops } = await setup(230);
    const sizes: number[] = [];
    const spy: FlushDeps = {
      ...deps,
      send: (b) => {
        sizes.push(b.commands.length);
        return server.handle(b);
      },
    };
    await flushOutbox('user-a', spy);
    expect(sizes).toEqual([100, 100, 30]);
    expect(server.received).toEqual(ops.map((o) => o.operation_id));
  });

  it('classifies auth and revoked-device failures and stops', async () => {
    for (const kind of ['auth', 'device_revoked', 'server'] as const) {
      const { deps, store } = await setup(2);
      const report = await flushOutbox('user-a', {
        ...deps,
        send: () => Promise.reject(new SyncTransportError(kind, kind)),
      });
      expect(report.error?.kind).toBe(kind);
      expect(
        (await store.list()).every(
          (o) => o.status === SyncStatus.PENDING_SYNC && o.last_error === kind,
        ),
      ).toBe(true);
    }
  });

  it('an unanswered operation is not assumed synced and does not loop forever', async () => {
    const { deps, store } = await setup(2);
    const silent: FlushDeps = {
      ...deps,
      send: () =>
        Promise.resolve({
          results: [],
          queue_revisions: {},
          processed_at: new Date().toISOString(),
        }),
    };
    const report = await flushOutbox('user-a', silent);
    expect(report.error?.kind).toBe('client');
    expect((await store.list()).every((o) => o.status === SyncStatus.PENDING_SYNC)).toBe(true);
  });

  it('presents authority tokens and a pending count with each batch', async () => {
    const { deps, server } = await setup(3);
    const seen: { pending: number; auth: string[] }[] = [];
    await flushOutbox('user-a', {
      ...deps,
      authorities: () => ['v1.tok.sig'],
      send: (b, m) => {
        seen.push({ pending: m.pending_count, auth: m.authorities });
        return server.handle(b);
      },
    });
    expect(seen).toEqual([{ pending: 3, auth: ['v1.tok.sig'] }]);
  });
});

describe('reconcileBatch', () => {
  it('matches by operation id, not response order, and leaves unanswered operations untouched', async () => {
    const store = new MemoryOutboxStore();
    const a = await recordLocalOperation(store, newCaptureInput(base));
    const b = await recordLocalOperation(store, newCaptureInput(base));
    const c = await recordLocalOperation(store, newCaptureInput(base));
    const { updated } = reconcileBatch(
      [a, b, c],
      [
        { operation_id: b.operation_id, client_sequence: 2, disposition: 'committed' },
        {
          operation_id: null,
          client_sequence: 0,
          disposition: 'rejected',
          reason_code: 'invalid_command',
        },
        {
          operation_id: a.operation_id,
          client_sequence: 1,
          disposition: 'rejected',
          reason_code: 'forbidden',
        },
      ],
    );
    expect(updated.map((o) => o.status)).toEqual([
      SyncStatus.REJECTED,
      SyncStatus.COMMITTED,
      SyncStatus.LOCAL_ONLY,
    ]);
  });

  it('a randomized replay (lost responses, reorders, duplicates) always converges to one commit per operation', async () => {
    // Deterministic pseudo-random so a failure is reproducible
    let seed = 42;
    const rnd = (): number => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let round = 0; round < 25; round++) {
      const { store, server, ops } = await setup(1 + Math.floor(rnd() * 40));
      const deps: FlushDeps = {
        store,
        send: (b) => {
          if (rnd() < 0.4) server.dropNextResponses = 1;
          return server.handle(b);
        },
      };
      for (let i = 0; i < 12; i++) await flushOutbox('user-a', deps);
      server.dropNextResponses = 0;
      await flushOutbox('user-a', deps);
      expect(server.committed.size).toBe(ops.length);
      const final = await store.list();
      expect(
        final.every((o) => o.status === SyncStatus.COMMITTED || o.status === SyncStatus.DUPLICATE),
      ).toBe(true);
      expect(new Set(final.map((o) => o.result?.public_code)).size).toBe(ops.length);
    }
    void QueueAction;
  });
});

describe('status hand-over credentials', () => {
  it('surface the server’s one-time token for confirmed captures, in memory only — never in the store', async () => {
    const store = new MemoryOutboxStore();
    const op = await recordLocalOperation(store, newCaptureInput(base));
    const report = await flushOutbox('user-a', {
      store,
      send: (b) =>
        Promise.resolve({
          results: b.commands.map((c, index) => ({
            index,
            operation_id: c.operation_id,
            client_sequence: c.client_sequence,
            disposition: 'committed' as const,
            public_code: 'G007',
            status_token: 'S'.repeat(43),
          })),
          queue_revisions: {},
          processed_at: new Date().toISOString(),
        }),
    });
    expect(report.handovers).toEqual([
      {
        operation_id: op.operation_id,
        queue_session_id: base.queue_session_id,
        public_code: 'G007',
        status_token: 'S'.repeat(43),
      },
    ]);
    expect(JSON.stringify(await store.list())).not.toContain('SSSS');
  });

  it('never for rejected / needs_review results, non-capture actions, or a missing public code', () => {
    const mk = (action: string, id: string): OutboxOperation =>
      ({ operation_id: id, action, queue_session_id: 'q' }) as unknown as OutboxOperation;
    const ops = [
      mk('ticket.create', 'a'),
      mk('ticket.call_next', 'b'),
      mk('ticket.create', 'c'),
      mk('ticket.create', 'd'),
    ];
    const out = extractHandovers(ops, [
      {
        operation_id: 'a',
        client_sequence: 1,
        disposition: 'needs_review',
        status_token: 'x',
        public_code: 'G1',
      },
      {
        operation_id: 'b',
        client_sequence: 2,
        disposition: 'committed',
        status_token: 'x',
        public_code: 'G1',
      },
      { operation_id: 'c', client_sequence: 3, disposition: 'committed', status_token: 'x' },
      {
        operation_id: 'd',
        client_sequence: 4,
        disposition: 'duplicate',
        status_token: 'y',
        public_code: 'G2',
      },
    ]);
    expect(out.map((h) => h.operation_id)).toEqual(['d']);
  });
});
