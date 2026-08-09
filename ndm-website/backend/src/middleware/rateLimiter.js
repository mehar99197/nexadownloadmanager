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

// Auth endpoints (register/login/forgot/reset): 5 per 15 min.
const authLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: 5,
});

// License validation (called by the C++ app): 10 per hour per source IP. The
// fingerprint is untrusted input and must not be the sole rate-limit key.
const licenseLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.ip,
});

// Admin login: 5 per 15 min.
const adminLoginLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: 5,
});

// Generous global limiter mounted on /api.
const apiLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: 1000,
});

module.exports = { authLimiter, licenseLimiter, adminLoginLimiter, apiLimiter };
