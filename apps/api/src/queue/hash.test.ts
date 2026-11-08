import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  computeEventHash,
  EVENT_DOMAIN_SEPARATOR,
  GENESIS_HASH,
  verifyChain,
  type StoredEvent,
} from './hash.js';

describe('canonicalJson', () => {
  it('sorts keys recursively and is independent of insertion order', () => {
    const a = { b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } };
    const b = { a: { c: 'x', d: [3, { y: 2, z: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('keeps nested keys (unlike JSON.stringify with a top-level key list)', () => {
    const v = { payload: { ticket_id: 't1' }, sequence: 1 };
    expect(JSON.stringify(v, Object.keys(v).sort())).toBe('{"payload":{},"sequence":1}'); // the pitfall
    expect(canonicalJson(v)).toBe('{"payload":{"ticket_id":"t1"},"sequence":1}');
  });

  it('omits undefined, keeps null, rejects non-finite numbers', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
  });
});

function chain(n: number): StoredEvent[] {
  const out: StoredEvent[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const body = {
      organization_id: 'o',
      queue_session_id: 'q',
      sequence: i,
      event_type: i === 1 ? 'queue.open' : 'ticket.create',
      actor_id: null,
      operation_id: null,
      payload: { i },
      committed_at: new Date(1_700_000_000_000 + i).toISOString(),
    };
    const event_hash = computeEventHash(prev, body);
    out.push({ ...body, prev_hash: prev, event_hash });
    prev = event_hash;
  }
  return out;
}

describe('event hash chain', () => {
  it('genesis is SHA-256 of the documented genesis string; hash uses the documented layout', () => {
    expect(GENESIS_HASH).toBe(createHash('sha256').update('queuebridge:v1:genesis').digest('hex'));
    const [e] = chain(1);
    const { prev_hash: _p, event_hash: _h, ...body } = e!;
    const manual = createHash('sha256')
      .update([EVENT_DOMAIN_SEPARATOR, 'q', '1', GENESIS_HASH, canonicalJson(body)].join('|'))
      .digest('hex');
    expect(e!.event_hash).toBe(manual);
  });

  it('verifies an intact chain and detects tampering, deletion, reordering and re-hashing', () => {
    const good = chain(5);
    expect(verifyChain(good)).toMatchObject({ valid: true, checked: 5 });

    const edited = good.map((e, i) => (i === 2 ? { ...e, payload: { i: 999 } } : e));
    expect(verifyChain(edited)).toMatchObject({
      valid: false,
      broken_at_sequence: 3,
      reason: 'event_hash mismatch',
    });

    expect(verifyChain([good[0]!, good[2]!])).toMatchObject({
      valid: false,
      reason: 'sequence gap or reorder',
    });
    expect(verifyChain([good[1]!, good[0]!])).toMatchObject({ valid: false });

    // Re-hashing one edited event breaks the NEXT link
    const rehashed = [...good];
    const { prev_hash: prev, event_hash: _old, ...fields } = good[1]!;
    const forged = { ...fields, payload: { i: 42 } };
    rehashed[1] = { ...forged, prev_hash: prev, event_hash: computeEventHash(prev, forged) };
    expect(verifyChain(rehashed)).toMatchObject({
      valid: false,
      broken_at_sequence: 3,
      reason: 'prev_hash mismatch',
    });

    // A single changed character in actor or timestamp is detected
    const actor = good.map((e, i) =>
      i === 4 ? { ...e, committed_at: e.committed_at.replace(/.$/, '1') } : e,
    );
    expect(verifyChain(actor).valid).toBe(false);
  });
});
