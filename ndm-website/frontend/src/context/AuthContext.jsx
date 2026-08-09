import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import api, { unwrap, setAccessToken, clearAccessToken } from '../api/client';

const AuthContext = createContext(null);

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
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        await refreshMe();
      } catch {
        setToken(null);
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

  const register = useCallback(async ({ name, email, password }) => {
    const res = await api.post('/auth/register', { name, email, password });
    return unwrap(res);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // ignore network/logout errors — we clear locally regardless
    }
    setToken(null);
    setUser(null);
  }, []);

  const value = {
    user,
    loading,
    isAuthenticated: !!user,
    login,
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
