'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AD_PLACEMENTS, AD_FREE_PLANS, MAX_ADS_PER_RESPONSE,
  isAdFreePlan, isServable, publicAd, ctr, planFromAuthHeader,
} = require('../src/utils/ads');
const {
  createAdSchema, updateAdSchema, serveAdsSchema, adEventSchema,
} = require('../src/schemas/ad.schema');

const NOW = new Date('2026-08-30T12:00:00.000Z');

function ad(overrides = {}) {
  return {
    id: 1,
    title: 'Nexa Pro',
    body: 'Unlimited downloads',
    image_url: null,
    target_url: 'https://nexadownloadmanager.com/pricing',
    cta_label: 'Upgrade',
    placement: 'app_banner',
    active: 1,
    weight: 5,
    starts_at: null,
    ends_at: null,
    impressions: 200,
    clicks: 10,
    ...overrides,
  };
}

// ---- Who sees ads ---------------------------------------------------------

test('paid plans are ad-free and free is not', () => {
  assert.deepEqual(AD_FREE_PLANS, ['pro', 'team']);
  assert.equal(isAdFreePlan('pro'), true);
  assert.equal(isAdFreePlan('team'), true);
  assert.equal(isAdFreePlan('PRO'), true);       // case is not a bypass
  assert.equal(isAdFreePlan('free'), false);
  assert.equal(isAdFreePlan(''), false);
  assert.equal(isAdFreePlan(undefined), false);  // no token == free == ads
  assert.equal(isAdFreePlan(null), false);
  // A plan nobody has heard of must not accidentally be entitled to ad-free.
  assert.equal(isAdFreePlan('enterprise'), false);
});

// ---- Scheduling -----------------------------------------------------------

test('an inactive ad is never servable, whatever its schedule', () => {
  assert.equal(isServable(ad({ active: 0 }), NOW), false);
  assert.equal(isServable(ad({ active: false }), NOW), false);
  assert.equal(isServable(null, NOW), false);
});

test('an ad with no bounds runs forever', () => {
  assert.equal(isServable(ad(), NOW), true);
});

test('the start bound is inclusive and the end bound is exclusive', () => {
  const window = { starts_at: '2026-08-30T12:00:00.000Z', ends_at: '2026-08-31T12:00:00.000Z' };
  assert.equal(isServable(ad(window), NOW), true);                                    // exactly at start
  assert.equal(isServable(ad(window), new Date('2026-08-30T11:59:59.999Z')), false);  // one ms early
  assert.equal(isServable(ad(window), new Date('2026-08-31T11:59:59.999Z')), true);
  assert.equal(isServable(ad(window), new Date('2026-08-31T12:00:00.000Z')), false);  // exactly at end
});

test('a half-open window bounds only the side it names', () => {
  assert.equal(isServable(ad({ starts_at: '2026-09-01T00:00:00.000Z' }), NOW), false);
  assert.equal(isServable(ad({ ends_at: '2026-09-01T00:00:00.000Z' }), NOW), true);
  assert.equal(isServable(ad({ ends_at: '2026-08-01T00:00:00.000Z' }), NOW), false);
});

test('camelCase rows (an already-serialised ad) are read the same way', () => {
  assert.equal(isServable({ active: true, startsAt: null, endsAt: null }, NOW), true);
  assert.equal(isServable({ active: true, endsAt: '2026-08-01T00:00:00.000Z' }, NOW), false);
});

// ---- What the client is told ----------------------------------------------

test('publicAd hides counters, scheduling and authorship', () => {
  const out = publicAd(ad({ created_by: 7 }));
  assert.deepEqual(Object.keys(out).sort(),
    ['body', 'ctaLabel', 'id', 'imageUrl', 'placement', 'targetUrl', 'title', 'weight']);
  assert.equal(out.targetUrl, 'https://nexadownloadmanager.com/pricing');
  assert.equal(out.ctaLabel, 'Upgrade');
  assert.equal(out.weight, 5);
});

test('publicAd fills in the defaults a sparse row leaves out', () => {
  const out = publicAd({ id: 2, title: 'x', target_url: 'https://a.example/b', placement: 'app_banner' });
  assert.equal(out.body, '');
  assert.equal(out.imageUrl, null);
  assert.equal(out.ctaLabel, 'Learn more');
  assert.equal(out.weight, 1);
});

test('ctr is a percentage and survives zero impressions', () => {
  assert.equal(ctr(ad({ impressions: 200, clicks: 10 })), 5);
  assert.equal(ctr(ad({ impressions: 0, clicks: 0 })), 0);
  assert.equal(ctr(ad({ impressions: 0, clicks: 3 })), 0);   // never Infinity/NaN
  assert.equal(ctr(undefined), 0);
});

test('the response list is capped', () => {
  assert.ok(MAX_ADS_PER_RESPONSE > 0 && MAX_ADS_PER_RESPONSE <= 25);
});

// ---- Input validation -----------------------------------------------------

test('an ad needs a title and an https target', () => {
  const parsed = createAdSchema.body.parse({
    title: '  Nexa Pro  ', targetUrl: 'https://nexadownloadmanager.com/pricing',
  });
  assert.equal(parsed.title, 'Nexa Pro');
  assert.equal(parsed.placement, 'app_banner');
  assert.equal(parsed.active, true);
  assert.equal(parsed.weight, 1);
  assert.equal(parsed.ctaLabel, 'Learn more');
  assert.throws(() => createAdSchema.body.parse({ title: '', targetUrl: 'https://a.example' }));
});

test('non-https links are refused everywhere they can appear', () => {
  for (const bad of ['http://a.example', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://a.example']) {
    assert.throws(() => createAdSchema.body.parse({ title: 'x', targetUrl: bad }), new RegExp(''),
      `targetUrl accepted ${bad}`);
    assert.throws(() => createAdSchema.body.parse({
      title: 'x', targetUrl: 'https://a.example', imageUrl: bad,
    }), new RegExp(''), `imageUrl accepted ${bad}`);
  }
});

test('a placement the app cannot render is refused', () => {
  assert.throws(() => createAdSchema.body.parse({
    title: 'x', targetUrl: 'https://a.example', placement: 'billboard',
  }));
  for (const p of AD_PLACEMENTS) {
    assert.equal(
      createAdSchema.body.parse({ title: 'x', targetUrl: 'https://a.example', placement: p }).placement, p);
  }
});

test('the schedule must not end before it starts', () => {
  assert.throws(() => createAdSchema.body.parse({
    title: 'x', targetUrl: 'https://a.example',
    startsAt: '2026-09-02T00:00:00.000Z', endsAt: '2026-09-01T00:00:00.000Z',
  }));
  const okParsed = createAdSchema.body.parse({
    title: 'x', targetUrl: 'https://a.example',
    startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-09-02T00:00:00.000Z',
  });
  assert.ok(okParsed.startsAt instanceof Date && okParsed.endsAt instanceof Date);
  // The admin form sends "" for an unset bound; that means "no bound", not an error.
  const open = createAdSchema.body.parse({ title: 'x', targetUrl: 'https://a.example', startsAt: '', endsAt: '' });
  assert.equal(open.startsAt, null);
  assert.equal(open.endsAt, null);
});

test('weight is bounded so one ad cannot swamp the rotation', () => {
  assert.equal(createAdSchema.body.parse({ title: 'x', targetUrl: 'https://a.example', weight: 100 }).weight, 100);
  assert.throws(() => createAdSchema.body.parse({ title: 'x', targetUrl: 'https://a.example', weight: 0 }));
  assert.throws(() => createAdSchema.body.parse({ title: 'x', targetUrl: 'https://a.example', weight: 101 }));
});

test('an update must actually update something and cannot smuggle new columns', () => {
  assert.throws(() => updateAdSchema.body.parse({}));
  assert.throws(() => updateAdSchema.body.parse({ impressions: 999 }));   // counters are server-owned
  assert.equal(updateAdSchema.body.parse({ active: false }).active, false);
});

test('serving defaults to the app banner and rejects unknown placements', () => {
  assert.equal(serveAdsSchema.query.parse({}).placement, 'app_banner');
  assert.throws(() => serveAdsSchema.query.parse({ placement: 'nope' }));
});

test('only impression and click can be reported', () => {
  assert.equal(adEventSchema.body.parse({ type: 'click' }).type, 'click');
  assert.equal(adEventSchema.params.parse({ id: '12' }).id, 12);
  assert.throws(() => adEventSchema.body.parse({ type: 'conversion' }));
});

// ---- The paid-plan gate ---------------------------------------------------
// planFromAuthHeader is the only thing standing between a paying customer and
// an ad, so every way of getting it wrong is spelled out here.

const verifyPro = () => ({ plan: 'pro', typ: 'license' });
const verifyThrows = () => { throw new Error('bad token'); };

test('a well-formed paid token is the only way to be ad-free', () => {
  assert.equal(planFromAuthHeader('Bearer good.token.here', verifyPro), 'pro');
  assert.equal(isAdFreePlan(planFromAuthHeader('Bearer good.token.here', verifyPro)), true);
  // Header casing and extra whitespace are HTTP normal, not an attack.
  assert.equal(planFromAuthHeader('bearer good.token', verifyPro), 'pro');
  assert.equal(planFromAuthHeader('BEARER   good.token', verifyPro), 'pro');
});

test('anything unusable in the header falls back to free (= sees ads)', () => {
  const cases = [
    undefined, null, '', '   ',
    'good.token',                 // no scheme
    'Bearer',                     // scheme with no token
    'Bearer ',
    'Basic Zm9vOmJhcg==',         // wrong scheme
    'Bearerfoo',                  // not a space-separated scheme
  ];
  for (const header of cases) {
    assert.equal(planFromAuthHeader(header, verifyPro), 'free', `header ${JSON.stringify(header)}`);
    assert.equal(isAdFreePlan(planFromAuthHeader(header, verifyPro)), false);
  }
});

test('a token the server cannot verify is free, never paid', () => {
  assert.equal(planFromAuthHeader('Bearer forged.token', verifyThrows), 'free');
  assert.equal(planFromAuthHeader('Bearer x', () => null), 'free');
  assert.equal(planFromAuthHeader('Bearer x', () => ({})), 'free');            // no plan claim
  assert.equal(planFromAuthHeader('Bearer x', () => ({ plan: '' })), 'free');
  assert.equal(planFromAuthHeader('Bearer x', () => ({ plan: 42 })), 'free');   // non-string claim
});

test('a real signed licence token round-trips through the gate', () => {
  process.env.LICENSE_JWT_SECRET ||= 'test-license-secret-value-long-enough';
  const { signLicenseToken, verifyLicense } = require('../src/utils/jwt');
  for (const [plan, adFree] of [['pro', true], ['team', true], ['free', false]]) {
    const token = signLicenseToken({ sub: 'NDM-AAAA-BBBB-CCCC', plan, device: 'dev' });
    assert.equal(planFromAuthHeader(`Bearer ${token}`, verifyLicense), plan);
    assert.equal(isAdFreePlan(planFromAuthHeader(`Bearer ${token}`, verifyLicense)), adFree);
  }
});

test('a token signed with the wrong secret cannot buy ad-free', () => {
  process.env.LICENSE_JWT_SECRET ||= 'test-license-secret-value-long-enough';
  const jwt = require('jsonwebtoken');
  const { verifyLicense } = require('../src/utils/jwt');
  const forged = jwt.sign({ plan: 'pro', typ: 'license' }, 'not-the-real-secret');
  assert.equal(planFromAuthHeader(`Bearer ${forged}`, verifyLicense), 'free');
  // Right secret, wrong token type: an access token must not pass as a licence.
  const wrongType = jwt.sign({ plan: 'pro', typ: 'access' }, process.env.LICENSE_JWT_SECRET);
  assert.equal(planFromAuthHeader(`Bearer ${wrongType}`, verifyLicense), 'free');
});

/* ----------------------------------------------------- event tokens ------- */

const { signAdEventToken, verifyAdEventToken } = require('../src/utils/ads');

test('an ad event only counts with a token this server issued for that ad', () => {
  const secret = 'a-licence-signing-secret';
  const token = signAdEventToken(42, secret);

  assert.equal(verifyAdEventToken(token, 42, secret), true);
  // Bound to the ad, so one served ad's token cannot inflate another.
  assert.equal(verifyAdEventToken(token, 43, secret), false);
  // Bound to our key, so nobody can mint their own.
  assert.equal(verifyAdEventToken(token, 42, 'another-secret'), false);
  // Anything malformed or absent fails closed, counting nothing.
  assert.equal(verifyAdEventToken('', 42, secret), false);
  assert.equal(verifyAdEventToken(undefined, 42, secret), false);
  assert.equal(verifyAdEventToken('garbage', 42, secret), false);
  assert.equal(verifyAdEventToken('9999999999.short', 42, secret), false);
});

test('an ad event token expires', () => {
  const secret = 'a-licence-signing-secret';
  const now = Date.parse('2026-09-02T10:00:00.000Z');
  const token = signAdEventToken(7, secret, { ttlSeconds: 60, now });

  assert.equal(verifyAdEventToken(token, 7, secret, { now: now + 59_000 }), true);
  assert.equal(verifyAdEventToken(token, 7, secret, { now: now + 61_000 }), false);
});

test('publicAd carries the token only when a secret is supplied', () => {
  const row = { id: 5, title: 'x', target_url: 'https://e.test', placement: 'app_banner', weight: 1 };
  assert.equal('token' in publicAd(row), false);
  assert.equal(typeof publicAd(row, { secret: 'k' }).token, 'string');
  // Still no counters, schedule or authorship — the shape stays narrow.
  assert.deepEqual(
    Object.keys(publicAd(row, { secret: 'k' })).sort(),
    ['body', 'ctaLabel', 'id', 'imageUrl', 'placement', 'targetUrl', 'title', 'token', 'weight']
  );
});
