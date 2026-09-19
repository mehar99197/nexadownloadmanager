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

// ── Auth ────────────────────────────────────────────────────────────────────
//
// One 5-per-15-min bucket, keyed on the source IP, used to cover register,
// login, google, forgot-password AND reset-password together. Two problems
// with that, both of them real:
//
//   * Shared egress. An office, a campus or any CGNAT address is one IP, so
//     the fifth person to sign in during a quarter of an hour was refused —
//     and Team plans are exactly the customers who sit behind one.
//   * One bucket. Five sign-up attempts left a colleague unable to start a
//     password reset, because the two spent the same budget.
//
// Keying on the EMAIL instead (what the audit found in production) is worse
// still: it hands anyone who knows an address the ability to close that
// account for fifteen minutes with five requests.
//
// So the budgets are split by concern, and the two keys do different jobs:
//
//   per IP    → REFUSES (429). The brute-force / credential-stuffing control.
//   per email → DELAYS, never refuses. An attacker can make one account slow;
//               they cannot make it unusable, and the owner still signs in.
//
// All of these are mounted AFTER validate() in routes/auth.js, so a request
// that fails its schema costs no auth quota — only real attempts count.

// Sign-in: sized for a shared address, not for one person.
const loginLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
});

// Account creation from one address. Generous enough for a family or an
// office, useless for a script farming accounts.
const registerLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many accounts created from this address. Please try again later.',
});

// Password recovery gets its own budget: being unable to reset a password
// because someone else on your network was signing up is its own outage.
const forgotPasswordLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
});

// Consuming a reset token. Bounded so the token space cannot be walked.
const resetPasswordLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
});

// "Continue with Google". Google has already challenged the human, so this is
// only a floor against a loop hammering the endpoint.
const googleLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
});

// Kept for callers that still want the old shared bucket semantics.
const authLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
});

// ── Per-account slowdown ────────────────────────────────────────────────────
//
// The second half of the dual key. Consecutive failed sign-ins for one address
// buy an increasing delay before the next attempt is even looked at, which
// makes online guessing pointless (a 2 s floor caps an attacker at ~1,800
// guesses a day per account) while leaving the real owner able to sign in —
// they wait a second or two, they are never told to come back in 15 minutes.
//
// A successful sign-in clears the counter, so one fat-fingered password never
// leaves a trace.
//
// In-memory and therefore per-process, exactly like express-rate-limit's own
// default store, so this adds no dependency and no new failure mode. Behind
// several API instances each one keeps its own view; the per-IP limiter above
// has always had the same property.
const LOGIN_FAILURE_TTL_MS = 15 * 60 * 1000;
const LOGIN_DELAY_STEPS_MS = [0, 0, 0, 100, 250, 500, 1000];
const LOGIN_DELAY_MAX_MS = 2000;
const LOGIN_FAILURE_SWEEP_AT = 5000;

const loginFailures = new Map();

const normaliseEmail = (value) =>
  (typeof value === 'string' ? value.trim().toLowerCase() : '');

function sweepLoginFailures(now) {
  for (const [email, entry] of loginFailures) {
    if (now - entry.at > LOGIN_FAILURE_TTL_MS) loginFailures.delete(email);
  }
}

function loginFailureCount(email) {
  const entry = loginFailures.get(email);
  if (!entry) return 0;
  if (Date.now() - entry.at > LOGIN_FAILURE_TTL_MS) {
    loginFailures.delete(email);
    return 0;
  }
  return entry.count;
}

function recordLoginFailure(email) {
  const key = normaliseEmail(email);
  if (!key) return;
  const now = Date.now();
  if (loginFailures.size > LOGIN_FAILURE_SWEEP_AT) sweepLoginFailures(now);
  const count = loginFailureCount(key) + 1;
  loginFailures.set(key, { count, at: now });
}

function clearLoginFailures(email) {
  const key = normaliseEmail(email);
  if (key) loginFailures.delete(key);
}

function loginDelayFor(email) {
  const count = loginFailureCount(normaliseEmail(email));
  if (count <= 0) return 0;
  return LOGIN_DELAY_STEPS_MS[count] ?? LOGIN_DELAY_MAX_MS;
}

/**
 * Middleware: hold a sign-in attempt for as long as this account's recent
 * failure count has earned. Mounted after validate(), so req.body.email is
 * already trimmed and lower-cased by the schema.
 */
function loginSlowdown(req, res, next) {
  if (limitsDisabled()) return next();
  const delay = loginDelayFor(req.body && req.body.email);
  if (delay <= 0) return next();
  const timer = setTimeout(next, delay);
  // A visitor who gives up mid-wait should not leave a timer behind.
  res.on('close', () => clearTimeout(timer));
  return undefined;
}

// License validation (called by the C++ app): 10 per hour per (source IP,
// licence key). Keyed on the IP alone, one shared egress address — an office,
// a campus, CGNAT — shared a single 10/hour budget across every user behind
// it, and the eleventh activation was refused; Team plans are exactly the
// customers most likely to sit behind one. Adding the key gives each licence
// its own budget per address. The IP stays in the key: the fingerprint is
// untrusted input, and one key still cannot be hammered from one address
// however many devices claim it.
const licenseLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => {
    const key = typeof req.body?.license_key === 'string'
      ? req.body.license_key.trim().toUpperCase().slice(0, 64) : '';
    return `${req.ip}|${key}`;
  },
});

// Session refresh runs on every full page load, so it must not share the
// 5/15 min login budget — but it is an unauthenticated endpoint that hits the
// database, so it cannot go unbounded either. Same shape as the admin one.
const sessionRefreshLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 120,
});

// Email-verification links: one click each, with room for the retries a
// confused user makes, but not for a script walking token space.
const verifyEmailLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
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
//
// Only a FRESH start counts: no Range header, or one that begins at byte 0.
// The desktop updater fetches the installer through the segmented engine —
// up to 32 connections, each its own ranged request, plus the work-stealing
// tails — and browsers and download managers resume with ranges too. Counting
// every chunk meant a single 187 MB update burned the whole budget
// mid-transfer and every user's updater died with 429. This is the same rule
// the route uses for its download counter (releases.js, isFreshStart), so
// what the limiter protects and what it counts are the same thing.
const downloadLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  skip: (req) => {
    const range = String(req.headers.range || '').trim();
    return range !== '' && !/^bytes=0-/.test(range);
  },
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
  sessionRefreshLimiter, verifyEmailLimiter,
  // WP-08: per-route budgets plus the per-account slowdown.
  loginLimiter, registerLimiter, forgotPasswordLimiter, resetPasswordLimiter, googleLimiter,
  loginSlowdown, recordLoginFailure, clearLoginFailures, loginDelayFor, loginFailureCount,
};
