'use strict';

// Ad serving rules, kept pure so they can be unit-tested without a database
// and so the "paid plans never see an ad" decision lives in exactly one place.

// Where in the desktop app an ad can appear. Adding one here is the only
// change needed on the server; the app asks for the placement it renders.
const AD_PLACEMENTS = ['app_banner', 'app_sidebar', 'app_complete'];

// Plans that are ad-free. Everything else (i.e. free) is ad-supported.
const AD_FREE_PLANS = ['pro', 'team'];

// Never hand the client an unbounded list — it rotates through what it gets.
const MAX_ADS_PER_RESPONSE = 10;

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

// The shape the desktop app sees. Deliberately narrow: no counters, no
// scheduling, no author — nothing the client has no business knowing.
function publicAd(ad) {
  return {
    id: ad.id,
    title: ad.title,
    body: ad.body || '',
    imageUrl: ad.image_url ?? ad.imageUrl ?? null,
    targetUrl: ad.target_url ?? ad.targetUrl,
    ctaLabel: ad.cta_label ?? ad.ctaLabel ?? 'Learn more',
    placement: ad.placement,
    weight: Number(ad.weight ?? 1) || 1,
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
function planFromAuthHeader(header, verify) {
  const value = String(header || '');
  if (!/^bearer\s+\S/i.test(value)) return 'free';
  try {
    const payload = verify(value.replace(/^bearer\s+/i, '').trim());
    const plan = payload && payload.plan;
    return typeof plan === 'string' && plan ? plan : 'free';
  } catch {
    return 'free';
  }
}

module.exports = {
  AD_PLACEMENTS, AD_FREE_PLANS, MAX_ADS_PER_RESPONSE,
  isAdFreePlan, isServable, publicAd, ctr, planFromAuthHeader,
};
