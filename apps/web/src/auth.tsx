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
import { api, ApiRequestError, setUnauthenticatedHandler } from './lib/api.js';

interface AuthState {
  user: SessionUser | null;
  /** True until the first /auth/me round-trip completes. */
  loading: boolean;
  /** True when a previously signed-in session was ended by the server (revoked/deactivated/expired). */
  sessionEnded: boolean;
  setUser: (user: SessionUser | null) => void;
  /** True right after a confirmed, user-initiated sign out (so guards send them home, not to /login). */
  signedOut: boolean;
  /** Called once the post-sign-out landing page is shown. */
  acknowledgeSignedOut: () => void;
  /**
   * Ends the server session. Resolves only after the server CONFIRMS invalidation (or reports
   * that no session exists). On any other failure it rejects and the user stays signed in.
   */
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((r) => {
        if (!cancelled) setUser(r.user);
      })
      .catch((e: unknown) => {
        // 401 simply means "signed out"; anything else also leaves the user signed out
        if (!(e instanceof ApiRequestError) && !cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  // Any 401 on an authenticated call means the server ended this session: leave the app cleanly
  useEffect(() => {
    setUnauthenticatedHandler(() => {
      setUser((current) => {
        if (current) setSessionEnded(true);
        return null;
      });
    });
    return (): void => setUnauthenticatedHandler(null);
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await api.logout();
    } catch (e) {
      // 401 = the server has no such session: it is already invalid, so signing out is true.
      // Anything else (network failure, 5xx, 403/CSRF) is NOT confirmation: stay signed in.
      if (!(e instanceof ApiRequestError && e.status === 401)) throw e;
    }
    setSessionEnded(false);
    setSignedOut(true);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      sessionEnded,
      signedOut,
      acknowledgeSignedOut: (): void => setSignedOut(false),
      setUser: (u: SessionUser | null): void => {
        if (u) {
          setSessionEnded(false);
          setSignedOut(false);
        }
        setUser(u);
      },
      logout,
    }),
    [user, loading, sessionEnded, signedOut, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
