'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');

const config = require('../config/env');
const User = require('../models/User');
const Subscription = require('../models/Subscription');

const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const { authLimiter } = require('../middleware/rateLimiter');
const { requireTurnstile } = require('../middleware/turnstile');
const { ok, fail } = require('../utils/respond');

const {
  registerSchema, loginSchema, verifyEmailSchema,
  forgotPasswordSchema, resetPasswordSchema,
} = require('../schemas/auth.schema');

const {
  signAccessToken, signEmailToken, signResetToken,
  verifyEmailToken, verifyResetToken, generateRefreshToken, hashRefreshToken,
} = require('../utils/jwt');

const { sendVerificationEmail, sendPasswordResetEmail, sendWelcomeEmail } = require('../utils/email');
const { generateLicenseKey, planSeats, planExpiry } = require('../utils/license');

const BCRYPT_COST = 12;
const REFRESH_COOKIE = 'ndm_refresh';

const REFRESH_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
// Non-httpOnly marker with the same lifetime as the refresh cookie. It holds no
// secret — it only tells the site "there may be a session, try /user/me", so a
// visitor who never signed in does not trigger a 401 + refresh on every load.
const SESSION_HINT_COOKIE = 'ndm_session';

function refreshCookieOptions() {
  return {
    httpOnly: true, sameSite: 'lax', secure: config.isProd,
    maxAge: REFRESH_MAX_AGE, path: '/api/auth',
  };
}

function setSessionHint(res) {
  res.cookie(SESSION_HINT_COOKIE, '1', {
    httpOnly: false, sameSite: 'lax', secure: config.isProd, maxAge: REFRESH_MAX_AGE, path: '/',
  });
}

router.post(
  '/register', authLimiter, requireTurnstile, validate(registerSchema),
  asyncHandler(async (req, res) => {
    const { name, email, password } = req.body;
    const existing = await User.findByEmail(email);
    if (existing) return fail(res, 'EMAIL_EXISTS', 'An account with this email already exists', 409);

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const user = await User.create({ name, email, passwordHash, emailVerified: false });

    await Subscription.create({
      userId: user.id, plan: 'free', status: 'active',
      licenseKey: generateLicenseKey(), seats: planSeats('free'),
      startDate: new Date(), expiryDate: planExpiry('free'),
    });

    const verifyToken = signEmailToken(user);
    await sendVerificationEmail(user, verifyToken);
    return ok(res, { userId: String(user.id) }, 201);
  })
);

router.post(
  '/login', authLimiter, validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findByEmail(email);
    if (!user) return fail(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return fail(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);

    if (!user.email_verified && config.EMAIL_VERIFICATION_REQUIRED)
      return fail(res, 'EMAIL_NOT_VERIFIED', 'Please verify your email before logging in', 403);

    const token = signAccessToken(user);
    const { token: refreshToken, hash } = generateRefreshToken();
    await User.update(user.id, { refreshTokenHash: hash });
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());
    setSessionHint(res);

    return ok(res, {
      token,
      user: { id: String(user.id), name: user.name, email: user.email, role: user.role },
    });
  })
);

router.post(
  '/verify-email', validate(verifyEmailSchema),
  asyncHandler(async (req, res) => {
    const { token } = req.body;
    let payload;
    try { payload = verifyEmailToken(token); }
    catch { return fail(res, 'INVALID_TOKEN', 'Verification link is invalid or has expired', 400); }
    const user = await User.findById(Number(payload.sub));
    if (!user) return fail(res, 'INVALID_TOKEN', 'Verification link is invalid or has expired', 400);
    await User.update(user.id, { emailVerified: true });
    // Best-effort: a mail failure must never make verification look broken.
    if (!user.email_verified)
      await sendWelcomeEmail(user).catch((err) =>
        console.error('[auth] welcome email failed:', err.message));
    return ok(res, { verified: true });
  })
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const cookie = req.cookies && req.cookies[REFRESH_COOKIE];
    if (!cookie) return fail(res, 'NO_REFRESH_TOKEN', 'Missing refresh token', 401);
    const hash = hashRefreshToken(cookie);
    const user = await User.findByRefreshTokenHash(hash);
    if (!user) return fail(res, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or has expired', 401);
    const { token: rt, hash: newHash } = generateRefreshToken();
    await User.update(user.id, { refreshTokenHash: newHash });
    res.cookie(REFRESH_COOKIE, rt, refreshCookieOptions());
    setSessionHint(res);
    return ok(res, { token: signAccessToken(user) });
  })
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const cookie = req.cookies && req.cookies[REFRESH_COOKIE];
    if (cookie) {
      const hash = hashRefreshToken(cookie);
      const user = await User.findByRefreshTokenHash(hash);
      if (user) await User.update(user.id, { refreshTokenHash: null });
    }
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    res.clearCookie(SESSION_HINT_COOKIE, { path: '/' });
    return ok(res, { loggedOut: true });
  })
);

router.post(
  '/forgot-password', authLimiter, requireTurnstile, validate(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    const { email } = req.body;
    const user = await User.findByEmail(email);
    if (user) {
      const resetToken = signResetToken(user);
      await sendPasswordResetEmail(user, resetToken);
    }
    return ok(res, { sent: true });
  })
);

router.post(
  '/reset-password', authLimiter, validate(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    const { token, password } = req.body;
    let payload;
    try { payload = verifyResetToken(token); }
    catch { return fail(res, 'INVALID_TOKEN', 'Reset link is invalid or has expired', 400); }
    const user = await User.findById(Number(payload.sub));
    if (!user) return fail(res, 'INVALID_TOKEN', 'Reset link is invalid or has expired', 400);
    await User.update(user.id, {
      passwordHash: await bcrypt.hash(password, BCRYPT_COST),
      refreshTokenHash: null,
      adminRefreshTokenHash: null,
    });
    return ok(res, { reset: true });
  })
);

module.exports = router;
