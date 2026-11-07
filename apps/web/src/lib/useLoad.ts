import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError } from './api.js';

export interface LoadState<T> {
  data: T | null;
  error: ApiRequestError | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/** Load data on mount / when `key` changes, exposing a manual reload. */
export function useLoad<T>(fn: () => Promise<T>, key: string): LoadState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [loading, setLoading] = useState(true);

  const run = useCallback(async (): Promise<void> => {
    try {
      setData(await fn());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e : new ApiRequestError(0, null, 'Unexpected error'));
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    setLoading(true);
    void run();
  }, [run]);

  return { data, error, loading, reload: run };
}
