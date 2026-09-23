import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api, {
  setAdminAccessToken,
  clearAdminAccessToken,
  refreshAdminToken,
  unwrap,
  TWO_FACTOR_REQUIRED_EVENT,
  SESSION_ENDED_EVENT,
} from '../api/client.js';
import { AUTH_NS, IS_ROOT } from '../realm.js';

const AdminAuthContext = createContext(null);

/**
 * Control-panel auth state for the current realm (staff /admin or creator /root).
 *
 * The short-lived access token lives in memory only. On mount we call
 * `POST /api/<realm>/refresh` (httpOnly cookie) to rehydrate it, then load the
 * profile from `GET /api/<realm>/me`. Logout revokes the cookie server-side via
 * `POST /api/<realm>/logout`. The two realms use different cookies on different
 * paths, so a staff session and a creator session coexist without interfering.
 */
export function AdminAuthProvider({ children }) {
  const [token, setToken] = useState(null);
  const [admin, setAdmin] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    try {
      const me = await unwrap(api.get(`${AUTH_NS}/me`));
      setAdmin(me || null);
      return me;
    } catch {
      // Do NOT invent a profile here (AUDIT.md M-09). This used to set
      // { authenticated: true }, which said the opposite of what had just
      // happened and had a second cost: the placeholder carries no role, so
      // isRoot below computed false and the creator-only navigation vanished
      // for the actual creator. A 401 has already been turned into
      // SESSION_ENDED_EVENT by the interceptor; anything else is a blip, and
      // leaving the last known profile alone is the honest answer to it.
      return null;
    }
  }, []);

  // The server refused a request because this account has not enrolled in
  // two-factor authentication yet (ADMIN_2FA_REQUIRED). Normally /me already
  // says so; this catches the setting being switched on under a live session.
  useEffect(() => {
    const onRequired = () => setAdmin((a) => (a ? { ...a, twoFactorRequired: true, twoFactorEnabled: false } : a));
    window.addEventListener(TWO_FACTOR_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(TWO_FACTOR_REQUIRED_EVENT, onRequired);
  }, []);

  // The session is over and the module-level token has already gone. Clearing
  // the React token is what actually bounces the panel to /login, because
  // ProtectedAdminRoute gates on isAuthenticated — which is Boolean(token)
  // below, not on the variable inside api/client.js (AUDIT.md M-09).
  useEffect(() => {
    const onEnded = () => {
      setToken(null);
      setAdmin(null);
    };
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const refreshed = await refreshAdminToken();
        if (cancelled) return;
        if (refreshed) {
          setToken(refreshed);
          await loadMe();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMe]);

  // Both login steps end here once the server hands over a bearer token.
  const acceptSession = useCallback(async (data) => {
    const adminToken = data?.token;
    if (!adminToken) {
      throw new Error('Login response missing token');
    }
    setAdminAccessToken(adminToken);
    setToken(adminToken);
    setAdmin(data.admin || null);
    await loadMe();
    return data;
  }, [loadMe]);

  /**
   * Password step. Resolves `{ requiresTwoFactor: true, challenge }` when the
   * account has 2FA on — no session exists yet; call completeTwoFactor next.
   */
  const login = useCallback(async (email, password) => {
    const data = await unwrap(api.post(`${AUTH_NS}/login`, { email, password }));
    if (data?.requiresTwoFactor) return data;
    return acceptSession(data);
  }, [acceptSession]);

  /** Second step: the authenticator (or recovery) code for a pending challenge. */
  const completeTwoFactor = useCallback(async (challenge, code) => {
    const data = await unwrap(api.post(`${AUTH_NS}/login/2fa`, { challenge, code }));
    return acceptSession(data);
  }, [acceptSession]);

  // Re-read the profile (e.g. after turning 2FA on or off).
  const refreshAdmin = useCallback(() => loadMe(), [loadMe]);

  const logout = useCallback(async () => {
    try {
      await api.post(`${AUTH_NS}/logout`);
    } catch {
      // ignore — we clear the local session regardless
    }
    clearAdminAccessToken();
    setToken(null);
    setAdmin(null);
  }, []);

  const value = useMemo(
    () => ({
      admin,
      loading,
      isAuthenticated: Boolean(token),
      // Convenience for rendering only — the server re-checks the real role on
      // every request, so a tampered value here grants nothing.
      isRoot: IS_ROOT && admin?.role === 'root',
      // Enrolment is mandatory and not done: ProtectedAdminRoute keeps the
      // account on the Security screen until it is (the API refuses
      // everything else anyway — this is the friendly half).
      mustEnrol: Boolean(admin?.twoFactorRequired && !admin?.twoFactorEnabled),
      login,
      completeTwoFactor,
      refreshAdmin,
      logout,
    }),
    [admin, loading, token, login, completeTwoFactor, refreshAdmin, logout],
  );

  return (
    <AdminAuthContext.Provider value={value}>
      {children}
    </AdminAuthContext.Provider>
  );
}

export function useAdminAuth() {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) {
    throw new Error('useAdminAuth must be used within an AdminAuthProvider');
  }
  return ctx;
}
