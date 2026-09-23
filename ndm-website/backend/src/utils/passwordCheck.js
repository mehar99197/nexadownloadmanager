'use strict';

/**
 * One password comparison that costs the same whatever the account is.
 *
 * A sign-in form that returns early when there is nothing to compare against
 * tells anyone with a stopwatch which addresses exist. Measured on this code,
 * same box, same request: 580 ms for a known account against 1.8 ms for an
 * unknown one — which reads as cleanly as the error code the deliberately
 * identical bodies were hiding. The panels had the same shape one realm over,
 * where the address it leaks is the admin's, and the creator's (AUDIT.md
 * M-05): `role !== 'admin'` returned immediately, a real admin paid bcrypt.
 *
 * So every branch runs a real cost-12 compare — against the account's hash, or
 * against a dummy nobody knows. `false` comes back for a missing user, a row
 * with no password (Google-created), and a locked account alike; bcryptjs also
 * throws on a null hash, so this is what keeps those from answering 500.
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const BCRYPT_COST = 12;

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

/**
 * Does `password` match `hash`? A missing or empty hash means "no", after the
 * same work a real comparison would have taken.
 */
async function passwordMatches(password, hash) {
  const candidate = typeof password === 'string' ? password : '';
  if (typeof hash === 'string' && hash) return bcrypt.compare(candidate, hash);
  await bcrypt.compare(candidate, dummyHash());
  return false;
}

module.exports = { passwordMatches, dummyHash, BCRYPT_COST };
