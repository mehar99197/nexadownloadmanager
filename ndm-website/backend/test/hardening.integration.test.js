'use strict';

/**
 * The defences that only mean anything against the real app: the ad counters,
 * the origin gate, and the licence a replaced key leaves behind.
 */
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./helpers/testServer');

const DEVICE = 'c'.repeat(64);

async function seedAd(title = 'Nexa Pro') {
  const id = await srv.query(
    `INSERT INTO ads (title, body, target_url, cta_label, placement, active, weight)
     VALUES (?, '', 'https://nexadownloadmanager.com/pricing', 'Learn more', 'app_banner', 1, 1)`,
    [title]
  );
  const [row] = await srv.query('SELECT id FROM ads WHERE title = ?', [title]);
  void id;
  return row.id;
}

test('hardening', async (t) => {
  if (!(await srv.available())) {
    t.skip('no MySQL reachable — see test/README.md');
    return;
  }
  await srv.start();
  await srv.reset();
  const api = srv.client();

  await t.test('an ad event only counts with the token the server served it with', async () => {
    const adId = await seedAd('Counted promo');

    const served = await api.get('/api/ads?placement=app_banner');
    assert.equal(served.status, 200);
    const ad = served.body.data.ads.find((a) => a.id === adId);
    assert.ok(ad, 'the ad should be served');
    assert.equal(typeof ad.token, 'string');
    // The shape stays narrow: no counters, schedule or authorship leak out.
    assert.equal('impressions' in ad, false);
    assert.equal('created_by' in ad, false);

    // A forged report — which is all it used to take — counts nothing.
    const forged = await api.post(`/api/ads/${adId}/event`, { type: 'impression', token: 'made-up' });
    assert.equal(forged.status, 200);
    assert.equal(forged.body.data.counted, false);

    // …and so does no token at all, which is what an old client sends.
    const bare = await api.post(`/api/ads/${adId}/event`, { type: 'impression' });
    assert.equal(bare.status, 200);
    assert.equal(bare.body.data.counted, false);

    // A token issued for a DIFFERENT ad cannot be reused on this one.
    const otherId = await seedAd('Other promo');
    const otherAd = (await api.get('/api/ads?placement=app_banner'))
      .body.data.ads.find((a) => a.id === otherId);
    const crossed = await api.post(`/api/ads/${adId}/event`,
      { type: 'impression', token: otherAd.token });
    assert.equal(crossed.body.data.counted, false);

    // The real thing counts.
    const real = await api.post(`/api/ads/${adId}/event`, { type: 'impression', token: ad.token });
    assert.equal(real.body.data.counted, true);
    const click = await api.post(`/api/ads/${adId}/event`, { type: 'click', token: ad.token });
    assert.equal(click.body.data.counted, true);

    const [row] = await srv.query('SELECT impressions, clicks FROM ads WHERE id = ?', [adId]);
    assert.equal(Number(row.impressions), 1);
    assert.equal(Number(row.clicks), 1);
  });

  await t.test('a mutating request from a foreign origin is refused', async () => {
    const evil = await api.post('/api/auth/login',
      { email: 'nobody@example.test', password: 'x' },
      { headers: { origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.body.error.code, 'BAD_ORIGIN');

    // A configured origin passes (and then fails on credentials, as it should).
    const ours = await api.post('/api/auth/login',
      { email: 'nobody@example.test', password: 'x' },
      { headers: { origin: 'http://localhost:5173' } });
    assert.equal(ours.status, 401);

    // No Origin at all is a non-browser client — the desktop app, Stripe, curl
    // — and cannot be a CSRF vector, so it goes through.
    const app = await api.post('/api/license/validate',
      { license_key: 'NDM-AAAA-BBBB-CCCC', device_fingerprint: DEVICE });
    assert.equal(app.status, 200);
    assert.equal(app.body.valid, false);
    assert.equal(app.body.reason, 'not_found');

    // Reads are never blocked, whatever the origin.
    const read = await api.get('/api/health', { headers: { origin: 'https://evil.example' } });
    assert.equal(read.status, 200);
  });

  await t.test('issuing a licence by hand retires the one it replaces', async () => {
    const user = await srv.makeUser(api, 'reissue');
    const oldKey = (await api.get('/api/user/license', { token: user.token })).body.data.licenseKey;

    // Straight to the model: this is the admin "Issue subscription" path, and
    // the point under test is what happens to the PREVIOUS key.
    const Subscription = require('../src/models/Subscription');
    const [me] = await srv.query('SELECT id FROM users WHERE email = ?', [user.email]);
    const created = await Subscription.create({
      userId: me.id, plan: 'pro', status: 'active',
      licenseKey: 'NDM-ZZZZ-YYYY-XXXX', seats: 1,
      startDate: new Date(), expiryDate: new Date(Date.now() + 30 * 86400000),
    });
    await Subscription.retireOthers(me.id, created.id);

    // The customer used to walk away holding two keys that both validated.
    const stale = await api.post('/api/license/validate',
      { license_key: oldKey, device_fingerprint: DEVICE });
    assert.equal(stale.body.valid, false);
    assert.equal(stale.body.reason, 'expired');

    const fresh = await api.post('/api/license/validate',
      { license_key: 'NDM-ZZZZ-YYYY-XXXX', device_fingerprint: DEVICE });
    assert.equal(fresh.body.valid, true);
    assert.equal(fresh.body.plan, 'pro');
  });

  await srv.stop();
});
