'use strict';

const config = require('../config/env');
const { fail } = require('../utils/respond');

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Cloudflare Turnstile gate for the anonymous write endpoints (register,
 * password reset, contact form, review posting).
 *
 * The widget puts its token in `turnstileToken`. This runs BEFORE validate():
 * the zod schemas are .strict(), so the token is stripped from the body once
 * checked and the schema never has to know about it.
 *
 * With no TURNSTILE_SECRET_KEY configured the gate is off — local development
 * and the integration tests run without a Cloudflare account. The site key is
 * likewise optional on the frontend, so both halves switch on together.
 */
function isEnabled() {
  return Boolean(config.TURNSTILE_SECRET_KEY);
}

async function verifyToken(token, remoteip, fetchImpl = globalThis.fetch) {
  if (!token) return { success: false, reason: 'missing-input-response' };
  const body = new URLSearchParams({ secret: config.TURNSTILE_SECRET_KEY, response: String(token) });
  if (remoteip) body.set('remoteip', remoteip);
  try {
    const res = await fetchImpl(VERIFY_URL, { method: 'POST', body });
    const data = await res.json();
    if (data && data.success === true) return { success: true };
    return { success: false, reason: (data && data['error-codes'] || ['unknown']).join(',') };
  } catch (err) {
    // Cloudflare unreachable. Note what this branch is and is not: a JSON
    // answer of `success: false` — a wrong, reused or missing token — already
    // fails closed above and always did. This is only the case where OUR
    // request never got an answer, which nobody outside Cloudflare can cause on
    // demand, so the default is to let the visitor through rather than take
    // sign-up, the contact form and reviews down with the outage.
    //
    // Loud, because a gate that is silently open is worse than one that is
    // shut: TURNSTILE_FAIL_CLOSED flips it if a bot wave ever coincides.
    // eslint-disable-next-line no-console
    console.error('[SECURITY] turnstile verification unreachable, gate is'
      + ` ${config.TURNSTILE_FAIL_CLOSED ? 'CLOSED' : 'OPEN'} for this request:`, err.message);
    if (config.TURNSTILE_FAIL_CLOSED) return { success: false, reason: 'verification-unavailable' };
    return { success: true, degraded: true };
  }
}

function requireTurnstile(req, res, next) {
  const token = req.body && req.body.turnstileToken;
  if (req.body && typeof req.body === 'object') delete req.body.turnstileToken;
  if (!isEnabled()) return next();
  verifyToken(token, req.ip)
    .then((result) => {
      if (result.success) return next();
      if (result.reason === 'verification-unavailable')
        return fail(res, 'CAPTCHA_UNAVAILABLE',
          'Verification is temporarily unavailable. Please try again in a few minutes.', 503,
          { reason: result.reason });
      return fail(res, 'CAPTCHA_FAILED', 'Please complete the verification challenge and try again', 400,
        { reason: result.reason });
    })
    .catch(next);
  return undefined;
}

module.exports = { requireTurnstile, verifyToken, isEnabled, VERIFY_URL };
