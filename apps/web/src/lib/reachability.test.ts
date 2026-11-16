// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setNetworkObserver } from './api.js';

/**
 * M5.0: which signals may change what the app believes about server reachability?
 *
 * The belief drives a real decision: a staff action taken while the app believes it is online
 * goes to the server; while it believes it is offline it is captured locally. Rules:
 *  - negative signals (browser `offline`, network failure) take effect at once;
 *  - restoring "reachable" needs a `/health` probe sent and answered within the current outage
 *    epoch while the browser is online; ordinary responses never restore it themselves.
 */

interface Gate {
  resolve: (r: Response) => void;
  promise: Promise<Response>;
}
function gate(): Gate {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { resolve, promise };
}
const okJson = (): Response =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
const okHealth = (): Response => new Response('ok', { status: 200 });
const setOnLine = (v: boolean): void => {
  Object.defineProperty(window.navigator, 'onLine', { value: v, configurable: true });
};
const goOffline = (): void => {
  setOnLine(false);
  window.dispatchEvent(new Event('offline'));
};
const urlOf = (a: unknown): string => String(a instanceof Request ? a.url : a);

let reports: boolean[];
beforeEach(async () => {
  // Start every case from a validated "reachable" state (module state is shared between tests)
  setOnLine(true);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(okHealth())),
  );
  await api.ping();
  vi.unstubAllGlobals();
  reports = [];
  setNetworkObserver((r) => reports.push(r));
});
afterEach(() => {
  setNetworkObserver(null);
  vi.unstubAllGlobals();
  setOnLine(true);
});

describe('negative signals take effect at once', () => {
  it('the browser `offline` event reports unreachable', () => {
    goOffline();
    expect(reports).toEqual([false]);
  });

  it('a network failure reports unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await api.me().catch(() => undefined);
    expect(reports).toEqual([false]);
  });

  it('a failing health probe reports unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('no', { status: 503 }))),
    );
    await expect(api.ping()).resolves.toBe(false);
    expect(reports).toEqual([false]);
  });
});

describe('restoring reachability requires server health validation', () => {
  it('a response to a request sent before the outage never restores reachability (original M5.0 defect)', async () => {
    const g = gate();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => g.promise),
    );
    const call = api.me().catch(() => undefined); // sent while online
    goOffline(); // the network drops while it is in flight
    g.resolve(okJson()); // the stale success lands
    await call;
    expect(reports).toEqual([false]);
  });

  it('... not even after the browser reports `online` again before it lands', async () => {
    const g = gate();
    const fetchMock = vi.fn((a: unknown) =>
      urlOf(a).endsWith('/health') ? new Promise<Response>(() => undefined) : g.promise,
    );
    vi.stubGlobal('fetch', fetchMock);
    const call = api.me().catch(() => undefined);
    goOffline();
    setOnLine(true); // browser says online, but no probe has answered yet
    g.resolve(okJson());
    await call;
    expect(reports).toEqual([false]);
  });

  it('after an outage an ordinary success does not restore reachability; it triggers a probe that does', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await api.me().catch(() => undefined); // server unreachable (browser still online)
    const fetchMock = vi.fn((a: unknown) =>
      Promise.resolve(urlOf(a).endsWith('/health') ? okHealth() : okJson()),
    );
    vi.stubGlobal('fetch', fetchMock);
    await api.me();
    await vi.waitFor(() => expect(reports).toEqual([false, true]));
    expect(fetchMock.mock.calls.map((c) => urlOf(c[0]))).toEqual(
      expect.arrayContaining([expect.stringMatching(/\/health$/)]),
    );
  });

  it('a probe that was in flight when an outage began does not count', async () => {
    const g = gate();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => g.promise),
    );
    const probe = api.ping();
    goOffline();
    setOnLine(true);
    g.resolve(okHealth());
    await expect(probe).resolves.toBe(false);
    expect(reports).toEqual([false]);
  });

  it('a probe answered while the browser reports offline does not count', async () => {
    goOffline();
    reports = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(okHealth())),
    );
    await expect(api.ping()).resolves.toBe(false);
    expect(reports).toEqual([]);
  });

  it('a probe sent and answered after the outage, while online, restores reachability', async () => {
    goOffline();
    setOnLine(true);
    reports = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(okHealth())),
    );
    await expect(api.ping()).resolves.toBe(true);
    expect(reports).toEqual([true]);
  });

  it('while reachable, ordinary successes change nothing and trigger no probe', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okJson()));
    vi.stubGlobal('fetch', fetchMock);
    await api.me();
    expect(reports).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
