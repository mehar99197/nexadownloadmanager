import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import api, { unwrap, setAccessToken, clearAccessToken, restoreSession } from '../api/client';

const AuthContext = createContext(null);

const SESSION_HINT = 'ndm_session';

function hasSessionHint() {
  try {
    return document.cookie.split(';').some((c) => c.trim().startsWith(`${SESSION_HINT}=`));
  } catch {
    return true;   // no cookie access (odd embed) — fall back to asking the server
  }
}

function clearSessionHint() {
  try {
    document.cookie = `${SESSION_HINT}=; Max-Age=0; path=/`;
  } catch {
    // nothing to clear
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const setToken = (token) => {
    if (token) setAccessToken(token);
    else clearAccessToken();
  };

  // GET /api/user/me → profile + subscription. Returns the user or throws.
  const refreshMe = useCallback(async () => {
    const res = await api.get('/user/me');
    const data = unwrap(res);
    // Backend returns profile + subscription; keep the whole payload around,
    // but expose the user object at the top level for convenience.
    const me = data?.user ? { ...data.user, subscription: data.subscription } : data;
    setUser(me);
    return me;
  }, []);

  // The httpOnly refresh cookie rehydrates the in-memory access token on mount.
  // The backend also sets a readable "ndm_session" marker beside it, so a
  // visitor who never signed in is not greeted by a 401 + a failed refresh on
  // every page load. No marker → no session → skip the round trips.
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      if (!hasSessionHint()) {
        setLoading(false);
        return;
      }
      try {
        // Refresh first, then /user/me — the access token only lives in memory,
        // so every full page load would otherwise open with a 401.
        if (!(await restoreSession())) throw new Error('no session');
        await refreshMe();
      } catch {
        setToken(null);
        clearSessionHint();
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    init();
    return () => {
      cancelled = true;
    };
  }, [refreshMe]);

  const login = useCallback(
    async (email, password) => {
      const res = await api.post('/auth/login', { email, password });
      const data = unwrap(res);
      if (!data?.token) {
        throw new Error('No token returned from login.');
      }
      setToken(data.token);
      return refreshMe();
    },
    [refreshMe]
  );

  const register = useCallback(async ({ name, email, password, turnstileToken }) => {
    const res = await api.post('/auth/register', {
      name, email, password, ...(turnstileToken ? { turnstileToken } : {}),
    });
    return unwrap(res);
  }, []);

  /**
   * "Continue with Google". `credential` is the ID token from Google Identity
   * Services; the backend verifies it against Google's public keys, creates or
   * links the account, and returns the same session a password login does.
   * Resolves the user plus `created` so the caller can tell a first sign-up from
   * a returning sign-in.
   */
  const loginWithGoogle = useCallback(
    async (credential) => {
      const res = await api.post('/auth/google', { credential });
      const data = unwrap(res);
      if (!data?.token) throw new Error('No token returned from Google sign-in.');
      setToken(data.token);
      const me = await refreshMe();
      return { user: me, created: Boolean(data.created) };
    },
    [refreshMe]
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // ignore network/logout errors — we clear locally regardless
    }
    setToken(null);
    clearSessionHint();
    setUser(null);
  }, []);

  const value = {
    user,
    loading,
    isAuthenticated: !!user,
    login,
    loginWithGoogle,
    register,
    logout,
    refreshMe,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

export default AuthContext;
