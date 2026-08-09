import axios from 'axios';

export const ADMIN_TOKEN_KEY = 'ndm_admin_token';
let adminAccessToken = null;

export const setAdminAccessToken = (token) => { adminAccessToken = token || null; };
export const clearAdminAccessToken = () => { adminAccessToken = null; };

/**
 * Shared axios instance for the admin panel.
 * - baseURL from VITE_API_URL (falls back to /api, proxied to the backend in dev).
 * - Attaches the short-lived admin Bearer token from memory on every request.
 * - On 401, clears the stored token and rejects (ProtectedAdminRoute then bounces
 *   the user to /login on the next render).
 */
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
});

api.interceptors.request.use((config) => {
  const token = adminAccessToken;
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401) {
      clearAdminAccessToken();
    }
    return Promise.reject(error);
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
