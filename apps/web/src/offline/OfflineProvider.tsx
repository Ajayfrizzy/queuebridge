import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { StaffQueue, SyncSnapshot } from '@queuebridge/contracts';
import {
  advanceFloor,
  flushOutbox,
  receiveAuthority,
  shouldReplaceAuthority,
  recordLocalOperation,
  StorageUnavailableError,
  summarizeOutbox,
  SyncTransportError,
  toEnvelope,
  type StatusHandover,
  type FlushReport,
  type LocalAuthority,
  type OutboxOperation,
  type OutboxSummary,
  type RecordInput,
} from '@queuebridge/continuity';
import { useAuth } from '../auth.js';
import { api, ApiRequestError, setNetworkObserver } from '../lib/api.js';
import { readClock } from './clock.js';
import { offlineDb, storageAvailable } from './idb.js';

/** Re-probe the server this often while it is unreachable. */
export const PROBE_INTERVAL_MS = 3000;
/** Re-send unsent actions this often while online (covers missed events). */
export const FLUSH_INTERVAL_MS = 15000;
const HEARTBEAT_INTERVAL_MS = 30000;
/** Persist the elapsed-time floor of held authorities this often (bounded loss on a crash). */
export const FLOOR_PERSIST_MS = 5000;

const authKey = (a: LocalAuthority): string =>
  `auth:${a.auth.queue_session_id}:${a.auth.epoch}:${a.auth.delivered_at ?? ''}`;

export interface CachedQueue {
  queue: StaffQueue;
  revision: number;
  coordinator: SyncSnapshot['coordinator'];
  server_time: string;
  stored_at: number;
}

export type BlockingProblem = 'device_revoked' | 'session_ended' | null;

export interface OfflineApi {
  /** Can this browser persist offline data? When false nothing is recorded locally. */
  storage: 'checking' | 'ok' | 'unavailable';
  /** The server (not just the network adapter) answered recently */
  reachable: boolean;
  summary: OutboxSummary;
  ops: OutboxOperation[];
  /** Unsent actions that belong to a DIFFERENT signed-in user of this device */
  foreignPending: number;
  flushing: boolean;
  lastFlush: FlushReport | null;
  problem: BlockingProblem;
  /** Stable device id for this user at the facility, registering it when online */
  ensureDevice: (facilityId: string) => Promise<string | null>;
  /** Fetch + cache the authorized snapshot; stores coordinator authority if this device holds it */
  refreshSnapshot: (queueId: string, deviceId: string | null) => Promise<SyncSnapshot | null>;
  loadCached: (queueId: string) => Promise<CachedQueue | null>;
  /** Authority currently held for the queue, and the highest epoch the server reported */
  authorityFor: (
    queueId: string,
  ) => Promise<{ authority: LocalAuthority | null; knownEpoch: number }>;
  /** Persist an action locally BEFORE acknowledging it; rejects if storage failed */
  record: (
    input: Omit<RecordInput, 'owner_user_id' | 'organization_id'>,
  ) => Promise<OutboxOperation>;
  flush: () => Promise<FlushReport | null>;
  reload: () => Promise<void>;
  /** Erase all offline data on this device including unsent actions (explicit, confirmed) */
  wipeLocalData: () => Promise<void>;
  /**
   * Visitor status links for tickets captured offline and now CONFIRMED by the server. Memory
   * only: never persisted; lost on reload or sign-out (re-issue with `requestHandover`).
   */
  handovers: StatusHandover[];
  dismissHandover: (operationId: string) => void;
  /**
   * Ask the server for a fresh status link for a confirmed capture by replaying its original
   * operation (the server re-issues only to the same signed-in user and device, and the new
   * link replaces any earlier one).
   */
  requestHandover: (operationId: string) => Promise<boolean>;
}

const Ctx = createContext<OfflineApi | null>(null);

const EMPTY: OutboxSummary = {
  total: 0,
  local_only: 0,
  pending_sync: 0,
  unsynced: 0,
  committed: 0,
  duplicate: 0,
  needs_review: 0,
  rejected: 0,
};

function classify(e: unknown): SyncTransportError {
  if (e instanceof SyncTransportError) return e;
  if (e instanceof ApiRequestError) {
    if (e.status === 0) return new SyncTransportError('network', e.message);
    if (e.status === 401) return new SyncTransportError('auth', e.message);
    if (e.status === 403 && /device-revoked/.test(e.problem?.type ?? '')) {
      return new SyncTransportError('device_revoked', e.message);
    }
    if (e.status >= 500 || e.status === 429) return new SyncTransportError('server', e.message);
    return new SyncTransportError('client', e.message);
  }
  return new SyncTransportError('network', 'Unexpected error');
}

/**
 * Delete stored authority tokens that nothing still needs: not the current authority of a queue
 * and not referenced by any of this user's unsent operations. (Replays of already-decided
 * operations are answered from the server's stored disposition and need no token.)
 */
async function pruneAuthorities(userId: string): Promise<void> {
  try {
    const [held, current, ops] = await Promise.all([
      offlineDb.kvList<LocalAuthority>('auth:', userId),
      offlineDb.kvList<LocalAuthority>('auth-current:', userId),
      offlineDb.list({ owner_user_id: userId }),
    ]);
    const keep = new Set<string>(current.map((c) => authKey(c.value)));
    for (const o of ops) {
      if ((o.status === 'local_only' || o.status === 'pending_sync') && o.authority_timing) {
        keep.add(
          `auth:${o.queue_session_id}:${o.coordinator_epoch}:${o.authority_timing.delivered_at}`,
        );
      }
    }
    for (const h of held) if (!keep.has(h.key)) await offlineDb.kvDelete(h.key);
  } catch {
    /* pruning is housekeeping; never block a flush on it */
  }
}

export function OfflineProvider({ children }: { children: ReactNode }): ReactElement {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const orgId = user?.organization.id ?? null;
  const [storage, setStorage] = useState<OfflineApi['storage']>('checking');
  const [reachable, setReachable] = useState<boolean>(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [ops, setOps] = useState<OutboxOperation[]>([]);
  const [foreignPending, setForeignPending] = useState(0);
  const [flushing, setFlushing] = useState(false);
  const [lastFlush, setLastFlush] = useState<FlushReport | null>(null);
  const [problem, setProblem] = useState<BlockingProblem>(null);
  const [handovers, setHandovers] = useState<StatusHandover[]>([]);
  const addHandovers = useCallback((list: StatusHandover[]): void => {
    if (list.length === 0) return;
    setHandovers((cur) => [
      ...cur.filter((h) => !list.some((n) => n.operation_id === h.operation_id)),
      ...list,
    ]);
  }, []);
  // A different (or re-established) identity starts clean: hand-over credentials belong to the
  // person who captured the ticket, a block such as "sign-in ended" belonged to the old session,
  // and in-flight device lookups belonged to the old user. Unsent actions are NOT touched — they
  // stay owned by whoever recorded them.
  useEffect(() => {
    setHandovers([]);
    deviceLookups.current.clear();
    // Clear a session block only when a session is ESTABLISHED (not when the old one ends,
    // which would race with the flush that is reporting "sign-in ended")
    if (userId) setProblem(null);
  }, [userId]);
  const flushLock = useRef(false);
  /** Device ids per `${userId}:${facilityId}` — a device belongs to ONE staff user */
  const deviceIds = useRef(new Map<string, string>());
  /** In-flight registrations, so concurrent callers share one request (never two devices) */
  const deviceLookups = useRef(new Map<string, Promise<string | null>>());

  useEffect(() => {
    let alive = true;
    void storageAvailable().then((ok) => alive && setStorage(ok ? 'ok' : 'unavailable'));
    return (): void => {
      alive = false;
    };
  }, []);

  // ---- Reachability: navigator.onLine is only a hint; the API's answer is the truth ----------
  useEffect(() => {
    setNetworkObserver(setReachable);
    const down = (): void => setReachable(false);
    const up = (): void => void api.ping();
    window.addEventListener('offline', down);
    window.addEventListener('online', up);
    return (): void => {
      setNetworkObserver(null);
      window.removeEventListener('offline', down);
      window.removeEventListener('online', up);
    };
  }, []);
  useEffect(() => {
    if (reachable) return undefined;
    const timer = setInterval(() => void api.ping(), PROBE_INTERVAL_MS);
    return (): void => clearInterval(timer);
  }, [reachable]);

  // ---- Outbox view ---------------------------------------------------------------------------
  const reload = useCallback(async (): Promise<void> => {
    if (storage !== 'ok' || !userId) {
      setOps([]);
      setForeignPending(0);
      return;
    }
    try {
      const all = await offlineDb.list();
      setOps(all.filter((o) => o.owner_user_id === userId));
      setForeignPending(
        all.filter(
          (o) =>
            o.owner_user_id !== userId &&
            (o.status === 'local_only' || o.status === 'pending_sync'),
        ).length,
      );
    } catch {
      setStorage('unavailable');
    }
  }, [storage, userId]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const summary = useMemo(() => (ops.length ? summarizeOutbox(ops) : EMPTY), [ops]);

  // ---- Authority + snapshot cache -------------------------------------------------------------
  /**
   * The held authority for a queue with its elapsed-time floor advanced to now (and persisted),
   * so restarts and clock changes are measured against the latest provable lower bound.
   */
  const authorityFor = useCallback<OfflineApi['authorityFor']>(
    async (queueId) => {
      if (storage !== 'ok' || !userId) return { authority: null, knownEpoch: 0 };
      try {
        const cur = await offlineDb.kvGet<LocalAuthority>(`auth-current:${queueId}`, userId);
        const epoch = await offlineDb.kvGet<number>(`epoch:${queueId}`, userId);
        let authority = cur?.value ?? null;
        if (authority) {
          authority = advanceFloor(authority, readClock());
          await offlineDb.kvPut(`auth-current:${queueId}`, authority, userId);
          await offlineDb.kvPut(authKey(authority), authority, userId);
        }
        return { authority, knownEpoch: epoch?.value ?? 0 };
      } catch {
        return { authority: null, knownEpoch: 0 };
      }
    },
    [storage, userId],
  );

  // Keep every held authority's floor fresh while the app is open (offline included)
  useEffect(() => {
    if (storage !== 'ok' || !userId) return undefined;
    const tick = async (): Promise<void> => {
      try {
        const rows = await offlineDb.kvList<LocalAuthority>('auth-current:', userId);
        for (const r of rows) {
          const next = advanceFloor(r.value, readClock());
          await offlineDb.kvPut(r.key, next, userId);
          await offlineDb.kvPut(authKey(next), next, userId);
        }
      } catch {
        /* storage trouble is surfaced elsewhere */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), FLOOR_PERSIST_MS);
    return (): void => clearInterval(t);
  }, [storage, userId]);

  const refreshSnapshot = useCallback<OfflineApi['refreshSnapshot']>(
    async (queueId, deviceId) => {
      let snap: SyncSnapshot;
      try {
        snap = (await api.syncSnapshot(queueId, deviceId)).snapshot;
      } catch (e) {
        if (
          e instanceof ApiRequestError &&
          e.status === 403 &&
          /device-revoked/.test(e.problem?.type ?? '')
        ) {
          setProblem('device_revoked');
        }
        return null;
      }
      if (storage === 'ok' && userId) {
        try {
          const cached: CachedQueue = {
            queue: snap.queue,
            revision: snap.revision,
            coordinator: snap.coordinator,
            server_time: snap.server_time,
            stored_at: Date.now(),
          };
          await offlineDb.kvPut(`snap:${queueId}`, cached, userId);
          await offlineDb.kvPut(`epoch:${queueId}`, snap.coordinator.epoch, userId);
          if (snap.authority && snap.coordinator.is_this_device) {
            const fresh = receiveAuthority(snap.authority, readClock());
            const cur = await offlineDb.kvGet<LocalAuthority>(`auth-current:${queueId}`, userId);
            if (fresh && shouldReplaceAuthority(cur?.value, fresh)) {
              // Keep every token that unsent actions were timed against: the server needs the
              // exact signed delivery time to place them on its timeline (and to fence them).
              await offlineDb.kvPut(authKey(fresh), fresh, userId);
              await offlineDb.kvPut(`auth-current:${queueId}`, fresh, userId);
            }
          } else {
            // Not (or no longer) the coordinator: stop offering offline advancement
            await offlineDb.kvDelete(`auth-current:${queueId}`);
          }
        } catch {
          setStorage('unavailable');
        }
      }
      return snap;
    },
    [storage, userId],
  );

  const loadCached = useCallback<OfflineApi['loadCached']>(
    async (queueId) => {
      if (storage !== 'ok' || !userId) return null;
      try {
        return (await offlineDb.kvGet<CachedQueue>(`snap:${queueId}`, userId))?.value ?? null;
      } catch {
        return null;
      }
    },
    [storage, userId],
  );

  // ---- Devices ----------------------------------------------------------------------------------
  const ensureDevice = useCallback<OfflineApi['ensureDevice']>(
    (facilityId) => {
      if (!userId || storage !== 'ok') return Promise.resolve(null);
      const memoKey = `${userId}:${facilityId}`;
      const memo = deviceIds.current.get(memoKey);
      if (memo) return Promise.resolve(memo);
      const inflight = deviceLookups.current.get(memoKey);
      if (inflight) return inflight;
      const key = `device:${userId}:${facilityId}`;
      const lookup = (async (): Promise<string | null> => {
        try {
          const stored = await offlineDb.kvGet<string>(key, userId);
          if (stored) {
            deviceIds.current.set(memoKey, stored.value);
            return stored.value;
          }
        } catch {
          return null;
        }
        if (!reachable) return null; // registering needs the server; do it before the outage
        try {
          const label = `${navigator.platform || 'Browser'} · ${new Date().toISOString().slice(0, 10)}`;
          const { device } = await api.registerDevice(facilityId, label);
          await offlineDb.kvPut(key, device.id, userId);
          deviceIds.current.set(memoKey, device.id);
          return device.id;
        } catch {
          return null;
        }
      })().finally(() => deviceLookups.current.delete(memoKey));
      deviceLookups.current.set(memoKey, lookup);
      return lookup;
    },
    [reachable, storage, userId],
  );

  // ---- Recording and flushing ----------------------------------------------------------------
  const record = useCallback<OfflineApi['record']>(
    async (input) => {
      if (storage !== 'ok' || !userId || !orgId) throw new StorageUnavailableError();
      const op = await recordLocalOperation(offlineDb, {
        ...input,
        owner_user_id: userId,
        organization_id: orgId,
      });
      await reload();
      return op;
    },
    [orgId, reload, storage, userId],
  );

  const flush = useCallback(async (): Promise<FlushReport | null> => {
    if (!userId || storage !== 'ok' || flushLock.current || problem) return null;
    flushLock.current = true;
    setFlushing(true);
    try {
      const report = await flushOutbox(userId, {
        store: offlineDb,
        // Exactly the tokens this batch's operations were timed against, read at send time
        authorities: async (batch) => {
          const refs = [
            ...new Set(
              batch.flatMap((o) =>
                o.authority_timing
                  ? [
                      `auth:${o.queue_session_id}:${o.coordinator_epoch}:${o.authority_timing.delivered_at}`,
                    ]
                  : [],
              ),
            ),
          ];
          const found = await Promise.all(
            refs.map((k) => offlineDb.kvGet<LocalAuthority>(k, userId).catch(() => undefined)),
          );
          return found.flatMap((f) => (f ? [f.value.token] : []));
        },
        send: async (batch, meta) => {
          try {
            return await api.syncBatch({
              commands: batch.commands,
              ...(meta.authorities.length ? { authorities: meta.authorities } : {}),
              device_report: { pending_count: meta.pending_count },
            });
          } catch (e) {
            throw classify(e);
          }
        },
      });
      setLastFlush(report);
      addHandovers(report.handovers);
      if (report.error?.kind === 'device_revoked') setProblem('device_revoked');
      if (report.error?.kind === 'auth') setProblem('session_ended');
      await pruneAuthorities(userId);
      await reload();
      return report;
    } finally {
      flushLock.current = false;
      setFlushing(false);
    }
  }, [addHandovers, problem, reload, storage, userId]);

  // Flush when the server becomes reachable, when new unsent work appears, and periodically
  useEffect(() => {
    if (reachable && summary.unsynced > 0) void flush();
  }, [reachable, summary.unsynced, flush]);
  useEffect(() => {
    if (!reachable) return undefined;
    const t = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
    return (): void => clearInterval(t);
  }, [reachable, flush]);

  // Report device health (display only) so supervisors can see pending work and storage trouble
  useEffect(() => {
    if (!reachable || !userId) return undefined;
    const send = (): void => {
      const mine = [...deviceIds.current.entries()]
        .filter(([k]) => k.startsWith(`${userId}:`))
        .map(([, id]) => id);
      for (const id of mine) {
        void api
          .heartbeat(id, {
            pending_count: summary.unsynced,
            failure_code: storage === 'unavailable' ? 'storage_unavailable' : null,
          })
          .catch(() => undefined);
      }
    };
    send();
    const t = setInterval(send, HEARTBEAT_INTERVAL_MS);
    return (): void => clearInterval(t);
  }, [reachable, summary.unsynced, storage, userId]);

  const dismissHandover = useCallback((operationId: string): void => {
    setHandovers((cur) => cur.filter((h) => h.operation_id !== operationId));
  }, []);

  const requestHandover = useCallback(
    async (operationId: string): Promise<boolean> => {
      if (!userId || storage !== 'ok') return false;
      const op = await offlineDb.get(operationId).catch(() => undefined);
      if (!op || op.owner_user_id !== userId || op.action !== 'ticket.create') return false;
      if (op.status !== 'committed' && op.status !== 'duplicate') return false;
      try {
        const res = await api.syncBatch({ commands: [toEnvelope(op)] });
        const r = res.results[0];
        if (
          !r?.status_token ||
          !r.public_code ||
          (r.disposition !== 'duplicate' && r.disposition !== 'committed')
        ) {
          return false;
        }
        addHandovers([
          {
            operation_id: op.operation_id,
            queue_session_id: op.queue_session_id,
            public_code: r.public_code,
            status_token: r.status_token,
          },
        ]);
        return true;
      } catch {
        return false;
      }
    },
    [addHandovers, storage, userId],
  );

  const wipeLocalData = useCallback(async (): Promise<void> => {
    await offlineDb.clearAll();
    deviceIds.current.clear();
    deviceLookups.current.clear();
    setHandovers([]);
    setProblem(null);
    await reload();
  }, [reload]);

  const value = useMemo<OfflineApi>(
    () => ({
      storage,
      reachable,
      summary,
      ops,
      foreignPending,
      flushing,
      lastFlush,
      problem,
      ensureDevice,
      refreshSnapshot,
      loadCached,
      authorityFor,
      record,
      flush,
      reload,
      wipeLocalData,
      handovers,
      dismissHandover,
      requestHandover,
    }),
    [
      storage,
      reachable,
      summary,
      ops,
      foreignPending,
      flushing,
      lastFlush,
      problem,
      ensureDevice,
      refreshSnapshot,
      loadCached,
      authorityFor,
      record,
      flush,
      reload,
      wipeLocalData,
      handovers,
      dismissHandover,
      requestHandover,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOffline(): OfflineApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useOffline must be used within OfflineProvider');
  return ctx;
}
