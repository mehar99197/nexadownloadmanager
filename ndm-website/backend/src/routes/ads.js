'use strict';

const router = require('express').Router();

const Ad = require('../models/Ad');
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const { adsLimiter } = require('../middleware/rateLimiter');
const { serveAdsSchema, adEventSchema } = require('../schemas/ad.schema');
const { verifyLicense } = require('../utils/jwt');
const { isAdFreePlan, publicAd, planFromAuthHeader } = require('../utils/ads');
const { ok } = require('../utils/respond');

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
    return ok(res, { adFree: false, ads: rows.map(publicAd) });
  })
);

// POST /api/ads/:id/event { type: 'impression' | 'click' }
// Fire-and-forget from the client: an unknown or switched-off id is not an
// error, it just counts nothing.
router.post(
  '/:id/event', adsLimiter, validate(adEventSchema),
  asyncHandler(async (req, res) => {
    if (isAdFreePlan(planFromLicenseHeader(req)))
      return ok(res, { counted: false });
    const id = Number(req.params.id);
    const affected = req.body.type === 'click'
      ? await Ad.recordClick(id)
      : await Ad.recordImpression(id);
    return ok(res, { counted: affected > 0 });
  })
);

module.exports = router;
