'use strict';

const router = require('express').Router();

const Ad = require('../models/Ad');
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const { adsLimiter } = require('../middleware/rateLimiter');
const { serveAdsSchema, adEventSchema } = require('../schemas/ad.schema');
const config = require('../config/env');
const { verifyLicense } = require('../utils/jwt');
const {
  isAdFreePlan, publicAd, planFromAuthHeader, verifyAdEventToken,
} = require('../utils/ads');
const { ok } = require('../utils/respond');

// Keyed by a server-side secret that never leaves this process. The token
// proves "this server served this ad, recently" and nothing else — it is not a
// session and identifies nobody. See config/env.js#AD_EVENT_SECRET.
const AD_EVENT_SECRET = config.adEventSecret;

// The desktop app sends the licence token it got from /api/license/validate.
// A valid token for a paid plan means "this install is entitled to no ads" —
// the app also hides its banner on a paid plan, but the entitlement is decided
// here so a client bug can never leak an ad to somebody who paid not to see one.
function planFromLicenseHeader(req) {
  return planFromAuthHeader(req.get('authorization'), verifyLicense);
}

// GET /api/ads?placement=app_banner
// Literal (non-enveloped fields are still inside the standard envelope, but the
// shape below is what the C++ client parses).
router.get(
  '/', adsLimiter, validate(serveAdsSchema),
  asyncHandler(async (req, res) => {
    if (isAdFreePlan(planFromLicenseHeader(req)))
      return ok(res, { adFree: true, ads: [] });
    const rows = await Ad.listServable(req.query.placement);
    // Each ad carries a short-lived token the client hands back when it reports
    // an impression or a click — see utils/ads.js#signAdEventToken.
    return ok(res, {
      adFree: false,
      ads: rows.map((ad) => publicAd(ad, { secret: AD_EVENT_SECRET })),
    });
  })
);

// POST /api/ads/:id/event { type: 'impression' | 'click', token }
//
// Fire-and-forget from the client: an unknown or switched-off id is not an
// error, it just counts nothing. The token must be one THIS server issued with
// that ad and must still be inside its window — without it anybody could inflate
// the counters (and therefore the CTR the admin panel reports) with a loop of
// curl calls.
router.post(
  '/:id/event', adsLimiter, validate(adEventSchema),
  asyncHandler(async (req, res) => {
    if (isAdFreePlan(planFromLicenseHeader(req)))
      return ok(res, { counted: false });
    const id = Number(req.params.id);
    if (!verifyAdEventToken(req.body.token, id, AD_EVENT_SECRET))
      return ok(res, { counted: false, reason: 'invalid_token' });
    const affected = req.body.type === 'click'
      ? await Ad.recordClick(id)
      : await Ad.recordImpression(id);
    return ok(res, { counted: affected > 0 });
  })
);

module.exports = router;
