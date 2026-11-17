import { describe, expect, it } from 'vitest';
import {
  PageClock,
  ROLLBACK_TOLERANCE_MS,
  SAFETY_MARGIN_MS,
  evaluateBundle,
  knownParam,
  mergeResponse,
  type CachedRestrictedBundle,
} from './offlineHelp.js';
import { art, response } from './fixtures.testkit.js';

const H = 3600_000;

function record(
  receivedAt: number,
  over: Partial<CachedRestrictedBundle> = {},
): CachedRestrictedBundle {
  const r = mergeResponse(null, response(), receivedAt)!;
  return { ...r, ...over };
}

describe('evaluateBundle: elapsed time since receipt (design §11.5.2)', () => {
  const T = 1_800_000_000_000;

  it('missing record is "missing"', () => {
    expect(evaluateBundle(null, T, false).state).toBe('missing');
    expect(evaluateBundle(undefined, T, false).state).toBe('missing');
  });

  it('valid until validForMs minus the safety margin, then expired', () => {
    const r = record(T);
    expect(evaluateBundle(r, T, false).state).toBe('valid');
    expect(evaluateBundle(r, T + 12 * H - SAFETY_MARGIN_MS - 1, false).state).toBe('valid');
    expect(evaluateBundle(r, T + 12 * H - SAFETY_MARGIN_MS, false).state).toBe('expired');
    expect(evaluateBundle(r, T + 48 * H, false).state).toBe('expired');
  });

  it('a device clock that is simply wrong (ahead or behind the server) has no effect', () => {
    // The server issued the bundle in 2020; the device clock says 2027 (or 1999). Only the
    // elapsed device time since receipt matters.
    for (const deviceNow of [Date.UTC(2027, 0, 1), Date.UTC(1999, 0, 1)]) {
      const r = record(deviceNow);
      expect(evaluateBundle(r, deviceNow + H, false).state).toBe('valid');
      expect(evaluateBundle(r, deviceNow + 13 * H, false).state).toBe('expired');
    }
  });

  it('advances and persists the high-water mark', () => {
    const r = record(T);
    const { persist } = evaluateBundle(r, T + H, false);
    expect(persist?.highWaterLocalMs).toBe(T + H);
    expect(evaluateBundle({ ...r, highWaterLocalMs: T + H }, T + H, false).persist).toBeNull();
  });

  it('clock moved backwards beyond the tolerance: unverifiable, and it sticks', () => {
    const r = record(T, { highWaterLocalMs: T + 2 * H });
    const back = evaluateBundle(r, T + 2 * H - ROLLBACK_TOLERANCE_MS - 1, false);
    expect(back.state).toBe('unverifiable');
    expect(back.persist?.unverifiable).toBe(true);
    // Moving the clock forward again does not bring the help back
    expect(evaluateBundle(back.persist, T + 3 * H, false).state).toBe('unverifiable');
  });

  it('a small backwards correction within the tolerance is accepted', () => {
    const r = record(T, { highWaterLocalMs: T + H });
    expect(evaluateBundle(r, T + H - ROLLBACK_TOLERANCE_MS + 1000, false).state).toBe('valid');
  });

  it('before the receipt time (rollback across a restart) is unverifiable', () => {
    expect(evaluateBundle(record(T), T - 10, false).state).toBe('unverifiable');
  });

  it('a wall-clock / monotonic disagreement in this page is unverifiable', () => {
    const v = evaluateBundle(record(T), T + H, true);
    expect(v.state).toBe('unverifiable');
    expect(v.persist?.unverifiable).toBe(true);
  });

  it.each([
    ['no clock metadata', { receivedAtLocalMs: undefined }],
    ['a non-numeric receipt time', { receivedAtLocalMs: 'yesterday' }],
    ['a high-water mark before receipt', { highWaterLocalMs: 0 }],
    ['a negative validity', { validForMs: -1 }],
    ['an infinite validity', { validForMs: Number.POSITIVE_INFINITY }],
    ['a missing fingerprint', { roleDigest: undefined }],
    ['a malformed fingerprint', { roleDigest: 'xyz' }],
    ['no articles array', { articles: 'all' }],
    ['no user', { userId: '' }],
  ])('treats %s as expired', (_l, over) => {
    const r = { ...record(T), ...over } as unknown;
    const v = evaluateBundle(r, T + 1, false);
    expect(v.state).toBe('expired');
    expect(v.persist).toBeNull();
  });
});

describe('PageClock (monotonic cross-check)', () => {
  it('detects a wall-clock jump relative to the monotonic clock', () => {
    let wall = 1_000_000;
    let mono = 0;
    const c = new PageClock(
      () => wall,
      () => mono,
    );
    wall += 60_000;
    mono += 60_000;
    expect(c.jumped()).toBe(false);
    wall -= 10 * 60_000; // user sets the clock back ten minutes
    expect(c.jumped()).toBe(true);
    wall += 20 * 60_000; // ... or forward
    expect(c.jumped()).toBe(true);
  });
});

describe('mergeResponse and knownParam (incremental update)', () => {
  const T = 1_800_000_000_000;

  it('builds the known list from the cached articles', () => {
    expect(knownParam(record(T))).toBe('staff.a.one:1,staff.b.two:1');
    expect(knownParam(null)).toBeUndefined();
  });

  it('reuses cached articles the server did not resend (same id and version)', () => {
    const prev = record(T);
    const delta = response({
      articles: [],
      index: prev.articles.map((a) => ({ id: a.id, version: a.version })),
    });
    const merged = mergeResponse(prev, delta, T + 5)!;
    expect(merged.articles.map((a) => a.id)).toEqual(['staff.a.one', 'staff.b.two']);
    expect(merged.receivedAtLocalMs).toBe(T + 5);
  });

  it('replaces changed articles and drops removed ones', () => {
    const prev = record(T);
    const delta = response({
      articles: [art('staff.b.two', 2)],
      index: [{ id: 'staff.b.two', version: 2 }],
    });
    const merged = mergeResponse(prev, delta, T)!;
    expect(merged.articles).toEqual([art('staff.b.two', 2)]);
  });

  it('never reuses another fingerprint’s articles: a delta becomes incomplete', () => {
    const prev = record(T);
    const delta = response({
      roleDigest: 'b'.repeat(64),
      articles: [],
      index: prev.articles.map((a) => ({ id: a.id, version: a.version })),
    });
    expect(mergeResponse(prev, delta, T)).toBeNull();
    expect(
      mergeResponse(
        { ...prev, userId: 'someone-else' },
        response({ articles: [], index: delta.index }),
        T,
      ),
    ).toBeNull();
    expect(
      mergeResponse(
        { ...prev, unverifiable: true },
        response({ articles: [], index: delta.index }),
        T,
      ),
    ).toBeNull();
  });

  it('a cached article at another version is not reused', () => {
    const prev = record(T);
    const delta = response({ articles: [], index: [{ id: 'staff.a.one', version: 2 }] });
    expect(mergeResponse(prev, delta, T)).toBeNull();
  });
});
