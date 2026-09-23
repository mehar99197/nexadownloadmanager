'use strict';

/**
 * L-12 — what a shared cache is allowed to keep.
 *
 * The API shipped with exactly one `Cache-Control` in it: the release feed's
 * deliberate `public, max-age=300`. Every other response carried none at all,
 * including the ones whose bodies are somebody's email address, licence key or
 * subscription. No header does not mean "do not cache" — a shared cache may
 * store a response with no freshness information and serve it again on its own
 * heuristics, and the CDN in front of the live deployment does cache (an `Age`
 * comes back on the feed). It happens to leave the uncontrolled responses
 * alone today; that is one vendor's configuration, not a property of this code.
 *
 * So the default is now no-store, and the one route that wants to be cached
 * still says so itself. These tests pin both halves — the default, and that
 * the opt-in still wins — because a middleware that quietly swallowed the
 * feed's header would cost real bandwidth and nothing would fail.
 */
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./helpers/testServer');

const cacheControl = (res) => res.headers.get('cache-control');

test('cache-control', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();
  await srv.reset();
  const api = srv.client();

  await t.test('a response carrying personal data is not storable', async () => {
    const user = await srv.makeUser(api);
    const me = await api.get('/api/user/me', { token: user.token });
    assert.equal(me.status, 200);
    // The body is the point, not its shape: this response carries the
    // account's own address, which is what a shared proxy must not keep.
    assert.ok(me.text.includes(user.email), 'the body names the account');
    assert.equal(cacheControl(me), 'no-store, private');
  });

  await t.test('an unauthenticated refusal is not storable either', async () => {
    // A cached 401 is its own bug — it outlives the sign-in that fixes it.
    const denied = await api.get('/api/user/me');
    assert.equal(denied.status, 401);
    assert.equal(cacheControl(denied), 'no-store, private');
  });

  await t.test('the release feed keeps its deliberate public caching', async () => {
    await srv.query(
      `INSERT INTO releases (version, changelog, windows_url, is_latest, published_at)
       VALUES ('9.9.9', 'notes', 'https://example.test/nexa.exe', 1, UTC_TIMESTAMP())`
    );
    const feed = await api.get('/api/releases/feed?os=windows');
    assert.equal(feed.status, 200);
    // The route sets its own header AFTER the default, so the opt-in wins.
    assert.equal(cacheControl(feed), 'public, max-age=300');
  });

  await t.test('a 404 under /api is covered too', async () => {
    const missing = await api.get('/api/definitely-not-a-route');
    assert.equal(missing.status, 404);
    assert.equal(cacheControl(missing), 'no-store, private');
  });

  // Without this the pool keeps the event loop alive and `node --test` waits
  // for a subprocess that will never exit — see AUDIT.md, T-03.
  await srv.stop();
});
