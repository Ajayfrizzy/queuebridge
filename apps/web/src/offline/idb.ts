import type { OutboxFilter, OutboxOperation, OutboxStore } from '@queuebridge/continuity';

/**
 * IndexedDB persistence for offline operation (ADR-005).
 *
 * Stores:
 *  - operations: the command outbox (REQ-F1.2)
 *  - kv: device registrations, sequence counters, cached authorized snapshots, coordinator
 *        authority and the minimal offline identity
 *
 * Nothing stored here is personal visitor data: operations hold ids, enums and temporary
 * references; snapshots hold ticket codes, states and counter names. Staff identity is reduced
 * to id, display name, organization and roles (no email).
 */

export const DEFAULT_DB_NAME = 'queuebridge-offline';

export class OfflineStorageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OfflineStorageError';
  }
}

interface KvRecord<T = unknown> {
  key: string;
  value: T;
  owner_user_id: string | null;
  stored_at: number;
}

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = (): void => resolve(r.result);
    r.onerror = (): void => reject(new OfflineStorageError(r.error?.message ?? 'IndexedDB error'));
  });

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void =>
      reject(new OfflineStorageError(tx.error?.message ?? 'IndexedDB error'));
    tx.onabort = (): void =>
      reject(new OfflineStorageError(tx.error?.message ?? 'IndexedDB transaction aborted'));
  });

/** Whether this browser can persist offline data at all (private modes / policies may block it). */
export async function storageAvailable(dbName: string = DEFAULT_DB_NAME): Promise<boolean> {
  try {
    if (typeof indexedDB === 'undefined') return false;
    const db = await new OfflineDb(dbName).open();
    db.close();
    return true;
  } catch {
    return false;
  }
}

export class OfflineDb implements OutboxStore {
  private opening: Promise<IDBDatabase> | null = null;
  /**
   * The signed-in user whose data may be cached. User-owned writes for anyone else are dropped,
   * so a request still in flight when someone signs out cannot re-populate the cache afterwards.
   */
  private activeUser: string | null = null;

  public setActiveUser(userId: string | null): void {
    this.activeUser = userId;
  }

  public constructor(private readonly name: string = DEFAULT_DB_NAME) {}

  public open(): Promise<IDBDatabase> {
    this.opening ??= this.openVersion(undefined).catch((e: unknown) => {
      this.opening = null;
      throw e;
    });
    return this.opening;
  }

  /**
   * Open the database, creating the stores in an upgrade. If the database already exists
   * without our stores (e.g. something else created an empty one), reopen at the next version
   * so the upgrade runs — never operate on a store-less database.
   */
  private openVersion(version: number | undefined): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new OfflineStorageError('IndexedDB is not available in this browser.'));
        return;
      }
      let r: IDBOpenDBRequest;
      try {
        r = version === undefined ? indexedDB.open(this.name) : indexedDB.open(this.name, version);
      } catch (e) {
        reject(new OfflineStorageError(e instanceof Error ? e.message : 'IndexedDB blocked'));
        return;
      }
      r.onupgradeneeded = (): void => {
        const db = r.result;
        if (!db.objectStoreNames.contains('operations')) {
          const ops = db.createObjectStore('operations', { keyPath: 'operation_id' });
          ops.createIndex('owner', 'owner_user_id');
          ops.createIndex('queue', 'queue_session_id');
        }
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      };
      r.onsuccess = (): void => {
        const db = r.result;
        if (!db.objectStoreNames.contains('operations') || !db.objectStoreNames.contains('kv')) {
          const next = db.version + 1;
          db.close();
          this.openVersion(next).then(resolve, reject);
          return;
        }
        // Another tab upgrading or the browser reclaiming storage: reopen on next use
        db.onclose = (): void => {
          this.opening = null;
        };
        db.onversionchange = (): void => {
          db.close();
          this.opening = null;
        };
        resolve(db);
      };
      r.onerror = (): void =>
        reject(new OfflineStorageError(r.error?.message ?? 'Could not open IndexedDB'));
      r.onblocked = (): void => reject(new OfflineStorageError('IndexedDB open was blocked'));
    });
  }

  // ---- OutboxStore ------------------------------------------------------------------------

  public async put(op: OutboxOperation): Promise<void> {
    await this.putMany([op]);
  }

  public async putMany(ops: readonly OutboxOperation[]): Promise<void> {
    const db = await this.open();
    const tx = db.transaction('operations', 'readwrite');
    const store = tx.objectStore('operations');
    for (const op of ops) store.put(op);
    await done(tx);
  }

  public async get(operationId: string): Promise<OutboxOperation | undefined> {
    const db = await this.open();
    const tx = db.transaction('operations', 'readonly');
    return (await req(tx.objectStore('operations').get(operationId))) as
      | OutboxOperation
      | undefined;
  }

  public async list(filter: OutboxFilter = {}): Promise<OutboxOperation[]> {
    const db = await this.open();
    const tx = db.transaction('operations', 'readonly');
    const all = (await req(tx.objectStore('operations').getAll())) as OutboxOperation[];
    return all
      .filter(
        (o) =>
          (filter.owner_user_id === undefined || o.owner_user_id === filter.owner_user_id) &&
          (filter.queue_session_id === undefined ||
            o.queue_session_id === filter.queue_session_id) &&
          (filter.statuses === undefined || filter.statuses.includes(o.status)),
      )
      .sort((a, b) => a.client_sequence - b.client_sequence);
  }

  public async remove(operationId: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction('operations', 'readwrite');
    tx.objectStore('operations').delete(operationId);
    await done(tx);
  }

  /** Atomic read-increment-write inside ONE readwrite transaction (safe across tabs). */
  public async nextClientSequence(deviceId: string): Promise<number> {
    const db = await this.open();
    const tx = db.transaction('kv', 'readwrite');
    const store = tx.objectStore('kv');
    const key = `seq:${deviceId}`;
    const current = (await req(store.get(key))) as KvRecord<number> | undefined;
    const next = (current?.value ?? 0) + 1;
    store.put({
      key,
      value: next,
      owner_user_id: null,
      stored_at: Date.now(),
    } satisfies KvRecord<number>);
    await done(tx);
    return next;
  }

  // ---- Key/value (caches, registrations, authority) ---------------------------------------

  public async kvPut<T>(key: string, value: T, ownerUserId: string | null): Promise<void> {
    if (ownerUserId !== null && ownerUserId !== this.activeUser) return;
    const db = await this.open();
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put({
      key,
      value,
      owner_user_id: ownerUserId,
      stored_at: Date.now(),
    } satisfies KvRecord<T>);
    await done(tx);
  }

  /** Returns the value only when it was stored for `ownerUserId` (never another user's data). */
  public async kvGet<T>(
    key: string,
    ownerUserId: string | null,
  ): Promise<{ value: T; stored_at: number } | undefined> {
    const db = await this.open();
    const tx = db.transaction('kv', 'readonly');
    const rec = (await req(tx.objectStore('kv').get(key))) as KvRecord<T> | undefined;
    if (!rec) return undefined;
    if (rec.owner_user_id !== ownerUserId) return undefined;
    return { value: rec.value, stored_at: rec.stored_at };
  }

  public async kvDelete(key: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(key);
    await done(tx);
  }

  /** All records under a key prefix that belong to `ownerUserId`. */
  public async kvList<T>(
    prefix: string,
    ownerUserId: string | null,
  ): Promise<{ key: string; value: T; stored_at: number }[]> {
    const db = await this.open();
    const tx = db.transaction('kv', 'readonly');
    const all = (await req(tx.objectStore('kv').getAll())) as KvRecord<T>[];
    return all
      .filter((r) => r.key.startsWith(prefix) && r.owner_user_id === ownerUserId)
      .map((r) => ({ key: r.key, value: r.value, stored_at: r.stored_at }));
  }

  /**
   * Remove cached, authorized DATA (snapshots, identity, facility caches) for everyone.
   * Device registrations and sequence counters always stay. With `discardOutboxOf`, that user's
   * unsent operations and coordinator tokens are discarded too (confirmed sign-out after the
   * person chose to discard). Other people's unsent operations are NEVER touched here — they
   * stay until that person syncs them or a supervisor explicitly clears the device.
   */
  public async clearSensitive(opts: { discardOutboxOf: string | null }): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(['kv', 'operations'], 'readwrite');
    const kv = tx.objectStore('kv');
    const records = (await req(kv.getAll())) as KvRecord[];
    for (const r of records) {
      if (r.key.startsWith('seq:') || r.key.startsWith('device:')) continue;
      if (
        r.key.startsWith('auth:') &&
        (opts.discardOutboxOf === null || r.owner_user_id !== opts.discardOutboxOf)
      ) {
        continue;
      }
      kv.delete(r.key);
    }
    if (opts.discardOutboxOf !== null) {
      const ops = tx.objectStore('operations');
      const mine = (await req(ops.index('owner').getAllKeys(opts.discardOutboxOf))) as string[];
      for (const k of mine) ops.delete(k);
    }
    await done(tx);
  }

  /** Erase everything this app stored, including device registrations (explicit, supervisor-grade). */
  public async clearAll(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(['kv', 'operations'], 'readwrite');
    tx.objectStore('kv').clear();
    tx.objectStore('operations').clear();
    await done(tx);
  }

  public close(): void {
    void this.opening?.then((db) => db.close()).catch(() => undefined);
    this.opening = null;
  }
}

/** Process-wide instance used by the app. */
export const offlineDb = new OfflineDb();
