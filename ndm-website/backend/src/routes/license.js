'use strict';

const router = require('express').Router();

const Subscription = require('../models/Subscription');
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const { licenseLimiter, apiLimiter } = require('../middleware/rateLimiter');
const {
  validateLicenseSchema, heartbeatSchema, releaseSeatSchema,
} = require('../schemas/license.schema');
const { signLicenseToken } = require('../utils/jwt');
const { isTrialActive, SEAT_LEASE_SECONDS } = require('../utils/license');
const { entitlementsFor } = require('../config/plans');

// LITERAL response shape consumed by the C++ app — never the envelope.
// `trial` is always present so the client can show trial state.
function invalid(res, reason, sub = null, extra = {}) {
  return res.json({
    valid: false,
    reason,
    trial: isTrialActive(sub),
    // A rejected client still gets Free entitlements so it can run in
    // reduced mode rather than guessing what it is allowed to do.
    features: entitlementsFor('free'),
    ...extra,
  });
}

// Resolve a licence key to a usable subscription, or the reason it is not.
async function resolveSubscription(licenseKey) {
  let sub = await Subscription.findByLicenseKey(licenseKey);
  if (!sub) return { reason: 'not_found', sub: null };
  // Lazy downgrade: a finished no-card trial falls back to free/active.
  sub = await Subscription.expireTrialIfNeeded(sub);
  if (sub.status === 'cancelled') return { reason: 'cancelled', sub };
  if (sub.status !== 'active') return { reason: 'invalid', sub };
  if (sub.expiry_date && new Date(sub.expiry_date).getTime() < Date.now())
    return { reason: 'expired', sub };
  return { reason: null, sub };
}

router.post(
  '/validate', licenseLimiter, validate(validateLicenseSchema),
  asyncHandler(async (req, res) => {
    const { license_key, device_fingerprint, device_name } = req.body;
    const { reason, sub } = await resolveSubscription(license_key);
    if (reason) return invalid(res, reason, sub);

    const seat = await Subscription.acquireSeat(sub.id, device_fingerprint, {
      deviceName: device_name || null,
    });
    if (!seat.ok) {
      // Every seat is in use by another machine right now. This is recoverable
      // — the user can close the app elsewhere — so say so precisely instead of
      // the old catch-all "device_mismatch".
      return invalid(res, seat.reason === 'seat_limit' ? 'seat_limit' : seat.reason, sub, {
        seats: seat.seats,
        activeSeats: seat.activeSeats,
      });
    }

    const features = entitlementsFor(sub.plan);
    return res.json({
      valid: true,
      plan: sub.plan,
      expires: sub.expiry_date ? new Date(sub.expiry_date).toISOString() : null,
      // The entitlements ride inside the signed token as well as beside it, so
      // a client that rewrites its local copy still cannot make a plan-gated
      // server endpoint agree.
      token: signLicenseToken({
        sub: license_key, plan: sub.plan, device: device_fingerprint, features,
      }),
      trial: isTrialActive(sub),
      features,
      seats: seat.seats,
      activeSeats: seat.activeSeats,
      leaseSeconds: seat.leaseSeconds,
    });
  })
);

// Keeps this device's seat alive. Cheaper than /validate (no token minting) and
// on the general API limiter, because a 5-minute heartbeat would otherwise eat
// the strict licence limiter's hourly budget.
router.post(
  '/heartbeat', apiLimiter, validate(heartbeatSchema),
  asyncHandler(async (req, res) => {
    const { license_key, device_fingerprint, device_name } = req.body;
    const { reason, sub } = await resolveSubscription(license_key);
    if (reason) return invalid(res, reason, sub);

    // renewOnly: a beat keeps a seat this device already holds, but must never
    // take one back after it was deliberately freed. Re-taking it is what made
    // the admin panel's "Free seats" button a no-op against a running client.
    const seat = await Subscription.acquireSeat(sub.id, device_fingerprint, {
      deviceName: device_name || null,
      renewOnly: true,
    });
    if (!seat.ok) {
      return invalid(res, seat.reason, sub, {
        seats: seat.seats, activeSeats: seat.activeSeats,
      });
    }
    return res.json({
      valid: true, plan: sub.plan, trial: isTrialActive(sub),
      seats: seat.seats, activeSeats: seat.activeSeats,
      leaseSeconds: seat.leaseSeconds,
    });
  })
);

// Clean shutdown: hand the seat back now rather than waiting out the lease.
// Always answers 200 — a client quitting must never block on this.
router.post(
  '/release', apiLimiter, validate(releaseSeatSchema),
  asyncHandler(async (req, res) => {
    const { license_key, device_fingerprint } = req.body;
    const sub = await Subscription.findByLicenseKey(license_key);
    if (!sub) return res.json({ released: false });
    const result = await Subscription.releaseSeat(sub.id, device_fingerprint);
    return res.json({ released: result.released, leaseSeconds: SEAT_LEASE_SECONDS });
  })
);

module.exports = router;
