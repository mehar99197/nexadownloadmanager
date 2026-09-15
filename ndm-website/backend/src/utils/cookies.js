'use strict';

/**
 * The one place a session cookie's flags are decided.
 *
 * Three refresh cookies (customer, staff, creator) and one hint cookie used to
 * spell their options out in four files, with a fifth copy inline in the
 * profile route — the kind of duplication where a flag gets tightened in one
 * place and quietly stays loose in another.
 *
 *   httpOnly  the browser never hands the value to script, so an XSS cannot
 *             read a refresh token (the access token is in memory and short).
 *   secure    only ever sent over TLS on a public deployment
 *             (config.secureCookies is off for a plain-http localhost).
 *   path      the refresh cookie is only sent to its own refresh/logout
 *             endpoints — every other request carries a Bearer token instead —
 *             so a bug anywhere else on the API never sees it.
 *   sameSite  'strict': the cookie never rides on a request another site
 *             started. Every request that needs it is XHR from our own page
 *             (the SPA calls /refresh after it loads), and a same-site XHR is
 *             sent the cookie whatever link the visitor arrived by. 'lax'
 *             would also send it on cross-site top-level GETs, which nothing
 *             here needs.
 *
 * The session HINT is different: it holds no secret (it only says "there may
 * be a session, try /refresh"), must be readable by the page, and must
 * survive a cross-site top-level navigation — otherwise a link from an email
 * lands a signed-in person on a page that thinks they are signed out until
 * they reload. So it stays 'lax' and script-readable, on purpose.
 */

const config = require('../config/env');

function refreshCookieOptions(path, maxAgeMs) {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'strict',
    path,
    maxAge: maxAgeMs,
  };
}

function sessionHintCookieOptions(maxAgeMs) {
  return {
    httpOnly: false,
    secure: config.secureCookies,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  };
}

module.exports = { refreshCookieOptions, sessionHintCookieOptions };
