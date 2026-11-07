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
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionEnded, setSessionEnded] = useState(false);

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
    } finally {
      setSessionEnded(false);
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      sessionEnded,
      setUser: (u: SessionUser | null): void => {
        if (u) setSessionEnded(false);
        setUser(u);
      },
      logout,
    }),
    [user, loading, sessionEnded, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
