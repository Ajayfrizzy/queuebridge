import { useEffect, useSyncExternalStore } from 'react';

/**
 * Facility of the current screen when the URL does not carry it (MQ.3). The queue console
 * (`/staff/queues/:queueId`) knows its facility only from the data it loaded; it reports it
 * here so Ask Que can offer that facility's screens. The hint is bound to the path that set it
 * and is ignored anywhere else. It is a navigation hint only: whether a link is offered is
 * still decided by the permission map against the session's server-derived roles, and the API
 * authorizes every screen.
 */
interface Hint {
  pathname: string;
  facilityId: string;
}

let current: Hint | null = null;
const listeners = new Set<() => void>();

function set(next: Hint | null): void {
  current = next;
  for (const l of [...listeners]) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return (): void => {
    listeners.delete(l);
  };
}

/** Called by a screen that knows its facility. */
export function useQueFacilityHint(facilityId: string | null | undefined): void {
  useEffect(() => {
    if (!facilityId) return undefined;
    const pathname = window.location.pathname;
    set({ pathname, facilityId });
    return (): void => {
      if (current?.pathname === pathname) set(null);
    };
  }, [facilityId]);
}

/** The hinted facility for `pathname`, or null. */
export function useFacilityHintFor(pathname: string): string | null {
  const hint = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  return hint && hint.pathname === pathname ? hint.facilityId : null;
}
