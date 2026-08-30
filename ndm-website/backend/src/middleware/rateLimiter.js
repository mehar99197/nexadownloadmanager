'use strict';

const rateLimit = require('express-rate-limit');
const { fail } = require('../utils/respond');

function limitReached(req, res) {
  return fail(res, 'RATE_LIMITED', 'Too many requests, please try again later', 429);
}

const common = {
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitReached,
};

// Integration tests drive hundreds of requests from one address, which the real
// limits would (correctly) block. RATE_LIMIT_DISABLED lifts them so the tests
// exercise the routes; the limiter suite sets it back to "0" to assert the real
// behaviour. It is honoured ONLY outside production, so it can never weaken a
// live deployment.
const limitsDisabled = () =>
  process.env.NODE_ENV !== 'production' && process.env.RATE_LIMIT_DISABLED === '1';

function makeLimiter(options) {
  const limiter = rateLimit({ ...common, ...options });
  return (req, res, next) => (limitsDisabled() ? next() : limiter(req, res, next));
}

// Auth endpoints (register/login/forgot/reset): 5 per 15 min.
const authLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
});

// License validation (called by the C++ app): 10 per hour per source IP. The
// fingerprint is untrusted input and must not be the sole rate-limit key.
const licenseLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.ip,
});

// Admin login: 5 per 15 min.
const adminLoginLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
});

// Ad serving + impression/click reporting from the desktop app. Every install
// polls a handful of times an hour, so this is sized to be invisible to a real
// client while still capping counter inflation from one address.
const adsLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 120,
});

// Generous global limiter mounted on /api.
const apiLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 1000,
});

// Public counting download redirect: light per-IP cap so the counter cannot
// be inflated trivially while still allowing retries for both OSes.
const downloadLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
});

// Admin/root session refresh runs on every full page load of the panel, so
// it must NOT share the 5/15min login limiter — the sixth reload used to 429
// and sign the admin out. Still bounded: a stolen cookie cannot hammer it.
const adminRefreshLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: 'Too many session refreshes. Please wait a few minutes.',
});

// Contact form: enough for a real person, useless for a script.
const contactLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many messages from this address. Please try again later.',
});

// Second factor on the control-panel login. A 6-digit code has a million
// values, so the budget must be tiny: ten attempts per challenge window.
const twoFactorLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many code attempts. Please wait a few minutes.',
});

// Team invites: a five-seat team never needs more than a handful, while a
// compromised account must not be able to spam invitations from our domain.
const teamInviteLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: 'Too many invitations sent. Please try again later.',
});

module.exports = {
  authLimiter, licenseLimiter, adminLoginLimiter, adminRefreshLimiter, apiLimiter, downloadLimiter,
  adsLimiter, contactLimiter, twoFactorLimiter, teamInviteLimiter,
};
