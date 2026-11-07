import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError } from './api.js';

export interface LoadState<T> {
  data: T | null;
  error: ApiRequestError | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * Load data on mount / when `key` changes, exposing a manual reload.
 *
 * Only the most recently STARTED load for the CURRENT key may update state:
 *  - overlapping loads (e.g. two quick reloads): a slower, older response can never overwrite
 *    a newer one, whether it succeeds or fails;
 *  - key changes: the previous resource's data is cleared immediately and any response (or a
 *    `reload` captured from the old key) for the old key is ignored;
 *  - unmount: late responses are dropped.
 */
export function useLoad<T>(fn: () => Promise<T>, key: string): LoadState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [loading, setLoading] = useState(true);

  const generation = useRef(0);
  const currentKey = useRef(key);
  const mounted = useRef(true);

  const run = useCallback(async (): Promise<void> => {
    // A reload captured under an older key must not touch the new key's state
    if (currentKey.current !== key || !mounted.current) return;
    const mine = ++generation.current;
    const isCurrent = (): boolean =>
      mounted.current && generation.current === mine && currentKey.current === key;
    try {
      const result = await fn();
      if (!isCurrent()) return;
      setData(result);
      setError(null);
    } catch (e) {
      if (!isCurrent()) return;
      setError(e instanceof ApiRequestError ? e : new ApiRequestError(0, null, 'Unexpected error'));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    mounted.current = true;
    // New resource: invalidate everything in flight and drop the previous resource's data
    currentKey.current = key;
    generation.current += 1;
    setData(null);
    setError(null);
    setLoading(true);
    void run();
    return (): void => {
      mounted.current = false;
    };
  }, [key, run]);

  return { data, error, loading, reload: run };
}
