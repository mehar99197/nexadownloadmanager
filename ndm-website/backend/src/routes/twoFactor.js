'use strict';

/**
 * Two-factor authentication, shared by /api/admin, /api/root and (optionally)
 * the customer realm on /api/auth. Each realm mounts it with its own token
 * family, so a staff 2FA challenge can never complete a creator login and
 * vice versa.
 *
 * Login flow once 2FA is on:
 *   POST <realm>/login           → { requiresTwoFactor:true, challenge }   (no session yet)
 *   POST <realm>/login/2fa       { challenge, code } → { token, admin }     (session issued)
 *
 * Enrolment (behind the realm's bearer gate):
 *   GET  <realm>/2fa             → { enabled, pending, recoveryCodesLeft, recoveryCodesLegacy }
 *   POST <realm>/2fa/setup       → { secret, otpauthUrl }   secret stored, NOT yet enabled
 *   POST <realm>/2fa/enable      { password, code } → { enabled:true, recoveryCodes:[…] }  shown once
 *   POST <realm>/2fa/recovery-codes { password, code } → { recoveryCodes:[…] }  fresh set, shown once
 *   POST <realm>/2fa/disable     { password, code } → { enabled:false }
 *
 * The challenge is a 5-minute JWT of the realm's family carrying typ
 * "2fa-<realm>"; it proves the password step already passed and nothing else.
 *
 * An authenticator code is single-use. matchTotp accepts one step of drift
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
 * loses the race is refused as a replay. The recovery-code path is spent the
 * same way, by swapping the set only while it still holds what the offered
 * code was matched against.
 *
 * A replay is answered as one (CODE_ALREADY_USED) rather than as a wrong
 * code, on purpose: the person it helps is the account owner, whose own app
 * just showed those digits, and the realm's onEvent turns it into a
 * "somebody presented your code again" security event. The attacker learns
 * nothing they did not already have — they are holding the digits.
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
// Required as the module object, not destructured, so the unit tests can stand
// in for its database writes (test/totp.test.js withUserRow).
const twoFactorLockout = require('../utils/twoFactorLockout');
const {
  twoFactorLoginSchema, twoFactorEnableSchema, twoFactorDisableSchema,
} = require('../schemas/twoFactor.schema');

const CHALLENGE_TTL = '5m';

const INVALID_CODE_MESSAGE = 'That code is not valid';
const REPLAYED_MESSAGE = 'That code has already been used. Wait for your app to show the next one.';

/** The answer while the code step is locked (utils/twoFactorLockout.js). */
function lockedAnswer(minutes) {
  const m = Math.max(1, Number(minutes) || 1);
  return {
    code: 'TWO_FACTOR_LOCKED',
    status: 429,
    message: `Too many wrong codes. Authenticator codes are paused for ${m} minute${m === 1 ? '' : 's'} — `
      + 'sign in with one of your recovery codes, or try again later.',
  };
}

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
 * result with spendCode(), which is what makes either kind single-use — or to
 * { ok:false, replayed:true } for a code this row has already accepted.
 * Async because recovery codes are bcrypt-compared; the TOTP path is tried
 * first and costs nothing.
 *
 * The step comparison here reads the row the caller already loaded, so it can
 * only see spends that finished before that read: it is a pre-check that
 * refuses an obviously stale code without paying for a write, NOT the guard.
 * spendCode() is the guard.
 */
async function checkCode(user, code, { recoveryOnly = false } = {}) {
  // recoveryOnly: the code step is locked (utils/twoFactorLockout.js), so an
  // authenticator code is not even compared — only a recovery code can pass.
  const secret = recoveryOnly ? null : totp.decryptSecret(user.totp_secret);
  const attempt = secret ? totp.matchTotp(secret, code) : { ok: false };
  if (attempt.ok) {
    const last = lastUsedStep(user);
    // A step EQUAL to the stored one is the same code offered twice; a LOWER
    // one is an older code that is still inside the window — a clock that
    // drifted backwards, or a replay of something captured a minute ago.
    // Both are stale, and refusing them locks nobody out: the next step's code
    // is always above whatever was stored, so the account is at most one
    // 30-second step away from signing in.
    if (last !== null && attempt.step <= last) return { ok: false, replayed: true };
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
 * race — which is a replay by definition: the same code, presented twice.
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

/**
 * checkCode + spendCode for the routes that accept a code. Resolves to the
 * accepted (and now spent) result, or to null after the request has been
 * answered: a replay — refused by the pre-check or by losing the race for the
 * spend — is CODE_ALREADY_USED, anything else INVALID_CODE. `status` is the
 * route's own (401 on a login, 400 on an enrolment change), and `refused` is
 * told which of the two it was so the realm can record the event. `refused`
 * may resolve to { code, message, status } to answer something else instead
 * (the login uses it for TWO_FACTOR_LOCKED).
 */
async function acceptCode(res, user, code, { status, refused = async () => {}, recoveryOnly = false }) {
  const result = await checkCode(user, code, { recoveryOnly });
  if (result.ok && await spendCode(user, result)) return result;
  const replayed = Boolean(result.replayed) || result.ok;
  const answer = await refused(replayed ? 'replayed' : 'failed');
  if (answer && answer.code) fail(res, answer.code, answer.message, answer.status || status);
  else if (replayed) fail(res, 'CODE_ALREADY_USED', REPLAYED_MESSAGE, status);
  else fail(res, 'INVALID_CODE', INVALID_CODE_MESSAGE, status);
  return null;
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
 * @param realm         'admin' | 'root' | 'user'
 * @param secret        that realm's JWT secret (challenge signing)
 * @param eligible(u)   is this user allowed to sign in to this realm at all?
 * @param finishLogin(res, user, req) → response data once both factors passed
 * @param audit(req, action, user, summary)
 * @param gate          the realm's requireAdmin / requireRoot / requireAuth middleware
 */
function mountTwoFactor(router, {
  realm, secret, eligible, finishLogin, audit, gate,
  // The request property the gate fills: `admin` for the panels, `user`
  // for customers (middleware/auth.js).
  subject = (req) => req.admin,
  // The issuer label the authenticator app shows for this entry.
  issuer = `Nexa ${realm === 'root' ? 'Root' : 'Admin'}`,
  // (req, user, 'failed' | 'replayed' | 'recovery' | 'enabled' | 'disabled' |
  // 'recovery_codes_regenerated') — the customer realm feeds
  // utils/securityEvents.js from here.
  onEvent = async () => {},
}) {
  const family = { secret, realm };

  /**
   * Every account that has a password must prove it before its second factor
   * is changed. A Google-created customer has none (routes/user.js makes the
   * same allowance for deleting the account); the code from the enrolled
   * authenticator is the proof available for it. Panel accounts always have a
   * password. Resolves true when the request may go on, false once it has
   * been answered.
   */
  async function provedPassword(req, res, me) {
    if (!me.password_hash) return true;
    if (!req.body.password) {
      fail(res, 'INVALID_PASSWORD', 'Password is required to change two-factor authentication', 400);
      return false;
    }
    if (!await bcrypt.compare(req.body.password, me.password_hash)) {
      fail(res, 'INVALID_PASSWORD', 'Password is incorrect', 400);
      return false;
    }
    return true;
  }

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

      // Spend the code before the session exists, and only if this request is
      // the one that gets it: from here on that code is used up, whatever the
      // rest of this request does. A concurrent login offering the same code
      // loses here and is refused as the replay it is — the whole point of the
      // column, since a relayed code arrives beside the real login rather
      // than after it. The recovery branch's spend IS this write: it stores
      // the remaining set, keeping whatever is left, legacy or not, because a
      // recovery sign-in says nothing about whether the authenticator still
      // exists and taking the rest away could lock the account out.
      //
      // Wrong codes are also counted against the ACCOUNT (utils/
      // twoFactorLockout.js): twoFactorLimiter is per address, and whoever
      // holds the password can mint a fresh challenge per guess from as many
      // addresses as they like. Past the threshold the code step locks: while
      // it holds, authenticator codes are not compared at all and only a
      // recovery code gets through — so the owner is never stranded, and
      // guessing the six digits stops paying.
      const locked = twoFactorLockout.isLocked(user);
      const result = await acceptCode(res, user, req.body.code, {
        status: 401,
        recoveryOnly: locked,
        refused: async (what) => {
          if (what === 'replayed') {
            await audit(req, `${realm}.code_replayed`, user,
              `${user.email} presented an already-used two-factor code`);
          }
          await onEvent(req, user, what);
          if (locked) return lockedAnswer(twoFactorLockout.minutesLeft(user));
          // A replay is the owner's own digits arriving twice (a double
          // submit, or a relay racing them) — not a guess, so not counted.
          if (what !== 'failed') return null;
          const outcome = await twoFactorLockout.recordFailure(user);
          if (!outcome.locked) return null;
          await audit(req, `${realm}.2fa_locked`, user,
            `${user.email}: authenticator codes refused for ${outcome.minutes} min after repeated wrong codes`);
          await onEvent(req, user, 'locked');
          return lockedAnswer(outcome.minutes);
        },
      });
      if (!result) return undefined;
      await twoFactorLockout.recordSuccess(user);
      if (result.usedRecovery) {
        await audit(req, `${realm}.recovery_code_used`, user,
          `${user.email} signed in with a recovery code (${result.remaining.length} left)`);
        await onEvent(req, user, 'recovery');
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
      // A spent step belongs to the secret it was minted from; this is a
      // different secret, so the count starts over. Leaving the old number in
      // the column would only be a trap for whoever reads it next. The one
      // write that deliberately LOWERS the column, which is why it is a plain
      // update and not the conditional spend — and it is safe because the
      // secret those steps belonged to is replaced in the same statement.
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
      // The same proof as turning it off. Without it, an access token alone —
      // leaked from a log, a shared machine, an XSS — could run /setup, scan
      // its own QR code and switch 2FA on: the owner's next sign-in would then
      // ask for a code from an authenticator only the attacker holds, and
      // /disable would need that code too. Checked before the code, so a
      // refused attempt spends nothing and the owner's own retry still works.
      // A Google-created account has no password; like /disable, the code
      // from the authenticator being enrolled is the proof it can give.
      if (!await provedPassword(req, res, me)) return undefined;
      // Straight to totp.matchTotp rather than checkCode: there is no
      // recovery set to fall back on yet. The step is still spent, because
      // the code that turns 2FA on stays live for another minute and must not
      // also be able to complete a /login/2fa challenge.
      const attempt = totp.matchTotp(secret, req.body.code);
      if (!attempt.ok)
        return fail(res, 'INVALID_CODE', 'That code is not valid — check the time on your phone and try again', 400);
      // Spent first, and conditionally, like every other accepted code: two
      // enable requests sent together with the same digits would otherwise
      // both mint a recovery set, and the operator would keep the printout of
      // whichever write lost.
      if (!await User.spendTotpStep(me.id, attempt.step))
        return fail(res, 'INVALID_CODE', 'That code is not valid — check the time on your phone and try again', 400);
      const { codes, hashes } = await totp.generateRecoveryCodes();
      await User.update(me.id, { totpEnabled: 1, totpRecovery: JSON.stringify(hashes) });
      // A code-step lock left from an earlier enrolment belongs to that one.
      await twoFactorLockout.recordSuccess(me);
      await audit(req, `${realm}.2fa_enabled`, me, `${me.email} turned on two-factor authentication`);
      await onEvent(req, me, 'enabled');
      return ok(res, { enabled: true, recoveryCodes: codes });
    })
  );

  router.post(
    '/2fa/recovery-codes', gate, twoFactorLimiter, validate(twoFactorDisableSchema),
    asyncHandler(async (req, res) => {
      const me = subject(req);
      if (!me.totp_enabled)
        return fail(res, 'NOT_ENABLED', 'Two-factor authentication is not on', 400);
      // Same proof as turning 2FA off — the password and a current code — and
      // the same schema, because a fresh set of recovery codes is a fresh way
      // past the second factor.
      if (!await provedPassword(req, res, me)) return undefined;
      // An authenticator code offered here is spent before the new set exists:
      // it proved a regenerate, and must not go on to prove a login as well.
      // A recovery code offered here is spent by the same conditional swap
      // that a recovery login uses, so two requests carrying it cannot both
      // walk away with a printout.
      const result = await acceptCode(res, me, req.body.code, { status: 400 });
      if (!result) return undefined;
      // The stored set is then replaced outright — a used-up one, or the
      // pre-bcrypt SHA-256 one — which is what retires whatever was there.
      const { codes, hashes } = await totp.generateRecoveryCodes();
      await User.update(me.id, { totpRecovery: JSON.stringify(hashes) });
      await audit(req, `${realm}.recovery_codes_regenerated`, me,
        `${me.email} generated a new set of recovery codes`);
      await onEvent(req, me, 'recovery_codes_regenerated');
      return ok(res, { recoveryCodes: codes });
    })
  );

  router.post(
    '/2fa/disable', gate, twoFactorLimiter, validate(twoFactorDisableSchema),
    asyncHandler(async (req, res) => {
      const me = subject(req);
      if (!me.totp_enabled)
        return fail(res, 'NOT_ENABLED', 'Two-factor authentication is not on', 400);
      if (!await provedPassword(req, res, me)) return undefined;
      // The proof code is spent before the secret is cleared. Nothing can
      // replay it once 2FA is off — and a re-enrol mints a new secret — but
      // every accepted code is spent the same way, so the guarantee does not
      // depend on which route happened to consume it, and the window between
      // this check and the write below is not one either.
      const result = await acceptCode(res, me, req.body.code, { status: 400 });
      if (!result) return undefined;
      await User.update(me.id, {
        totpEnabled: 0, totpSecret: null, totpRecovery: null, totpLastStep: null,
      });
      await audit(req, `${realm}.2fa_disabled`, me, `${me.email} turned off two-factor authentication`);
      await onEvent(req, me, 'disabled');
      return ok(res, { enabled: false });
    })
  );
}

module.exports = {
  mountTwoFactor, signChallenge, verifyChallenge, checkCode, spendCode, twoFactorState, retireLegacyRecoveryCodes,
};
