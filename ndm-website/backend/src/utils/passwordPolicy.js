'use strict';

/**
 * What a password must not be — beyond the length rule the schemas enforce.
 *
 * Length alone lets "Password123!" through, and that exact string is in every
 * credential-stuffing list. Two checks, both about the password's VALUE:
 *
 *  - it must not contain the account's own email local-part (a-guessable
 *    prefix somebody types out of habit), and
 *  - it must not appear in a known breach. That is asked of Have I Been
 *    Pwned's range API with k-anonymity: only the first five hex characters
 *    of the SHA-1 leave this server, the API answers with every suffix in
 *    that bucket (padded, so the response size says nothing either), and the
 *    comparison happens here. The password itself is never sent anywhere.
 *
 * The breach check fails OPEN: if HIBP is unreachable or slow the password is
 * accepted and a warning is logged. Refusing every sign-up because a third
 * party is down would be a worse outcome than one breached password.
 * PASSWORD_BREACH_CHECK=false turns it off (the test suites do).
 */

const crypto = require('crypto');
const config = require('../config/env');

const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/';

function containsEmailLocalPart(password, email) {
  const local = String(email || '').split('@')[0].trim().toLowerCase();
  if (local.length < 4) return false;
  return password.toLowerCase().includes(local);
}

async function breachedCount(password, { fetchImpl = globalThis.fetch, timeoutMs } = {}) {
  const sha1 = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const res = await fetchImpl(HIBP_RANGE_URL + prefix, {
    headers: { 'Add-Padding': 'true', 'User-Agent': 'nexadownloadmanager.com password check' },
    signal: AbortSignal.timeout(timeoutMs || config.PASSWORD_BREACH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HIBP answered ${res.status}`);
  const body = await res.text();
  for (const line of body.split(/\r?\n/)) {
    const [hashSuffix, count] = line.split(':');
    if (hashSuffix === suffix) return Number(count) || 0;
  }
  return 0;
}

/**
 * Resolves null when the password is acceptable, otherwise the message to
 * show the person (safe to send verbatim). `email` is the account's address.
 */
async function passwordProblem(password, { email, fetchImpl } = {}) {
  if (containsEmailLocalPart(password, email)) {
    return 'Your password must not contain your email address.';
  }
  if (!config.PASSWORD_BREACH_CHECK) return null;
  try {
    const count = await breachedCount(password, { fetchImpl });
    if (count > 0) {
      return 'This password has appeared in a known data breach. Please choose a different one.';
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[password] breach check skipped: ${err.message}`);
  }
  return null;
}

module.exports = { passwordProblem, breachedCount, containsEmailLocalPart };
