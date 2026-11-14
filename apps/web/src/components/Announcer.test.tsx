// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnouncerProvider, MESSAGE_GAP_MS, useAnnounce, type Announce } from './Announcer.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let say: Announce = () => undefined;

function Probe(): ReactElement {
  say = useAnnounce();
  return <p>page</p>;
}
const region = (id: string): string =>
  (container.querySelector(`[data-testid="${id}"]`)?.textContent ?? '').trim();

/** Every distinct non-empty text a region ever held (what a screen reader is given, in order). */
function record(id: string, sink: string[]): MutationObserver {
  const el = container.querySelector(`[data-testid="${id}"]`) as Node;
  let cleared = true;
  const o = new MutationObserver(() => {
    const t = (el.textContent ?? '').trim();
    if (!t) {
      cleared = true;
      return;
    }
    // a new entry is a different text, or the same text written again after the region emptied
    if (cleared || sink[sink.length - 1] !== t) sink.push(t);
    cleared = false;
  });
  o.observe(el, { childList: true, characterData: true, subtree: true });
  return o;
}

beforeEach(async () => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <AnnouncerProvider>
        <Probe />
      </AnnouncerProvider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('announcer scheduling (11.A3)', () => {
  it('both live regions exist and are empty before anything is said', () => {
    expect(container.querySelector('[data-testid="status"]')?.getAttribute('aria-live')).toBe(
      'polite',
    );
    expect(
      container.querySelector('[data-testid="status-assertive"]')?.getAttribute('aria-live'),
    ).toBe('assertive');
    expect(region('status')).toBe('');
    expect(region('status-assertive')).toBe('');
  });

  it('two DIFFERENT messages in the same instant are both written, in order (none is lost)', async () => {
    const seen: string[] = [];
    const o = record('status', seen);
    await act(async () => {
      say('You are offline. Actions are saved on this device and are not confirmed yet.');
      say('2 actions need a supervisor to review. Needs review.');
    });
    await act(async () => void vi.advanceTimersByTime(1000));
    o.disconnect();
    expect(seen).toEqual([
      'You are offline. Actions are saved on this device and are not confirmed yet.',
      '2 actions need a supervisor to review. Needs review.',
    ]);
  });

  it('a message is never cancelled by one arriving within 30 ms of it', async () => {
    const seen: string[] = [];
    const o = record('status', seen);
    await act(async () => say('First'));
    await act(async () => void vi.advanceTimersByTime(10));
    await act(async () => say('Second'));
    await act(async () => void vi.advanceTimersByTime(1000));
    o.disconnect();
    expect(seen).toEqual(['First', 'Second']);
  });

  it('assertive messages use their own region and are not displaced by polite ones', async () => {
    await act(async () => {
      say('It is your turn. Please go to Counter 1 now.', { assertive: true });
      say('You are now number 2 in line, 1 ahead of you.');
    });
    await act(async () => void vi.advanceTimersByTime(1000));
    expect(region('status-assertive')).toBe('It is your turn. Please go to Counter 1 now.');
    expect(region('status')).toBe('You are now number 2 in line, 1 ahead of you.');
  });

  it('a burst keeps every distinct message in order, spaced so each can be taken in', async () => {
    const seen: string[] = [];
    const o = record('status', seen);
    await act(async () => {
      for (const m of ['A', 'B', 'C']) say(m);
    });
    await act(async () => void vi.advanceTimersByTime(100));
    expect(seen).toEqual(['A']); // the others wait their turn, none is dropped
    await act(async () => void vi.advanceTimersByTime(MESSAGE_GAP_MS));
    expect(seen).toEqual(['A', 'B']);
    await act(async () => void vi.advanceTimersByTime(MESSAGE_GAP_MS));
    o.disconnect();
    expect(seen).toEqual(['A', 'B', 'C']);
  });

  it('a repeated identical message is dropped inside 2 s, and announced again after', async () => {
    const seen: string[] = [];
    const o = record('status', seen);
    await act(async () => say('Back online.'));
    await act(async () => void vi.advanceTimersByTime(500));
    await act(async () => say('Back online.'));
    await act(async () => void vi.advanceTimersByTime(1000));
    expect(seen).toEqual(['Back online.']);
    await act(async () => void vi.advanceTimersByTime(2500));
    await act(async () => say('Back online.'));
    await act(async () => void vi.advanceTimersByTime(1000));
    o.disconnect();
    // the same words after the dedupe window are re-announced (cleared, then written again)
    expect(seen).toEqual(['Back online.', 'Back online.']);
  });

  it('the position stream is throttled while a different important message still goes through', async () => {
    const seen: string[] = [];
    const o = record('status', seen);
    const pos = { throttleKey: 'position', throttleMs: 15_000 };
    await act(async () => say('You are now number 4 in line, 3 ahead of you.', pos));
    await act(async () => say('You are now number 3 in line, 2 ahead of you.', pos));
    await act(async () =>
      say('You are offline. Actions are saved on this device and are not confirmed yet.'),
    );
    await act(async () => void vi.advanceTimersByTime(1000));
    o.disconnect();
    expect(seen).toEqual([
      'You are now number 4 in line, 3 ahead of you.',
      'You are offline. Actions are saved on this device and are not confirmed yet.',
    ]);
  });
});
