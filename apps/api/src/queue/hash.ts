import { createHash } from 'node:crypto';

/** Domain separator for queue event hashes (ADR-010). */
export const EVENT_DOMAIN_SEPARATOR = 'queuebridge:v1:event';
/** prev_hash of the first event in every queue session. */
export const GENESIS_HASH = createHash('sha256')
  .update('queuebridge:v1:genesis', 'utf8')
  .digest('hex');

/**
 * Canonical JSON: object keys sorted recursively, no insignificant whitespace, arrays in order.
 * Unlike `JSON.stringify(obj, sortedTopLevelKeys)` this also canonicalizes nested objects and
 * never drops nested keys. `undefined` values are omitted (as JSON does).
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

/**
 * event_hash = SHA256(domain_separator | queue_session_id | sequence | prev_hash | canonical_event_json)
 * (fields joined with '|', per design §6).
 */
export function computeEventHash(prevHash: string, body: HashedEventBody): string {
  const input = [
    EVENT_DOMAIN_SEPARATOR,
    body.queue_session_id,
    String(body.sequence),
    prevHash,
    canonicalJson(body),
  ].join('|');
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface StoredEvent extends HashedEventBody {
  prev_hash: string;
  event_hash: string;
}

export type ChainVerification =
  | { valid: true; checked: number; head_hash: string }
  | { valid: false; checked: number; broken_at_sequence: number; reason: string };

/** Verify a complete, ordered event sequence of ONE queue session. */
export function verifyChain(events: readonly StoredEvent[]): ChainVerification {
  let prev = GENESIS_HASH;
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
    const expected = computeEventHash(prev, {
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
