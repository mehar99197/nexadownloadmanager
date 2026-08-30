'use strict';

/**
 * End-to-end HTTP tests against the real app and a real MySQL database.
 *
 * These cover the paths where a bug costs money or access: the auth/refresh
 * rotation, licence validation and seat caps, the no-card trial, the release
 * feed the desktop updater polls, and the admin session. They skip themselves
 * when no database is reachable (see test/README.md).
 */
process.env.RATE_LIMIT_DISABLED = '1';   // the limiter suite re-enables them

const test = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./helpers/testServer');

const dbUp = () => srv.available();

test('backend API', async (t) => {
  if (!(await dbUp())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();

  // ---------------------------------------------------------------- auth ---
  await t.test('registration, login and refresh rotation', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const email = 'auth-user@example.test';
    const password = 'a-strong-password';

    await t2.test('registers and issues a free licence', async () => {
      const res = await api.post('/api/auth/register', { name: 'Auth User', email, password });
      assert.equal(res.status, 201, res.text);   // created
      const rows = await srv.query('SELECT plan, license_key FROM subscriptions');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].plan, 'free');
      assert.match(rows[0].license_key, /^NDM(-[A-Z0-9]{4}){3}$/);
    });

    await t2.test('rejects a duplicate email', async () => {
      const res = await api.post('/api/auth/register', { name: 'Again', email, password });
      assert.equal(res.status >= 400, true);
      assert.equal(res.body.ok, false);
    });

    await t2.test('rejects the wrong password without leaking which field was wrong', async () => {
      const res = await api.post('/api/auth/login', { email, password: 'not-it' });
      assert.equal(res.status, 401);
      assert.equal(res.body.ok, false);
      assert.doesNotMatch(String(res.body.error.message).toLowerCase(), /password is|no such user/);
    });

    let accessToken;
    await t2.test('logs in and sets an httpOnly refresh cookie', async () => {
      const res = await api.post('/api/auth/login', { email, password });
      assert.equal(res.status, 200, res.text);
      accessToken = res.body.data.token;
      assert.ok(accessToken);
      assert.ok(api.cookies.get('ndm_refresh'), 'refresh cookie set');
    });

    await t2.test('the access token authenticates /api/user/me', async () => {
      const res = await api.get('/api/user/me', { token: accessToken });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.user.email, email);
      // The trial fields the frontend renders must always be present.
      assert.ok(Object.hasOwn(res.body.data.subscription, 'trial'));
      assert.ok(Object.hasOwn(res.body.data.subscription, 'trialEndsAt'));
    });

    await t2.test('refresh rotates the cookie and invalidates the old one', async () => {
      const old = api.cookies.get('ndm_refresh');
      const res = await api.post('/api/auth/refresh');
      assert.equal(res.status, 200, res.text);
      assert.ok(res.body.data.token);
      const rotated = api.cookies.get('ndm_refresh');
      assert.notEqual(rotated, old, 'cookie value changed');

      // Replaying the old cookie must fail: that is the whole point of rotation.
      const replay = srv.client();
      replay.cookies.set('ndm_refresh', old);
      const res2 = await replay.post('/api/auth/refresh');
      assert.equal(res2.status, 401, 'stale refresh token rejected');
    });

    await t2.test('logout clears the cookie and the stored hash', async () => {
      const res = await api.post('/api/auth/logout');
      assert.equal(res.status, 200, res.text);
      const rows = await srv.query('SELECT refresh_token_hash FROM users WHERE email = ?', [email]);
      assert.equal(rows[0].refresh_token_hash, null);
    });

    await t2.test('a banned user cannot use a still-valid access token', async () => {
      const fresh = await api.post('/api/auth/login', { email, password });
      const token = fresh.body.data.token;
      await srv.query('UPDATE users SET banned = 1 WHERE email = ?', [email]);
      const res = await api.get('/api/user/me', { token });
      assert.equal(res.status, 403);
      await srv.query('UPDATE users SET banned = 0 WHERE email = ?', [email]);
    });
  });

  // ------------------------------------------------------------- licence ---
  await t.test('licence validation', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const user = await srv.makeUser(api, 'lic');
    const [sub] = await srv.query('SELECT * FROM subscriptions LIMIT 1');
    const key = sub.license_key;
    const fingerprint = 'a'.repeat(64);

    await t2.test('always answers 200 with a literal body, never the envelope', async () => {
      const res = await api.post('/api/license/validate', {
        license_key: key, device_fingerprint: fingerprint,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, undefined, 'no envelope');
      assert.equal(res.body.valid, true);
      assert.equal(res.body.plan, 'free');
      assert.ok(res.body.token, 'signed licence token returned');
      assert.equal(typeof res.body.trial, 'boolean', 'trial is always present');
    });

    await t2.test('an unknown key is invalid, still HTTP 200', async () => {
      const res = await api.post('/api/license/validate', {
        license_key: 'NDM-ZZZZ-ZZZZ-ZZZZ', device_fingerprint: fingerprint,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.valid, false);
      assert.equal(res.body.reason, 'not_found');
      assert.equal(res.body.trial, false);
    });

    await t2.test('a malformed key is rejected by validation', async () => {
      const res = await api.post('/api/license/validate', {
        license_key: 'nope', device_fingerprint: fingerprint,
      });
      assert.equal(res.status, 400);
    });

    await t2.test('the same device re-validates without consuming a seat', async () => {
      for (let i = 0; i < 3; i += 1) {
        const res = await api.post('/api/license/validate', {
          license_key: key, device_fingerprint: fingerprint,
        });
        assert.equal(res.body.valid, true);
      }
      const rows = await srv.query('SELECT COUNT(*) AS n FROM license_activations');
      assert.equal(Number(rows[0].n), 1, 'one activation row for one device');
    });

    await t2.test('a second device exceeds a 1-seat plan', async () => {
      const res = await api.post('/api/license/validate', {
        license_key: key, device_fingerprint: 'b'.repeat(64),
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.valid, false);
      assert.equal(res.body.reason, 'device_mismatch');
    });

    await t2.test('an expired subscription reports expired', async () => {
      await srv.query(
        "UPDATE subscriptions SET expiry_date = DATE_SUB(NOW(), INTERVAL 1 DAY), plan = 'pro' WHERE id = ?",
        [sub.id]
      );
      const res = await api.post('/api/license/validate', {
        license_key: key, device_fingerprint: fingerprint,
      });
      assert.equal(res.body.valid, false);
      assert.equal(res.body.reason, 'expired');
    });

    void user;
  });

  // --------------------------------------------------------------- trial ---
  await t.test('the 7-day no-card Pro trial', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const user = await srv.makeUser(api, 'trial');

    await t2.test('starts once and grants Pro', async () => {
      const res = await api.post('/api/subscription/start-trial', {}, { token: user.token });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.plan, 'pro');
      assert.equal(res.body.data.trial, true);
      assert.ok(res.body.data.trialEndsAt);
      const rows = await srv.query('SELECT plan, trial_ends_at FROM subscriptions');
      assert.equal(rows[0].plan, 'pro');
      assert.notEqual(rows[0].trial_ends_at, null);
    });

    await t2.test('cannot be started twice', async () => {
      const res = await api.post('/api/subscription/start-trial', {}, { token: user.token });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'TRIAL_UNAVAILABLE');
    });

    await t2.test('licence validation reports trial:true while it runs', async () => {
      const [sub] = await srv.query('SELECT license_key FROM subscriptions LIMIT 1');
      const res = await api.post('/api/license/validate', {
        license_key: sub.license_key, device_fingerprint: 'c'.repeat(64),
      });
      assert.equal(res.body.valid, true);
      assert.equal(res.body.plan, 'pro');
      assert.equal(res.body.trial, true);
    });

    await t2.test('expires lazily back to free once the end date passes', async () => {
      await srv.query(
        'UPDATE subscriptions SET trial_ends_at = DATE_SUB(NOW(), INTERVAL 1 HOUR), expiry_date = DATE_SUB(NOW(), INTERVAL 1 HOUR)'
      );
      const res = await api.get('/api/subscription/status', { token: user.token });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.plan, 'free', 'downgraded without a cron job');
      assert.equal(res.body.data.trial, false);
      const rows = await srv.query('SELECT plan, trial_ends_at FROM subscriptions');
      assert.equal(rows[0].plan, 'free');
      assert.equal(rows[0].trial_ends_at, null);
    });
  });

  // ------------------------------------------------------------ releases ---
  await t.test('releases, update feed and counted downloads', async (t2) => {
    await srv.reset();
    const api = srv.client();

    await t2.test('the feed 404s cleanly with no release published', async () => {
      const res = await api.get('/api/releases/feed?os=windows');
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'no_release');
    });

    await srv.query(
      `INSERT INTO releases (version, windows_url, linux_url, changelog, windows_sha256, is_latest, published_at)
       VALUES ('0.2.0', 'https://cdn.example.test/nexa.exe', 'https://cdn.example.test/nexa.deb',
               'Faster everything', ?, 1, NOW())`,
      ['d'.repeat(64)]
    );

    await t2.test('latest exposes checksums and the download count', async () => {
      const res = await api.get('/api/releases/latest');
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.version, '0.2.0');
      assert.equal(res.body.data.windowsSha256, 'd'.repeat(64));
      assert.equal(res.body.data.linuxSha256, null, 'absent checksum is null, not invented');
      assert.equal(res.body.data.downloadCount, 0);
    });

    await t2.test('the feed returns the literal shape the desktop updater parses', async () => {
      const res = await api.get('/api/releases/feed?os=windows');
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.ok, undefined, 'no envelope');
      assert.equal(res.body.version, '0.2.0');
      assert.equal(res.body.sha256, 'd'.repeat(64));
      assert.match(res.body.url, /\/api\/releases\/download\/windows$/);
      assert.match(res.headers.get('cache-control') || '', /max-age=300/);
    });

    await t2.test('a missing checksum is an empty string, never fabricated', async () => {
      const res = await api.get('/api/releases/feed?os=linux');
      assert.equal(res.status, 200);
      assert.equal(res.body.sha256, '');
    });

    await t2.test('an unknown os is rejected', async () => {
      const res = await api.get('/api/releases/feed?os=solaris');
      assert.equal(res.status, 400);
    });

    await t2.test('the download route redirects and counts exactly once', async () => {
      const res = await api.get('/api/releases/download/windows');
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), 'https://cdn.example.test/nexa.exe');
      const rows = await srv.query('SELECT download_count FROM releases');
      assert.equal(Number(rows[0].download_count), 1);

      await api.get('/api/releases/download/linux');
      const after = await srv.query('SELECT download_count FROM releases');
      assert.equal(Number(after[0].download_count), 2);
    });

    await t2.test('public stats now report the real download total', async () => {
      const res = await api.get('/api/stats');
      assert.equal(res.body.data.downloads, 2);
    });
  });

  // ----------------------------------------------------------------- ads ---
  // Ads are the one surface where the plan decides what the SERVER returns, so
  // the entitlement is tested against real rows rather than a stub.
  await t.test('ads: free installs are served, paid licences are not', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const { signLicenseToken } = require('../src/utils/jwt');

    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('admin-password-123', 12);
    await srv.query(
      "INSERT INTO users (name, email, password_hash, role, email_verified) VALUES ('Admin', 'adsadmin@example.test', ?, 'admin', 1)",
      [hash]
    );
    const login = await api.post('/api/admin/login', {
      email: 'adsadmin@example.test', password: 'admin-password-123',
    });
    const adminToken = login.body.data.token;
    const auth = { token: adminToken };

    let adId;
    await t2.test('an admin can create an ad', async () => {
      const res = await api.post('/api/admin/ads', {
        title: 'Go Pro', body: 'Unlimited downloads',
        targetUrl: 'https://nexadownloadmanager.com/pricing', ctaLabel: 'See plans', weight: 5,
      }, auth);
      assert.equal(res.status, 201, res.text);
      adId = res.body.data.id;
      assert.equal(res.body.data.active, 1);
      assert.equal(res.body.data.ctr, 0);
    });

    await t2.test('a non-https link is refused', async () => {
      const res = await api.post('/api/admin/ads', {
        title: 'Bad', targetUrl: 'http://evil.example',
      }, auth);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    await t2.test('a free install (no token) is served the ad', async () => {
      const res = await api.get('/api/ads?placement=app_banner');
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.adFree, false);
      assert.equal(res.body.data.ads.length, 1);
      const ad = res.body.data.ads[0];
      assert.equal(ad.title, 'Go Pro');
      // Counters, schedule and authorship must never reach the client.
      assert.deepEqual(Object.keys(ad).sort(),
        ['body', 'ctaLabel', 'id', 'imageUrl', 'placement', 'targetUrl', 'title', 'weight']);
    });

    for (const plan of ['pro', 'team']) {
      await t2.test(`a ${plan} licence is served nothing`, async () => {
        const token = signLicenseToken({ sub: 'NDM-AAAA-BBBB-CCCC', plan, device: 'd' });
        const res = await api.get('/api/ads', { headers: { authorization: `Bearer ${token}` } });
        assert.equal(res.status, 200, res.text);
        assert.equal(res.body.data.adFree, true);
        assert.deepEqual(res.body.data.ads, []);
      });
    }

    await t2.test('a free licence token still sees ads', async () => {
      const token = signLicenseToken({ sub: 'NDM-AAAA-BBBB-CCCC', plan: 'free', device: 'd' });
      const res = await api.get('/api/ads', { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.body.data.adFree, false);
      assert.equal(res.body.data.ads.length, 1);
    });

    await t2.test('a forged token cannot buy ad-free', async () => {
      const jwt = require('jsonwebtoken');
      const forged = jwt.sign({ plan: 'pro', typ: 'license' }, 'not-the-real-secret');
      const res = await api.get('/api/ads', { headers: { authorization: `Bearer ${forged}` } });
      assert.equal(res.body.data.adFree, false);
      assert.equal(res.body.data.ads.length, 1);
    });

    await t2.test('impressions and clicks are counted, once each', async () => {
      assert.equal((await api.post(`/api/ads/${adId}/event`, { type: 'impression' })).body.data.counted, true);
      assert.equal((await api.post(`/api/ads/${adId}/event`, { type: 'click' })).body.data.counted, true);
      const [row] = await srv.query('SELECT impressions, clicks FROM ads WHERE id = ?', [adId]);
      assert.equal(row.impressions, 1);
      assert.equal(row.clicks, 1);
    });

    await t2.test('a paid licence reporting an event counts nothing', async () => {
      const token = signLicenseToken({ sub: 'NDM-AAAA-BBBB-CCCC', plan: 'pro', device: 'd' });
      const res = await api.post(`/api/ads/${adId}/event`, { type: 'impression' },
        { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.body.data.counted, false);
      const [row] = await srv.query('SELECT impressions FROM ads WHERE id = ?', [adId]);
      assert.equal(row.impressions, 1, 'unchanged');
    });

    await t2.test('an unknown ad id is not an error', async () => {
      const res = await api.post('/api/ads/999999/event', { type: 'click' });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.counted, false);
    });

    await t2.test('renaming an ad leaves its schedule alone', async () => {
      await api.put(`/api/admin/ads/${adId}`, {
        startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2030-01-01T00:00:00.000Z',
      }, auth);
      const res = await api.put(`/api/admin/ads/${adId}`, { title: 'Go Pro today' }, auth);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.title, 'Go Pro today');
      assert.ok(res.body.data.starts_at, 'start survived a partial edit');
      assert.ok(res.body.data.ends_at, 'end survived a partial edit');
    });

    await t2.test('an empty string clears a schedule bound', async () => {
      const res = await api.put(`/api/admin/ads/${adId}`, { startsAt: '', endsAt: '' }, auth);
      assert.equal(res.body.data.starts_at, null);
      assert.equal(res.body.data.ends_at, null);
    });

    await t2.test('a scheduled ad is withheld until its window opens', async () => {
      await api.put(`/api/admin/ads/${adId}`, { startsAt: '2099-01-01T00:00:00.000Z' }, auth);
      assert.deepEqual((await api.get('/api/ads')).body.data.ads, []);
      await api.put(`/api/admin/ads/${adId}`, { startsAt: '' }, auth);
      assert.equal((await api.get('/api/ads')).body.data.ads.length, 1);
    });

    await t2.test('an expired ad stops being served', async () => {
      await api.put(`/api/admin/ads/${adId}`, { endsAt: '2020-01-01T00:00:00.000Z' }, auth);
      assert.deepEqual((await api.get('/api/ads')).body.data.ads, []);
      await api.put(`/api/admin/ads/${adId}`, { endsAt: '' }, auth);
    });

    await t2.test('pausing an ad withdraws it immediately', async () => {
      await api.put(`/api/admin/ads/${adId}`, { active: false }, auth);
      assert.deepEqual((await api.get('/api/ads')).body.data.ads, []);
      // A paused ad also stops counting.
      assert.equal((await api.post(`/api/ads/${adId}/event`, { type: 'click' })).body.data.counted, false);
      await api.put(`/api/admin/ads/${adId}`, { active: true }, auth);
    });

    await t2.test('an ad for another placement is not served here', async () => {
      await api.put(`/api/admin/ads/${adId}`, { placement: 'app_complete' }, auth);
      assert.deepEqual((await api.get('/api/ads?placement=app_banner')).body.data.ads, []);
      assert.equal((await api.get('/api/ads?placement=app_complete')).body.data.ads.length, 1);
      await api.put(`/api/admin/ads/${adId}`, { placement: 'app_banner' }, auth);
    });

    await t2.test('the admin list carries the counters and CTR the app never sees', async () => {
      const res = await api.get('/api/admin/ads', auth);
      assert.equal(res.status, 200, res.text);
      const ad = res.body.data.find((a) => a.id === adId);
      assert.equal(ad.impressions, 1);
      assert.equal(ad.clicks, 1);
      assert.equal(ad.ctr, 100);
      const stats = await api.get('/api/admin/ads/stats', auth);
      assert.equal(stats.body.data.total, 1);
      assert.equal(stats.body.data.active, 1);
    });

    await t2.test('the ads routes need no user session, the admin routes do', async () => {
      assert.equal((await api.get('/api/ads')).status, 200);
      const anon = srv.client();
      assert.equal((await anon.get('/api/admin/ads')).status >= 401, true);
      assert.equal((await anon.post('/api/admin/ads', { title: 'x', targetUrl: 'https://a.example' })).status >= 401, true);
    });

    await t2.test('deleting an ad removes it everywhere', async () => {
      assert.equal((await api.del(`/api/admin/ads/${adId}`, auth)).status, 200);
      assert.equal((await api.del(`/api/admin/ads/${adId}`, auth)).status, 404);
      assert.deepEqual((await api.get('/api/ads')).body.data.ads, []);
    });
  });

  // --------------------------------------------------------------- admin ---
  await t.test('admin session', async (t2) => {
    await srv.reset();
    const api = srv.client();
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('admin-password-123', 12);
    await srv.query(
      "INSERT INTO users (name, email, password_hash, role, email_verified) VALUES ('Admin', 'admin@example.test', ?, 'admin', 1)",
      [hash]
    );

    let adminToken;
    await t2.test('login returns a token and sets the admin refresh cookie', async () => {
      const res = await api.post('/api/admin/login', {
        email: 'admin@example.test', password: 'admin-password-123',
      });
      assert.equal(res.status, 200, res.text);
      adminToken = res.body.data.token;
      assert.ok(adminToken);
      assert.ok(api.cookies.get('ndm_admin_refresh'), 'admin refresh cookie set');
    });

    await t2.test('a user access token cannot reach admin routes', async () => {
      const userApi = srv.client();
      const user = await srv.makeUser(userApi, 'notadmin');
      const res = await api.get('/api/admin/stats', { token: user.token });
      assert.equal(res.status >= 401, true, 'user token rejected by the admin guard');
    });

    await t2.test('refresh returns a new token from the cookie alone', async () => {
      const res = await api.post('/api/admin/refresh');
      assert.equal(res.status, 200, res.text);
      assert.ok(res.body.data.token);
      adminToken = res.body.data.token;
    });

    await t2.test('/me identifies the admin', async () => {
      const res = await api.get('/api/admin/me', { token: adminToken });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.email, 'admin@example.test');
      assert.equal(res.body.data.role, 'admin');
    });

    await t2.test('logout clears the cookie and the stored hash', async () => {
      const res = await api.post('/api/admin/logout', {}, { token: adminToken });
      assert.equal(res.status, 200, res.text);
      const rows = await srv.query(
        'SELECT admin_refresh_token_hash FROM users WHERE email = ?', ['admin@example.test']
      );
      assert.equal(rows[0].admin_refresh_token_hash, null);
      const after = await api.post('/api/admin/refresh');
      assert.equal(after.status, 401, 'the cleared cookie no longer refreshes');
    });
  });

  await srv.stop();
});
