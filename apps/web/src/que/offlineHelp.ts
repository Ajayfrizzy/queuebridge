import type {
  Audience,
  KbArticle,
  KbArticleRef,
  RestrictedKbResponse,
} from '@queuebridge/contracts';

/**
 * Offline authorization for restricted Ask Que help (MQ.2; design §11.5.2–§11.5.4; REQ-F13.3.4,
 * F13.3.6–F13.3.9; decision D2).
 *
 * Expiry is ELAPSED TIME SINCE RECEIPT, never a comparison of the device clock with a server
 * timestamp, so a clock that is simply ahead or behind has no effect. A clock moved backwards,
 * a wall-clock/monotonic disagreement, or missing/corrupt metadata hides restricted help until a
 * fresh authorized fetch succeeds. The browser only stores and compares server-issued values
 * (`userId`, `roleDigest`); it never computes a fingerprint or decides what it may see.
 *
 * Honest limit: this bounds DISPLAY against wrong, drifting or reset clocks. It cannot stop a
 * person in full control of the device (frozen clock, reading IndexedDB). Confidentiality comes
 * from the content rule: restricted bundles hold only generic procedures (design §11.5.1).
 */

export const SAFETY_MARGIN_MS = 5 * 60 * 1000;
export const ROLLBACK_TOLERANCE_MS = 2 * 60 * 1000;

/** What is stored per user in IndexedDB. Server-issued fields are copied verbatim. */
export interface CachedRestrictedBundle {
  userId: string;
  roleDigest: string;
  audiences: Audience[];
  kbVersion: number;
  issuedAt: string;
  authorizedUntil: string;
  validForMs: number;
  articles: KbArticle[];
  /** Device `Date.now()` when the bundle was received. */
  receivedAtLocalMs: number;
  /** Largest `Date.now()` ever observed for this bundle (persisted). */
  highWaterLocalMs: number;
  /** Set once a clock problem is detected; only a fresh authorized fetch clears it. */
  unverifiable?: true;
}

export type BundleState = 'valid' | 'expired' | 'unverifiable' | 'missing';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function wellFormed(r: unknown): r is CachedRestrictedBundle {
  if (typeof r !== 'object' || r === null) return false;
  const b = r as Partial<CachedRestrictedBundle>;
  return (
    typeof b.userId === 'string' &&
    b.userId.length > 0 &&
    typeof b.roleDigest === 'string' &&
    /^[0-9a-f]{64}$/.test(b.roleDigest) &&
    Array.isArray(b.articles) &&
    Array.isArray(b.audiences) &&
    finite(b.kbVersion) &&
    finite(b.validForMs) &&
    b.validForMs >= 0 &&
    finite(b.receivedAtLocalMs) &&
    finite(b.highWaterLocalMs) &&
    b.highWaterLocalMs >= b.receivedAtLocalMs
  );
}

/**
 * Tracks wall clock against the monotonic clock for the lifetime of one page. If the wall clock
 * jumps relative to `performance.now()` by more than the tolerance, cached restricted help is
 * treated as unverifiable (design §11.5.2). A device that suspends `performance.now()` while
 * asleep also trips this; that fails closed (help reappears after the next online fetch).
 */
export class PageClock {
  private readonly wallStart: number;
  private readonly monoStart: number;
  public constructor(
    private readonly wall: () => number = () => Date.now(),
    private readonly mono: () => number = () => performance.now(),
  ) {
    this.wallStart = wall();
    this.monoStart = mono();
  }
  public now(): number {
    return this.wall();
  }
  /** True when wall-clock elapsed and monotonic elapsed disagree beyond the tolerance. */
  public jumped(): boolean {
    const wallElapsed = this.wall() - this.wallStart;
    const monoElapsed = this.mono() - this.monoStart;
    return Math.abs(wallElapsed - monoElapsed) > ROLLBACK_TOLERANCE_MS;
  }
}

/**
 * Decide whether a cached bundle may be shown now. Returns the state and the record to persist
 * (high-water mark advanced, or marked unverifiable), or `null` when nothing must be written.
 */
export function evaluateBundle(
  record: unknown,
  nowMs: number,
  clockJumped: boolean,
): { state: BundleState; persist: CachedRestrictedBundle | null } {
  if (record === undefined || record === null) return { state: 'missing', persist: null };
  // Missing or corrupt clock metadata: treated as expired (design §11.5.2)
  if (!wellFormed(record) || !finite(nowMs)) return { state: 'expired', persist: null };
  if (record.unverifiable) return { state: 'unverifiable', persist: null };
  const rolledBack = nowMs < record.highWaterLocalMs - ROLLBACK_TOLERANCE_MS;
  const elapsed = nowMs - record.receivedAtLocalMs;
  if (rolledBack || clockJumped || elapsed < 0) {
    return { state: 'unverifiable', persist: { ...record, unverifiable: true } };
  }
  const persist = nowMs > record.highWaterLocalMs ? { ...record, highWaterLocalMs: nowMs } : null;
  if (elapsed >= record.validForMs - SAFETY_MARGIN_MS) return { state: 'expired', persist };
  return { state: 'valid', persist };
}

/** The `known` query value for an incremental refresh (`id:version,...`), or undefined. */
export function knownParam(record: CachedRestrictedBundle | null): string | undefined {
  if (!record || record.articles.length === 0) return undefined;
  return record.articles.map((a) => `${a.id}:${a.version}`).join(',');
}

/**
 * Build the record to store from a server response, reusing cached articles the server did not
 * resend (same id AND version). Returns `null` when an indexed article is neither in the
 * response nor in the cache at that version: the caller must fetch the full bundle instead.
 * A cached record of a different user or role fingerprint is never reused.
 */
export function mergeResponse(
  previous: CachedRestrictedBundle | null,
  response: RestrictedKbResponse,
  nowMs: number,
): CachedRestrictedBundle | null {
  const reusable =
    previous &&
    previous.userId === response.userId &&
    previous.roleDigest === response.roleDigest &&
    !previous.unverifiable
      ? previous.articles
      : [];
  const fresh = new Map(response.articles.map((a) => [a.id, a]));
  const cached = new Map(reusable.map((a) => [a.id, a]));
  const articles: KbArticle[] = [];
  for (const ref of response.index as KbArticleRef[]) {
    const a = fresh.get(ref.id) ?? cached.get(ref.id);
    if (!a || a.version !== ref.version) return null;
    articles.push(a);
  }
  return {
    userId: response.userId,
    roleDigest: response.roleDigest,
    audiences: response.audiences,
    kbVersion: response.kbVersion,
    issuedAt: response.issuedAt,
    authorizedUntil: response.authorizedUntil,
    validForMs: response.validForMs,
    articles,
    receivedAtLocalMs: nowMs,
    highWaterLocalMs: nowMs,
  };
}
