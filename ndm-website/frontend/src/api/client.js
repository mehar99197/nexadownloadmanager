import axios from 'axios';

let accessToken = null;
let refreshPromise = null;

export const setAccessToken = (token) => { accessToken = token || null; };
export const clearAccessToken = () => { accessToken = null; };

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  withCredentials: true,
});

// Keep the short-lived access token in memory; the refresh token remains an
// httpOnly cookie managed by the backend.
api.interceptors.request.use((config) => {
  const token = accessToken;
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error?.config;
    if (error?.response?.status !== 401 || !original || original._retry ||
        original.url?.includes('/auth/refresh') || original.url?.includes('/auth/login')) {
      return Promise.reject(error);
    }
    original._retry = true;
    try {
      refreshPromise ||= axios.post(
        `${import.meta.env.VITE_API_URL || '/api'}/auth/refresh`, {}, { withCredentials: true }
      ).finally(() => { refreshPromise = null; });
      const refreshed = await refreshPromise;
      const token = refreshed.data?.data?.token;
      if (!token) throw new Error('Refresh response missing token');
      setAccessToken(token);
      original.headers = original.headers || {};
      original.headers.Authorization = `Bearer ${token}`;
      return api(original);
    } catch (refreshError) {
      clearAccessToken();
      return Promise.reject(refreshError);
    }
  }
);

/**
 * Rehydrate the in-memory access token from the httpOnly refresh cookie.
 * Called once on load (when the session hint says there may be a session)
 * BEFORE any authenticated request, so a signed-in user's page load never
 * starts with a 401 that then has to be recovered by the interceptor.
 * Resolves true when a token was obtained.
 */
export async function restoreSession() {
  try {
    refreshPromise ||= axios.post(
      `${import.meta.env.VITE_API_URL || '/api'}/auth/refresh`, {}, { withCredentials: true }
    ).finally(() => { refreshPromise = null; });
    const res = await refreshPromise;
    const token = res.data?.data?.token;
    if (!token) return false;
    setAccessToken(token);
    return true;
  } catch {
    clearAccessToken();
    return false;
  }
}

/**
 * Unwrap the standard success envelope: { ok:true, data }.
 * NOTE: POST /api/license/validate is the ONE endpoint that does NOT use this
 * envelope — but the website never calls it (the C++ app does).
 */
export const unwrap = (res) => res.data.data;

export default api;
