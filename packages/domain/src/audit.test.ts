import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkpointMessage,
  checkpointRoot,
  computeEventHash,
  genesisHash,
  verifyChain,
  verifyCheckpoints,
  type CheckpointRecord,
  type StoredEvent,
} from './audit.js';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function chain(n: number): StoredEvent[] {
  const out: StoredEvent[] = [];
  let prev = genesisHash(sha);
  for (let i = 1; i <= n; i++) {
    const body = {
      organization_id: 'o',
      queue_session_id: 'q',
      sequence: i,
      event_type: i === 1 ? 'queue.open' : 'ticket.create',
      actor_id: null,
      operation_id: null,
      payload: { n: i },
      committed_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    };
    const event_hash = computeEventHash(sha, prev, body);
    out.push({ ...body, prev_hash: prev, event_hash });
    prev = event_hash;
  }
  return out;
}

describe('audit chain (shared by API and worker)', () => {
  it('matches the M2 genesis and verifies a known sequence', () => {
    expect(genesisHash(sha)).toBe(sha('queuebridge:v1:genesis'));
    expect(verifyChain(sha, chain(10))).toMatchObject({ valid: true, checked: 10 });
  });
  it('a single changed character in a committed payload breaks the chain at that event', () => {
    const c = chain(10);
    const t = c.map((e, i) => (i === 4 ? { ...e, payload: { n: 50 } } : e));
    expect(verifyChain(sha, t)).toMatchObject({
      valid: false,
      broken_at_sequence: 5,
      reason: 'event_hash mismatch',
    });
  });
  it('a deleted event or a re-hashed forgery is caught', () => {
    const c = chain(6);
    expect(verifyChain(sha, [...c.slice(0, 2), ...c.slice(3)])).toMatchObject({
      valid: false,
      reason: 'sequence gap or reorder',
    });
    const forged = c.map((e) => ({ ...e }));
    forged[2] = { ...forged[2]!, payload: { n: 99 } };
    const { prev_hash: ph, event_hash: _eh, ...body } = forged[2];
    forged[2].event_hash = computeEventHash(sha, ph, body); // forger recomputes THIS event's hash...
    expect(verifyChain(sha, forged)).toMatchObject({
      valid: false,
      broken_at_sequence: 4,
      reason: 'prev_hash mismatch',
    }); // ...but not the rest
  });
});

describe('checkpoints', () => {
  const key = 'k';
  const sign = (m: string): string => createHash('sha256').update(`${key}|${m}`).digest('hex');
  const cp = (events: StoredEvent[], from: number, to: number): CheckpointRecord => {
    const hashes = events.slice(from - 1, to).map((e) => e.event_hash);
    const root_hash = checkpointRoot(sha, hashes);
    const head_hash = hashes[hashes.length - 1] as string;
    return {
      from_sequence: from,
      to_sequence: to,
      root_hash,
      head_hash,
      key_id: 'k1',
      signature: sign(
        checkpointMessage({
          queue_session_id: 'q',
          from_sequence: from,
          to_sequence: to,
          root_hash,
          head_hash,
        }),
      ),
    };
  };
  const verify = (m: string, c: CheckpointRecord): boolean | null =>
    c.key_id === 'k1' ? sign(m) === c.signature : null;

  it('root hash covers exactly the range (concatenated event hashes)', () => {
    const c = chain(5);
    expect(
      checkpointRoot(
        sha,
        c.slice(1, 4).map((e) => e.event_hash),
      ),
    ).toBe(sha(c[1]!.event_hash + c[2]!.event_hash + c[3]!.event_hash));
  });

  it('valid contiguous checkpoints verify and report coverage', () => {
    const c = chain(9);
    const r = verifyCheckpoints(sha, c, [cp(c, 1, 4), cp(c, 5, 7)], 'q', verify);
    expect(r.results.map((x) => x.status)).toEqual(['valid', 'valid']);
    expect(r.covered_to).toBe(7);
  });

  it('detects altered root, forged signature, gaps, overlaps and missing events', () => {
    const c = chain(9);
    const good = cp(c, 1, 4);
    const cases: [CheckpointRecord[], string][] = [
      [[{ ...good, root_hash: sha('x') }], 'root_hash mismatch'],
      [[{ ...good, signature: 'f'.repeat(64) }], 'signature mismatch'],
      [[cp(c, 2, 4)], 'range not contiguous'],
      [[good, cp(c, 3, 6)], 'range not contiguous'],
      [[{ ...good, to_sequence: 12 }], 'events in range are missing'],
      [[{ ...good, head_hash: c[0]!.event_hash }], 'head_hash mismatch'],
    ];
    for (const [cps, reason] of cases) {
      const r = verifyCheckpoints(sha, c, cps, 'q', verify);
      expect(
        r.results.some((x) => x.status === 'invalid' && x.reason === reason),
        reason,
      ).toBe(true);
    }
  });

  it('a checkpoint signed with an unavailable key is unverifiable — never valid', () => {
    const c = chain(4);
    const r = verifyCheckpoints(sha, c, [{ ...cp(c, 1, 4), key_id: 'other' }], 'q', verify);
    expect(r.results[0]).toMatchObject({ status: 'unverifiable' });
    expect(r.covered_to).toBe(0);
  });

  it('a checkpoint moved to another session does not verify (session id is signed)', () => {
    const c = chain(4);
    expect(
      verifyCheckpoints(sha, c, [cp(c, 1, 4)], 'other-session', verify).results[0]?.status,
    ).toBe('invalid');
  });
});
