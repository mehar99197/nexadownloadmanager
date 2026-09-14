'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config/env');
const { fail } = require('../utils/respond');
const { MySqlRateLimitStore } = require('./rateLimitStore');

// express-rate-limit hands the resolved options to the handler. Reading
// `message` from them is what makes the per-limiter wording below reach the
// client at all: a custom `handler` replaces the library's own message
// response, so every limiter used to answer the same generic sentence and the
// specific ones ("Too many code attempts…") were dead configuration.
function limitReached(req, res, next, options) {
  const message = typeof options?.message === 'string' && options.message
    ? options.message
    : 'Too many requests, please try again later';
  return fail(res, 'RATE_LIMITED', message, 429);
}

const common = {
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitReached,
};

// Integration tests drive hundreds of requests from one address, which the real
// limits would (correctly) block. RATE_LIMIT_DISABLED lifts them so the tests
// exercise the routes; the limiter suite sets it back to "0" to assert the real
// behaviour. It is honoured ONLY on a local, non-production deployment
// (config.allowRateLimitBypass), so it can never weaken a live box — not even
// one mistakenly running with NODE_ENV=development.
const limitsDisabled = () =>
  config.allowRateLimitBypass && process.env.RATE_LIMIT_DISABLED === '1';

function makeLimiter(options) {
  const limiter = rateLimit({ ...common, ...options });
  return (req, res, next) => (limitsDisabled() ? next() : limiter(req, res, next));
}

/**
 * A limiter whose counts live in MySQL, so they survive the restarts the
 * keepalive cron performs and hold across processes. Reserved for the
 * security-critical endpoints — see middleware/rateLimitStore.js for why the
 * high-volume limiters stay in memory.
 */
function makeDurableLimiter(name, options) {
  return makeLimiter({ ...options, store: new MySqlRateLimitStore({ prefix: name }) });
}

/**
 * Sign-in attempts are counted per (IP, email), not per IP alone.
 *
 * A single per-IP budget of 5 per 15 minutes means one person fat-fingering
 * their password locks out everybody behind the same office NAT or mobile
 * carrier. Keying on the address as well keeps the per-account brute-force
 * budget tight while leaving other people on that IP unaffected; `authIpLimiter`
 * below still caps the total from one address, so nobody can walk a dictionary
 * of emails past it either.
 */
function loginKey(req) {
  const email = String(req.body?.email || '').toLowerCase().trim().slice(0, 190);
  return `${req.ip}|${email}`;
}

// Register / forgot / reset: 5 per 15 min per address. These carry no shared
// account identity, so the IP is the only key available.
const authLimiter = makeDurableLimiter('auth', {
  windowMs: 15 * 60 * 1000,
  max: 5,
});

// Sign-in: 5 per 15 min per (IP, email) — see loginKey.
const loginLimiter = makeDurableLimiter('login', {
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: loginKey,
  message: 'Too many sign-in attempts for this account. Please wait a few minutes.',
});

// …and a looser ceiling on the address itself, so cycling through emails does
// not buy an attacker an unlimited number of guesses.
const authIpLimiter = makeDurableLimiter('auth-ip', {
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: 'Too many sign-in attempts from this network. Please wait a few minutes.',
});

// License validation (called by the C++ app): 10 per hour per source IP. The
// fingerprint is untrusted input and must not be the sole rate-limit key.
const licenseLimiter = makeDurableLimiter('license', {
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.ip,
});

// Admin login: 5 per 15 min.
const adminLoginLimiter = makeDurableLimiter('admin-login', {
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

// Every call here costs real money at Anthropic, so this is deliberately the
// tightest limiter in the file and it counts in MySQL — an attacker who found a
// way to spend our API budget would otherwise get a fresh allowance every time
// the keepalive cron restarted the process. Sized for the honest case: a batch
// of finished downloads being renamed, not a loop.
const aiLimiter = makeDurableLimiter('ai', {
  windowMs: 60 * 60 * 1000,
  max: 120,
});

// The public installer route, /api/releases/download/:os, is where the
// desktop updater and the site's download button fetch a 150-200 MB file.
// The updater pulls it through the segmented engine: up to 32 connections,
// each its own ranged request, plus work-stealing tails and per-segment
// retries. Browsers and download managers resume with ranges too. One update
// is therefore dozens of requests from one address in a few seconds.
//
// Counting those against per-address budgets broke the rollout of v0.2.1
// (2026-09-13): the download limiter (then 30) refused segments mid-transfer,
// the engine retried every refusal, and 2 300 retries pushed the same address
// over the GLOBAL limit, which took the whole API away from that user for a
// quarter of an hour — including the website's own pages.
//
// Two rules follow. The route is exempt from the global limiter altogether:
// it has its own budget below, and nothing that happens to an installer
// transfer may lock a user out of login, licensing or pricing. And the
// route's own budget is sized for a segmented transfer, not for a click,
// while still bounding how far a script can inflate the download counter.
//
// Continuations (a range not starting at byte 0) are exempt from that budget
// as well, matching the route's own counter rule (releases.js, isFreshStart).
// Note that behind Hostinger's CDN the origin never sees a Range header — the
// edge strips it, fetches the object and slices it itself — so every chunk
// arrives here as a fresh start. That is why the budget cannot be "30 clicks":
// it must absorb a whole segmented transfer even when the exemption cannot
// fire. With the CDN off (recommended for this domain) ranges reach the
// origin and only true fresh starts count.
const DOWNLOAD_ROUTE = /^\/(?:api\/)?releases\/download\//;
function isDownloadRoute(req) {
  return DOWNLOAD_ROUTE.test(req.originalUrl || req.url || '');
}
function isDownloadContinuation(req) {
  if (!isDownloadRoute(req)) return false;
  const range = String(req.headers.range || '').trim();
  return range !== '' && !/^bytes=0-/.test(range);
}

// Generous global limiter mounted on /api.
const apiLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  skip: isDownloadRoute,
});

// Public counting download: bounded per address so the counter cannot be
// inflated trivially, sized for a full segmented transfer with retries.
const downloadLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 150,
  skip: isDownloadContinuation,
  message: 'Too many installer downloads from this address. Please try again in a few minutes.',
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
const contactLimiter = makeDurableLimiter('contact', {
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many messages from this address. Please try again later.',
});

// Second factor on the control-panel login. A 6-digit code has a million
// values, so the budget must be tiny: ten attempts per challenge window.
const twoFactorLimiter = makeDurableLimiter('2fa', {
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many code attempts. Please wait a few minutes.',
});

// Team invites: a five-seat team never needs more than a handful, while a
// compromised account must not be able to spam invitations from our domain.
const teamInviteLimiter = makeDurableLimiter('team-invite', {
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: 'Too many invitations sent. Please try again later.',
});

// Rotating a licence key invalidates every installed copy of it, so it is
// deliberately awkward to do by accident or in a loop — but it must stay
// reachable the moment a key leaks. Durable, because it is a security action
// and a process restart must not hand out a fresh budget.
const licenseRotateLimiter = makeDurableLimiter('license-rotate', {
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  message: 'Too many licence key rotations today. Please try again tomorrow.',
});

module.exports = {
  authLimiter, loginLimiter, authIpLimiter, licenseRotateLimiter,
  licenseLimiter, adminLoginLimiter, adminRefreshLimiter, apiLimiter, downloadLimiter,
  adsLimiter, contactLimiter, twoFactorLimiter, teamInviteLimiter, aiLimiter,
  loginKey,
};
