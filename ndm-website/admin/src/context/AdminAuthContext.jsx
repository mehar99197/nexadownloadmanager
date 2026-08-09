import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import api, { setAdminAccessToken, clearAdminAccessToken, unwrap } from '../api/client.js';

const AdminAuthContext = createContext(null);

/**
 * Admin auth state.
 *
 * There is no `/api/admin/me` endpoint, so authentication is derived from the
 * token presence. The login response supplies the display identity; we never
 * decode sensitive claims from the JWT in the browser.
 */
export function AdminAuthProvider({ children }) {
  const [token, setToken] = useState(null);
  const [admin, setAdmin] = useState(null);
  const [loading] = useState(false);

  async function login(email, password) {
    const data = await unwrap(
      api.post('/admin/login', { email, password }),
    );
    const adminToken = data?.token;
    if (!adminToken) {
      throw new Error('Login response missing token');
    }
    setAdminAccessToken(adminToken);
    setToken(adminToken);
    setAdmin(data.admin || { authenticated: true });
    return data;
  }

  function logout() {
    clearAdminAccessToken();
    setToken(null);
    setAdmin(null);
  }

  const value = useMemo(
    () => ({
      admin,
      loading,
      isAuthenticated: Boolean(token),
      login,
      logout,
    }),
    [admin, loading, token],
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
