import { uuidv7 } from '@queuebridge/contracts';

/**
 * How an online command ended, as far as this client can know:
 * - `committed` — the server applied it;
 * - `refused` — the server answered definitively without applying it (validation, permission or
 *   a rejected command such as `counter_busy`; a rejected disposition is stored for its id);
 * - `unknown` — no definitive answer (network failure, timeout, 429, 5xx): it may or may not have
 *   been applied.
 */
export type RunOutcome = 'committed' | 'refused' | 'unknown';

/** Map a failed request's HTTP status (0 = no response) to an outcome. */
export function outcomeOfStatus(status: number): RunOutcome {
  return status === 0 || status === 429 || status >= 500 ? 'unknown' : 'refused';
}

/**
 * Operation-id policy (AGENTS.md §4.4 — deduplication by `operation_id`): the SAME id is reused
 * only to retry the SAME command after an `unknown` outcome (so a lost response can never apply
 * it twice). After a commit or a definitive refusal, or when the command changes, a new id is
 * issued — re-sending a refused id would only replay the stored refusal and never execute.
 */
export class OperationIdTracker {
  private pending: { key: string; id: string } | null = null;

  public constructor(private readonly newId: () => string = uuidv7) {}

  /** The id to send for a command identified by `key` (its full, normalized content). */
  public idFor(key: string): string {
    if (this.pending?.key === key) return this.pending.id;
    const id = this.newId();
    this.pending = { key, id };
    return id;
  }

  /** Record how the last command ended. */
  public settle(outcome: RunOutcome): void {
    if (outcome !== 'unknown') this.pending = null;
  }
}
