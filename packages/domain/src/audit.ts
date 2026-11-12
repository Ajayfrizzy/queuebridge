/**
 * Audit hash chain and checkpoint primitives (ADR-010), shared by the API and the worker so
 * there is exactly one implementation.
 *
 * This package performs no I/O and has no Node dependency: callers inject SHA-256
 * (`(input: string) => lowercase hex`). Everything here is deterministic.
 *
 *   event_hash = SHA256(domain_separator | queue_session_id | sequence | prev_hash | canonical_json)
 *   root_hash  = SHA256(event_hash[from] ‖ … ‖ event_hash[to])          (concatenated hex)
 *
 * The root hash can be recomputed without application code, e.g. in PostgreSQL:
 *   SELECT encode(sha256(convert_to(string_agg(event_hash, '' ORDER BY sequence), 'UTF8')), 'hex')
 *     FROM queue_events WHERE queue_session_id = $1 AND sequence BETWEEN $2 AND $3;
 */

export type Sha256Hex = (input: string) => string;

/** Domain separator for queue event hashes. */
export const EVENT_DOMAIN_SEPARATOR = 'queuebridge:v1:event';
/** Input whose SHA-256 is the prev_hash of the first event of every session. */
export const GENESIS_INPUT = 'queuebridge:v1:genesis';

export const genesisHash = (sha256: Sha256Hex): string => sha256(GENESIS_INPUT);

/**
 * Canonical JSON: object keys sorted recursively, no insignificant whitespace, arrays in order,
 * `undefined` omitted, non-finite numbers rejected.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('canonicalJson: non-finite number');
    }
    return JSON.stringify(value);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** The fields of a queue event that are covered by its hash. */
export interface HashedEventBody {
  organization_id: string;
  queue_session_id: string;
  sequence: number;
  event_type: string;
  actor_id: string | null;
  operation_id: string | null;
  payload: Record<string, unknown>;
  committed_at: string; // ISO 8601, millisecond precision, UTC
}

export interface StoredEvent extends HashedEventBody {
  prev_hash: string;
  event_hash: string;
}

export function computeEventHash(
  sha256: Sha256Hex,
  prevHash: string,
  body: HashedEventBody,
): string {
  return sha256(
    [
      EVENT_DOMAIN_SEPARATOR,
      body.queue_session_id,
      String(body.sequence),
      prevHash,
      canonicalJson(body),
    ].join('|'),
  );
}

export type ChainVerification =
  | { valid: true; checked: number; head_hash: string }
  | { valid: false; checked: number; broken_at_sequence: number; reason: string };

/** Verify the complete, ordered event sequence of ONE queue session from genesis. */
export function verifyChain(sha256: Sha256Hex, events: readonly StoredEvent[]): ChainVerification {
  let prev = genesisHash(sha256);
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as StoredEvent;
    if (e.sequence !== i + 1) {
      return {
        valid: false,
        checked: i,
        broken_at_sequence: i + 1,
        reason: 'sequence gap or reorder',
      };
    }
    if (e.prev_hash !== prev) {
      return {
        valid: false,
        checked: i,
        broken_at_sequence: e.sequence,
        reason: 'prev_hash mismatch',
      };
    }
    const expected = computeEventHash(sha256, prev, {
      organization_id: e.organization_id,
      queue_session_id: e.queue_session_id,
      sequence: e.sequence,
      event_type: e.event_type,
      actor_id: e.actor_id,
      operation_id: e.operation_id,
      payload: e.payload,
      committed_at: e.committed_at,
    });
    if (expected !== e.event_hash) {
      return {
        valid: false,
        checked: i,
        broken_at_sequence: e.sequence,
        reason: 'event_hash mismatch',
      };
    }
    prev = e.event_hash;
  }
  return { valid: true, checked: events.length, head_hash: prev };
}

/** Root hash of a contiguous range of event hashes (in sequence order). */
export function checkpointRoot(sha256: Sha256Hex, eventHashes: readonly string[]): string {
  return sha256(eventHashes.join(''));
}

/** The exact message a checkpoint signature covers (versioned, unambiguous field order). */
export function checkpointMessage(c: {
  queue_session_id: string;
  from_sequence: number;
  to_sequence: number;
  root_hash: string;
  head_hash: string;
}): string {
  return [
    'queuebridge:v1:checkpoint',
    c.queue_session_id,
    String(c.from_sequence),
    String(c.to_sequence),
    c.root_hash,
    c.head_hash,
  ].join('|');
}

export interface CheckpointRecord {
  from_sequence: number;
  to_sequence: number;
  root_hash: string;
  head_hash: string | null;
  key_id: string;
  signature: string;
}

export type CheckpointCheck =
  | { status: 'valid' }
  | { status: 'invalid'; reason: string }
  | { status: 'unverifiable'; reason: string };

/**
 * Check checkpoints of one session against its (already chain-verified) events.
 * `verifySignature` returns null when the signing key is unavailable (→ unverifiable, never
 * valid). Ranges must start at 1, be contiguous and never overlap.
 */
export function verifyCheckpoints(
  sha256: Sha256Hex,
  events: readonly StoredEvent[],
  checkpoints: readonly CheckpointRecord[],
  queueSessionId: string,
  verifySignature: (message: string, c: CheckpointRecord) => boolean | null,
): {
  results: (CheckpointCheck & { from_sequence: number; to_sequence: number })[];
  covered_to: number;
} {
  const bySeq = new Map(events.map((e) => [e.sequence, e]));
  const sorted = [...checkpoints].sort((a, b) => a.from_sequence - b.from_sequence);
  const results: (CheckpointCheck & { from_sequence: number; to_sequence: number })[] = [];
  let expectedFrom = 1;
  let covered = 0;
  for (const c of sorted) {
    const range = { from_sequence: c.from_sequence, to_sequence: c.to_sequence };
    if (c.from_sequence !== expectedFrom || c.to_sequence < c.from_sequence) {
      results.push({ ...range, status: 'invalid', reason: 'range not contiguous' });
      expectedFrom = c.to_sequence + 1;
      continue;
    }
    expectedFrom = c.to_sequence + 1;
    const hashes: string[] = [];
    for (let s = c.from_sequence; s <= c.to_sequence; s++) {
      const e = bySeq.get(s);
      if (!e) break;
      hashes.push(e.event_hash);
    }
    if (hashes.length !== c.to_sequence - c.from_sequence + 1) {
      results.push({ ...range, status: 'invalid', reason: 'events in range are missing' });
      continue;
    }
    if (checkpointRoot(sha256, hashes) !== c.root_hash) {
      results.push({ ...range, status: 'invalid', reason: 'root_hash mismatch' });
      continue;
    }
    const head = hashes[hashes.length - 1] as string;
    if (c.head_hash !== null && c.head_hash !== head) {
      results.push({ ...range, status: 'invalid', reason: 'head_hash mismatch' });
      continue;
    }
    const sig = verifySignature(
      checkpointMessage({
        queue_session_id: queueSessionId,
        ...range,
        root_hash: c.root_hash,
        head_hash: head,
      }),
      c,
    );
    if (sig === null) {
      results.push({
        ...range,
        status: 'unverifiable',
        reason: `signing key ${c.key_id} not available`,
      });
      continue;
    }
    if (!sig) {
      results.push({ ...range, status: 'invalid', reason: 'signature mismatch' });
      continue;
    }
    results.push({ ...range, status: 'valid' });
    covered = c.to_sequence;
  }
  return { results, covered_to: covered };
}
