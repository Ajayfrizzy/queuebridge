import { useEffect, type ReactElement } from 'react';
import { useAuth } from '../auth.js';
import type { api } from '../lib/api.js';
import type { LoadState } from '../lib/useLoad.js';
import './facility-loading.css';

type Facilities = Awaited<ReturnType<typeof api.listFacilities>>;
type Identity = NonNullable<ReturnType<typeof useAuth>['user']>;

// Each login (including a repeat login by the same person) receives a new identity object.
const previous = new WeakMap<Identity, Facilities>();

const identities = new WeakMap<Identity, number>();
let nextIdentity = 0;

export function useFacilitySessionKey(): number {
  const { user } = useAuth();
  if (!user) return 0;
  const existing = identities.get(user);
  if (existing !== undefined) return existing;
  const key = ++nextIdentity;
  identities.set(user, key);
  return key;
}

export function useFacilityPreview(
  load: LoadState<Facilities>,
  offline = false,
): Facilities | null {
  const { user } = useAuth();
  useEffect(() => {
    if (!user) return;
    if (load.error) previous.delete(user);
    else if (load.data && !offline && !load.loading) previous.set(user, load.data);
  }, [user, load.error, load.data, load.loading, offline]);
  if (!user || load.error) return null;
  return load.data ?? (load.loading ? (previous.get(user) ?? null) : null);
}

export function FacilityLoading({
  what,
  updating = false,
}: {
  what: string;
  updating?: boolean;
}): ReactElement {
  return (
    <div role="status" className="facility-loading muted">
      <span className="facility-spinner" aria-hidden="true" />
      {updating ? 'Updating' : 'Loading'} {what}…
      {!updating && <div className="facility-placeholder" aria-hidden="true" />}
    </div>
  );
}
