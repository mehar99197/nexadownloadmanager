'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');

const asyncHandler = require('../utils/asyncHandler');
const { ok, fail } = require('../utils/respond');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { updateProfileSchema } = require('../schemas/user.schema');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Payment = require('../models/Payment');

const BCRYPT_COST = 12;

function sanitizeUser(user) {
  const { password_hash, refresh_token_hash, ...safe } = user;
  return safe;
}

async function findUserSubscription(userId) {
  const active = await Subscription.findActiveByUserId(userId);
  return active || (await Subscription.findByUserId(userId))[0] || null;
}

function subscriptionSummary(sub) {
  if (!sub) return null;
  return {
    plan: sub.plan, status: sub.status, expiryDate: sub.expiry_date,
    seats: sub.seats, licenseKey: sub.license_key,
  };
}

router.get(
  '/me', requireAuth,
  asyncHandler(async (req, res) => {
    const sub = await findUserSubscription(req.user.id);
    return ok(res, { user: sanitizeUser(req.user), subscription: subscriptionSummary(sub) });
  })
);

router.put(
  '/profile', requireAuth, validate(updateProfileSchema),
  asyncHandler(async (req, res) => {
    const { name, currentPassword, newPassword } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (newPassword !== undefined) {
      const matches = await bcrypt.compare(currentPassword, req.user.password_hash);
      if (!matches) return fail(res, 'INVALID_PASSWORD', 'Current password is incorrect', 400);
      updates.passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    }
    if (Object.keys(updates).length) await User.update(req.user.id, updates);
    const user = await User.findById(req.user.id);
    return ok(res, { user: sanitizeUser(user) });
  })
);

router.get(
  '/license', requireAuth,
  asyncHandler(async (req, res) => {
    const sub = await findUserSubscription(req.user.id);
    if (!sub) return fail(res, 'NOT_FOUND', 'No subscription found', 404);
    return ok(res, {
      licenseKey: sub.license_key, plan: sub.plan, status: sub.status, expiryDate: sub.expiry_date,
    });
  })
);

router.get(
  '/billing', requireAuth,
  asyncHandler(async (req, res) => {
    const payments = await Payment.findByUserId(req.user.id);
    return ok(res, { payments });
  })
);

module.exports = router;
