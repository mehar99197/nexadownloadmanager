'use strict';

/**
 * Two-factor authentication for the control panels, shared by /api/admin and
 * /api/root. Each realm mounts it with its own token family, so a staff 2FA
 * challenge can never complete a creator login and vice versa.
 *
 * Login flow once 2FA is on:
 *   POST <realm>/login           → { requiresTwoFactor:true, challenge }   (no session yet)
 *   POST <realm>/login/2fa       { challenge, code } → { token, admin }     (session issued)
 *
 * Enrolment (behind the realm's bearer gate):
 *   GET  <realm>/2fa             → { enabled, pending, recoveryCodesLeft }
 *   POST <realm>/2fa/setup       → { secret, otpauthUrl }   secret stored, NOT yet enabled
 *   POST <realm>/2fa/enable      { code } → { enabled:true, recoveryCodes:[…] }  shown once
 *   POST <realm>/2fa/disable     { password, code } → { enabled:false }
 *
 * The challenge is a 5-minute JWT of the realm's family carrying typ
 * "2fa-<realm>"; it proves the password step already passed and nothing else.
 */

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const User = require('../models/User');
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const { ok, fail } = require('../utils/respond');
const { twoFactorLimiter } = require('../middleware/rateLimiter');
const totp = require('../utils/totp');
const {
  twoFactorLoginSchema, twoFactorEnableSchema, twoFactorDisableSchema,
} = require('../schemas/twoFactor.schema');

const CHALLENGE_TTL = '5m';

function parseRecovery(value) {
  if (!value) return [];
  try {
    const list = JSON.parse(value);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function signChallenge(user, { secret, realm }) {
  return jwt.sign({ sub: String(user.id), typ: `2fa-${realm}` }, secret, { expiresIn: CHALLENGE_TTL });
}

function verifyChallenge(token, { secret, realm }) {
  // SECURITY: Verify token type BEFORE any other logic to prevent token confusion attacks
  const payload = jwt.verify(token, secret);
  if (!payload || payload.typ !== `2fa-${realm}`) {
    throw new jwt.JsonWebTokenError('invalid challenge type');
  }
  return payload;
}

/**
 * Check a TOTP code or a recovery code against the user's stored secret.
 *
 * Returns { ok, usedRecovery, remaining, step }. The caller persists
 * `remaining` when a recovery code was consumed — and this now also burns the
 * TOTP step it accepted, so the same six digits cannot be presented twice.
 *
 * Without that, a code stayed usable for its own 30-second step plus the drift
 * step either side: whoever read it over a shoulder, out of a phishing page or
 * from a logged request body had up to 90 seconds to use it a second time,
 * which is exactly the window a real-time phishing proxy operates in. A
 * recovery code was already single-use; the authenticator code was not.
 *
 * `totp_last_step` is a monotonic high-water mark rather than a set of spent
 * codes: steps only move forward, so `step <= totp_last_step` rejects both the
 * replay and any attempt to walk backwards into the drift window.
 */
async function checkCode(user, code) {
  const secret = totp.decryptSecret(user.totp_secret);
  if (secret) {
    const match = totp.matchTotp(secret, code);
    if (match.ok) {
      const lastStep = Number(user.totp_last_step) || 0;
      if (match.step <= lastStep) return { ok: false, replayed: true };
      await User.update(user.id, { totpLastStep: match.step });
      return { ok: true, usedRecovery: false, step: match.step };
    }
  }
  const remaining = totp.consumeRecoveryCode(parseRecovery(user.totp_recovery), code);
  if (remaining) return { ok: true, usedRecovery: true, remaining };
  return { ok: false };
}

function twoFactorState(user) {
  return {
    enabled: Boolean(user.totp_enabled),
    pending: Boolean(user.totp_secret) && !user.totp_enabled,
    recoveryCodesLeft: user.totp_enabled ? parseRecovery(user.totp_recovery).length : 0,
  };
}

/**
 * Mount the 2FA routes on a realm router.
 *
 * @param router        express router for the realm (before its bearer gate is applied)
 * @param realm         'admin' | 'root'
 * @param secret        that realm's JWT secret (challenge signing)
 * @param eligible(u)   is this user allowed to sign in to this realm at all?
 * @param finishLogin(res, user) → response data once both factors passed
 * @param audit(req, action, user, summary)
 * @param gate          the realm's requireAdmin / requireRoot middleware array
 */
function mountTwoFactor(router, {
  realm, secret, eligible, finishLogin, audit, gate,
  // The request property the gate fills: `admin` for the panels, `user`
  // for customers (middleware/auth.js).
  subject = (req) => req.admin,
  // The issuer label the authenticator app shows for this entry.
  issuer = `Nexa ${realm === 'root' ? 'Root' : 'Admin'}`,
  // (req, user, 'failed' | 'replayed' | 'recovery' | 'enabled' | 'disabled') —
  // the customer realm feeds utils/securityEvents.js from here.
  onEvent = async () => {},
}) {
  const family = { secret, realm };

  router.post(
    '/login/2fa', twoFactorLimiter, validate(twoFactorLoginSchema),
    asyncHandler(async (req, res) => {
      let payload;
      try { payload = verifyChallenge(req.body.challenge, family); }
      catch { return fail(res, 'INVALID_CHALLENGE', 'Sign in again — the code prompt has expired', 401); }
      const user = await User.findById(Number(payload.sub));
      if (!user || !eligible(user) || user.banned)
        return fail(res, 'INVALID_CHALLENGE', 'Sign in again — the code prompt has expired', 401);
      if (!user.totp_enabled) return fail(res, 'NOT_ENABLED', 'Two-factor authentication is not enabled', 400);

      const result = await checkCode(user, req.body.code);
      if (!result.ok) {
        if (result.replayed) {
          await audit(req, `${realm}.code_replayed`, user,
            `${user.email} presented an already-used two-factor code`);
          await onEvent(req, user, 'replayed');
          return fail(res, 'CODE_ALREADY_USED',
            'That code has already been used. Wait for your app to show the next one.', 401);
        }
        await onEvent(req, user, 'failed');
        return fail(res, 'INVALID_CODE', 'That code is not valid', 401);
      }
      if (result.usedRecovery) {
        await User.update(user.id, { totpRecovery: JSON.stringify(result.remaining) });
        await audit(req, `${realm}.recovery_code_used`, user,
          `${user.email} signed in with a recovery code (${result.remaining.length} left)`);
        await onEvent(req, user, 'recovery');
      }
      return ok(res, await finishLogin(res, user, req));
    })
  );

  router.get('/2fa', gate, asyncHandler(async (req, res) => ok(res, twoFactorState(subject(req)))));

  router.post(
    '/2fa/setup', gate,
    asyncHandler(async (req, res) => {
      const me = subject(req);
      if (me.totp_enabled)
        return fail(res, 'ALREADY_ENABLED', 'Two-factor authentication is already on. Turn it off first to re-enrol.', 400);
      const secret = totp.generateSecret();
      await User.update(me.id, {
        totpSecret: totp.encryptSecret(secret), totpRecovery: null, totpLastStep: null,
      });
      return ok(res, {
        secret,
        otpauthUrl: totp.otpauthUrl({ secret, account: me.email, issuer }),
      });
    })
  );

  router.post(
    '/2fa/enable', gate, twoFactorLimiter, validate(twoFactorEnableSchema),
    asyncHandler(async (req, res) => {
      const me = subject(req);
      if (me.totp_enabled)
        return fail(res, 'ALREADY_ENABLED', 'Two-factor authentication is already on', 400);
      const secret = totp.decryptSecret(me.totp_secret);
      if (!secret) return fail(res, 'NOT_SET_UP', 'Start the setup first', 400);
      const match = totp.matchTotp(secret, req.body.code);
      if (!match.ok)
        return fail(res, 'INVALID_CODE', 'That code is not valid — check the time on your phone and try again', 400);
      const { codes, hashes } = totp.generateRecoveryCodes();
      // totpLastStep in the same write: the code that turned 2FA on is spent,
      // so it cannot be turned straight back around at /2fa/disable.
      await User.update(me.id, {
        totpEnabled: 1, totpRecovery: JSON.stringify(hashes), totpLastStep: match.step,
      });
      await audit(req, `${realm}.2fa_enabled`, me, `${me.email} turned on two-factor authentication`);
      await onEvent(req, me, 'enabled');
      return ok(res, { enabled: true, recoveryCodes: codes });
    })
  );

  router.post(
    '/2fa/disable', gate, twoFactorLimiter, validate(twoFactorDisableSchema),
    asyncHandler(async (req, res) => {
      const me = subject(req);
      if (!me.totp_enabled)
        return fail(res, 'NOT_ENABLED', 'Two-factor authentication is not on', 400);
      // Every account that has a password must prove it. A Google-created
      // customer has none (routes/user.js makes the same allowance for
      // deleting the account); the code from the enrolled authenticator is
      // the proof available for it. Panel accounts always have a password.
      if (me.password_hash) {
        if (!req.body.password)
          return fail(res, 'INVALID_PASSWORD', 'Password is required to turn off two-factor authentication', 400);
        if (!await bcrypt.compare(req.body.password, me.password_hash))
          return fail(res, 'INVALID_PASSWORD', 'Password is incorrect', 400);
      }
      const result = await checkCode(me, req.body.code);
      if (!result.ok)
        return fail(res, result.replayed ? 'CODE_ALREADY_USED' : 'INVALID_CODE',
          result.replayed
            ? 'That code has already been used. Wait for your app to show the next one.'
            : 'That code is not valid', 400);
      await User.update(me.id, {
        totpEnabled: 0, totpSecret: null, totpRecovery: null, totpLastStep: null,
      });
      await audit(req, `${realm}.2fa_disabled`, me, `${me.email} turned off two-factor authentication`);
      await onEvent(req, me, 'disabled');
      return ok(res, { enabled: false });
    })
  );
}

module.exports = { mountTwoFactor, signChallenge, verifyChallenge, checkCode, twoFactorState };
