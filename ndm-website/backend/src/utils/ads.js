'use strict';

const crypto = require('crypto');

// Ad serving rules, kept pure so they can be unit-tested without a database
// and so the "paid plans never see an ad" decision lives in exactly one place.

// Where in the desktop app an ad can appear. Adding one here is the only
// change needed on the server; the app asks for the placement it renders.
const AD_PLACEMENTS = ['app_banner', 'app_sidebar', 'app_complete'];

// Plans that are ad-free. Everything else (i.e. free) is ad-supported.
const AD_FREE_PLANS = ['pro', 'team'];

// Never hand the client an unbounded list — it rotates through what it gets.
const MAX_ADS_PER_RESPONSE = 10;

/**
 * How long an ad's event token stays valid.
 *
 * The desktop app refreshes its ads every 30 minutes and rotates through them
 * for as long as the window is open, so a token has to outlive one refresh
 * cycle comfortably. Beyond that it is only a replay budget.
 */
// The desktop client re-fetches ads (and therefore tokens) every 30 minutes.
// 45 leaves slack for a missed refresh while keeping a captured token's useful
// life close to an honest one's — the budget in models/Ad.js does the rest.
const AD_EVENT_TOKEN_TTL_SECONDS = 45 * 60;

function isAdFreePlan(plan) {
  return AD_FREE_PLANS.includes(String(plan || '').toLowerCase());
}

// A row is servable when it is switched on and "now" is inside its schedule.
// Null bounds mean open-ended in that direction.
function isServable(ad, now = new Date()) {
  if (!ad) return false;
  const on = ad.active === true || ad.active === 1;
  if (!on) return false;
  const at = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(at)) return false;
  const starts = ad.starts_at ?? ad.startsAt;
  const ends = ad.ends_at ?? ad.endsAt;
  if (starts && new Date(starts).getTime() > at) return false;
  if (ends && new Date(ends).getTime() <= at) return false;
  return true;
}

/**
 * A short-lived token proving THIS server served THIS ad, recently.
 *
 * /api/ads/:id/event took anybody's word for an impression or a click, behind
 * nothing but a per-IP cap — so the counters, and the CTR the admin panel
 * computes from them, were numbers you could not stand behind the moment you
 * sold a placement. The token is issued with the ad and echoed back with the
 * event: an HMAC over the ad id and an expiry, keyed by the licence secret the
 * server already holds. It proves the reporter was actually served the ad; it
 * is not a session and identifies nobody.
 */
//
// It also carries a random nonce, which is what makes it single-use. The
// signature alone only proved the token was ISSUED by us and had not expired —
// so the same token replayed in a loop for the next two hours counted an
// impression every time, and a click is worth more than an impression. A
// counter anybody can turn is not a counter, and the CTR the admin panel
// computes from these is a number sold to advertisers. routes/ads.js burns the
// nonce on first use (models/Ad.js#claimEventNonce), so the token counts once.
function signAdEventToken(adId, secret, { ttlSeconds = AD_EVENT_TOKEN_TTL_SECONDS, now = Date.now(), nonce = null } = {}) {
  const expires = Math.floor(now / 1000) + ttlSeconds;
  // 16 bytes: the nonce only has to be unique among live tokens, and it is
  // stored as a primary key for the length of one TTL.
  const n = nonce || crypto.randomBytes(16).toString('base64url');
  const mac = crypto.createHmac('sha256', String(secret)).update(`${adId}.${expires}.${n}`).digest('base64url');
  return `${expires}.${n}.${mac}`;
}

/**
 * Verify a token against an ad id, returning its nonce so the caller can spend
 * it. Anything malformed, wrong, stale or replayed is `{ ok: false }`.
 *
 * A two-part token is the pre-nonce format. It is refused rather than accepted
 * as legacy: accepting it would leave the replay open to anyone who simply sent
 * the old shape. The only tokens affected are those issued in the two hours
 * before the deploy that added this.
 */
function readAdEventToken(token, adId, secret, { now = Date.now() } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false };
  const [expiresRaw, nonce, mac] = parts;
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires * 1000 <= now) return { ok: false };
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return { ok: false };
  const expected = crypto
    .createHmac('sha256', String(secret))
    .update(`${adId}.${expires}.${nonce}`)
    .digest('base64url');
  if (expected.length !== mac.length) return { ok: false };
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return { ok: false };
  return { ok: true, nonce, expiresAt: new Date(expires * 1000) };
}

/** Boolean form, kept for callers (and tests) that only ask "is this ours?". */
function verifyAdEventToken(token, adId, secret, options = {}) {
  return readAdEventToken(token, adId, secret, options).ok;
}

// The shape the desktop app sees. Deliberately narrow: no counters, no
// scheduling, no author — nothing the client has no business knowing. The
// `token` is the one thing added: the client hands it straight back when it
// reports an impression or a click.
function publicAd(ad, { secret } = {}) {
  return {
    id: ad.id,
    title: ad.title,
    body: ad.body || '',
    imageUrl: ad.image_url ?? ad.imageUrl ?? null,
    targetUrl: ad.target_url ?? ad.targetUrl,
    ctaLabel: ad.cta_label ?? ad.ctaLabel ?? 'Learn more',
    placement: ad.placement,
    weight: Number(ad.weight ?? 1) || 1,
    ...(secret ? { token: signAdEventToken(ad.id, secret) } : {}),
  };
}

// Click-through rate as a percentage, guarding the 0-impression case that
// would otherwise render as NaN in the admin table.
function ctr(ad) {
  const impressions = Number(ad?.impressions || 0);
  const clicks = Number(ad?.clicks || 0);
  if (impressions <= 0) return 0;
  return (clicks / impressions) * 100;
}

// Read the plan out of the `Authorization: Bearer <licence token>` header the
// desktop app sends. `verify` is injected so this stays testable and so the
// only way to claim a paid plan is a token this server signed.
//
// Anything unusable — no header, wrong scheme, garbage, expired, a token of
// some other type, or one carrying no plan — is 'free'. Failing closed here
// would mean an outage silently turning ads off for everyone; failing to
// 'free' means the worst case is an ad shown to somebody who should not see
// one, which the client's own paid-plan check then suppresses.
// `onRejected` is called with the verification error when a bearer token was
// present but unusable. It exists so the caller can count forgery attempts —
// a real client never sends a token this server did not sign — without this
// function's fail-to-'free' behaviour changing in any way. A throw from the
// callback is swallowed for the same reason: telemetry must never be able to
// turn ads on for somebody who paid not to see them.
function planFromAuthHeader(header, verify, onRejected) {
  const value = String(header || '');
  if (!/^bearer\s+\S/i.test(value)) return 'free';
  try {
    const payload = verify(value.replace(/^bearer\s+/i, '').trim());
    const plan = payload && payload.plan;
    return typeof plan === 'string' && plan ? plan : 'free';
  } catch (err) {
    if (typeof onRejected === 'function') {
      try { onRejected(err); } catch { /* never let telemetry break the gate */ }
    }
    return 'free';
  }
}

module.exports = {
  AD_PLACEMENTS, AD_FREE_PLANS, MAX_ADS_PER_RESPONSE, AD_EVENT_TOKEN_TTL_SECONDS,
  isAdFreePlan, isServable, publicAd, ctr, planFromAuthHeader,
  signAdEventToken, verifyAdEventToken, readAdEventToken,
};
