import type { CachedRestrictedBundle } from './offlineHelp.js';

/**
 * Per-user cache of restricted Ask Que help (MQ.2; design §11.5). A separate IndexedDB database
 * from the queue outbox, so clearing help never touches unsent actions. One record per user,
 * written in a single transaction (atomic replacement). Holds only the server's restricted
 * bundle and its clock metadata: no credentials, no tenant data, no other API response.
 */
export interface RestrictedHelpStore {
  get(userId: string): Promise<CachedRestrictedBundle | null>;
  /** Replace the user's record atomically. */
  put(record: CachedRestrictedBundle): Promise<void>;
  delete(userId: string): Promise<void>;
  /** Delete every other user's record (a different user signed in on this device). */
  deleteAllExcept(userId: string): Promise<void>;
  deleteAll(): Promise<void>;
}

export const QUE_DB_NAME = 'queuebridge-que';
const STORE = 'restricted';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = (): void => resolve(r.result);
    r.onerror = (): void => reject(r.error ?? new Error('IndexedDB error'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error ?? new Error('IndexedDB error'));
    tx.onabort = (): void => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export class IdbRestrictedHelpStore implements RestrictedHelpStore {
  private opening: Promise<IDBDatabase> | null = null;
  public constructor(private readonly name: string = QUE_DB_NAME) {}

  private open(): Promise<IDBDatabase> {
    this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = (): void => {
        if (!r.result.objectStoreNames.contains(STORE)) {
          r.result.createObjectStore(STORE, { keyPath: 'userId' });
        }
      };
      r.onsuccess = (): void => resolve(r.result);
      r.onerror = (): void => reject(r.error ?? new Error('IndexedDB open failed'));
    }).catch((e: unknown) => {
      this.opening = null;
      throw e;
    });
    return this.opening;
  }

  public async get(userId: string): Promise<CachedRestrictedBundle | null> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readonly');
    const r = (await req(tx.objectStore(STORE).get(userId))) as CachedRestrictedBundle | undefined;
    return r ?? null;
  }

  public async put(record: CachedRestrictedBundle): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    await done(tx);
  }

  public async delete(userId: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(userId);
    await done(tx);
  }

  public async deleteAllExcept(userId: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite');
    const s = tx.objectStore(STORE);
    for (const k of (await req(s.getAllKeys())) as string[]) if (k !== userId) s.delete(k);
    await done(tx);
  }

  public async deleteAll(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await done(tx);
  }
}

/** In-memory store with the same contract (unit tests). */
export class MemoryRestrictedHelpStore implements RestrictedHelpStore {
  public readonly records = new Map<string, CachedRestrictedBundle>();
  public async get(userId: string): Promise<CachedRestrictedBundle | null> {
    const r = this.records.get(userId);
    return r ? structuredClone(r) : null;
  }
  public async put(record: CachedRestrictedBundle): Promise<void> {
    this.records.set(record.userId, structuredClone(record));
  }
  public async delete(userId: string): Promise<void> {
    this.records.delete(userId);
  }
  public async deleteAllExcept(userId: string): Promise<void> {
    for (const k of [...this.records.keys()]) if (k !== userId) this.records.delete(k);
  }
  public async deleteAll(): Promise<void> {
    this.records.clear();
  }
}
