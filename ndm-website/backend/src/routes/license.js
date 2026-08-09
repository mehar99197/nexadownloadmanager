'use strict';

const router = require('express').Router();

const Subscription = require('../models/Subscription');
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const { licenseLimiter } = require('../middleware/rateLimiter');
const { validateLicenseSchema } = require('../schemas/license.schema');
const { signLicenseToken } = require('../utils/jwt');

router.post(
  '/validate', licenseLimiter, validate(validateLicenseSchema),
  asyncHandler(async (req, res) => {
    const { license_key, device_fingerprint } = req.body;
    const sub = await Subscription.findByLicenseKey(license_key);
    if (!sub) return res.json({ valid: false, reason: 'not_found' });
    if (sub.status === 'cancelled') return res.json({ valid: false, reason: 'cancelled' });
    if (sub.status !== 'active') return res.json({ valid: false, reason: 'invalid' });
    if (sub.expiry_date && new Date(sub.expiry_date).getTime() < Date.now())
      return res.json({ valid: false, reason: 'expired' });

    const activation = await Subscription.bindDeviceFingerprint(sub.id, device_fingerprint);
    if (!activation.ok) {
      return res.json({ valid: false, reason: 'device_mismatch' });
    }

    return res.json({
      valid: true, plan: sub.plan,
      expires: sub.expiry_date ? new Date(sub.expiry_date).toISOString() : null,
      token: signLicenseToken({ sub: license_key, plan: sub.plan, device: device_fingerprint }),
    });
  })
);

module.exports = router;
