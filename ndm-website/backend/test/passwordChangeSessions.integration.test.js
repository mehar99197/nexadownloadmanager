'use strict';

/**
 * M-01 — changing your password from the profile page signs out the OTHER
 * browsers, and only them.
 *
 * The scenario this exists for: an account is compromised, the owner changes
 * their password from /account, and the attacker's 30-day refresh cookie has
 * to stop working. /auth/reset-password already did that; the profile route
 * did not. The inverse matters just as much — the tab doing the change must
 * stay signed in, or people learn to avoid changing their password.
 *
 * The change is POST /auth/change-password, not PUT /user/profile: the refresh
 * cookie is scoped to /api/auth, so on any other path the server cannot tell
 * the caller's own browser from a stolen bearer token and "keep the caller
 * signed in" is impossible. (This harness's cookie jar ignores Path, so a
 * test alone would never have caught a route on the wrong path.)
 *
 * Both sides are driven through the real endpoints with independent cookie
 * jars, because the bug lived in the gap between the route and the session
 * table and a model-level test would have missed it entirely. For the same
 * reason every credential this route revokes is asserted by REPLAYING it, not
 * by reading the column it lives in: all four of them (the session rows and
 * the three single-slot columns) read empty on a fresh account, so a column
 * check passes whether or not the route does anything at all.
 */
process.env.RATE_LIMIT_DISABLED = '1';   // this suite hammers /auth/refresh

const test = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./helpers/testServer');
// Required AFTER the helper, which sets the env that config/env.js reads.
// Hashing the planted cookie with production's own function is the point: a
// test-local sha256 would still pass if the two ever disagreed.
const { hashRefreshToken } = require('../src/utils/jwt');

// One session row per signed-in browser; count them by the account's address
// rather than by an id the test would have to carry around.
async function sessionCount(email) {
  const rows = await srv.query(
    'SELECT COUNT(*) AS n FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?',
    [email]
  );
  return Number(rows[0].n);
}

// The three one-per-account refresh slots that live on the users row itself:
// the pre-sessions site cookie, the admin panel's, and the creator panel's.
async function slots(email) {
  const rows = await srv.query(
    `SELECT refresh_token_hash, admin_refresh_token_hash, root_refresh_token_hash
       FROM users WHERE email = ?`,
    [email]
  );
  return rows[0];
}

test('changing a password from the profile page', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();
  await srv.reset();

  // Browser A is the owner's laptop, browser B stands in for the attacker's
  // session (it is the same account signed in twice — that is the point).
  const a = srv.client();
  const b = srv.client();
  const { email, password } = await srv.makeUser(a, 'pwchange');
  const newPassword = 'a-much-better-password';

  let aToken = null;
  let bToken = null;

  await t.test('both browsers hold a live session to begin with', async () => {
    const loginB = await b.post('/api/auth/login', { email, password });
    assert.equal(loginB.status, 200, loginB.text);
    assert.notEqual(b.cookies.get('ndm_refresh'), a.cookies.get('ndm_refresh'));
    assert.equal(await sessionCount(email), 2, 'one session row per browser');

    const refreshA = await a.post('/api/auth/refresh');
    assert.equal(refreshA.status, 200, refreshA.text);
    aToken = refreshA.body.data.token;
    const refreshB = await b.post('/api/auth/refresh');
    assert.equal(refreshB.status, 200, refreshB.text);
    // Kept so the revocation can be replayed with it later: a cookie being
    // dead is not the same claim as a session being dead.
    bToken = refreshB.body.data.token;
  });

  await t.test('a wrong current password changes and revokes nothing', async () => {
    const before = b.cookies.get('ndm_refresh');
    const res = await a.post('/api/auth/change-password',
      { currentPassword: 'not-the-password', newPassword },
      { token: aToken });
    assert.equal(res.status, 400, res.text);
    assert.equal(res.body.error.code, 'INVALID_PASSWORD');

    assert.equal(await sessionCount(email), 2, 'no session was revoked');
    assert.equal(b.cookies.get('ndm_refresh'), before, 'no cookie was reissued');

    const stillB = await b.post('/api/auth/refresh');
    assert.equal(stillB.status, 200, 'the other browser is unaffected: ' + stillB.text);
    bToken = stillB.body.data.token;
    // And the password itself did not move. This opens a third session, which
    // the counts below account for.
    const login = await srv.client().post('/api/auth/login', { email, password });
    assert.equal(login.status, 200, 'the old password still works');
  });

  await t.test('a name-only update leaves every session alone', async () => {
    const before = b.cookies.get('ndm_refresh');
    const res = await a.put('/api/user/profile', { name: 'Renamed' }, { token: aToken });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.user.name, 'Renamed');
    assert.equal(res.headers.getSetCookie().length, 0, 'no cookie reissued for a name edit');
    assert.equal(await sessionCount(email), 3, 'sessions untouched by a name edit');
    assert.equal(b.cookies.get('ndm_refresh'), before, 'no cookie reissued for a name edit');

    const stillB = await b.post('/api/auth/refresh');
    assert.equal(stillB.status, 200, 'the other browser keeps working: ' + stillB.text);
    bToken = stillB.body.data.token;
  });

  await t.test('changing the password revokes the other browser', async () => {
    const res = await a.post('/api/auth/change-password',
      { currentPassword: password, newPassword }, { token: aToken });
    assert.equal(res.status, 200, res.text);

    // All three rows are gone and exactly one — the caller's fresh one — remains.
    assert.equal(await sessionCount(email), 1, 'only the calling browser keeps a session');

    const deadB = await b.post('/api/auth/refresh');
    assert.equal(deadB.status, 401, 'the other browser is signed out: ' + deadB.text);
    assert.equal(deadB.body.error.code, 'INVALID_REFRESH_TOKEN');
  });

  await t.test('KNOWN GAP: the revoked browser keeps its access token', async () => {
    // Read this before "fixing" the assertion below — it asserts the hole ON
    // PURPOSE, as a tripwire.
    //
    // Revoking the session rows kills the refresh cookie and nothing else.
    // requireAuth (src/middleware/auth.js) verifies the access JWT and reloads
    // the user row; it never asks whether a user_sessions row still exists, and
    // signAccessToken mints SEVEN DAYS (src/utils/jwt.js). So the browser the
    // test above just called "signed out" still reads and writes the whole
    // account with the bearer token it was already holding: M-01's window
    // narrows from 30 days to 7 rather than closing.
    //
    // Closing it means binding the access token to something a password change
    // moves — a session id in the claim that requireAuth resolves, or the `pv`
    // password-version claim utils/jwt.js already computes for reset links —
    // which is a change to middleware/auth.js and utils/jwt.js, not to this
    // route. /auth/reset-password has the identical hole, which is why parity
    // with it was never enough.
    //
    // When that lands, these four lines start failing. The correct response is
    // to flip them to 401 and delete this comment, NOT to delete the checks.
    for (const path of ['/api/user/me', '/api/user/license', '/api/user/export', '/api/user/devices']) {
      const replay = await b.get(path, { token: bToken });
      assert.equal(replay.status, 200,
        `${path} answered ${replay.status}: a 401 means the access token is session-bound at `
        + 'last — M-01 is closed, flip this assertion');
    }
  });

  await t.test('the browser that made the change stays signed in', async () => {
    const refreshA = await a.post('/api/auth/refresh');
    assert.equal(refreshA.status, 200, 'the caller was handed a working session: ' + refreshA.text);
    aToken = refreshA.body.data.token;

    const me = await a.get('/api/user/me', { token: aToken });
    assert.equal(me.status, 200, me.text);
    assert.equal(me.body.data.user.email, email);
  });

  await t.test('the caller is handed a refresh cookie on the path /auth/refresh reads', async () => {
    // With the route under /api/auth there is exactly one openSession, shared
    // with /auth/login — so this is not guarding against drift between two
    // copies any more, it is pinning the path itself: a cookie written
    // anywhere but /api/auth is one the refresh endpoint never sees.
    const fresh = srv.client();
    const login = await fresh.post('/api/auth/login', { email, password: newPassword });
    assert.equal(login.status, 200, login.text);
    const change = await fresh.post('/api/auth/change-password',
      { currentPassword: newPassword, newPassword }, { token: login.body.data.token });
    assert.equal(change.status, 200, change.text);
    assert.equal(change.body.data.sessionKept, true);
    const refreshLine = change.headers.getSetCookie().find((l) => l.startsWith('ndm_refresh='));
    assert.ok(refreshLine, 'a fresh ndm_refresh cookie was set');
    assert.match(refreshLine, /;\s*Path=\/api\/auth(;|$)/i, 'scoped to the path /auth/refresh lives on');
    assert.match(refreshLine, /;\s*HttpOnly(;|$)/i);
  });

  await t.test('all three single-slot refresh columns die with the password', async () => {
    // Each of these columns is a credential, so the test plants a real value in
    // every one and then replays the one that can be replayed from a browser.
    // Asserting they read NULL afterwards proves nothing on its own: they are
    // NULL on a fresh account, and the whole clear could be deleted from
    // routes/user.js without such an assertion noticing.
    const owner = srv.client();
    const slotUser = await srv.makeUser(owner, 'slots');
    const legacyCookie = 'a-refresh-cookie-issued-before-user_sessions-existed';
    const plant = () => srv.query(
      `UPDATE users
          SET refresh_token_hash = ?, admin_refresh_token_hash = ?, root_refresh_token_hash = ?
        WHERE email = ?`,
      [hashRefreshToken(legacyCookie), 'a-live-admin-panel-slot', 'a-live-creator-panel-slot',
        slotUser.email]
    );

    await plant();
    // /auth/refresh honours a pre-sessions cookie once and adopts it into a
    // session row of its own — that adoption is what makes the legacy column a
    // live credential rather than a leftover.
    const oldBrowser = srv.client();
    oldBrowser.cookies.set('ndm_refresh', legacyCookie);
    const adopted = await oldBrowser.post('/api/auth/refresh');
    assert.equal(adopted.status, 200, 'the planted cookie refreshes while the slot holds it: ' + adopted.text);

    // Adoption consumed the slot, so plant all three again for the real run.
    await plant();
    const before = await slots(slotUser.email);
    assert.ok(before.refresh_token_hash && before.admin_refresh_token_hash
      && before.root_refresh_token_hash, 'all three slots hold a credential before the change');

    const changed = await owner.post('/api/auth/change-password',
      { currentPassword: slotUser.password, newPassword: 'slots-rotated-password' },
      { token: slotUser.token });
    assert.equal(changed.status, 200, changed.text);

    const after = await slots(slotUser.email);
    assert.equal(after.refresh_token_hash, null);
    assert.equal(after.admin_refresh_token_hash, null, 'the admin panel session goes too');
    assert.equal(after.root_refresh_token_hash, null, 'and the creator panel session');

    oldBrowser.cookies.set('ndm_refresh', legacyCookie);
    const dead = await oldBrowser.post('/api/auth/refresh');
    assert.equal(dead.status, 401, 'the pre-sessions cookie no longer refreshes: ' + dead.text);
  });

  await t.test('the creator control-panel session dies with the password too', async () => {
    // root_refresh_token_hash is the account's highest-privilege session and
    // the only one with no server-side expiry at all: POST /api/root/refresh
    // re-issues it on every use, so it rolls indefinitely. It was also the slot
    // the first attempt at this fix forgot, which would have left the strongest
    // session as the one thing a password change did not kill. Driven end to
    // end, because the column only matters inasmuch as /api/root/refresh
    // honours it.
    const site = srv.client();
    const creator = await srv.makeUser(site, 'creator');
    // Promoted in SQL: there is no endpoint that mints a creator, and the panel
    // gate is role + ROOT_ADMIN_EMAIL (unset in tests, so role is enough).
    await srv.query("UPDATE users SET role = 'root' WHERE email = ?", [creator.email]);

    const panel = srv.client();
    const panelLogin = await panel.post('/api/root/login',
      { email: creator.email, password: creator.password });
    assert.equal(panelLogin.status, 200, 'the creator signs in to /api/root: ' + panelLogin.text);
    const panelAlive = await panel.post('/api/root/refresh');
    assert.equal(panelAlive.status, 200, 'the panel session rolls before the change: ' + panelAlive.text);

    const changed = await site.post('/api/auth/change-password',
      { currentPassword: creator.password, newPassword: 'creator-rotated-password' },
      { token: creator.token });
    assert.equal(changed.status, 200, changed.text);

    const panelDead = await panel.post('/api/root/refresh');
    assert.equal(panelDead.status, 401, 'the creator panel session is revoked: ' + panelDead.text);
    assert.equal(panelDead.body.error.code, 'INVALID_REFRESH_TOKEN');
  });

  await t.test('a bearer token on its own is never upgraded into a session', async () => {
    // The thief's shape: an access token lifted from the victim, no cookie of
    // their own. Re-opening a session for whoever holds the bearer would hand
    // the theft a 30-day renewal chain it did not have a moment earlier — and
    // on an account with no password yet, where the route deliberately lets the
    // session alone set the first one, a lockout primitive as well. So the
    // caller only keeps a session when they presented a live one.
    const victim = srv.client();
    const stolen = await srv.makeUser(victim, 'stolen');
    // Turn it into a Google-created account: no password hash, so no
    // currentPassword is demanded. That branch predates this route's session
    // handling and stays; what must not happen is the thief walking away with
    // a credential.
    await srv.query('UPDATE users SET password_hash = NULL, google_id = ? WHERE email = ?',
      [`g-${Date.now()}`, stolen.email]);
    assert.equal(await sessionCount(stolen.email), 1, 'the victim is signed in on one browser');

    const thief = srv.client();
    const res = await thief.post('/api/auth/change-password',
      { newPassword: 'a-password-the-thief-picked' }, { token: stolen.token });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.sessionKept, false);
    assert.equal(res.headers.getSetCookie().length, 0, 'no session minted for a cookie-less caller');
    assert.equal(thief.cookies.size, 0, 'the thief leaves with nothing to refresh');
    assert.equal(await sessionCount(stolen.email), 0, 'and the victim’s own session is still revoked');

    const victimDead = await victim.post('/api/auth/refresh');
    assert.equal(victimDead.status, 401, 'the victim is signed out: ' + victimDead.text);
  });

  await srv.stop();
});
