'use strict';

/**
 * Customer browser sessions — the one place they are opened and closed.
 *
 * A session is one user_sessions row (models/UserSession.js) named by the
 * httpOnly refresh cookie, plus a short-lived access token the page keeps in
 * memory. Password sign-in, two-factor completion, Google sign-in and a
 * password change all open one through issueSession(); /logout and the
 * account's own "sign out this device" close them.
 */

const config = require('../config/env');
const UserSession = require('../models/UserSession');
const { signAccessToken, generateRefreshToken } = require('./jwt');
const cookieFlags = require('./cookies');

const REFRESH_COOKIE = 'ndm_refresh';
const REFRESH_PATH = '/api/auth';
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
// Non-httpOnly marker with the same lifetime as the refresh cookie. It holds no
// secret — it only tells the site "there may be a session, try /refresh", so a
// visitor who never signed in does not trigger a 401 + refresh on every load.
const SESSION_HINT_COOKIE = 'ndm_session';

function refreshCookieOptions() {
  return cookieFlags.refreshCookieOptions(REFRESH_PATH, REFRESH_MAX_AGE);
}

function setSessionHint(res) {
  res.cookie(SESSION_HINT_COOKIE, '1', cookieFlags.sessionHintCookieOptions(REFRESH_MAX_AGE));
}

function clearSessionCookies(res) {
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
  res.clearCookie(SESSION_HINT_COOKIE, { path: '/' });
}

/** Open a session for `user` on this browser; returns the response body. */
async function issueSession(req, res, user) {
  const { token: refreshToken, hash } = generateRefreshToken();
  await UserSession.create({
    userId: user.id, tokenHash: hash, ttlMs: REFRESH_MAX_AGE,
    userAgent: req.get('user-agent'), ip: req.ip,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());
  setSessionHint(res);
  return {
    token: signAccessToken(user),
    user: { id: String(user.id), name: user.name, email: user.email, role: user.role },
  };
}

module.exports = {
  REFRESH_COOKIE, REFRESH_PATH, REFRESH_MAX_AGE, SESSION_HINT_COOKIE,
  refreshCookieOptions, setSessionHint, clearSessionCookies, issueSession,
  accessTokenTtl: config.ACCESS_TOKEN_TTL,
};
