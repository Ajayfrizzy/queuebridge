import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { SessionUser } from '@queuebridge/contracts';
import { api, ApiRequestError, setSessionObserver, setUnauthenticatedHandler } from './lib/api.js';
import { offlineDb } from './offline/idb.js';
import { forgetIdentity, loadIdentity, saveIdentity } from './offline/identity.js';
import { queHelp } from './que/index.js';

/** Ask Que restricted help is never allowed to break sign-in or sign-out (MQ.2). */
const purgeQueHelp = (): Promise<void> => queHelp.purgeAll().catch(() => undefined);

interface AuthState {
  user: SessionUser | null;
  /** True until the first /auth/me round-trip completes. */
  loading: boolean;
  /** True when a previously signed-in session was ended by the server (revoked/deactivated/expired). */
  sessionEnded: boolean;
  setUser: (user: SessionUser | null) => void;
  /**
   * True while the user is shown from the minimal cached identity because the server cannot be
   * reached. The session is re-verified as soon as the server answers.
   */
  offlineIdentity: boolean;
  /**
   * Ends the server session. Resolves only after the server CONFIRMS invalidation (or reports
   * that no session exists). On any other failure it rejects and the user stays signed in.
   *
   * `afterConfirmed` runs once the sign-out is confirmed and local data is erased, and BEFORE
   * the user state is cleared. The caller navigates home there, so the browser URL has already
   * left the protected page by the time any route guard sees "no user" (M5.0: a guard that won
   * that race left a blank protected URL after Back).
   */
  logout: (afterConfirmed?: () => void) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [offlineIdentity, setOfflineIdentity] = useState(false);
  const [sessionExpiry, setSessionExpiry] = useState<string | null>(null);

  // Only the signed-in user's data may be written to the offline cache. Assigned during render
  // (idempotent) rather than in an effect, because child effects run before this provider's.
  offlineDb.setActiveUser(user?.id ?? null);

  // Remember the server-reported session end so the offline identity cannot outlive it
  useEffect(() => {
    setSessionObserver(setSessionExpiry);
    return (): void => setSessionObserver(null);
  }, []);

  useEffect(() => {
    if (user && sessionExpiry && !offlineIdentity) {
      void saveIdentity(user, sessionExpiry).catch(() => undefined);
    }
  }, [user, sessionExpiry, offlineIdentity]);

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((r) => {
        if (!cancelled) setUser(r.user);
      })
      .catch(async (e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiRequestError && e.status === 0) {
          // Server unreachable: reopen from the minimal cached identity if it is still valid
          const cached = await loadIdentity();
          if (!cancelled && cached) {
            setUser(cached);
            setOfflineIdentity(true);
          }
          return;
        }
        // 401 simply means "signed out"; anything else also leaves the user signed out
        if (!(e instanceof ApiRequestError)) setUser(null);
        // Nobody is signed in here: no restricted help may remain on the device (REQ-F13.3.9)
        if (e instanceof ApiRequestError && e.status === 401) void purgeQueHelp();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  // Ask Que restricted help (MQ.2, design §11.5.3): every confirmed session (sign-in, /auth/me
  // with possibly changed roles) removes other users' help and, online, revalidates this user's
  // bundle before it can be shown. Offline, the cached bundle follows its expiry rules.
  useEffect(() => {
    if (!user) return;
    void queHelp.signedIn(user.id, !offlineIdentity).catch(() => undefined);
  }, [user, offlineIdentity]);

  // While showing a cached identity, keep trying to verify the real session
  useEffect(() => {
    if (!offlineIdentity) return undefined;
    const timer = setInterval(() => {
      api
        .me()
        .then((r) => {
          setUser(r.user);
          setOfflineIdentity(false);
        })
        .catch((e: unknown) => {
          if (e instanceof ApiRequestError && e.status === 401) {
            // Session ended while we were away: drop cached data, keep unsent actions
            setOfflineIdentity(false);
            setSessionEnded(true);
            setUser(null);
            void forgetIdentity();
            void offlineDb.clearSensitive({ discardOutboxOf: null }).catch(() => undefined);
            void purgeQueHelp();
          }
        });
    }, 3000);
    return (): void => clearInterval(timer);
  }, [offlineIdentity]);

  // Any 401 on an authenticated call means the server ended this session: leave the app cleanly
  useEffect(() => {
    setUnauthenticatedHandler(() => {
      setUser((current) => {
        if (current) setSessionEnded(true);
        return null;
      });
      // The server ended the session: erase cached data, but keep unsent actions so the same
      // user can still sync them after signing in again
      offlineDb.setActiveUser(null);
      void forgetIdentity();
      void offlineDb.clearSensitive({ discardOutboxOf: null }).catch(() => undefined);
      void purgeQueHelp();
    });
    return (): void => setUnauthenticatedHandler(null);
  }, []);

  const logout = useCallback(
    async (afterConfirmed?: () => void): Promise<void> => {
      try {
        await api.logout();
      } catch (e) {
        // 401 = the server has no such session: it is already invalid, so signing out is true.
        // Anything else (network failure, 5xx, 403/CSRF) is NOT confirmation: stay signed in.
        if (!(e instanceof ApiRequestError && e.status === 401)) throw e;
      }
      // Confirmed sign-out: erase everything cached on this device (the UI has already made the
      // person sync or explicitly discard unsent actions). Stop accepting cache writes first.
      offlineDb.setActiveUser(null);
      if (user) await offlineDb.clearSensitive({ discardOutboxOf: user.id }).catch(() => undefined);
      await forgetIdentity();
      await purgeQueHelp();
      afterConfirmed?.();
      setSessionEnded(false);
      setUser(null);
      setOfflineIdentity(false);
    },
    [user],
  );

  const value = useMemo(
    () => ({
      user,
      loading,
      sessionEnded,
      offlineIdentity,
      setUser: (u: SessionUser | null): void => {
        if (u) setSessionEnded(false);
        setUser(u);
      },
      logout,
    }),
    [user, loading, sessionEnded, offlineIdentity, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
