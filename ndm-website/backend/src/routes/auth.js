'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const config = require('../config/env');
const User = require('../models/User');
const Subscription = require('../models/Subscription');

const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const { authLimiter, loginLimiter, authIpLimiter } = require('../middleware/rateLimiter');
const { requireTurnstile } = require('../middleware/turnstile');
const { ok, fail } = require('../utils/respond');

const {
  registerSchema, loginSchema, verifyEmailSchema,
  forgotPasswordSchema, resetPasswordSchema, googleSchema, resendVerificationSchema,
} = require('../schemas/auth.schema');

const {
  signAccessToken, signEmailToken, signResetToken,
  verifyEmailToken, verifyResetToken, generateRefreshToken, hashRefreshToken,
} = require('../utils/jwt');

const {
  sendVerificationEmail, sendPasswordResetEmail, sendWelcomeEmail, sendAccountExistsEmail,
} = require('../utils/email');
const { verifyGoogleIdToken } = require('../utils/googleAuth');
const { generateLicenseKey, planSeats, planExpiry } = require('../utils/license');

const BCRYPT_COST = 12;

// A real bcrypt hash of a value nobody knows, compared against when an account
// has no password of its own so that branch costs the same as a genuine check.
// Generated at runtime rather than committed: nothing fixed to target, and no
// constant anyone could ever make the compare accept.
//
// Lazily, and deliberately: bcryptjs is pure JavaScript, so hashing at cost 12
// blocks the event loop for the better part of a second. At module load that
// delay lands squarely in process start-up, where it holds up the listen() and
// everything queued behind it. Here it costs one passwordless sign-in, once.
let dummyPasswordHash = null;
function dummyHash() {
  if (!dummyPasswordHash)
    dummyPasswordHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), BCRYPT_COST);
  return dummyPasswordHash;
}
const REFRESH_COOKIE = 'ndm_refresh';

const REFRESH_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
// Non-httpOnly marker with the same lifetime as the refresh cookie. It holds no
// secret — it only tells the site "there may be a session, try /user/me", so a
// visitor who never signed in does not trigger a 401 + refresh on every load.
const SESSION_HINT_COOKIE = 'ndm_session';

function refreshCookieOptions() {
  return {
    httpOnly: true, sameSite: 'lax', secure: config.secureCookies,
    maxAge: REFRESH_MAX_AGE, path: '/api/auth',
  };
}

function setSessionHint(res) {
  res.cookie(SESSION_HINT_COOKIE, '1', {
    httpOnly: false, sameSite: 'lax', secure: config.secureCookies, maxAge: REFRESH_MAX_AGE, path: '/',
  });
}

router.post(
  '/register', authLimiter, requireTurnstile, validate(registerSchema),
  asyncHandler(async (req, res) => {
    const { name, email, password } = req.body;

    // Hashed BEFORE the lookup, deliberately. bcrypt at cost 12 is a quarter of
    // a second; doing it only on the "new address" branch would put that
    // quarter second between the two answers and rebuild, in the response time,
    // exactly the oracle the equal bodies below remove.
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    // Registration must not tell a stranger whether an address is registered.
    // The 409 EMAIL_EXISTS this used to return was a free, definitive
    // membership oracle for any address anyone cared to type — the kind of
    // list that gets sold, credential-stuffed and phished. So an existing
    // address takes the same code path shape as a new one: the same success
    // body, the same status, an email sent, and nothing said on the wire.
    //
    // The person entitled to know IS told, in their own inbox: the
    // account-exists mail explains that no new account was created and points
    // at sign-in and password reset. It carries nothing that grants access, so
    // triggering it on somebody else's address achieves only that they hear
    // about it.
    //
    // Both branches answer `201 {ok:true, data:{}}`, byte for byte. This used
    // to return `{ userId }` on the real-registration branch only, so the
    // PRESENCE of that field was itself the oracle the equal status codes were
    // meant to remove — and it leaked a sequential user id besides. Nothing
    // consumes it: the site navigates to /login on any success.
    const existing = await User.findByEmail(email);
    if (existing) {
      await sendAccountExistsEmail(existing).catch((err) =>
        // eslint-disable-next-line no-console
        console.error('[auth] account-exists notice failed:', err.message));
      return ok(res, {}, 201);   // identical to the success body below
    }

    const user = await User.create({ name, email, passwordHash, emailVerified: false });

    await Subscription.create({
      userId: user.id, plan: 'free', status: 'active',
      licenseKey: generateLicenseKey(), seats: planSeats('free'),
      startDate: new Date(), expiryDate: planExpiry('free'),
    });

    // Best-effort, like every other outbound mail here. The account IS created
    // at this point, so a 500 from the mail server would tell the visitor their
    // sign-up failed when it did not, and their retry then lands on the
    // account-exists branch above. A visitor who never gets the mail can ask
    // for it again (POST /auth/resend-verification); one who thinks the sign-up
    // failed is simply stuck. (Harmless while email ran in mock mode, which
    // never throws; real SMTP does.)
    const verifyToken = signEmailToken(user);
    await sendVerificationEmail(user, verifyToken).catch((err) =>
      // eslint-disable-next-line no-console
      console.error('[auth] verification email failed:', err.message));
    return ok(res, {}, 201);
  })
);

router.post(
  // Counted per (IP, email) so one person mistyping their password cannot lock
  // out an entire office NAT, with a looser per-IP ceiling behind it so cycling
  // through addresses is not a way around that. See middleware/rateLimiter.js.
  '/login', authIpLimiter, loginLimiter, validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findByEmail(email);
    if (!user) return fail(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);

    // A Google-created account has no password hash at all — but saying so was
    // the last membership oracle on this API: `PASSWORD_NOT_SET` for an address
    // that exists, versus `INVALID_CREDENTIALS` for one that does not, is a
    // yes/no answer about any address anybody cares to type. Registration no
    // longer leaks that, so leaking it here would only move the hole.
    //
    // Nothing is lost by staying quiet. The sign-in page shows the Google
    // button beside the form, and after ANY failed sign-in it now says that an
    // account created with Google needs that button — advice it can give
    // without the server having confirmed anything about the address.
    //
    // The dummy compare is not decoration: bcrypt at cost 12 takes a quarter of
    // a second, so returning early here would leave "no password set" and
    // "wrong password" trivially distinguishable by response time.
    const match = user.password_hash
      ? await bcrypt.compare(password, user.password_hash)
      : (await bcrypt.compare(password, dummyHash()), false);
    if (!match) return fail(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);

    if (user.banned) return fail(res, 'FORBIDDEN', 'Account is banned', 403);

    if (!user.email_verified && config.EMAIL_VERIFICATION_REQUIRED)
      return fail(res, 'EMAIL_NOT_VERIFIED',
        'Please verify your email address first. Check your inbox, or ask for a new link.', 403,
        { canResend: true });

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
  '/google', authLimiter, validate(googleSchema),
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
        // has just confirmed it. Never overwrite an existing name.
        //
        // An UNVERIFIED local account is treated as unowned, and its password
        // is dropped. That closes a pre-registration takeover: anybody could
        // sign up with a stranger's address, never verify it, and simply wait.
        // When the real owner arrived through Google, the two accounts were
        // merged and the address was marked verified — leaving the squatter's
        // password live on the victim's account, licence key and billing. A
        // verified account is a different matter: the person proved they own
        // the address before Google was ever involved, so their password
        // stands.
        const unowned = !byEmail.email_verified;
        await User.update(byEmail.id, {
          googleId: identity.googleId,
          emailVerified: true,
          ...(byEmail.avatar_url ? {} : { avatarUrl: identity.picture }),
          ...(unowned ? { passwordHash: null } : {}),
        });
        if (unowned) {
          // Kill anything the squatter was already holding.
          await User.revokeSessions(byEmail.id);
          // eslint-disable-next-line no-console
          console.warn(`[auth] google link cleared the unverified password on account ${byEmail.id}`);
        }
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
    const { token: refreshToken, hash } = generateRefreshToken();
    await User.update(user.id, { refreshTokenHash: hash });
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());
    setSessionHint(res);

    return ok(res, {
      token,
      created,
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

/**
 * POST /auth/resend-verification — send the verification link again.
 *
 * Without this the verification requirement is a trap: a link that expires
 * after an hour, an address that went to spam, or a run where email was in
 * mock mode leaves the account permanently unreachable. There is no way to
 * sign in to ask for another, so it has to be an anonymous endpoint.
 *
 * The answer is the same whether or not the address is registered, and whether
 * or not it is already verified: this is an unauthenticated endpoint, so any
 * difference in the reply turns it into a way to test which addresses have
 * accounts. Behind the same limiter as register/forgot.
 */
router.post(
  '/resend-verification', authLimiter, requireTurnstile, validate(resendVerificationSchema),
  asyncHandler(async (req, res) => {
    const user = await User.findByEmail(req.body.email);
    if (user && !user.email_verified && !user.banned) {
      await sendVerificationEmail(user, signEmailToken(user)).catch((err) =>
        // eslint-disable-next-line no-console
        console.error('[auth] resend verification email failed:', err.message));
    }
    return ok(res, { sent: true });
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
    // The same two gates login applies. A cookie issued before an account was
    // banned — or before verification became a requirement — must not quietly
    // mint fresh access tokens for the next thirty days.
    if (user.banned) return fail(res, 'FORBIDDEN', 'Account is banned', 403);
    if (!user.email_verified && config.EMAIL_VERIFICATION_REQUIRED)
      return fail(res, 'EMAIL_NOT_VERIFIED',
        'Please verify your email address first. Check your inbox, or ask for a new link.', 403,
        { canResend: true });
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
      // Swallowing the failure is what keeps this endpoint's answer constant.
      // It returns `sent: true` for an unknown address on purpose, so that it
      // never reveals who has an account — but an SMTP error thrown from here
      // would answer 500 for exactly the addresses that DO exist, handing back
      // the enumeration oracle the constant answer was hiding.
      await sendPasswordResetEmail(user, resetToken).catch((err) =>
        // eslint-disable-next-line no-console
        console.error('[auth] password reset email failed:', err.message));
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
    // The link is single use: it carries the session generation it was minted
    // with, and the revocation below moves that on. A second attempt with the
    // same link — or with an older one still inside its hour — fails here.
    if ((Number(payload.tv) || 0) !== (Number(user.token_version) || 0))
      return fail(res, 'INVALID_TOKEN', 'Reset link is invalid or has expired', 400);
    await User.update(user.id, {
      passwordHash: await bcrypt.hash(password, BCRYPT_COST),
      // Receiving this link is itself proof the person reads that inbox, which
      // is exactly what verification asks for. Marking it here gives every
      // account created while email was undeliverable a way back in, instead of
      // stranding it behind a verification mail it can never receive.
      emailVerified: true,
    });
    // Ends every other session on the account — the whole point of a reset when
    // the reason for it is "somebody else may be in here".
    await User.revokeSessions(user.id);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    res.clearCookie(SESSION_HINT_COOKIE, { path: '/' });
    return ok(res, { reset: true });
  })
);

module.exports = router;
