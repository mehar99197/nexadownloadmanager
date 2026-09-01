'use strict';

/**
 * Google ID token verification (utils/googleAuth.js).
 *
 * A throwaway RSA keypair stands in for Google's: the JWKS fetch is injected, so
 * these run offline and still exercise the real jsonwebtoken verification path
 * (signature, issuer, audience, expiry) rather than a stub of it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const config = require('../src/config/env');
const { verifyGoogleIdToken, resetCertCache, CERTS_URL } = require('../src/utils/googleAuth');

const CLIENT_ID = '123456789-test.apps.googleusercontent.com';
const KID = 'test-key-1';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

// Injected fetch: serves our JWKS and counts calls so the cache can be asserted.
function certsFetch(keys = [jwk]) {
  const impl = async (url) => {
    impl.calls += 1;
    assert.equal(url, CERTS_URL);
    return { ok: true, json: async () => ({ keys }) };
  };
  impl.calls = 0;
  return impl;
}

function sign(claims = {}, { kid = KID, key = privateKey, algorithm = 'RS256' } = {}) {
  return jwt.sign(
    {
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      sub: '1029384756',
      email: 'ada@example.test',
      email_verified: true,
      name: 'Ada Lovelace',
      picture: 'https://lh3.googleusercontent.test/a/ada',
      ...claims,
    },
    key,
    { algorithm, keyid: kid, expiresIn: '5m' }
  );
}

function withClientId(clientId, work) {
  const saved = config.GOOGLE_CLIENT_ID;
  config.GOOGLE_CLIENT_ID = clientId;
  resetCertCache();
  try {
    return work();
  } finally {
    config.GOOGLE_CLIENT_ID = saved;
    resetCertCache();

test('a well-formed token yields the identity Google asserts', async () => {
  await withClientId(CLIENT_ID, async () => {
    const identity = await verifyGoogleIdToken(sign(), { fetchImpl: certsFetch() });
    assert.deepEqual(identity, {
      googleId: '1029384756',
      email: 'ada@example.test',
      emailVerified: true,
      name: 'Ada Lovelace',
      picture: 'https://lh3.googleusercontent.test/a/ada',
    });
  });
});

test('the email is lowercased and a missing name falls back to the local part', async () => {
  await withClientId(CLIENT_ID, async () => {
    const identity = await verifyGoogleIdToken(
      sign({ email: 'Ada.Lovelace@Example.TEST', name: undefined }),
      { fetchImpl: certsFetch() }
    );
    assert.equal(identity.email, 'ada.lovelace@example.test');
    assert.equal(identity.name, 'ada.lovelace');
  });
});

test("another site's token is rejected (audience mismatch)", async () => {
  await withClientId(CLIENT_ID, async () => {
    await assert.rejects(
      verifyGoogleIdToken(sign({ aud: 'someone-else.apps.googleusercontent.com' }), { fetchImpl: certsFetch() }),
      /audience/i
    );
  });
});

test('a token signed by a different key is rejected', async () => {
  await withClientId(CLIENT_ID, async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    // Same kid, so the right key is looked up — only the signature disagrees.
    await assert.rejects(
      verifyGoogleIdToken(sign({}, { key: other.privateKey }), { fetchImpl: certsFetch() }),
      /signature/i
    );
  });

test('wrong issuer, expiry and an unverified email are all refused', async () => {
  await withClientId(CLIENT_ID, async () => {
    await assert.rejects(
      verifyGoogleIdToken(sign({ iss: 'https://evil.test' }), { fetchImpl: certsFetch() }),
      /issuer/i
    );
    const expired = jwt.sign(
      { iss: 'accounts.google.com', aud: CLIENT_ID, sub: '1', email: 'a@b.test', email_verified: true },
      privateKey,
      { algorithm: 'RS256', keyid: KID, expiresIn: '-1s' }
    );
    await assert.rejects(verifyGoogleIdToken(expired, { fetchImpl: certsFetch() }), /expired/i);
    await assert.rejects(
      verifyGoogleIdToken(sign({ email_verified: false }), { fetchImpl: certsFetch() }),
      /unverified email/i
    );
  });
});

test('an unsigned (alg=none) token never reaches verification', async () => {
  await withClientId(CLIENT_ID, async () => {
    const unsigned = jwt.sign(
      { iss: 'accounts.google.com', aud: CLIENT_ID, sub: '1', email: 'a@b.test', email_verified: true },
      '', { algorithm: 'none' }
    );
    await assert.rejects(verifyGoogleIdToken(unsigned, { fetchImpl: certsFetch() }), /algorithm/i);
  });
});

test('an unknown key id forces one refetch, and the key set is otherwise cached', async () => {
  await withClientId(CLIENT_ID, async () => {
    const fetchImpl = certsFetch();
    await verifyGoogleIdToken(sign(), { fetchImpl });
    await verifyGoogleIdToken(sign(), { fetchImpl });
    assert.equal(fetchImpl.calls, 1, 'the second verification must reuse the cached keys');

    // A token naming a key we have never seen looks exactly like a rotation.
    await assert.rejects(
      verifyGoogleIdToken(sign({}, { kid: 'rotated-key' }), { fetchImpl }),
      /signing key not found/i
    );
    assert.equal(fetchImpl.calls, 2, 'an unknown kid must trigger exactly one refetch');
  });
});

test('with no client ID configured nothing is verified at all', async () => {
  await withClientId('', async () => {
    await assert.rejects(verifyGoogleIdToken(sign(), { fetchImpl: certsFetch() }), /not configured/i);
  });
});

test('a missing or malformed credential is refused before any network call', async () => {
  await withClientId(CLIENT_ID, async () => {
    const fetchImpl = certsFetch();
    await assert.rejects(verifyGoogleIdToken('', { fetchImpl }), /Missing Google credential/);
    await assert.rejects(verifyGoogleIdToken(null, { fetchImpl }), /Missing Google credential/);
    await assert.rejects(verifyGoogleIdToken('not-a-jwt', { fetchImpl }), /Malformed Google credential/);
    assert.equal(fetchImpl.calls, 0);
  });
});

});

  }
}
