import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios, { AxiosError } from 'axios';

import api, { SESSION_ENDED_EVENT, clearAccessToken } from '../api/client';

/**
 * Which 401s the client treats as an expired session.
 *
 * Only the access-token ones are worth a refresh and a retry: requireAuth's
 * UNAUTHORIZED and SESSION_REVOKED, the JWT handler's TOKEN_EXPIRED and
 * INVALID_TOKEN, or a bare 401. /auth/google's own 401s ARE the answer and
 * have to reach the page as sent. Before, a failed Google sign-in came back as
 * the refresh's "Missing refresh token", and GOOGLE_NONCE_INVALID, which Login
 * recovers from by minting a new nonce, never arrived at all.
 *
 * Runs the real interceptor. Only the transport is replaced, on both the api
 * instance and the global axios the refresh call goes through.
 */

let calls;
let routes;   // "METHOD /path" -> response, or an array of responses in order

function adapter(config) {
  const path = `${config.baseURL || ''}${config.url || ''}`.replace(/^\/api/, '');
  const key = `${(config.method || 'get').toUpperCase()} ${path}`;
  calls.push({ key, auth: config.headers?.Authorization });
  const entry = routes[key];
  const hit = (Array.isArray(entry) ? entry.shift() : entry)
    || { status: 404, body: { ok: false, error: { code: 'NOT_FOUND', message: 'no route' } } };
  const response = { data: hit.body, status: hit.status, statusText: String(hit.status), headers: {}, config, request: {} };
  if (hit.status >= 200 && hit.status < 300) return Promise.resolve(response);
  return Promise.reject(new AxiosError(`Request failed with status code ${hit.status}`,
    AxiosError.ERR_BAD_REQUEST, config, {}, response));
}

const fail = (status, code, message = code) => ({ status, body: { ok: false, error: { code, message } } });
const ok = (data) => ({ status: 200, body: { ok: true, data } });

let savedApi;
let savedGlobal;
let ended;
const onEnded = () => { ended += 1; };

beforeEach(() => {
  calls = [];
  routes = {};
  ended = 0;
  savedApi = api.defaults.adapter;
  savedGlobal = axios.defaults.adapter;
  api.defaults.adapter = adapter;
  axios.defaults.adapter = adapter;
  window.addEventListener(SESSION_ENDED_EVENT, onEnded);
});

afterEach(() => {
  api.defaults.adapter = savedApi;
  axios.defaults.adapter = savedGlobal;
  window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
  clearAccessToken();
});

describe('a 401 that is not about the session', () => {
  it.each([
    ['GOOGLE_NONCE_INVALID', 'That Google sign-in has expired. Please reload the page and try again.'],
    ['GOOGLE_AUTH_FAILED', 'Could not verify that Google sign-in. Please try again.'],
  ])('reaches the page as sent: %s', async (code, message) => {
    routes['POST /auth/google'] = fail(401, code, message);
    routes['POST /auth/refresh'] = fail(401, 'NO_REFRESH_TOKEN', 'Missing refresh token');

    const err = await api.post('/auth/google', { credential: 'id-token' }).catch((e) => e);

    expect(err.response.data.error.code).toBe(code);
    expect(err.response.data.error.message).toBe(message);
    // No refresh, no second use of a one-time Google credential, and a
    // visitor who was never signed in is not "signed out" either.
    expect(calls.map((c) => c.key)).toEqual(['POST /auth/google']);
    expect(ended).toBe(0);
  });
});

describe('a 401 about the access token', () => {
  it('is refreshed once and the request retried with the new token', async () => {
    routes['GET /user/me'] = [fail(401, 'TOKEN_EXPIRED', 'Token expired'), ok({ user: { id: 7 } })];
    routes['POST /auth/refresh'] = ok({ token: 'fresh-token' });

    const res = await api.get('/user/me');

    expect(res.data.data.user.id).toBe(7);
    expect(calls.map((c) => c.key)).toEqual(['GET /user/me', 'POST /auth/refresh', 'GET /user/me']);
    expect(calls[2].auth).toBe('Bearer fresh-token');
    expect(ended).toBe(0);
  });

  it.each(['UNAUTHORIZED', 'INVALID_TOKEN', 'SESSION_REVOKED'])(
    '%s that cannot be refreshed ends the session', async (code) => {
      routes['GET /user/license'] = fail(401, code);
      routes['POST /auth/refresh'] = fail(401, 'INVALID_REFRESH_TOKEN', 'Session is invalid or has expired');

      await expect(api.get('/user/license')).rejects.toBeTruthy();

      expect(calls.map((c) => c.key)).toEqual(['GET /user/license', 'POST /auth/refresh']);
      expect(ended).toBe(1);
    }
  );

  it('a bare 401 with no code (a proxy\'s) still gets the refresh', async () => {
    routes['GET /user/me'] = [{ status: 401, body: '' }, ok({ user: { id: 3 } })];
    routes['POST /auth/refresh'] = ok({ token: 't2' });

    const res = await api.get('/user/me');

    expect(res.data.data.user.id).toBe(3);
    expect(calls.map((c) => c.key)).toEqual(['GET /user/me', 'POST /auth/refresh', 'GET /user/me']);
  });
});
