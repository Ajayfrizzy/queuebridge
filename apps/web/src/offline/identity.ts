import type { SessionUser } from '@queuebridge/contracts';
import { offlineDb } from './idb.js';

/**
 * Minimal staff identity kept so the PWA can reopen offline. Deliberately omits the email
 * address, and is only honoured until the server-reported session expiry — the offline UI
 * must not outlive the sign-in it came from.
 */
interface CachedIdentity {
  id: string;
  display_name: string;
  organization: SessionUser['organization'];
  roles: SessionUser['roles'];
  session_expires_at: string;
}

const KEY = 'identity';

export async function saveIdentity(user: SessionUser, sessionExpiresAt: string): Promise<void> {
  const record: CachedIdentity = {
    id: user.id,
    display_name: user.display_name,
    organization: user.organization,
    roles: user.roles,
    session_expires_at: sessionExpiresAt,
  };
  // Single slot per device: the next sign-in replaces it, and sign-out/401 erase it
  await offlineDb.kvPut(KEY, record, null);
}

/** The cached identity, if the stored session has not expired on this device's clock. */
export async function loadIdentity(nowMs: number = Date.now()): Promise<SessionUser | null> {
  try {
    const rec = await offlineDb.kvGet<CachedIdentity>(KEY, null);
    if (!rec) return null;
    const v = rec.value;
    if (!(Date.parse(v.session_expires_at) > nowMs)) return null;
    return {
      id: v.id,
      email: '',
      display_name: v.display_name,
      organization: v.organization,
      roles: v.roles,
    };
  } catch {
    return null;
  }
}

export async function forgetIdentity(): Promise<void> {
  try {
    await offlineDb.kvDelete(KEY);
  } catch {
    /* nothing to forget */
  }
}
