/**
 * Announcement policy (REQ-F7.12; design §16.4), kept free of React so it can be tested exactly.
 *
 *  - The same message at the same level inside {@link DEDUPE_MS} is dropped (a retried request,
 *    a duplicate SSE refresh or a double render must never be read twice).
 *  - A throttled stream (for example `position`) speaks at most once per `throttleMs`; changes in
 *    between are skipped, never queued, so the person hears the latest value later or not at all
 *    rather than a backlog of stale ones.
 *  - Assertive messages are for the called alert and blocking errors only. They are never
 *    throttled (a call must never be swallowed) but are still deduplicated.
 */
export const DEDUPE_MS = 2000;
/** At most one position announcement per 15 seconds */
export const POSITION_THROTTLE_MS = 15_000;

export type Politeness = 'polite' | 'assertive';

export interface AnnounceOptions {
  /** Use only for the called alert and blocking errors */
  assertive?: boolean;
  /** Streams that must be rate-limited share a key, for example `position` */
  throttleKey?: string;
  throttleMs?: number;
}

export interface AnnouncePolicy {
  /** True when the message should be spoken now. Records the decision. */
  admit(message: string, opts?: AnnounceOptions): boolean;
}

export function createAnnouncePolicy(now: () => number = () => Date.now()): AnnouncePolicy {
  const lastSame = new Map<string, number>();
  const lastKey = new Map<string, number>();
  return {
    admit(message, opts = {}): boolean {
      const t = now();
      const level: Politeness = opts.assertive ? 'assertive' : 'polite';
      const sameKey = `${level}\u0000${message}`;
      const seen = lastSame.get(sameKey);
      if (seen !== undefined && t - seen < DEDUPE_MS) return false;
      if (opts.throttleKey !== undefined) {
        const last = lastKey.get(opts.throttleKey);
        const every = opts.throttleMs ?? POSITION_THROTTLE_MS;
        if (last !== undefined && t - last < every) return false;
        lastKey.set(opts.throttleKey, t);
      }
      lastSame.set(sameKey, t);
      // Keep the maps small on long-lived pages
      if (lastSame.size > 200) {
        for (const [k, v] of lastSame) if (t - v > DEDUPE_MS) lastSame.delete(k);
      }
      return true;
    },
  };
}
