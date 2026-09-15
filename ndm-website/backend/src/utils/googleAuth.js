'use strict';

/**
 * Google Sign-In ("Continue with Google") — ID token verification.
 *
 * The browser runs Google Identity Services and posts the resulting ID token to
 * POST /api/auth/google. That token is a signed JWT, so it can be verified
 * offline against Google's published public keys — no client secret and no
 * server-to-server code exchange are involved.
 *
 * Verification uses only existing dependencies (jsonwebtoken + node:crypto):
 * the JWKS is fetched from Google, the matching key is converted from JWK to a
 * KeyObject, and jsonwebtoken checks signature, `iss`, `aud` and `exp`. Nothing
 * from the token payload is trusted before that check passes — an unverified
 * `email` would let anyone sign in as anyone.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/env');

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

// Google rotates its signing keys; the JWKS response carries Cache-Control with
// a max-age of a few hours. One fetch per key set is kept in memory and refreshed
// when it ages out, or immediately when a token names a key we have not seen
// (which is exactly what a rotation looks like).
const CACHE_TTL_MS = 60 * 60 * 1000;
let cache = { keys: null, fetchedAt: 0 };
let inFlight = null;

function toKeyObject(jwk) {
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

async function fetchCerts(fetchImpl) {
  const res = await fetchImpl(CERTS_URL);
  if (!res.ok) throw new Error(`Google certs request failed with HTTP ${res.status}`);
  const body = await res.json();
  if (!body || !Array.isArray(body.keys) || body.keys.length === 0)
    throw new Error('Google certs response contained no keys');
  return body.keys;
}

/** Google's current signing keys, cached. `force` bypasses the cache once. */
async function getCerts({ force = false, fetchImpl = globalThis.fetch } = {}) {
  const fresh = cache.keys && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (fresh && !force) return cache.keys;
  // Concurrent sign-ins must not each trigger their own fetch.
  inFlight ||= fetchCerts(fetchImpl)
    .then((keys) => {
      cache = { keys, fetchedAt: Date.now() };
      return keys;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

function keyFor(keys, kid) {
  if (!kid) return null;
  const jwk = keys.find((k) => k.kid === kid);
  return jwk ? toKeyObject(jwk) : null;
}

/**
 * Verify a Google ID token and return the identity it asserts.
 *
 * Resolves `{ googleId, email, emailVerified, name, picture }`.
 * Throws on anything suspect: unknown key, bad signature, wrong issuer, wrong
 * audience (another site's token replayed at ours), expiry, or an email Google
 * itself has not verified.
 */
async function verifyGoogleIdToken(idToken, { fetchImpl = globalThis.fetch, nonce } = {}) {
  if (!config.GOOGLE_CLIENT_ID) throw new Error('Google sign-in is not configured');
  if (!idToken || typeof idToken !== 'string') throw new Error('Missing Google credential');

  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || !decoded.header) throw new Error('Malformed Google credential');
  if (decoded.header.alg !== 'RS256') throw new Error('Unexpected Google token algorithm');

  let keys = await getCerts({ fetchImpl });
  let key = keyFor(keys, decoded.header.kid);
  if (!key) {
    // Unknown kid: most likely a key rotation since the last fetch.
    keys = await getCerts({ force: true, fetchImpl });
    key = keyFor(keys, decoded.header.kid);
  }
  if (!key) throw new Error('Google signing key not found for this credential');

  // jsonwebtoken enforces signature, audience, issuer and expiry together.
  const payload = jwt.verify(idToken, key, {
    algorithms: ['RS256'],
    audience: config.GOOGLE_CLIENT_ID,
    issuer: ISSUERS,
  });

  if (!payload.sub) throw new Error('Google credential carries no subject');
  if (!payload.email) throw new Error('Google credential carries no email address');
  // Google marks an address it has not confirmed; accepting one would let a
  // Google Workspace admin claim an address they do not actually control.
  if (payload.email_verified !== true && payload.email_verified !== 'true')
    throw new Error('This Google account has an unverified email address');
  // The OIDC nonce: this server handed the page a value, the page gave it to
  // Google, Google signed it into the token. A token minted for our client id
  // in any other context — another site's page, an earlier visit, a captured
  // credential — does not carry it. Compared in constant time; a missing
  // expectation (older bundle) is refused rather than skipped.
  if (!nonce || typeof payload.nonce !== 'string'
      || payload.nonce.length !== nonce.length
      || !crypto.timingSafeEqual(Buffer.from(payload.nonce), Buffer.from(nonce)))
    throw new Error('Google credential nonce mismatch');

  return {
    googleId: String(payload.sub),
    email: String(payload.email).toLowerCase(),
    emailVerified: true,
    name: payload.name || String(payload.email).toLowerCase().split('@')[0],
    picture: typeof payload.picture === 'string' ? payload.picture.slice(0, 500) : null,
    // For the replay ledger (used_id_tokens): Google sets jti on every ID
    // token; exp bounds how long the ledger has to remember it.
    jti: typeof payload.jti === 'string' ? payload.jti.slice(0, 191) : null,
    expiresAt: Number(payload.exp) ? new Date(Number(payload.exp) * 1000) : null,
  };
}

/** Test seam: drop the cached key set. */
function resetCertCache() {
  cache = { keys: null, fetchedAt: 0 };
  inFlight = null;
}

module.exports = {
  verifyGoogleIdToken, getCerts, resetCertCache, CERTS_URL, ISSUERS,
};
