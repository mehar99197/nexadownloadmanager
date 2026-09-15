'use strict';

/**
 * Per-account sign-in lockout.
 *
 * The login rate limiter is keyed per (IP, email), which stops one machine
 * hammering one account but says nothing about a hundred machines each
 * spending their five attempts on the same account. The account itself has
 * to keep the score: after LOGIN_LOCKOUT_THRESHOLD wrong passwords in a row
 * password sign-in is refused for a while, however many addresses the guesses
 * came from. Locks escalate (15 → 30 → 60 minutes) and are capped at an hour,
 * because the same mechanism is a way to lock a victim OUT — a cap plus the
 * password-reset flow (which proves inbox ownership and clears the lock) keeps
 * that nuisance bounded.
 *
 * The lock is deliberately invisible from the outside: a locked account
 * answers exactly like a wrong password, after the same bcrypt of work, so a
 * guesser learns neither that the account exists nor that they tripped
 * anything. The owner is told in their inbox instead (once a day at most).
 * Only the password gate is affected — "Continue with Google" proves identity
 * another way and is not a guess.
 *
 * Every step is one UPDATE with its condition in SQL, so two failures landing
 * at the same instant cannot both read "9" and neither lock.
 */

const { execute, queryOne } = require('../config/db');
const config = require('../config/env');

const MAX_LEVEL = 10;

function lockMinutesForLevel(level) {
  const base = Math.max(1, config.LOGIN_LOCKOUT_MINUTES);
  // 15, 30, 60, 60, 60 … — capped so an attacker cannot escalate a victim's
  // lock into a day-long outage.
  return Math.min(base * 2 ** Math.max(0, level), base * 4);
}

function isLocked(user, now = Date.now()) {
  if (!user || !user.locked_until) return false;
  const until = new Date(user.locked_until).getTime();
  return Number.isFinite(until) && until > now;
}

/**
 * Count one wrong password. Resolves { locked, lockedUntil, minutes, notify }:
 * `locked` when this failure crossed the threshold, `notify` when the owner
 * has not been told about a lock in the last 24 hours.
 */
async function recordFailure(user) {
  const threshold = Math.max(1, config.LOGIN_LOCKOUT_THRESHOLD);
  await execute('UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ?', [user.id]);
  const row = await queryOne(
    'SELECT failed_logins, lock_level, lock_notified_at FROM users WHERE id = ?', [user.id]
  );
  if (!row || Number(row.failed_logins) < threshold) {
    return { locked: false, lockedUntil: null, minutes: 0, notify: false };
  }
  const minutes = lockMinutesForLevel(Number(row.lock_level) || 0);
  // The `failed_logins >= ?` guard makes concurrent crossers idempotent: the
  // first one locks and zeroes the counter, the others find nothing to do.
  const result = await execute(
    `UPDATE users
        SET locked_until = DATE_ADD(NOW(), INTERVAL ? MINUTE),
            lock_level = LEAST(lock_level + 1, ?),
            failed_logins = 0
      WHERE id = ? AND failed_logins >= ?`,
    [minutes, MAX_LEVEL, user.id, threshold]
  );
  if (!result.affectedRows) return { locked: false, lockedUntil: null, minutes: 0, notify: false };

  const notifiedAt = row.lock_notified_at ? new Date(row.lock_notified_at).getTime() : 0;
  const notify = !notifiedAt || Date.now() - notifiedAt > 24 * 60 * 60 * 1000;
  if (notify) await execute('UPDATE users SET lock_notified_at = NOW() WHERE id = ?', [user.id]);
  const after = await queryOne('SELECT locked_until FROM users WHERE id = ?', [user.id]);
  return { locked: true, lockedUntil: after ? after.locked_until : null, minutes, notify };
}

/** A correct password (past an expired lock) puts the account back to zero. */
async function recordSuccess(user) {
  if (!user) return;
  if (!Number(user.failed_logins) && !Number(user.lock_level) && !user.locked_until) return;
  await clearLock(user.id);
}

/** Password reset and an admin's unlock both land here. */
async function clearLock(userId) {
  await execute(
    'UPDATE users SET failed_logins = 0, lock_level = 0, locked_until = NULL WHERE id = ?',
    [userId]
  );
}

module.exports = { isLocked, recordFailure, recordSuccess, clearLock, lockMinutesForLevel };
