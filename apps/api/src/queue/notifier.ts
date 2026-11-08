import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db.js';

/** PostgreSQL channel carrying "queue changed" signals (no data, no PII). */
export const QUEUE_CHANNEL = 'qb_queue_events';

export interface QueueSignal {
  /** facility id */
  f: string;
  /** queue session id */
  s: string;
  /** session revision after the change */
  r: number;
}

type Listener = (signal: QueueSignal) => void;

/**
 * Fan-out of committed-change signals to SSE subscribers.
 *
 * Commands publish with `pg_notify` inside their transaction, so a signal is delivered only if
 * the transaction commits, and every API instance listening on the channel receives it
 * (REQ-NFR.4). Subscribers receive only (facility, session, revision) and must refetch through
 * an authorized endpoint — the stream itself carries no queue data.
 */
export class QueueNotifier {
  private readonly listeners = new Set<Listener>();
  private starting: Promise<void> | null = null;
  private unlisten: (() => Promise<void>) | null = null;
  private closed = false;

  public constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Start LISTEN lazily (first subscriber) so apps without a reachable DB still boot. */
  public async ensureStarted(): Promise<void> {
    if (this.unlisten || this.closed) return;
    this.starting ??= (async (): Promise<void> => {
      try {
        const sub = await this.db.listen(QUEUE_CHANNEL, (raw) => this.dispatch(raw));
        this.unlisten = sub.unlisten;
      } catch (err) {
        this.log.error({ err }, 'queue notifier: LISTEN failed; live updates fall back to polling');
        this.starting = null;
        throw err;
      }
    })();
    await this.starting;
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public get subscriberCount(): number {
    return this.listeners.size;
  }

  private dispatch(raw: string): void {
    let signal: QueueSignal;
    try {
      signal = JSON.parse(raw) as QueueSignal;
    } catch {
      return;
    }
    for (const l of this.listeners) {
      try {
        l(signal);
      } catch (err) {
        this.log.warn({ err }, 'queue notifier: listener failed');
      }
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    if (this.unlisten) {
      const u = this.unlisten;
      this.unlisten = null;
      await u().catch(() => undefined);
    }
  }
}
