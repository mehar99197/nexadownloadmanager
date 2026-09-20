'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const totp = require('../src/utils/totp');

test('base32 round-trips arbitrary bytes', () => {
  for (const len of [0, 1, 5, 7, 20, 33]) {
    const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + 11) & 255));
    assert.deepEqual(totp.base32Decode(totp.base32Encode(buf)), buf);
  }
});

test('generateSecret is 32 base32 chars (160 bits) and unique', () => {
  const a = totp.generateSecret();
  const b = totp.generateSecret();
  assert.match(a, /^[A-Z2-7]{32}$/);
  assert.notEqual(a, b);
});

test('matches the RFC 6238 SHA-1 reference vectors', () => {
  // Secret "12345678901234567890" (RFC 6238 appendix B), 6 digits, 30 s step.
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(totp.totpAt(secret, seconds * 1000).slice(-6), expected, `t=${seconds}`);
  }
});

test('verifyTotp accepts the current step and one step of drift, rejects further', () => {
  const secret = totp.generateSecret();
  const now = 1_700_000_000_000;
  assert.equal(totp.verifyTotp(secret, totp.totpAt(secret, now), { when: now }), true);
  assert.equal(totp.verifyTotp(secret, totp.totpAt(secret, now - 30_000), { when: now }), true);
  assert.equal(totp.verifyTotp(secret, totp.totpAt(secret, now + 30_000), { when: now }), true);
  // Two steps away is outside the ±1 window (unless codes coincidentally collide).
  const far = totp.totpAt(secret, now + 90_000);
  const nearby = [totp.totpAt(secret, now - 30_000), totp.totpAt(secret, now), totp.totpAt(secret, now + 30_000)];
  if (!nearby.includes(far)) assert.equal(totp.verifyTotp(secret, far, { when: now }), false);
  // Malformed input never verifies.
  for (const bad of ['', '12345', 'abcdef', '1234567', null, undefined, 123456]) {
    assert.equal(totp.verifyTotp(secret, bad, { when: now }), false, `bad=${bad}`);
  }
});

test('otpauth URL carries issuer, account, and the secret', () => {
  const url = totp.otpauthUrl({ secret: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', account: 'admin@example.com', issuer: 'Nexa Admin' });
  assert.ok(url.startsWith('otpauth://totp/Nexa%20Admin%3Aadmin%40example.com?'));
  const params = new URL(url).searchParams;
  assert.equal(params.get('secret'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
  assert.equal(params.get('issuer'), 'Nexa Admin');
  assert.equal(params.get('digits'), '6');
  assert.equal(params.get('period'), '30');
});

test('secrets are encrypted at rest and decrypt back; tampering fails closed', () => {
  const secret = totp.generateSecret();
  const stored = totp.encryptSecret(secret);
  assert.notEqual(stored, secret);
  assert.equal(stored.split('.').length, 3);
  assert.equal(totp.decryptSecret(stored), secret);
  // Same secret encrypts differently every time (random IV).
  assert.notEqual(totp.encryptSecret(secret), stored);
  // Flip a character in the ciphertext → GCM tag mismatch → null, never garbage.
  const [iv, tag, enc] = stored.split('.');
  const flipped = enc[0] === 'A' ? `B${enc.slice(1)}` : `A${enc.slice(1)}`;
  assert.equal(totp.decryptSecret(`${iv}.${tag}.${flipped}`), null);
  assert.equal(totp.decryptSecret('garbage'), null);
  assert.equal(totp.decryptSecret(null), null);
});

test('recovery codes: eight unique codes, each usable exactly once, case/dash-insensitive', async () => {
  const { codes, hashes } = await totp.generateRecoveryCodes();
  assert.equal(codes.length, totp.RECOVERY_COUNT);
  assert.equal(hashes.length, totp.RECOVERY_COUNT);
  assert.equal(new Set(codes).size, codes.length);
  for (const c of codes) assert.match(c, /^[a-z0-9]{5}-[a-z0-9]{5}$/);
  // Stored as bcrypt (salted, slow) — never a bare digest a GPU could grind through.
  for (const h of hashes) assert.ok(h.startsWith('$2'), h);
  assert.equal(new Set(hashes).size, hashes.length);

  const remaining = await totp.consumeRecoveryCode(hashes, codes[2].toUpperCase().replace('-', ' '));
  assert.ok(remaining);
  assert.equal(remaining.length, hashes.length - 1);
  assert.equal(remaining.includes(hashes[2]), false);
  // Used once — gone.
  assert.equal(await totp.consumeRecoveryCode(remaining, codes[2]), null);
  // The others still work.
  assert.ok(await totp.consumeRecoveryCode(remaining, codes[0]));
  // Wrong codes: the right shape with no match, and one too short to ever be a code.
  assert.equal(await totp.consumeRecoveryCode(hashes, 'zzzzz-zzzzz'), null);
  assert.equal(await totp.consumeRecoveryCode(hashes, 'nope-nope'), null);
  assert.equal(await totp.consumeRecoveryCode(null, codes[0]), null);
  assert.equal(await totp.consumeRecoveryCode([], codes[0]), null);
});

test('recovery codes draw uniformly from [a-z0-9] — no case-folded base64 leaking entropy', () => {
  const sample = Array.from({ length: 200 }, () => totp.randomRecoveryCode());
  for (const c of sample) assert.match(c, /^[a-z0-9]{5}-[a-z0-9]{5}$/);
  assert.equal(new Set(sample).size, sample.length);
  // 2000 uniform picks from a 36-symbol alphabet: the odds of never seeing a
  // letter, or never a digit, are (26/36)^2000 — effectively zero.
  const joined = sample.join('');
  assert.match(joined, /[a-z]/);
  assert.match(joined, /[0-9]/);
});

test('hashRecoveryCode normalises first, so the printed form and the typed form agree', async () => {
  const hash = await totp.hashRecoveryCode('K7F3Q-9X2MP');
  assert.ok(hash.startsWith('$2'));
  assert.deepEqual(await totp.consumeRecoveryCode([hash], 'k7f3q 9x2mp'), []);
  assert.equal(await totp.consumeRecoveryCode([hash], 'k7f3q-9x2mq'), null);
});

test('legacy SHA-256 recovery entries still verify, exactly once, alongside bcrypt ones', async () => {
  // Rows enrolled before the bcrypt change hold sha256(normalised code) as hex.
  const sha = (code) => crypto.createHash('sha256').update(code).digest('hex');
  const legacy = [sha('k7f3q9x2mp'), sha('abcde12345')];
  const modern = await totp.hashRecoveryCode('zyxwv-98765');
  const stored = [legacy[0], modern, legacy[1]];

  const remaining = await totp.consumeRecoveryCode(stored, 'K7F3Q-9X2MP');
  assert.deepEqual(remaining, [modern, legacy[1]]);
  assert.equal(await totp.consumeRecoveryCode(remaining, 'k7f3q-9x2mp'), null);
  // The bcrypt entry beside it is unaffected, and a wrong code matches nothing.
  assert.deepEqual(await totp.consumeRecoveryCode(remaining, 'zyxwv-98765'), [legacy[1]]);
  assert.equal(await totp.consumeRecoveryCode(remaining, 'qqqqq-qqqqq'), null);
  // Garbage in the column (neither shape) is skipped, never thrown on.
  assert.equal(await totp.consumeRecoveryCode(['not-a-hash', 42, null], 'k7f3q-9x2mp'), null);
});

test('a corrupted bcrypt-looking entry fails itself — not the login, and not the codes after it', async () => {
  // bcryptjs only short-circuits on length !== 60. Each of these is 60 chars
  // and starts with "$2", so compare() itself rejects — bad revision, bad
  // salt, cost out of range — which used to surface as a 500 on /login/2fa.
  const corrupt = [
    `$2${'x'.repeat(58)}`,
    `$2a$10$${'!'.repeat(53)}`,
    `$2b$10$${'!'.repeat(53)}`,
    `$2a$99$${'a'.repeat(53)}`,
  ];
  for (const entry of corrupt) {
    assert.equal(entry.length, 60);
    await assert.doesNotReject(totp.consumeRecoveryCode([entry], 'k7f3q-9x2mp'));
    assert.equal(await totp.consumeRecoveryCode([entry], 'k7f3q-9x2mp'), null, entry);
  }
  // A valid entry BEHIND the corrupt ones is still reached and consumed.
  const good = await totp.hashRecoveryCode('k7f3q-9x2mp');
  assert.deepEqual(await totp.consumeRecoveryCode([...corrupt, good], 'k7f3q-9x2mp'), corrupt);
  assert.equal(await totp.consumeRecoveryCode([...corrupt, good], 'zzzzz-zzzzz'), null);
});

test('isLegacyRecoveryHash tells the pre-bcrypt SHA-256 shape from everything else', async () => {
  const sha = crypto.createHash('sha256').update('k7f3q9x2mp').digest('hex');
  assert.equal(totp.isLegacyRecoveryHash(sha), true);
  assert.equal(totp.isLegacyRecoveryHash(await totp.hashRecoveryCode('k7f3q-9x2mp')), false);
  for (const junk of ['', 'not-a-hash', 42, null, undefined, sha.slice(1), `${sha}0`]) {
    assert.equal(totp.isLegacyRecoveryHash(junk), false, String(junk));
  }
});

/* ------------------------------------------------ routes/twoFactor.js */

// The route tests drive mountTwoFactor through a fake router with the User
// model stubbed, so they run without MySQL like the rest of this file. The
// limiter in the chain is real express-rate-limit middleware; RATE_LIMIT_DISABLED
// is honoured outside production and lets it pass a bare request through.
process.env.RATE_LIMIT_DISABLED = '1';
const bcrypt = require('bcryptjs');
const User = require('../src/models/User');
const twoFactor = require('../src/routes/twoFactor');

const REALM = { realm: 'admin', secret: 'test-only-challenge-secret-0123456789' };
const sha = (code) => crypto.createHash('sha256').update(code).digest('hex');

/** A staff row with a live authenticator, password "correct horse", and the given stored codes. */
async function staffRow({ recovery, enabled = 1 } = {}) {
  const secret = totp.generateSecret();
  return {
    secret,
    row: {
      id: 7, email: 'staff@example.com', role: 'admin', banned: 0,
      password_hash: await bcrypt.hash('correct horse', 4),
      totp_secret: totp.encryptSecret(secret),
      totp_enabled: enabled,
      totp_recovery: recovery === undefined ? null : JSON.stringify(recovery),
    },
  };
}

/**
 * Stub the User model around one row for the duration of fn(updates), then
 * restore it. findById hands back a COPY, as a SELECT would; `updates` collects
 * every write, in order, in the model's camelCase field shape.
 */
async function withUserRow(row, fn) {
  const original = { findById: User.findById, update: User.update };
  const updates = [];
  const column = (k) => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  User.findById = async (id) => (Number(id) === row.id ? { ...row } : null);
  User.update = async (id, fields) => {
    assert.equal(id, row.id);
    updates.push(fields);
    for (const [k, v] of Object.entries(fields)) row[column(k)] = v;
  };
  try { await fn(updates); } finally { Object.assign(User, original); }
}

/** Mount the realm on a fake router; returns a runner for its handler chains plus the audit trail. */
function mountFake(overrides = {}) {
  const routes = new Map();
  const auditLog = [];
  const router = {
    post: (route, ...handlers) => routes.set(`POST ${route}`, handlers),
    get: (route, ...handlers) => routes.set(`GET ${route}`, handlers),
  };
  twoFactor.mountTwoFactor(router, {
    ...REALM,
    eligible: (u) => u.role === 'admin',
    finishLogin: async (res, user) => ({ token: 'session', admin: { id: String(user.id) } }),
    audit: async (req, action, user, summary) => { auditLog.push({ action, userId: user.id, summary }); },
    gate: (req, res, next) => next(),
    ...overrides,
  });
  async function call(route, req) {
    const res = {
      statusCode: 200,
      body: undefined,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    for (const handler of routes.get(route)) {
      // Each link either responds, calls next(), or (asyncHandler) settles a
      // promise. A next(err) is what Express would turn into a 500, so it
      // rejects here and fails the test.
      await new Promise((resolve, reject) => {
        let settled = false;
        const next = (err) => { settled = true; if (err) reject(err); else resolve(); };
        Promise.resolve(handler(req, res, next)).then(() => { if (!settled) resolve(); }, reject);
      });
      if (res.body !== undefined) break;
    }
    return res;
  }
  return { call, auditLog };
}

test('twoFactorState flags a row still holding pre-bcrypt recovery codes', async () => {
  const legacy = [sha('k7f3q9x2mp'), sha('abcde12345')];
  const modern = await totp.hashRecoveryCode('zyxwv-98765');
  const state = (recovery, enabled = 1) => twoFactor.twoFactorState({
    totp_enabled: enabled, totp_secret: 'x', totp_recovery: JSON.stringify(recovery),
  });
  assert.deepEqual(state(legacy), { enabled: true, pending: false, recoveryCodesLeft: 2, recoveryCodesLegacy: true });
  assert.deepEqual(state([modern, legacy[0]]), { enabled: true, pending: false, recoveryCodesLeft: 2, recoveryCodesLegacy: true });
  assert.deepEqual(state([modern]), { enabled: true, pending: false, recoveryCodesLeft: 1, recoveryCodesLegacy: false });
  assert.deepEqual(state([]), { enabled: true, pending: false, recoveryCodesLeft: 0, recoveryCodesLegacy: false });
  // Not enabled yet: whatever the column holds is not a usable code.
  assert.deepEqual(state(legacy, 0), { enabled: false, pending: true, recoveryCodesLeft: 0, recoveryCodesLegacy: false });
});

test('retireLegacyRecoveryCodes keeps the bcrypt entries beside the SHA-256 ones', async () => {
  const modern = await totp.hashRecoveryCode('zyxwv-98765');
  const { row } = await staffRow({ recovery: [sha('k7f3q9x2mp'), modern, sha('abcde12345')] });
  await withUserRow(row, async (updates) => {
    assert.equal(await twoFactor.retireLegacyRecoveryCodes(row), 2);
    assert.deepEqual(updates, [{ totpRecovery: JSON.stringify([modern]) }]);
    // Nothing legacy left: a no-op that does not touch the row.
    assert.equal(await twoFactor.retireLegacyRecoveryCodes(row), 0);
    assert.equal(updates.length, 1);
  });
});

test('an authenticator sign-in retires the pre-bcrypt recovery codes and says so', async () => {
  const { secret, row } = await staffRow({ recovery: [sha('k7f3q9x2mp'), sha('abcde12345')] });
  const { call, auditLog } = mountFake();
  await withUserRow(row, async (updates) => {
    const challenge = twoFactor.signChallenge(row, REALM);
    const res = await call('POST /login/2fa', { body: { challenge, code: totp.totpAt(secret) } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.token, 'session');
    assert.deepEqual(updates, [{ totpRecovery: '[]' }]);
    assert.deepEqual(auditLog.map((a) => a.action), ['admin.recovery_codes_retired']);
    assert.match(auditLog[0].summary, /retired 2 recovery codes/);
    assert.deepEqual(twoFactor.twoFactorState(row), { enabled: true, pending: false, recoveryCodesLeft: 0, recoveryCodesLegacy: false });
  });
});

test('an authenticator sign-in leaves a bcrypt recovery set alone', async () => {
  const { hashes } = await totp.generateRecoveryCodes();
  const { secret, row } = await staffRow({ recovery: hashes });
  const { call, auditLog } = mountFake();
  await withUserRow(row, async (updates) => {
    const challenge = twoFactor.signChallenge(row, REALM);
    const res = await call('POST /login/2fa', { body: { challenge, code: totp.totpAt(secret) } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(updates, [], 'the bcrypt set is untouched');
    assert.deepEqual(auditLog, []);
  });
});

test('a recovery-code sign-in spends that code only — the others stay, legacy or not', async () => {
  const legacy = [sha('k7f3q9x2mp'), sha('abcde12345')];
  const { row } = await staffRow({ recovery: legacy });
  const { call, auditLog } = mountFake();
  await withUserRow(row, async (updates) => {
    const challenge = twoFactor.signChallenge(row, REALM);
    const res = await call('POST /login/2fa', { body: { challenge, code: 'K7F3Q-9X2MP' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(updates, [{ totpRecovery: JSON.stringify([legacy[1]]) }]);
    assert.deepEqual(auditLog.map((a) => a.action), ['admin.recovery_code_used']);
    assert.equal(twoFactor.twoFactorState(row).recoveryCodesLegacy, true);
  });
});

test('POST /login/2fa answers INVALID_CODE, not 500, when the row holds a corrupted bcrypt entry', async () => {
  const good = await totp.hashRecoveryCode('k7f3q-9x2mp');
  const corrupt = `$2a$10$${'!'.repeat(53)}`;
  const { row } = await staffRow({ recovery: [corrupt, good] });
  const { call } = mountFake();
  await withUserRow(row, async (updates) => {
    const challenge = twoFactor.signChallenge(row, REALM);
    const wrong = await call('POST /login/2fa', { body: { challenge, code: 'zzzzz-zzzzz' } });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.body.error.code, 'INVALID_CODE');
    // The valid code behind the corrupted entry still signs in, and is spent.
    const right = await call('POST /login/2fa', { body: { challenge, code: 'k7f3q-9x2mp' } });
    assert.equal(right.statusCode, 200, JSON.stringify(right.body));
    assert.deepEqual(updates, [{ totpRecovery: JSON.stringify([corrupt]) }]);
  });
});

test('POST /2fa/recovery-codes replaces the set behind the password and a current code', async () => {
  const { secret, row } = await staffRow({ recovery: [sha('k7f3q9x2mp')] });
  const { call, auditLog } = mountFake({ realm: 'root' });
  await withUserRow(row, async (updates) => {
    const req = (body) => ({ admin: row, body });
    let res = await call('POST /2fa/recovery-codes', req({ password: 'wrong', code: totp.totpAt(secret) }));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'INVALID_PASSWORD');
    // Right shape for a recovery code, matches nothing, cannot be a TOTP.
    res = await call('POST /2fa/recovery-codes', req({ password: 'correct horse', code: 'zzzzz-zzzzz' }));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'INVALID_CODE');
    assert.deepEqual(updates, []);
    assert.deepEqual(auditLog, []);

    res = await call('POST /2fa/recovery-codes', req({ password: 'correct horse', code: totp.totpAt(secret) }));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const { recoveryCodes } = res.body.data;
    assert.equal(recoveryCodes.length, totp.RECOVERY_COUNT);
    for (const c of recoveryCodes) assert.match(c, /^[a-z0-9]{5}-[a-z0-9]{5}$/);
    assert.equal(updates.length, 1);
    const stored = JSON.parse(updates[0].totpRecovery);
    assert.equal(stored.length, totp.RECOVERY_COUNT);
    for (const h of stored) assert.ok(h.startsWith('$2'), h);
    assert.deepEqual(auditLog.map((a) => a.action), ['root.recovery_codes_regenerated']);
    // The legacy code is gone; a fresh one works.
    assert.equal(await totp.consumeRecoveryCode(stored, 'k7f3q-9x2mp'), null);
    assert.ok(await totp.consumeRecoveryCode(stored, recoveryCodes[0]));
    assert.deepEqual(twoFactor.twoFactorState(row), {
      enabled: true, pending: false, recoveryCodesLeft: totp.RECOVERY_COUNT, recoveryCodesLegacy: false,
    });
  });
});

test('POST /2fa/recovery-codes refuses when two-factor is off', async () => {
  const { row } = await staffRow({ enabled: 0 });
  const { call } = mountFake();
  await withUserRow(row, async (updates) => {
    const res = await call('POST /2fa/recovery-codes', { admin: row, body: { password: 'correct horse', code: '123456' } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'NOT_ENABLED');
    assert.deepEqual(updates, []);
  });
});
