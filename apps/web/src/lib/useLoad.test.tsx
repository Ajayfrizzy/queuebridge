// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from './api.js';
import { useLoad, type LoadState } from './useLoad.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;
let latest: LoadState<string>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  errorSpy.mockRestore();
});

function Probe({ k, fetcher }: { k: string; fetcher: () => Promise<string> }): ReactElement {
  latest = useLoad(fetcher, k);
  return <span>{latest.data ?? 'none'}</span>;
}
const render = async (k: string, fetcher: () => Promise<string>): Promise<void> => {
  await act(async () => root.render(<Probe k={k} fetcher={fetcher} />));
};
const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe('useLoad', () => {
  it('loads data and reports loading → loaded', async () => {
    const d = deferred<string>();
    await render('a', () => d.promise);
    expect(latest.loading).toBe(true);
    await act(async () => d.resolve('A'));
    expect(latest).toMatchObject({ data: 'A', loading: false, error: null });
  });

  it('an older reload that finishes last never overwrites a newer result', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const third = deferred<string>();
    const queue = [first, second, third];
    await render('a', () => (queue.shift() as Deferred<string>).promise);
    await act(async () => first.resolve('initial'));

    let r1!: Promise<void>;
    let r2!: Promise<void>;
    await act(async () => {
      r1 = latest.reload(); // slow: uses `second`
      r2 = latest.reload(); // fast: uses `third`
    });
    await act(async () => third.resolve('newest'));
    await r2;
    expect(latest.data).toBe('newest');
    await act(async () => second.resolve('stale'));
    await r1;
    expect(latest.data).toBe('newest');
  });

  it('a stale failure cannot replace newer data with an error', async () => {
    const d0 = deferred<string>();
    const slowFail = deferred<string>();
    const fast = deferred<string>();
    const queue = [d0, slowFail, fast];
    await render('a', () => (queue.shift() as Deferred<string>).promise);
    await act(async () => d0.resolve('initial'));
    await act(async () => {
      void latest.reload();
      void latest.reload();
    });
    await act(async () => fast.resolve('good'));
    await act(async () => slowFail.reject(new ApiRequestError(500, null, 'boom')));
    expect(latest).toMatchObject({ data: 'good', error: null, loading: false });
  });

  it('changing the key clears the old resource and ignores its late response', async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    await render('a', () => a.promise);
    await render('b', () => b.promise);
    expect(latest).toMatchObject({ data: null, loading: true });

    await act(async () => b.resolve('B'));
    expect(latest.data).toBe('B');
    await act(async () => a.resolve('A-late'));
    expect(latest).toMatchObject({ data: 'B', loading: false, error: null });
  });

  it('never shows the previous key’s data while the new key is loading', async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    await render('a', () => a.promise);
    await act(async () => a.resolve('A'));
    expect(latest.data).toBe('A');
    await render('b', () => b.promise);
    expect(latest.data).toBeNull();
    expect(container.textContent).toBe('none');
  });

  it('a reload captured under the old key is a no-op for the new key', async () => {
    const a0 = deferred<string>();
    const b0 = deferred<string>();
    const a1 = vi.fn(() => Promise.resolve('A-reloaded'));
    let n = 0;
    await render('a', () => (n++ === 0 ? a0.promise : a1()));
    await act(async () => a0.resolve('A'));
    const oldReload = latest.reload;
    await render('b', () => b0.promise);
    await act(async () => {
      await oldReload();
    });
    expect(a1).not.toHaveBeenCalled();
    await act(async () => b0.resolve('B'));
    expect(latest.data).toBe('B');
  });

  it('an old-key failure does not surface on the new key', async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    await render('a', () => a.promise);
    await render('b', () => b.promise);
    await act(async () => a.reject(new ApiRequestError(404, null, 'gone')));
    expect(latest.error).toBeNull();
    expect(latest.loading).toBe(true);
    await act(async () => b.resolve('B'));
    expect(latest).toMatchObject({ data: 'B', error: null });
  });

  it('responses arriving after unmount are dropped without React warnings', async () => {
    const d = deferred<string>();
    await render('a', () => d.promise);
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => d.resolve('late'));
    await settle();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('surfaces errors for the current request', async () => {
    const d = deferred<string>();
    await render('a', () => d.promise);
    await act(async () => d.reject(new ApiRequestError(403, null, 'nope')));
    expect(latest.error?.status).toBe(403);
    expect(latest.loading).toBe(false);
  });
});
