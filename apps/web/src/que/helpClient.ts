import {
  RestrictedKbResponseSchema,
  type KbArticle,
  type RestrictedKbResponse,
} from '@queuebridge/contracts';
import {
  PageClock,
  evaluateBundle,
  knownParam,
  mergeResponse,
  type BundleState,
} from './offlineHelp.js';
import type { RestrictedHelpStore } from './store.js';

/** Fetches `GET /api/v1/que/kb`; rejects with an error carrying `status` (0 = unreachable). */
export type RestrictedFetcher = (known: string | undefined) => Promise<unknown>;

export type RefreshOutcome = 'updated' | 'signed_out' | 'unavailable' | 'superseded';

function statusOf(e: unknown): number {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : 0;
}

/**
 * Restricted Ask Que help on this device (MQ.2; design §11.5.2–§11.5.4). The browser never
 * decides what a user may read: it stores what the server issued for this session and hides it
 * when the server's fingerprint changes, the session ends, or the offline bound expires.
 *
 * Invalidation (design §11.5.3): confirmed sign-out, any 401 and an unexpected user → delete all;
 * a different user signing in → delete every other user's record; a new role fingerprint →
 * delete, then store the new bundle; a successful online `/auth/me` → revalidate before showing.
 */
export class QueHelpClient {
  /** User whose bundle must be revalidated before restricted help is shown. */
  private pendingFor: string | null = null;
  /** Bumped on every purge so a refresh still in flight cannot re-populate the cache. */
  private generation = 0;
  /** MQ.3: views (the Ask Que panel) re-read restricted help when it may have changed. */
  private readonly listeners = new Set<() => void>();

  /** Notify when stored help or the pending state changes. Returns an unsubscribe function. */
  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // a broken view never breaks the cache logic
      }
    }
  }

  public constructor(
    private readonly store: RestrictedHelpStore,
    private readonly fetchRestricted: RestrictedFetcher,
    private readonly clock: PageClock = new PageClock(),
  ) {}

  /**
   * A user is signed in. Other users' help is deleted at once. Online, the bundle is revalidated
   * (and restricted help stays hidden until that finishes); offline, the cached bundle follows
   * the expiry rules.
   */
  public async signedIn(userId: string, online: boolean): Promise<RefreshOutcome | 'offline'> {
    await this.store.deleteAllExcept(userId);
    if (!online) return 'offline';
    this.pendingFor = userId;
    this.notify();
    return this.refresh(userId);
  }

  /** Confirmed sign-out, any 401, or a session ended by the server. */
  public async purgeAll(): Promise<void> {
    this.generation++;
    this.pendingFor = null;
    await this.store.deleteAll();
    this.notify();
  }

  private async fetchParsed(known: string | undefined): Promise<RestrictedKbResponse> {
    return RestrictedKbResponseSchema.parse(await this.fetchRestricted(known));
  }

  public async refresh(userId: string): Promise<RefreshOutcome> {
    const gen = this.generation;
    const previous = await this.store.get(userId);
    let response: RestrictedKbResponse;
    try {
      response = await this.fetchParsed(knownParam(previous));
    } catch (e) {
      if (statusOf(e) === 401) {
        await this.purgeAll();
        return 'signed_out';
      }
      // Unreachable, server error or malformed response: nothing was revalidated. The cached
      // copy (if any) keeps following the offline expiry rules.
      if (this.pendingFor === userId) this.pendingFor = null;
      this.notify();
      return 'unavailable';
    }
    if (gen !== this.generation) return 'superseded';
    if (response.userId !== userId) {
      await this.purgeAll();
      return 'signed_out';
    }
    let record = mergeResponse(previous, response, this.clock.now());
    if (!record) {
      // The cache lacked an article the server did not resend: fetch the complete bundle
      try {
        response = await this.fetchParsed(undefined);
      } catch (e) {
        if (statusOf(e) === 401) {
          await this.purgeAll();
          return 'signed_out';
        }
        if (this.pendingFor === userId) this.pendingFor = null;
        this.notify();
        return 'unavailable';
      }
      record = mergeResponse(null, response, this.clock.now());
      if (!record || gen !== this.generation) return 'superseded';
    }
    if (previous && previous.roleDigest !== record.roleDigest) await this.store.delete(userId);
    if (gen !== this.generation) return 'superseded';
    await this.store.put(record);
    if (this.pendingFor === userId) this.pendingFor = null;
    this.notify();
    return 'updated';
  }

  /**
   * Restricted articles that may be shown now. `pending` while an online revalidation is
   * outstanding; otherwise the cached bundle's offline state (design §11.5.2).
   */
  public async restrictedHelp(
    userId: string,
  ): Promise<{ state: BundleState | 'pending'; articles: KbArticle[] }> {
    if (this.pendingFor === userId) return { state: 'pending', articles: [] };
    const gen = this.generation;
    const record = await this.store.get(userId);
    const { state, persist } = evaluateBundle(record, this.clock.now(), this.clock.jumped());
    if (persist && gen === this.generation) await this.store.put(persist);
    return { state, articles: state === 'valid' && record ? record.articles : [] };
  }
}
