'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const config = require('../config/env');
const User = require('../models/User');
const { insert } = require('../config/db');
const Subscription = require('../models/Subscription');

const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
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
  sendControlPanelSignInAttemptEmail, sendAccountLockedEmail,
} = require('../utils/email');
const {
  isReservedEmail, isControlPanelAccount, CONTROL_PANEL_MESSAGE,
} = require('../utils/reservedEmail');
const { verifyGoogleIdToken } = require('../utils/googleAuth');
const { generateLicenseKey, planSeats, planExpiry } = require('../utils/license');
const { isLocked, recordFailure, recordSuccess, clearLock } = require('../utils/loginLockout');
const { passwordProblem } = require('../utils/passwordPolicy');
const UserSession = require('../models/UserSession');
const security = require('../utils/securityEvents');
const { mountTwoFactor, signChallenge } = require('./twoFactor');
const AuditLog = require('../models/AuditLog');

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

// The session cookies, their flags and issueSession() live in utils/session.js
// (shared with the profile route, which opens a fresh session after a
// password change).
const {
  REFRESH_COOKIE, REFRESH_MAX_AGE, refreshCookieOptions, setSessionHint,
  clearSessionCookies, issueSession,
} = require('../utils/session');

/**
 * The password (or Google) checked out. A two-factor account gets a challenge
 * instead of a session; everybody else gets the session.
 */
async function finishSignIn(req, res, user, extra = {}) {
  if (user.totp_enabled) {
    return ok(res, {
      requiresTwoFactor: true,
      challenge: signChallenge(user, { secret: config.JWT_SECRET, realm: 'user' }),
      ...extra,
    });
  }
  await security.record('login.success', { req, user });
  return ok(res, { ...(await issueSession(req, res, user)), ...extra });
}

router.post(
  '/register', authLimiter, requireTurnstile, validate(registerSchema),
  asyncHandler(async (req, res) => {
    const { name, email, password } = req.body;

    // Value rules (breached / contains the address) come before the hash and
    // before the lookup, so the refusal is the same for a new and an existing
    // address and nothing about membership rides on it.
    const problem = await passwordProblem(password, { email });
    if (problem) return fail(res, 'WEAK_PASSWORD', problem, 400);

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
      // …but not to a control-panel account. That mail tells the reader to sign
      // in or use "Forgot password", and neither is true for a staff or creator
      // row: the panels have their own login and the reset flow now refuses
      // them. Sending advice that cannot work is worse than sending nothing, so
      // this is logged for the operator instead. The RESPONSE is unchanged, so
      // the distinction stays invisible from outside.
      if (isControlPanelAccount(existing)) {
        // eslint-disable-next-line no-console
        console.warn('[SECURITY] registration attempted on a control-panel address');
      } else {
        // Not awaited, for the same reason as the reset mail below: this
        // branch sends one and the control-panel branch above sends none, so
        // waiting would make "which kind of account is this?" a stopwatch
        // question even though the bodies are identical.
        void sendAccountExistsEmail(existing).catch((err) =>
          // eslint-disable-next-line no-console
          console.error('[auth] account-exists notice failed:', err.message));
      }
      return ok(res, {}, 201);   // identical to the success body below
    }

    // The creator's address is reserved and cannot become a customer account.
    // Normally the creator's own row already occupies it and the branch above
    // handles this; reaching here means that row is gone, and a reserved
    // address must not be claimable by whoever registers first.
    //
    // Answered exactly like every other branch — same status, same empty body,
    // and the bcrypt above has already been paid — because a distinct error
    // here would point a stranger straight at the administrator's address.
    if (isReservedEmail(email)) {
      // eslint-disable-next-line no-console
      console.warn('[SECURITY] registration attempted on the reserved creator address');
      return ok(res, {}, 201);
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
    void sendVerificationEmail(user, verifyToken).catch((err) =>
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

    // One compare, three cases, the same cost — that is the whole point of the
    // shape below.
    //
    // A Google-created account has no password hash at all, and an unknown
    // address has no row. Saying either out loud was a membership oracle:
    // `PASSWORD_NOT_SET` for an address that exists versus
    // `INVALID_CREDENTIALS` for one that does not is a yes/no answer about any
    // address anybody cares to type. Registration no longer leaks that, so
    // leaking it here would only move the hole. Both now answer
    // `INVALID_CREDENTIALS`, exactly like a wrong password.
    //
    // Identical bodies are only half of it. This used to return early when
    // `user` was null, WITHOUT touching bcrypt — so a registered address paid
    // the quarter second and an unknown one came straight back. Measured on
    // this code, same box, same request: 580 ms against 1.8 ms, which reads as
    // cleanly as the error code the equal bodies were hiding. So every branch
    // now runs a real cost-12 compare, against the account's hash or against a
    // dummy nobody knows.
    //
    // `match` is false whenever `user` is null, so the rejection below still
    // fires and nothing past it can see a null user.
    //
    // Nothing is lost by staying quiet: the sign-in page shows the Google
    // button beside the form, and after ANY failed sign-in it says that an
    // account created with Google needs that button — advice it can give
    // without the server having confirmed anything about the address.
    //
    // A locked account (utils/loginLockout.js) takes the dummy branch too: the
    // real hash is never consulted while the lock holds, and the answer is the
    // same 401 after the same work, so the lock is not observable from here.
    const locked = isLocked(user);
    const match = user && user.password_hash && !locked
      ? await bcrypt.compare(password, user.password_hash)
      : (await bcrypt.compare(password, dummyHash()), false);
    if (!match) {
      // Only a genuine wrong guess at a customer account counts towards the
      // lock. A control-panel row is refused below whatever the password, and
      // must not be lockable from the customer form.
      if (user && user.password_hash && !locked && !isControlPanelAccount(user)) {
        const outcome = await recordFailure(user);
        if (outcome.locked) {
          await security.record('login.locked', { req, user, severity: 'warning',
            detail: `locked for ${outcome.minutes} min after repeated wrong passwords` });
          if (outcome.notify) {
            void sendAccountLockedEmail(user, outcome).catch((err) =>
              // eslint-disable-next-line no-console
              console.error('[auth] lockout notice failed:', err.message));
          }
        }
      }
      // Recorded for every refusal, known account or not — the stuffing rule
      // in utils/securityEvents.js counts across addresses. A locked account's
      // guesses are included: they are still somebody guessing.
      await security.record('login.failed', { req, email, user: user || undefined });
      return fail(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
    }

    // A control-panel account has no customer session, and this is the gate
    // that was missing. Register, "Continue with Google", forgot-password and
    // reset-password all learned to leave a staff or creator row alone; the
    // sign-in form never did — and it is the same row and the same
    // password_hash that /admin/login and /root/login check. So the creator's
    // credentials opened a customer session from any address, with no IP
    // allowlist and no second factor, and PUT /user/profile then rewrote that
    // very hash: the customer site was a way to *set* the panel password.
    //
    // Refused with the ORDINARY `INVALID_CREDENTIALS`, identical to a wrong
    // password — same code, same message, same status, same one bcrypt of work
    // before it. A named refusal here would be worse than the hole it closes:
    // credential-stuffing a leaked password against this form would answer
    // "wrong password" for thousands of ordinary addresses and "this one is the
    // administrator" for exactly one, which is the single address on the site
    // worth attacking, given away for free. That the caller already holds the
    // password is not a reason to confirm anything — a reused password from an
    // unrelated breach is exactly how they would be holding it.
    //
    // /admin/login and /root/login have always answered a *customer's* correct
    // credentials with the same flat `INVALID_CREDENTIALS`. This is that rule,
    // pointed the other way, so neither door reports what lives behind the
    // other.
    //
    // The person entitled to the explanation gets it in their own inbox, where
    // nobody else can read it — the same trade registration makes with
    // sendAccountExistsEmail. Not awaited, like every other conditional send in
    // this file: an SMTP round trip on one branch and not the other is the same
    // yes/no answer, read with a stopwatch.
    if (isControlPanelAccount(user)) {
      // eslint-disable-next-line no-console
      console.warn('[SECURITY] customer sign-in refused for a control-panel account');
      void sendControlPanelSignInAttemptEmail(user).catch((err) =>
        // eslint-disable-next-line no-console
        console.error('[auth] control-panel sign-in notice failed:', err.message));
      return fail(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
    }

    if (user.banned) return fail(res, 'FORBIDDEN', 'Account is banned', 403);

    if (!user.email_verified && config.EMAIL_VERIFICATION_REQUIRED)
      return fail(res, 'EMAIL_NOT_VERIFIED',
        'Please verify your email address first. Check your inbox, or ask for a new link.', 403,
        { canResend: true });

    await recordSuccess(user);
    // A hash made at a lower cost than today's is replaced with a fresh one
    // while the plaintext is in hand — the only moment that is possible — so
    // raising BCRYPT_COST later upgrades every account on its next sign-in
    // instead of needing a migration nobody can run without the passwords.
    if (bcrypt.getRounds(user.password_hash) < BCRYPT_COST) {
      await User.update(user.id, { passwordHash: await bcrypt.hash(password, BCRYPT_COST) });
    }

    return finishSignIn(req, res, user);
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
/**
 * OIDC nonce for "Continue with Google". The page asks for one before it
 * initialises Google Identity Services and passes it along; Google signs it
 * into the ID token; /google below requires the token's nonce to equal the
 * one this server issued to THIS browser (kept in an httpOnly cookie, so the
 * page cannot substitute its own). Signed rather than stored: HMAC over a
 * random value and an expiry, verifiable without a table. Single use is
 * enforced separately by the used_id_tokens ledger on the token's jti.
 */
const GOOGLE_NONCE_COOKIE = 'ndm_gnonce';
const GOOGLE_NONCE_TTL_MS = 30 * 60 * 1000;
function mintGoogleNonce() {
  const random = crypto.randomBytes(18).toString('base64url');
  const exp = Date.now() + GOOGLE_NONCE_TTL_MS;
  const sig = crypto.createHmac('sha256', config.JWT_SECRET).update(`${random}.${exp}`).digest('base64url').slice(0, 22);
  return `${random}.${exp}.${sig}`;
}
function googleNonceIsValid(nonce) {
  const parts = String(nonce || '').split('.');
  if (parts.length !== 3) return false;
  const [random, exp, sig] = parts;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', config.JWT_SECRET).update(`${random}.${exp}`).digest('base64url').slice(0, 22);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

router.get(
  '/google/nonce',
  asyncHandler(async (req, res) => {
    if (!config.isGoogleAuthEnabled)
      return fail(res, 'GOOGLE_AUTH_DISABLED', 'Google sign-in is not available', 503);
    const nonce = mintGoogleNonce();
    res.cookie(GOOGLE_NONCE_COOKIE, nonce, {
      httpOnly: true, secure: config.secureCookies, sameSite: 'strict',
      path: '/api/auth/google', maxAge: GOOGLE_NONCE_TTL_MS,
    });
    return ok(res, { nonce, expiresInSeconds: GOOGLE_NONCE_TTL_MS / 1000 });
  })
);

router.post(
  '/google', authLimiter, validate(googleSchema),
  asyncHandler(async (req, res) => {
    if (!config.isGoogleAuthEnabled)
      return fail(res, 'GOOGLE_AUTH_DISABLED', 'Google sign-in is not available', 503);

    // The nonce this server issued to this browser. The body copy is what
    // the page gave Google; the cookie is what we remember giving the page.
    // Both must be ours and agree, and the token must carry the same value.
    const nonce = req.cookies && req.cookies[GOOGLE_NONCE_COOKIE];
    res.clearCookie(GOOGLE_NONCE_COOKIE, { path: '/api/auth/google' });
    if (!nonce || !googleNonceIsValid(nonce) || (req.body.nonce && req.body.nonce !== nonce)) {
      await security.record('google.nonce_rejected', { req, severity: 'warning',
        detail: !nonce ? 'no nonce cookie' : !googleNonceIsValid(nonce) ? 'expired or forged nonce' : 'body/cookie nonce mismatch' });
      return fail(res, 'GOOGLE_NONCE_INVALID',
        'That Google sign-in has expired. Please reload the page and try again.', 401);
    }

    let identity;
    try {
      identity = await verifyGoogleIdToken(req.body.credential, { nonce });
    } catch (err) {
      // The reason is logged for operators but never echoed verbatim: it can
      // describe our own configuration.
      // eslint-disable-next-line no-console
      console.error('[auth] google credential rejected:', err.message);
      await security.record('google.token_rejected', { req, severity: 'warning', detail: err.message.slice(0, 200) });
      return fail(res, 'GOOGLE_AUTH_FAILED', 'Could not verify that Google sign-in. Please try again.', 401);
    }

    // One signed token opens one session. The ledger keeps the jti until the
    // token itself expires (an hour), after which Google's exp refuses it.
    if (identity.jti) {
      try {
        await insert('INSERT INTO used_id_tokens (jti, expires_at) VALUES (?, ?)',
          [identity.jti, identity.expiresAt || new Date(Date.now() + 60 * 60 * 1000)]);
      } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') {
          await security.record('google.token_replayed', { req, email: identity.email, severity: 'critical',
            detail: 'a Google ID token was presented a second time' });
          return fail(res, 'GOOGLE_AUTH_FAILED', 'Could not verify that Google sign-in. Please try again.', 401);
        }
        throw err;
      }
    }

    let user = await User.findByGoogleId(identity.googleId);
    let created = false;

    if (!user) {
      const byEmail = await User.findByEmail(identity.email);

      // The public sign-in flow may not create or modify a control-panel
      // identity. Linking would attach a second, self-service credential to an
      // account that signs in at /admin or /root — and would mark it verified
      // and possibly clear its password on the way. Whoever holds the mailbox
      // has proved nothing about the panel; the panels have their own login.
      //
      // This branch NAMES the reason where the password form deliberately does
      // not, and the difference is who is asking. A password proves only that
      // somebody, somewhere, once typed it — it travels in breach dumps, so
      // confirming "that address is the administrator" to whoever produced one
      // is a real disclosure. Google has just confirmed the caller reads that
      // mailbox, which is the same mailbox the password form's refusal is
      // explained in. There is nobody left to hide it from, and a vague answer
      // would only waste the creator's time.
      if (isReservedEmail(identity.email) || isControlPanelAccount(byEmail)) {
        // eslint-disable-next-line no-console
        console.warn('[SECURITY] google sign-in refused for a reserved/control-panel address');
        return fail(res, 'RESERVED_ADDRESS', CONTROL_PANEL_MESSAGE, 403);
      }

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

    return finishSignIn(req, res, user, { created });
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
 *
 * "The same" includes how long it takes. Every anonymous endpoint in this file
 * that sends mail on one branch and not another starts the send WITHOUT
 * awaiting it, because an SMTP round trip is seconds and the branch that skips
 * it answers in milliseconds — a difference a stopwatch reads as easily as an
 * error code would. Their outcome was already swallowed, so there was never
 * anything to wait for.
 */
router.post(
  '/resend-verification', authLimiter, requireTurnstile, validate(resendVerificationSchema),
  asyncHandler(async (req, res) => {
    const user = await User.findByEmail(req.body.email);
    if (user && !user.email_verified && !user.banned) {
      // Not awaited: only this branch sends anything, so waiting for SMTP made
      // the response time the very yes/no the identical body withholds.
      void sendVerificationEmail(user, signEmailToken(user)).catch((err) =>
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
    let session = await UserSession.findLive(hash);
    if (!session) {
      // Not a live token. Was it one that was just rotated away? Two tabs
      // refreshing on one cookie jar present the old cookie within seconds of
      // each other and are rotated again; a copy turning up later is a stolen
      // cookie, and the whole family ends — see models/UserSession.js.
      const replaced = await UserSession.findReplaced(hash);
      if (replaced && replaced.withinGrace) {
        session = replaced.session;
      } else {
        if (replaced) {
          await UserSession.revokeFamily(replaced.session.family);
          const owner = await User.findById(replaced.session.user_id);
          await security.record('session.reuse_detected', {
            req, user: owner || undefined, severity: 'critical',
            detail: `a rotated refresh token was presented again ${Math.round(Number(replaced.session.since_rotation_ms) / 1000)}s after rotation; session family revoked`,
          });
        }
        clearSessionCookies(res);
        return fail(res, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or has expired', 401);
      }
    }
    const user = await User.findById(session.user_id);
    if (!user) {
      clearSessionCookies(res);
      return fail(res, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or has expired', 401);
    }
    // The same two gates login applies. A cookie issued before an account was
    // banned — or before verification became a requirement — must not quietly
    // mint fresh access tokens for the next thirty days.
    if (user.banned) return fail(res, 'FORBIDDEN', 'Account is banned', 403);
    // The same rule as /login, applied to the cookie. A customer refresh cookie
    // issued before that rule existed — or before the account was promoted to
    // staff — would otherwise keep minting customer access tokens for thirty
    // days, which is exactly how long the hole would have outlived the fix.
    // The stale hash is cleared rather than merely refused, so a session that
    // should never have existed is actually gone rather than retried on every
    // page load.
    if (isControlPanelAccount(user)) {
      await UserSession.revokeFamily(session.family);
      clearSessionCookies(res);
      // Answered as an unusable cookie, not as "this is an admin". The holder
      // of the cookie already knows whose account it is, so there is nothing to
      // hide from them — but this response is what the SITE reads, and telling
      // the page a control-panel account exists behind this session is how such
      // a fact ends up rendered on a screen somebody else is looking at. The
      // browser simply falls back to signed-out, which is the truth.
      return fail(res, 'INVALID_REFRESH_TOKEN',
        'Refresh token is invalid or has expired', 401);
    }
    if (!user.email_verified && config.EMAIL_VERIFICATION_REQUIRED)
      return fail(res, 'EMAIL_NOT_VERIFIED',
        'Please verify your email address first. Check your inbox, or ask for a new link.', 403,
        { canResend: true });
    const { token: rt, hash: newHash } = generateRefreshToken();
    const rotated = await UserSession.rotate(session.id, session.token_hash, newHash, REFRESH_MAX_AGE);
    if (!rotated) {
      // Lost a race with a concurrent refresh of the same row: that request's
      // cookie is the live one now and the browser already holds it.
      return fail(res, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or has expired', 401);
    }
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
      // This browser's session only; the account's other sessions stay.
      const session = await UserSession.findLive(hashRefreshToken(cookie));
      if (session) await UserSession.revokeFamily(session.family);
    }
    clearSessionCookies(res);
    return ok(res, { loggedOut: true });
  })
);

router.post(
  '/forgot-password', authLimiter, requireTurnstile, validate(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    const { email } = req.body;
    const user = await User.findByEmail(email);
    // A control-panel account is not recoverable through the customer site.
    // /admin/login and /root/login check the SAME password_hash this flow
    // rewrites, so leaving it open turns read access to one mailbox into the
    // panel password. Recovery for the creator is `npm run create-root` on the
    // server, which updates the existing row — deliberately something you must
    // already be on the box to do.
    //
    // Silent, because this endpoint's whole design is a constant answer: it
    // returns `sent: true` for addresses that do not exist, and singling this
    // one out would mark it as the interesting address.
    if (isControlPanelAccount(user)) {
      // eslint-disable-next-line no-console
      console.warn('[SECURITY] password reset refused for a control-panel account');
      return ok(res, { sent: true });
    }
    if (user) {
      const resetToken = signResetToken(user);
      // Swallowing the failure is what keeps this endpoint's answer constant.
      // It returns `sent: true` for an unknown address on purpose, so that it
      // never reveals who has an account — but an SMTP error thrown from here
      // would answer 500 for exactly the addresses that DO exist, handing back
      // the enumeration oracle the constant answer was hiding.
      // Started, deliberately NOT awaited. The constant `sent: true` above is
      // only half of a constant answer: awaiting the SMTP round trip made this
      // endpoint take ~3 s for an address that HAS an account and ~3 ms for one
      // that does not, which is the same yes/no the body refuses to give,
      // readable with a stopwatch. Measured on production before this changed.
      //
      // Nothing is lost by not waiting: the outcome was already swallowed (see
      // above), so there was never anything to do with the result.
      void sendPasswordResetEmail(user, resetToken).catch((err) =>
        // eslint-disable-next-line no-console
        console.error('[auth] password reset email failed:', err.message));
      await security.record('password.reset_requested', { req, user });
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
    // Checked again at redemption, not only at issue: a link minted before the
    // rule above existed — or before the account was promoted to staff — must
    // not still rewrite a control-panel password an hour later.
    if (isControlPanelAccount(user)) {
      // eslint-disable-next-line no-console
      console.warn('[SECURITY] reset link redemption refused for a control-panel account');
      return fail(res, 'INVALID_TOKEN', 'Reset link is invalid or has expired', 400);
    }
    const problem = await passwordProblem(password, { email: user.email });
    if (problem) return fail(res, 'WEAK_PASSWORD', problem, 400);
    await User.update(user.id, {
      passwordHash: await bcrypt.hash(password, BCRYPT_COST),
      // Receiving this link is itself proof the person reads that inbox, which
      // is exactly what verification asks for. Marking it here gives every
      // account created while email was undeliverable a way back in, instead of
      // stranding it behind a verification mail it can never receive.
      emailVerified: true,
    });
    // Proof of the inbox is also the way out of a sign-in lock — the one the
    // lockout mail points at — and it takes the guessed-at password with it.
    await clearLock(user.id);
    // Ends every other session on the account — the whole point of a reset when
    // the reason for it is "somebody else may be in here".
    await User.revokeSessions(user.id);
    await security.record('password.reset', { req, user, detail: 'every session ended; lock cleared' });
    clearSessionCookies(res);
    return ok(res, { reset: true });
  })
);

// Customer two-factor authentication: the same routes the control panels use
// (routes/twoFactor.js), mounted on this router — /login/2fa completes a
// sign-in that answered `requiresTwoFactor`, /2fa/* manage enrolment from the
// account page. Optional for customers; the panels enforce it
// (ADMIN_2FA_REQUIRED, middleware/adminAuth.js).
mountTwoFactor(router, {
  realm: 'user',
  secret: config.JWT_SECRET,
  eligible: (user) => user.role === 'user',
  gate: requireAuth,
  subject: (req) => req.user,
  issuer: 'Nexa Download Manager',
  finishLogin: async (res, user, req) => {
    await security.record('login.success', { req, user, detail: 'two-factor' });
    return issueSession(req, res, user);
  },
  audit: (req, action, user, summary) =>
    AuditLog.create({ adminUserId: null, action, entityType: 'user', entityId: user.id, summary }),
  onEvent: (req, user, what) => security.record(
    { failed: '2fa.failed', replayed: '2fa.replayed', recovery: '2fa.recovery_used',
      enabled: '2fa.enabled', disabled: '2fa.disabled' }[what] || `2fa.${what}`,
    { req, user, severity: ['failed', 'replayed', 'recovery'].includes(what) ? 'warning' : 'info' }
  ),
});

module.exports = router;
