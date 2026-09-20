'use strict';

/**
 * H-05 — a banned account must be turned away at sign-in, not one call later.
 * M-02 — a password-reset link must stop working the moment it is spent.
 *
 * Both fixes are one line and one conditional write in routes/auth.js, and both
 * were invisible to the existing suites: api.integration.test.js mints its token
 * BEFORE banning, so it only ever exercised requireAuth, and nothing anywhere
 * POSTed /api/auth/reset-password at all. Deleting either fix passed CI.
 *
 * These drive the real endpoints against the real database because that is
 * where both bugs live — the ban one in the ORDER of the checks around bcrypt,
 * the reset one in whether the UPDATE re-asserts the binding the earlier read
 * checked. The unit suite (test/jwt.test.js) covers the helper and can see
 * neither.
 */
process.env.RATE_LIMIT_DISABLED = '1';   // more sign-ins and resets than the real budgets allow

const test = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./helpers/testServer');           // sets env before src/ is loaded
const { signResetToken } = require('../src/utils/jwt');

/** One session row per signed-in browser — the thing a refused login must not create. */
async function sessionCount(email) {
  const rows = await srv.query(
    'SELECT COUNT(*) AS n FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?',
    [email]
  );
  return Number(rows[0].n);
}

async function rowFor(email) {
  const rows = await srv.query('SELECT * FROM users WHERE email = ?', [email]);
  return rows[0];
}

/**
 * Mint the link the email would have carried. Going through /forgot-password
 * would only add Turnstile and a mail stub between the test and what it checks;
 * either way the token is signed from the live row, which is the part that
 * matters — `pv` has to come from the hash currently in the database.
 */
async function mintResetLink(email) {
  return signResetToken(await rowFor(email));
}

test('account state is enforced at sign-in and at password reset', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();
  await srv.reset();

  // ------------------------------------------------------------ H-05 ban ---
  await t.test('a banned account is refused at sign-in', async (t2) => {
    const api = srv.client();
    const { email, password } = await srv.makeUser(api, 'banlogin');
    const setBanned = (v) => srv.query('UPDATE users SET banned = ? WHERE email = ?', [v, email]);

    await t2.test('the right password still gets 403, and no session', async () => {
      await setBanned(1);
      const before = await sessionCount(email);

      const res = await srv.client().post('/api/auth/login', { email, password });
      assert.equal(res.status, 403, res.text);
      assert.equal(res.body.error.code, 'FORBIDDEN');
      assert.equal(res.body.data, undefined, 'no token for a banned account');

      // The half-signed-in state H-05 describes: before the fix this was a 200
      // with a 7-day token and a fresh row here, and only the NEXT call 403'd.
      assert.equal(await sessionCount(email), before, 'no session row was opened');
    });

    await t2.test('a wrong password is still just a wrong password', async () => {
      // The ban is checked AFTER bcrypt on purpose: answering earlier would let
      // anyone holding a list of addresses ask which of them are banned. So this
      // has to be indistinguishable from a wrong password on an unbanned account.
      const res = await srv.client().post('/api/auth/login', { email, password: 'not-the-password' });
      assert.equal(res.status, 401, res.text);
      assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
    });

    await t2.test('unbanning lets the account back in', async () => {
      await setBanned(0);
      const res = await srv.client().post('/api/auth/login', { email, password });
      assert.equal(res.status, 200, res.text);
      assert.ok(res.body.data.token);
    });
  });

  // -------------------------------------------------- M-02 single-use link ---
  await t.test('a password-reset link is single use', async (t2) => {
    await t2.test('the same link cannot be spent twice', async () => {
      const api = srv.client();
      const { email, password } = await srv.makeUser(api, 'reset1');
      const link = await mintResetLink(email);

      const first = await api.post('/api/auth/reset-password', { token: link, password: 'brand-new-password' });
      assert.equal(first.status, 200, first.text);
      assert.equal(first.body.data.reset, true);

      // The same token, still well inside its hour, still correctly signed and typed.
      const second = await api.post('/api/auth/reset-password', { token: link, password: 'attacker-password' });
      assert.equal(second.status, 400, second.text);
      assert.equal(second.body.error.code, 'INVALID_TOKEN');

      // ...and the refused attempt changed nothing, which is the whole point: the
      // account ends up with the password the first caller chose, not the last.
      const relogin = await srv.client().post('/api/auth/login', { email, password: 'brand-new-password' });
      assert.equal(relogin.status, 200, 'the first reset stands');
      const stolen = await srv.client().post('/api/auth/login', { email, password: 'attacker-password' });
      assert.equal(stolen.status, 401, 'the refused reset wrote nothing');
      const old = await srv.client().post('/api/auth/login', { email, password });
      assert.equal(old.status, 401, 'the original password is gone');
    });

    await t2.test('two outstanding links are one use between them', async () => {
      const api = srv.client();
      const { email } = await srv.makeUser(api, 'reset2');
      // Two reset emails requested in a row. They carry the SAME binding, because
      // asking for a second one does not retire the first (see utils/jwt.js), so
      // the guarantee under test is that the pair is collectively single-use.
      const older = await mintResetLink(email);
      const newer = await mintResetLink(email);

      const spent = await api.post('/api/auth/reset-password', { token: newer, password: 'chosen-password' });
      assert.equal(spent.status, 200, spent.text);

      const stale = await api.post('/api/auth/reset-password', { token: older, password: 'other-password' });
      assert.equal(stale.status, 400, 'the older email died with the newer one');
      assert.equal(stale.body.error.code, 'INVALID_TOKEN');
    });

    await t2.test('a Google account sets its first password, once', async () => {
      const api = srv.client();
      const { email } = await srv.makeUser(api, 'reset3');
      // What /auth/google creates: a real account whose password_hash is NULL. It
      // is the case the conditional write needs a null-safe comparison for —
      // `password_hash = NULL` is never true, so a plain `=` guard would refuse
      // every one of these and leave the account with no way in at all.
      await srv.query('UPDATE users SET password_hash = NULL WHERE email = ?', [email]);

      const link = await mintResetLink(email);
      const first = await api.post('/api/auth/reset-password', { token: link, password: 'first-password-ever' });
      assert.equal(first.status, 200, first.text);
      assert.ok((await rowFor(email)).password_hash, 'the password really was set');

      const again = await api.post('/api/auth/reset-password', { token: link, password: 'attacker-password' });
      assert.equal(again.status, 400, 'the link died on first use like any other');

      const login = await srv.client().post('/api/auth/login', { email, password: 'first-password-ever' });
      assert.equal(login.status, 200, login.text);
    });

    await t2.test('two requests racing on one link resolve to one winner', async () => {
      const api = srv.client();
      const { email } = await srv.makeUser(api, 'reset4');
      const link = await mintResetLink(email);

      // The window this closes: both requests read password_hash and pass the
      // binding check, then each spends ~300 ms in bcrypt before writing. Fired
      // together they overlap by design, so checking the token and then writing
      // unconditionally accepted it twice — last write won, and the caller whose
      // reset had been overwritten was told it had succeeded. The write is now
      // the guard, so exactly one of these can land.
      const passwords = ['racer-one-password', 'racer-two-password'];
      const results = await Promise.all(
        passwords.map((p) => srv.client().post('/api/auth/reset-password', { token: link, password: p }))
      );

      const winners = results.filter((r) => r.status === 200);
      assert.equal(winners.length, 1, results.map((r) => r.status + ' ' + r.text).join(' | '));
      const loser = results.find((r) => r.status !== 200);
      assert.equal(loser.status, 400);
      assert.equal(loser.body.error.code, 'INVALID_TOKEN');

      // The account ends up with the password of the request that was told yes,
      // not the other one. That correspondence is the defect, not the count.
      const winning = passwords[results.indexOf(winners[0])];
      const losing = passwords[results.indexOf(loser)];
      assert.equal((await srv.client().post('/api/auth/login', { email, password: winning })).status, 200);
      assert.equal((await srv.client().post('/api/auth/login', { email, password: losing })).status, 401);
    });
  });

  await srv.stop();
});
