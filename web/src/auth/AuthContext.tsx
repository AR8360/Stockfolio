import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { api, tokenStore, type AuthResult, type User } from '../api/client';

/**
 * The one genuinely cross-cutting piece of client state (ASSUMPTIONS.md #28).
 * Everything else is page-local, so there is no global store.
 */

interface AuthValue {
  user: User | null;
  /** Distinguishes "not logged in" from "we have a token and are still
   *  checking it" — without it, a refresh flashes the login page for a moment
   *  before the session is confirmed. */
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (tokenStore.get() === null) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    api<User>('/api/auth/me', { signal: controller.signal })
      .then(setUser)
      .catch(() => {
        // Expired or revoked — the token is 7-day and cannot be revoked
        // server-side (ASSUMPTIONS.md #26), so clearing it here is the only
        // cleanup there is.
        tokenStore.clear();
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, []);

  const apply = useCallback((result: AuthResult) => {
    tokenStore.set(result.token);
    setUser(result.user);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      loading,
      login: async (email, password) => {
        apply(await api<AuthResult>('/api/auth/login', { method: 'POST', body: { email, password } }));
      },
      register: async (email, password, name) => {
        apply(await api<AuthResult>('/api/auth/register', { method: 'POST', body: { email, password, name } }));
      },
      logout: () => {
        tokenStore.clear();
        setUser(null);
      },
    }),
    [user, loading, apply],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth used outside AuthProvider');
  return context;
}

/** Route guard. Remembers where the user was heading so login can send them
 *  back there instead of dumping them on the home page. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <div className="empty">Checking your session…</div>;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <>{children}</>;
}
