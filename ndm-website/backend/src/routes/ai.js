'use strict';

/**
 * The desktop app's AI helpers, gated on a real entitlement.
 *
 * These endpoints exist so that `aiRename` means something. The app used to
 * call Anthropic directly with a key from its own environment, which left the
 * entitlement as a client-side boolean over an API the client reached without
 * us — patch the boolean and the feature was yours. Now the privileged work
 * happens here, behind a token this server signed, for a plan this server says
 * includes it.
 *
 * Two narrow endpoints rather than one prompt-forwarding proxy, deliberately:
 * see the header of utils/aiProxy.js.
 */

const router = require('express').Router();

const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const { ok, fail } = require('../utils/respond');
const { aiLimiter } = require('../middleware/rateLimiter');
const { verifyLicense } = require('../utils/jwt');
const { planFromAuthHeader } = require('../utils/ads');
const { entitlementsFor } = require('../config/plans');
const { recordRejection, classifyRejection } = require('../utils/tokenAbuse');
const aiProxy = require('../utils/aiProxy');
const { aiRenameSchema, aiCommandSchema } = require('../schemas/ai.schema');

/**
 * Require a licence token whose plan includes AI.
 *
 * `entitlementsFor` is the single authority on what a plan may do, so this asks
 * it rather than testing the plan name — an unknown, absent or forged plan
 * resolves to free there, which does not include aiRename.
 */
function requireAiEntitlement(req, res, next) {
  const plan = planFromAuthHeader(req.get('authorization'), verifyLicense, (err) => {
    void recordRejection(classifyRejection(err));
  });
  if (!entitlementsFor(plan).aiRename)
    return fail(res, 'AI_NOT_ENTITLED', 'This feature requires a Pro or Team license', 403);
  req.licensePlan = plan;
  return next();
}

// Answered when the server has no Anthropic key: the desktop app treats it the
// same way it treated a missing local key — the feature is simply unavailable,
// and a download keeps its original name.
function unavailable(res) {
  return fail(res, 'AI_UNAVAILABLE', 'AI features are not configured on this server', 503);
}

// POST /api/ai/rename  → { name }
router.post(
  '/rename', aiLimiter, requireAiEntitlement, validate(aiRenameSchema),
  asyncHandler(async (req, res) => {
    if (!aiProxy.isConfigured()) return unavailable(res);
    const name = await aiProxy.suggestFilename({
      filename: req.body.filename,
      url: req.body.url,
      contentType: req.body.contentType,
    });
    // An empty answer is a success with nothing to apply, not an error: the
    // client keeps the original filename either way.
    return ok(res, { name: name || '' });
  })
);

// POST /api/ai/command  → { downloads, schedule }
router.post(
  '/command', aiLimiter, requireAiEntitlement, validate(aiCommandSchema),
  asyncHandler(async (req, res) => {
    if (!aiProxy.isConfigured()) return unavailable(res);
    const result = await aiProxy.interpretCommand({ text: req.body.text });
    return ok(res, result || { downloads: [], schedule: { atIso: '', recurrence: 'none' } });
  })
);

module.exports = router;
