import axios from 'axios';
import { AUTH_NS } from '../realm.js';

let adminAccessToken = null;
let refreshPromise = null;

const BASE_URL = import.meta.env.VITE_API_URL || '/api';

export const setAdminAccessToken = (token) => { adminAccessToken = token || null; };
export const clearAdminAccessToken = () => { adminAccessToken = null; };

/**
 * Shared axios instance for whichever control panel is mounted.
 *
 * Session endpoints are namespaced by realm (AUTH_NS): the staff panel talks to
 * /api/admin/{login,refresh,logout,me}, the creator panel to /api/root/*. Each
 * gets its own httpOnly cookie scoped to its own path, so the two sessions are
 * independent — signing out of one does not touch the other.
 *
 * - baseURL from VITE_API_URL (falls back to /api, proxied to the backend in dev).
 * - withCredentials so the httpOnly refresh cookie flows to <realm>/refresh.
 * - Attaches the short-lived admin Bearer token from memory on every request.
 * - On 401, tries one silent refresh and replays the request; if that fails the
 *   token is cleared and the error is rejected (ProtectedAdminRoute then bounces
 *   the user to /login on the next render).
 */
const api = axios.create({
  baseURL: BASE_URL,
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const token = adminAccessToken;
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/** POST <realm>/refresh using the httpOnly cookie. Resolves the new token or null. */
export async function refreshAdminToken() {
  refreshPromise ||= axios
    .post(`${BASE_URL}${AUTH_NS}/refresh`, {}, { withCredentials: true })
    .then((res) => res.data?.data?.token || null)
    .catch(() => null)
    .finally(() => { refreshPromise = null; });
  const token = await refreshPromise;
  if (token) setAdminAccessToken(token);
  return token;
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error?.config;
    const url = original?.url || '';
    if (
      error?.response?.status !== 401 ||
      !original ||
      original._retry ||
      url.includes(`${AUTH_NS}/login`) ||
      url.includes(`${AUTH_NS}/refresh`) ||
      url.includes(`${AUTH_NS}/logout`)
    ) {
      if (error?.response?.status === 401) clearAdminAccessToken();
      return Promise.reject(error);
    }
    original._retry = true;
    const token = await refreshAdminToken();
    if (!token) {
      clearAdminAccessToken();
      return Promise.reject(error);
    }
    original.headers = original.headers || {};
    original.headers.Authorization = `Bearer ${token}`;
    return api(original);
  },
);

/**
 * Unwrap the backend response envelope `{ ok, data }`.
 * Pass an axios response (or a promise of one) and get back `data`.
 *
 *   const stats = await unwrap(api.get('/admin/stats'));
 *
 * Throws on a non-ok envelope so callers can try/catch normally.
 */
export async function unwrap(responseOrPromise) {
  const res = await responseOrPromise;
  const body = res?.data;
  if (body && typeof body === 'object' && 'ok' in body) {
    if (!body.ok) {
      const err = new Error(body.error?.message || 'Request failed');
      err.code = body.error?.code;
      err.details = body.error?.details;
      throw err;
    }
    return body.data;
  }
  // Non-enveloped response — return as-is.
  return body;
}

export default api;
