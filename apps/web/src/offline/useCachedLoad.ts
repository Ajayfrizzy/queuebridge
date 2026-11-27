import { useCallback, useState } from 'react';
import { useAuth } from '../auth.js';
import { ApiRequestError } from '../lib/api.js';
import { useLoad, type LoadState } from '../lib/useLoad.js';
import { offlineDb } from './idb.js';

/**
 * `useLoad` for authorized staff data that should survive a connectivity loss: a successful
 * load is cached (per signed-in user); if the server cannot be reached the last cached copy is
 * shown instead and flagged `fromCache`. Authorization errors (401/403/404) are never masked.
 */
export function useCachedLoad<T>(
  fn: () => Promise<T>,
  key: string,
): LoadState<T> & { fromCache: boolean } {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [fromCache, setFromCache] = useState(false);
  const wrapped = useCallback(async (): Promise<T> => {
    try {
      const data = await fn();
      setFromCache(false);
      if (userId) void offlineDb.kvPut(`cache:${key}`, data, userId).catch(() => undefined);
      return data;
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 0 && userId) {
        const hit = await offlineDb.kvGet<T>(`cache:${key}`, userId).catch(() => undefined);
        if (hit) {
          setFromCache(true);
          return hit.value;
        }
      }
      throw e;
    }
  }, [key, userId]);
  return { ...useLoad(wrapped, key), fromCache };
}
