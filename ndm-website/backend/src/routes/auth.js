'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');

const config = require('../config/env');
const User = require('../models/User');
const UserSession = require('../models/UserSession');
const Subscription = require('../models/Subscription');

const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const {
  loginLimiter, registerLimiter, forgotPasswordLimiter, resetPasswordLimiter, googleLimiter,
  loginSlowdown, recordLoginFailure, clearLoginFailures,
  sessionRefreshLimiter, verifyEmailLimiter,
} = require('../middleware/rateLimiter');
const { requireTurnstile } = require('../middleware/turnstile');
const { ok, fail } = require('../utils/respond');

const {
  registerSchema, loginSchema, verifyEmailSchema,
  forgotPasswordSchema, resetPasswordSchema, googleSchema,
} = require('../schemas/auth.schema');

const {
  signAccessToken, signEmailToken, signResetToken,
  verifyEmailToken, verifyResetToken, generateRefreshToken, hashRefreshToken,
} = require('../utils/jwt');

const { sendVerificationEmail, sendPasswordResetEmail, sendWelcomeEmail } = require('../utils/email');
const { verifyGoogleIdToken } = require('../utils/googleAuth');
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

function refreshExpiry() {
  return new Date(Date.now() + REFRESH_MAX_AGE);
}

// Open a NEW session row for this browser and set its cookies. Every sign-in
// path (password, Google) goes through here so a second device never touches
// the first one's session.
async function openSession(req, res, user) {
  const { token: refreshToken, hash } = generateRefreshToken();
  await UserSession.create({
    userId: user.id, tokenHash: hash,
    userAgent: req.get('user-agent') || null, ip: req.ip || null,
    expiresAt: refreshExpiry(),
  });
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());
  setSessionHint(res);
}

router.post(
  // requireTurnstile must precede validate(): it strips `turnstileToken` from
  // the body, which the .strict() schema would otherwise reject. The limiter
  // sits AFTER validate so a schema-invalid request spends no auth quota.
  '/register', requireTurnstile, validate(registerSchema), registerLimiter,
  asyncHandler(async (req, res) => {
    const { name, email, password } = req.body;

    // Hash FIRST, before looking the address up, so both paths below cost the
    // same. bcrypt at cost 12 is ~250 ms; doing it only for new accounts would
    // make "this address is taken" measurable with a stopwatch even though the
    // responses are identical.
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    const existing = await User.findByEmail(email);
    if (!existing) {
      const user = await User.create({ name, email, passwordHash, emailVerified: false });

      await Subscription.create({
        userId: user.id, plan: 'free', status: 'active',
        licenseKey: generateLicenseKey(), seats: planSeats('free'),
        startDate: new Date(), expiryDate: planExpiry('free'),
      });

      const verifyToken = signEmailToken(user);
      await sendVerificationEmail(user, verifyToken);
    }

    // The SAME answer either way. Returning 409 EMAIL_EXISTS turned sign-up
    // into an account oracle: anyone could test a list of addresses and learn
    // which ones have accounts here. The person who really owns the address
    // finds out through their inbox — either a verification email, or nothing
    // because they already signed up — which is the only channel that proves
    // they own it. The body carries no id for the same reason.
    return ok(res, { registered: true }, 201);
  })
);

router.post(
  '/login', validate(loginSchema), loginLimiter, loginSlowdown,
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findByEmail(email);
    if (!user) {
      // Counted even for an unknown address: otherwise the delay itself would
      // tell an attacker which addresses are registered.
      recordLoginFailure(email);
      return fail(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
    }

    // A Google-created account has no password hash at all. Saying so is not a
    // disclosure risk (the sign-in page offers both buttons anyway) and it saves
    // the user guessing at a password that was never set.
    //
    // WP-11: the wording must not describe where the button is. Production said
    // "Use “Continue with Google” below" while the button sits ABOVE the form,
    // and any such phrasing breaks again the next time the layout moves or on a
    // narrow screen. Name the control, never its position.
    if (!user.password_hash)
      return fail(res, 'PASSWORD_NOT_SET',
        'This account was created with Google. Sign in with the “Continue with Google” button, or set a password via “Forgot password”.', 409);

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      recordLoginFailure(email);
      return fail(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
    }

    if (!user.email_verified && config.EMAIL_VERIFICATION_REQUIRED)
      return fail(res, 'EMAIL_NOT_VERIFIED', 'Please verify your email before logging in', 403);

    // Proof of ownership: drop whatever slowdown a guesser had built up, so a
    // burst of wrong passwords never costs the real owner anything afterwards.
    clearLoginFailures(email);

    const token = signAccessToken(user);
    await openSession(req, res, user);

    return ok(res, {
      token,
      user: { id: String(user.id), name: user.name, email: user.email, role: user.role },
    });
  })
);

/**
 * POST /auth/google — "Continue with Google".
 *
 * The browser sends the ID token from Google Identity Services; it is verified
 * against Google's public keys (utils/googleAuth.js) before anything in it is
 * believed. Three cases follow:
 *
 *  1. `google_id` already known  → sign in.
 *  2. email already registered   → link this Google account to it, then sign in.
 *     Safe because Google asserts `email_verified` and the address is unique in
 *     our users table, so this cannot be used to hijack a stranger's account.
 *  3. nobody matches             → create the account (already verified — Google
 *     confirmed the address, so no verification email is needed) plus the usual
 *     free subscription that registration creates, then sign in.
 *
 * Turnstile is deliberately NOT applied: Google's own challenge already proves a
 * human, and there is no anonymous write here to abuse.
 */
router.post(
  '/google', validate(googleSchema), googleLimiter,
  asyncHandler(async (req, res) => {
    if (!config.isGoogleAuthEnabled)
      return fail(res, 'GOOGLE_AUTH_DISABLED', 'Google sign-in is not available', 503);

    let identity;
    try {
      identity = await verifyGoogleIdToken(req.body.credential);
    } catch (err) {
      // The reason is logged for operators but never echoed verbatim: it can
      // describe our own configuration.
      // eslint-disable-next-line no-console
      console.error('[auth] google credential rejected:', err.message);
      return fail(res, 'GOOGLE_AUTH_FAILED', 'Could not verify that Google sign-in. Please try again.', 401);
    }

    let user = await User.findByGoogleId(identity.googleId);
    let created = false;

    if (!user) {
      const byEmail = await User.findByEmail(identity.email);
      if (byEmail) {
        // Link, and take the opportunity to mark the address verified — Google
        // has just confirmed it. Never overwrite an existing name or password.
        await User.update(byEmail.id, {
          googleId: identity.googleId,
          emailVerified: true,
          ...(byEmail.avatar_url ? {} : { avatarUrl: identity.picture }),
        });
        user = await User.findById(byEmail.id);
      } else {
        user = await User.create({
          name: identity.name,
          email: identity.email,
          passwordHash: null,          // password sign-in stays unavailable until set
          emailVerified: true,
          googleId: identity.googleId,
          avatarUrl: identity.picture,
        });
        await Subscription.create({
          userId: user.id, plan: 'free', status: 'active',
          licenseKey: generateLicenseKey(), seats: planSeats('free'),
          startDate: new Date(), expiryDate: planExpiry('free'),
        });
        created = true;
        // Best-effort, exactly as in /verify-email: a mail failure must not make
        // a successful sign-up look broken.
        await sendWelcomeEmail(user).catch((err) =>
          console.error('[auth] welcome email failed:', err.message));
      }
    }

    if (user.banned) return fail(res, 'FORBIDDEN', 'Account is banned', 403);

    const token = signAccessToken(user);
    await openSession(req, res, user);

    return ok(res, {
      token,
      created,
      user: { id: String(user.id), name: user.name, email: user.email, role: user.role },
    });
  })
);

router.post(
  '/verify-email', verifyEmailLimiter, validate(verifyEmailSchema),
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
  '/refresh', sessionRefreshLimiter,
  asyncHandler(async (req, res) => {
    const cookie = req.cookies && req.cookies[REFRESH_COOKIE];
    if (!cookie) return fail(res, 'NO_REFRESH_TOKEN', 'Missing refresh token', 401);
    const hash = hashRefreshToken(cookie);
    const invalid = () =>
      fail(res, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or has expired', 401);

    let session = await UserSession.findLiveByTokenHash(hash);
    if (!session) {
      // A cookie issued before user_sessions existed still points at the old
      // single slot on the users row. Honour it once and move it into a row of
      // its own, so nobody has to sign in again just because we deployed.
      const legacy = await User.findByRefreshTokenHash(hash);
      if (!legacy) return invalid();
      await User.update(legacy.id, { refreshTokenHash: null });
      session = await UserSession.create({
        userId: legacy.id, tokenHash: hash,
        userAgent: req.get('user-agent') || null, ip: req.ip || null,
        expiresAt: refreshExpiry(),
      });
    }

    const user = await User.findById(session.user_id);
    if (!user || user.banned) {
      await UserSession.removeByTokenHash(hash);
      return invalid();
    }

    const { token: rt, hash: newHash } = generateRefreshToken();
    // Conditional on the OLD hash: if another tab already rotated this
    // session, this one loses cleanly instead of overwriting its cookie.
    if (!(await UserSession.rotate(session.id, hash, newHash, refreshExpiry())))
      return invalid();
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
      // Only THIS browser's session ends; every other device stays signed in.
      await UserSession.removeByTokenHash(hash);
      const legacy = await User.findByRefreshTokenHash(hash);
      if (legacy) await User.update(legacy.id, { refreshTokenHash: null });
    }
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    res.clearCookie(SESSION_HINT_COOKIE, { path: '/' });
    return ok(res, { loggedOut: true });
  })
);

router.post(
  '/forgot-password', requireTurnstile, validate(forgotPasswordSchema), forgotPasswordLimiter,
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
  '/reset-password', validate(resetPasswordSchema), resetPasswordLimiter,
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
    // A password reset signs the account out EVERYWHERE — that is the point of
    // one, and with per-browser sessions it now has to be said explicitly.
    await UserSession.removeAllForUser(user.id);
    return ok(res, { reset: true });
  })
);

module.exports = router;
