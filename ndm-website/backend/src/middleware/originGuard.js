'use strict';

/**
 * A second layer under the cookie flags, for state-changing requests.
 *
 * CSRF is already covered here: every session cookie is `SameSite=Lax`, so a
 * browser will not attach one to a cross-site POST, and every mutation also
 * needs a bearer token the attacker's page cannot read. That holds — but it is
 * one assumption, and it is the kind of assumption a future change (a cookie
 * relaxed to `SameSite=None` for an embed, a route that trusts the cookie
 * alone) quietly breaks without anything failing loudly.
 *
 * So: a mutating request that CARRIES an Origin must carry one we recognise.
 *
 * A missing Origin is allowed on purpose. It is what every non-browser client
 * sends — the desktop app validating a licence, Stripe delivering a webhook,
 * curl, the integration tests — and none of those can be a CSRF vector, because
 * CSRF is precisely an attack that borrows a *browser's* ambient credentials.
 * Browsers have sent Origin on cross-origin POSTs for years, which is the case
 * this guards.
 */

const config = require('../config/env');
const { fail } = require('../utils/respond');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Normalise to scheme://host[:port], or null when it is not a usable origin. */
function normalize(value) {
  if (!value || value === 'null') return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** The origin this request was actually addressed to, behind the proxy. */
function selfOrigin(req) {
  const host = req.get('x-forwarded-host') || req.get('host');
  if (!host) return null;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  return `${proto.split(',')[0].trim()}://${host.split(',')[0].trim()}`;
}

function isAllowedOrigin(req, origin) {
  if (config.CORS_ORIGINS.some((allowed) => normalize(allowed) === origin)) return true;
  return selfOrigin(req) === origin;
}

function originGuard(req, res, next) {
  if (!MUTATING.has(req.method)) return next();
  const origin = normalize(req.get('origin'));
  // No Origin: not a browser, so not a CSRF vector. See the note above.
  if (!origin) return next();
  if (isAllowedOrigin(req, origin)) return next();
  return fail(res, 'BAD_ORIGIN', 'This request did not come from an allowed origin', 403);
}

module.exports = { originGuard, isAllowedOrigin, normalize, selfOrigin };
