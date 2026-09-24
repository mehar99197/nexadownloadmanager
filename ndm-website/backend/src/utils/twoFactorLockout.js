'use strict';

/**
 * Per-account lockout of the second-factor step (POST <realm>/login/2fa).
 *
 * twoFactorLimiter counts code attempts per address, which says nothing about
 * a guesser spreading attempts over many addresses. A six-digit code has a
 * million values and three of them are live at any moment, so the account has
 * to keep its own score, as it does for passwords (utils/loginLockout.js).
 *
 * Why not reuse the password lockout's counter: a correct password clears it,
 * and the only person who ever reaches the code step is somebody who just gave
 * the correct password — each guess would wipe its own count. So the code step
 * has its own columns (totp_failures, totp_locked_until, totp_lock_level), and
 * only a correct CODE clears them.
 *
 * Nobody can lock an account through this without its password: a challenge
 * is minted only after the password (or Google) checked out. And the lock
 * cannot strand the owner:
 *
 *   - it refuses only authenticator codes. A recovery code (about 52 bits,
 *     not guessable) is still accepted during a lock, and clears it;
 *   - locks are short and capped: LOGIN_LOCKOUT_MINUTES (15), doubling per
 *     repeat, never more than four times the base, and the level resets on
 *     the next correct code;
 *   - an admin's unlock (routes/admin.js) and a password reset — which also
 *     takes the known password away from whoever was guessing — lift it.
 *
 * Unlike the password lock, this one is stated plainly to the caller. The
 * password gate stays silent so a guesser learns nothing about an account;
 * here the caller has already proved the password, and the owner — the person
 * most likely to see the message — needs to know to reach for a recovery code.
 *
 * Every step is one UPDATE with its condition in SQL, so two failures landing
 * at the same instant cannot both read "4" and neither lock.
 */

const { execute, queryOne } = require('../config/db');
const config = require('../config/env');
const { lockMinutesForLevel } = require('./loginLockout');

const MAX_LEVEL = 10;

function threshold() {
  return Math.max(1, Number(config.TWO_FACTOR_LOCKOUT_THRESHOLD) || 5);
}

/** Is the code step locked on this (freshly loaded) row right now? */
function isLocked(user, now = Date.now()) {
  if (!user || !user.totp_locked_until) return false;
  const until = new Date(user.totp_locked_until).getTime();
  return Number.isFinite(until) && until > now;
}

/** Whole minutes until the lock on this row lifts (at least 1). */
function minutesLeft(user, now = Date.now()) {
  if (!isLocked(user, now)) return 0;
  return Math.max(1, Math.ceil((new Date(user.totp_locked_until).getTime() - now) / 60000));
}

/**
 * Count one wrong code. Resolves { locked, minutes }: `locked` when this
 * failure crossed the threshold and set the lock.
 */
async function recordFailure(user) {
  const limit = threshold();
  await execute('UPDATE users SET totp_failures = totp_failures + 1 WHERE id = ?', [user.id]);
  const row = await queryOne('SELECT totp_failures, totp_lock_level FROM users WHERE id = ?', [user.id]);
  if (!row || Number(row.totp_failures) < limit) return { locked: false, minutes: 0 };
  const minutes = lockMinutesForLevel(Number(row.totp_lock_level) || 0);
  // The `totp_failures >= ?` guard makes concurrent crossers idempotent: the
  // first one locks and zeroes the counter, the others find nothing to do.
  const result = await execute(
    `UPDATE users
        SET totp_locked_until = DATE_ADD(NOW(), INTERVAL ? MINUTE),
            totp_lock_level = LEAST(totp_lock_level + 1, ?),
            totp_failures = 0
      WHERE id = ? AND totp_failures >= ?`,
    [minutes, MAX_LEVEL, user.id, limit]
  );
  if (!result.affectedRows) return { locked: false, minutes: 0 };
  return { locked: true, minutes };
}

/** A correct code puts the code step back to zero. No write when already clear. */
async function recordSuccess(user) {
  if (!user) return;
  if (!Number(user.totp_failures) && !Number(user.totp_lock_level) && !user.totp_locked_until) return;
  await clear(user.id);
}

/**
 * Lift the lock. `keepLevel` leaves the escalation where it is (a password
 * reset: the next lock, if the guessing resumes, is a longer one); an admin's
 * unlock and a correct code start over completely.
 */
async function clear(userId, { keepLevel = false } = {}) {
  await execute(
    keepLevel
      ? 'UPDATE users SET totp_failures = 0, totp_locked_until = NULL WHERE id = ?'
      : 'UPDATE users SET totp_failures = 0, totp_locked_until = NULL, totp_lock_level = 0 WHERE id = ?',
    [userId]
  );
}

module.exports = { isLocked, minutesLeft, recordFailure, recordSuccess, clear, threshold };
