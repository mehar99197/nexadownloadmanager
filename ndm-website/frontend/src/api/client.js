import axios from 'axios';

let accessToken = null;
let refreshPromise = null;

export const setAccessToken = (token) => { accessToken = token || null; };
export const clearAccessToken = () => { accessToken = null; };

/**
 * The refresh cookie is gone or was refused: there is no session any more.
 *
 * This exists because clearing the in-memory token is only a third of the job
 * (AUDIT.md M-10). The readable ndm_session hint still says "there may be a
 * session here", so the NEXT page load pays for a refresh that cannot work;
 * and AuthContext's user state still says signed in, so the header keeps
 * rendering an account menu over a session that ended. AuthContext listens for
 * this and clears all three in one place — the alternative is three callers
 * remembering to do three things, which is how it drifted apart to begin with.
 *
 * Deliberately NOT dispatched from clearAccessToken(): that one also runs on a
 * deliberate sign-out, which already tears down its own state.
 */
export const SESSION_ENDED_EVENT = 'ndm:session-ended';

function sessionEnded() {
  clearAccessToken();
  if (typeof window !== 'undefined' && window.dispatchEvent) {
    window.dispatchEvent(new window.CustomEvent(SESSION_ENDED_EVENT));
  }
}

/**
 * A 401 is worth a refresh-and-retry only when it is about the access token.
 *
 * /auth/google answers 401 for its own reasons: Google's sign-in did not
 * verify (GOOGLE_AUTH_FAILED) or its nonce expired while the page sat open
 * (GOOGLE_NONCE_INVALID). Taken for an expired session, a signed-out visitor's
 * failed Google sign-in went to /auth/refresh instead, and the page showed the
 * refresh's "Missing refresh token" — and never saw the GOOGLE_NONCE_INVALID
 * it recovers from by minting a new nonce. These are the codes requireAuth and
 * the JWT error handler send; a 401 with no code at all (a proxy's) still gets
 * the refresh, as before.
 */
const SESSION_CODES = new Set(['UNAUTHORIZED', 'TOKEN_EXPIRED', 'INVALID_TOKEN', 'SESSION_REVOKED']);

function isSessionError(error) {
  if (error?.response?.status !== 401) return false;
  const code = error.response.data?.error?.code;
  return !code || SESSION_CODES.has(code);
}

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
    if (!isSessionError(error) || !original || original._retry ||
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
      sessionEnded();
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
    sessionEnded();
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
