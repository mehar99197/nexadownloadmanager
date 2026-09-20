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
 *   GET  <realm>/2fa             → { enabled, pending, recoveryCodesLeft, recoveryCodesLegacy }
 *   POST <realm>/2fa/setup       → { secret, otpauthUrl }   secret stored, NOT yet enabled
 *   POST <realm>/2fa/enable      { code } → { enabled:true, recoveryCodes:[…] }  shown once
 *   POST <realm>/2fa/recovery-codes { password, code } → { recoveryCodes:[…] }  fresh set, shown once
 *   POST <realm>/2fa/disable     { password, code } → { enabled:false }
 *
 * The challenge is a 5-minute JWT of the realm's family carrying typ
 * "2fa-<realm>"; it proves the password step already passed and nothing else.
 *
 * An authenticator code is single-use. verifyTotp accepts one step of drift
 * either way, so the six digits stay arithmetically valid for up to 90
 * seconds; without a memory of what has been spent, a code read over a
 * shoulder or typed into a phishing page completes a second, attacker-driven
 * login in that window. Every accepted code's step is therefore spent against
 * users.totp_last_step, and checkCode refuses anything at or below it.
 *
 * That spend is a conditional UPDATE (User.spendTotpStep), not a read here and
 * a write afterwards. The threat this closes is a real-time phishing relay,
 * which forwards the victim's digits and submits its own login *alongside*
 * theirs — concurrent by construction, not by coincidence. Every await below
 * yields the event loop, so both requests would otherwise load the row before
 * either wrote to it, both find the step unspent, and both get a session;
 * behind pm2/cluster they are not even in the same process. checkCode's own
 * comparison is a cheap pre-check that saves a write on an obviously stale
 * code — the database row is what actually decides, and the request that
 * loses the race is refused exactly like a wrong code. The recovery-code path
 * is spent the same way, by swapping the set only while it still holds what
 * the offered code was matched against.
 *
 * Recovery codes enrolled before they were bcrypt-hashed sit in the row as
 * unsalted SHA-256 of ~52-bit codes, which a database read turns into an
 * offline crack. They are retired the next time the account signs in with
 * its authenticator — that sign-in proves the phone is present, so nobody is
 * locked out — and until then GET /2fa reports recoveryCodesLegacy so the
 * panel can ask for a fresh set from /2fa/recovery-codes.
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
 * The last TOTP step this account has already spent, or null for one that has
 * never used a code (and for rows written before the column existed). Number()
 * on its own will not do: Number(null) is 0, which would read as "step 0 is
 * already spent" rather than "nothing is".
 */
function lastUsedStep(user) {
  if (user.totp_last_step === null || user.totp_last_step === undefined) return null;
  const step = Number(user.totp_last_step);
  return Number.isFinite(step) ? step : null;
}

/**
 * Check a TOTP code or a recovery code against the user's stored secret.
 * Resolves to { ok, usedRecovery, remaining, step } — the caller spends the
 * result with spendCode(), which is what makes either kind single-use.
 * Async because recovery codes are bcrypt-compared; the TOTP path is tried
 * first and costs nothing.
 *
 * The step comparison here reads the row the caller already loaded, so it can
 * only see spends that finished before that read: it is a pre-check that
 * refuses an obviously stale code without paying for a write, NOT the guard.
 * spendCode() is the guard.
 */
async function checkCode(user, code) {
  const secret = totp.decryptSecret(user.totp_secret);
  const attempt = secret ? totp.verifyTotpStep(secret, code) : { ok: false };
  if (attempt.ok) {
    const last = lastUsedStep(user);
    // A step EQUAL to the stored one is the same code offered twice; a LOWER
    // one is an older code that is still inside the window — a clock that
    // drifted backwards, or a replay of something captured a minute ago.
    // Both are stale, and refusing them locks nobody out: the next step's code
    // is always above whatever was stored, so the account is at most one
    // 30-second step away from signing in.
    if (last !== null && attempt.step <= last) return { ok: false };
    return { ok: true, usedRecovery: false, step: attempt.step };
  }
  // Six digits can never normalise to a recovery code's ten characters, so a
  // refused TOTP falls through only to be told no again — the path below is
  // for the other shape.
  const remaining = await totp.consumeRecoveryCode(parseRecovery(user.totp_recovery), code);
  if (remaining) return { ok: true, usedRecovery: true, remaining };
  return { ok: false };
}

/**
 * Take the code a checkCode result accepted, so nothing else can. Resolves
 * true when this request is the one that got it and false when it lost the
 * race, which every caller answers with the same INVALID_CODE it would give a
 * wrong code — a distinct reply would tell an attacker their relayed digits
 * were genuine.
 *
 * Both kinds are spent by a single conditional statement, so the check and the
 * write cannot be pulled apart by a concurrent request:
 *   TOTP     — raise totp_last_step, only from a lower value or NULL.
 *   recovery — store the remaining set, only while the column still holds the
 *              one the code was matched against.
 */
async function spendCode(user, result) {
  if (result.usedRecovery) {
    const before = user.totp_recovery === undefined ? null : user.totp_recovery;
    return User.swapRecoveryCodes(user.id, before, JSON.stringify(result.remaining));
  }
  return User.spendTotpStep(user.id, result.step);
}

function twoFactorState(user) {
  const stored = user.totp_enabled ? parseRecovery(user.totp_recovery) : [];
  return {
    enabled: Boolean(user.totp_enabled),
    pending: Boolean(user.totp_secret) && !user.totp_enabled,
    recoveryCodesLeft: stored.length,
    // Pre-bcrypt SHA-256 codes still on the row: crackable from a database
    // read, so the panel should offer a fresh set rather than count them.
    recoveryCodesLegacy: stored.some(totp.isLegacyRecoveryHash),
  };
}

/**
 * Drop the pre-bcrypt SHA-256 recovery codes from a row, keeping any bcrypt
 * ones beside them. Called only once the authenticator has verified, so the
 * account keeps a working second factor; resolves to how many were retired
 * so the caller can audit it.
 *
 * Conditional on the set this call read, for the same reason the spends are:
 * a recovery sign-in running concurrently has just dropped a used code from
 * that column, and a blind write of "everything I saw minus the legacy ones"
 * would put it back — un-spending it. Losing the race retires nothing and
 * reports 0; the next authenticator sign-in retires them instead.
 */
async function retireLegacyRecoveryCodes(user) {
  const stored = parseRecovery(user.totp_recovery);
  const kept = stored.filter((entry) => !totp.isLegacyRecoveryHash(entry));
  if (kept.length === stored.length) return 0;
  const before = user.totp_recovery === undefined ? null : user.totp_recovery;
  if (!await User.swapRecoveryCodes(user.id, before, JSON.stringify(kept))) return 0;
  return stored.length - kept.length;
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
function mountTwoFactor(router, { realm, secret, eligible, finishLogin, audit, gate }) {
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
      if (!result.ok) return fail(res, 'INVALID_CODE', 'That code is not valid', 401);
      // Spend the code before the session exists, and only if this request is
      // the one that gets it: from here on that code is used up, whatever the
      // rest of this request does. A concurrent login offering the same code
      // loses here and is refused exactly like a wrong one — the whole point
      // of the column, since a relayed code arrives beside the real login
      // rather than after it. The recovery branch's spend IS this write: it
      // stores the remaining set, keeping whatever is left, legacy or not,
      // because a recovery sign-in says nothing about whether the
      // authenticator still exists and taking the rest away could lock the
      // account out.
      if (!await spendCode(user, result))
        return fail(res, 'INVALID_CODE', 'That code is not valid', 401);
      if (result.usedRecovery) {
        await audit(req, `${realm}.recovery_code_used`, user,
          `${user.email} signed in with a recovery code (${result.remaining.length} left)`);
      } else {
        // The authenticator just proved itself: the one moment the pre-bcrypt
        // recovery codes can go without locking anyone out. The audit row and
        // GET /2fa (0 left) are how the account learns to generate a new set.
        const retired = await retireLegacyRecoveryCodes(user);
        if (retired) {
          await audit(req, `${realm}.recovery_codes_retired`, user,
            `${user.email}: retired ${retired} recovery code${retired === 1 ? '' : 's'} hashed before bcrypt — generate a new set from Security`);
        }
      }
      return ok(res, await finishLogin(res, user));
    })
  );

  router.get('/2fa', gate, asyncHandler(async (req, res) => ok(res, twoFactorState(req.admin))));

  router.post(
    '/2fa/setup', gate,
    asyncHandler(async (req, res) => {
      if (req.admin.totp_enabled)
        return fail(res, 'ALREADY_ENABLED', 'Two-factor authentication is already on. Turn it off first to re-enrol.', 400);
      const secret = totp.generateSecret();
      // A spent step belongs to the secret it was minted from; this is a
      // different secret, so the count starts over. Leaving the old number in
      // the column would only be a trap for whoever reads it next. The one
      // write that deliberately LOWERS the column, which is why it is a plain
      // update and not the conditional spend — and it is safe because the
      // secret those steps belonged to is replaced in the same statement.
      await User.update(req.admin.id, {
        totpSecret: totp.encryptSecret(secret), totpRecovery: null, totpLastStep: null,
      });
      return ok(res, {
        secret,
        otpauthUrl: totp.otpauthUrl({ secret, account: req.admin.email, issuer: `Nexa ${realm === 'root' ? 'Root' : 'Admin'}` }),
      });
    })
  );

  router.post(
    '/2fa/enable', gate, twoFactorLimiter, validate(twoFactorEnableSchema),
    asyncHandler(async (req, res) => {
      if (req.admin.totp_enabled)
        return fail(res, 'ALREADY_ENABLED', 'Two-factor authentication is already on', 400);
      const secret = totp.decryptSecret(req.admin.totp_secret);
      if (!secret) return fail(res, 'NOT_SET_UP', 'Start the setup first', 400);
      // Straight to totp.verifyTotpStep rather than checkCode: there is no
      // recovery set to fall back on yet. The step is still recorded, because
      // the code that turns 2FA on stays live for another minute and must not
      // also be able to complete a /login/2fa challenge.
      const attempt = totp.verifyTotpStep(secret, req.body.code);
      if (!attempt.ok)
        return fail(res, 'INVALID_CODE', 'That code is not valid — check the time on your phone and try again', 400);
      // Spent first, and conditionally, like every other accepted code: two
      // enable requests sent together with the same digits would otherwise
      // both mint a recovery set, and the operator would keep the printout of
      // whichever write lost.
      if (!await User.spendTotpStep(req.admin.id, attempt.step))
        return fail(res, 'INVALID_CODE', 'That code is not valid — check the time on your phone and try again', 400);
      const { codes, hashes } = await totp.generateRecoveryCodes();
      await User.update(req.admin.id, {
        totpEnabled: 1, totpRecovery: JSON.stringify(hashes),
      });
      await audit(req, `${realm}.2fa_enabled`, req.admin, `${req.admin.email} turned on two-factor authentication`);
      return ok(res, { enabled: true, recoveryCodes: codes });
    })
  );

  router.post(
    '/2fa/recovery-codes', gate, twoFactorLimiter, validate(twoFactorDisableSchema),
    asyncHandler(async (req, res) => {
      if (!req.admin.totp_enabled)
        return fail(res, 'NOT_ENABLED', 'Two-factor authentication is not on', 400);
      // Same proof as turning 2FA off — the password and a current code — and
      // the same schema, because a fresh set of recovery codes is a fresh way
      // past the second factor.
      const passwordOk = await bcrypt.compare(req.body.password, req.admin.password_hash);
      if (!passwordOk) return fail(res, 'INVALID_PASSWORD', 'Password is incorrect', 400);
      const result = await checkCode(req.admin, req.body.code);
      if (!result.ok) return fail(res, 'INVALID_CODE', 'That code is not valid', 400);
      // An authenticator code offered here is spent before the new set exists:
      // it proved a regenerate, and must not go on to prove a login as well.
      // A recovery code offered here is spent by the same conditional swap
      // that a recovery login uses, so two requests carrying it cannot both
      // walk away with a printout.
      if (!await spendCode(req.admin, result))
        return fail(res, 'INVALID_CODE', 'That code is not valid', 400);
      // The stored set is then replaced outright — a used-up one, or the
      // pre-bcrypt SHA-256 one — which is what retires whatever was there.
      const { codes, hashes } = await totp.generateRecoveryCodes();
      await User.update(req.admin.id, { totpRecovery: JSON.stringify(hashes) });
      await audit(req, `${realm}.recovery_codes_regenerated`, req.admin,
        `${req.admin.email} generated a new set of recovery codes`);
      return ok(res, { recoveryCodes: codes });
    })
  );

  router.post(
    '/2fa/disable', gate, twoFactorLimiter, validate(twoFactorDisableSchema),
    asyncHandler(async (req, res) => {
      if (!req.admin.totp_enabled)
        return fail(res, 'NOT_ENABLED', 'Two-factor authentication is not on', 400);
      const passwordOk = await bcrypt.compare(req.body.password, req.admin.password_hash);
      if (!passwordOk) return fail(res, 'INVALID_PASSWORD', 'Password is incorrect', 400);
      const result = await checkCode(req.admin, req.body.code);
      if (!result.ok) return fail(res, 'INVALID_CODE', 'That code is not valid', 400);
      // The proof code is spent before the secret is cleared. Nothing can
      // replay it once 2FA is off — and a re-enrol mints a new secret — but
      // every accepted code is spent the same way, so the guarantee does not
      // depend on which route happened to consume it, and the window between
      // this check and the write below is not one either.
      if (!await spendCode(req.admin, result))
        return fail(res, 'INVALID_CODE', 'That code is not valid', 400);
      await User.update(req.admin.id, { totpEnabled: 0, totpSecret: null, totpRecovery: null });
      await audit(req, `${realm}.2fa_disabled`, req.admin, `${req.admin.email} turned off two-factor authentication`);
      return ok(res, { enabled: false });
    })
  );
}

module.exports = {
  mountTwoFactor, signChallenge, verifyChallenge, checkCode, spendCode, twoFactorState, retireLegacyRecoveryCodes,
};
