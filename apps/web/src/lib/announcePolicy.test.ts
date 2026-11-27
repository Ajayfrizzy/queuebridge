import { describe, expect, it } from 'vitest';
import { createAnnouncePolicy, DEDUPE_MS, POSITION_THROTTLE_MS } from './announcePolicy.js';

describe('announcement policy (11.A3)', () => {
  it('drops an identical message inside 2 s and allows it again afterwards', () => {
    let t = 1000;
    const p = createAnnouncePolicy(() => t);
    expect(p.admit('Back online.')).toBe(true);
    t += DEDUPE_MS - 1;
    expect(p.admit('Back online.')).toBe(false);
    t += 2;
    expect(p.admit('Back online.')).toBe(true);
  });

  it('a different message is never swallowed by deduplication', () => {
    const p = createAnnouncePolicy(() => 5);
    expect(p.admit('A')).toBe(true);
    expect(p.admit('B')).toBe(true);
  });

  it('position announcements: at most one per 15 s, later ones skipped not queued', () => {
    let t = 0;
    const p = createAnnouncePolicy(() => t);
    const opts = { throttleKey: 'position', throttleMs: POSITION_THROTTLE_MS };
    expect(p.admit('You are number 5.', opts)).toBe(true);
    t += 3000;
    expect(p.admit('You are number 4.', opts)).toBe(false);
    t += 6000;
    expect(p.admit('You are number 3.', opts)).toBe(false);
    t += POSITION_THROTTLE_MS;
    expect(p.admit('You are number 2.', opts)).toBe(true);
  });

  it('a throttled stream does not throttle other messages', () => {
    const p = createAnnouncePolicy(() => 0);
    expect(p.admit('Position 3', { throttleKey: 'position' })).toBe(true);
    expect(p.admit('Your ticket is missed.')).toBe(true);
  });

  it('the called alert is assertive, never throttled, and still deduplicated', () => {
    let t = 0;
    const p = createAnnouncePolicy(() => t);
    expect(p.admit('Position', { throttleKey: 'position' })).toBe(true);
    expect(p.admit('It is your turn.', { assertive: true })).toBe(true);
    expect(p.admit('It is your turn.', { assertive: true })).toBe(false); // double render
    t += DEDUPE_MS + 1;
    expect(p.admit('It is your turn.', { assertive: true })).toBe(true);
  });

  it('the same words at different levels are separate messages', () => {
    const p = createAnnouncePolicy(() => 0);
    expect(p.admit('Saved.')).toBe(true);
    expect(p.admit('Saved.', { assertive: true })).toBe(true);
  });
});
