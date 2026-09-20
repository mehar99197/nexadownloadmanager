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
  let sub = await Subscription.findByLicenseKeyForValidation(licenseKey);
  if (!sub) return { reason: 'not_found', sub: null };
  // A banned account is refused before anything else is even looked at: the
  // ban is on the person, so the plan's status, expiry and trial state are all
  // irrelevant, and this is the only check that makes a ban reach the desktop
  // app at all. Banning used to lock the website only — the app kept being
  // handed a fresh Pro token every day, for ever. Checking here also skips the
  // lazy trial-downgrade write below for a row that is being refused anyway.
  if (sub.owner_banned) return { reason: 'banned', sub };

  // The other half of the same ban, for a licence that is shared. A Team plan
  // is one key with N seats, and routes/user.js deliberately hands a member the
  // OWNER's key — "the key that actually unlocks the app for them" — so banning
  // a member leaves them holding a credential that still works while the check
  // above reads an owner who is perfectly fine. This request cannot tell the
  // difference: it is a key plus a device fingerprint, with no user in it, so
  // there is no device to single out and no caller to refuse. The shared secret
  // itself is therefore withdrawn — the roster loses its banned members and the
  // key is rotated (Subscription.revokeBannedMembers). This is the same lazy
  // pattern as the trial downgrade below: the ban is reconciled the first time
  // the licence is used after it, so no cron and no admin route has to know.
  //
  // The key in this request is the one that was just rotated away, whoever sent
  // it, so `not_found` is the honest answer — accusing the caller of being
  // banned would be a guess, and usually the wrong one. `sub` goes with it so
  // the refusal cannot report the trial state of a licence this key no longer
  // names. Everyone still entitled re-copies the new key from their dashboard;
  // the banned member cannot, because the ban is what stops them signing in.
  if (sub.banned_member) {
    const { rotated } = await Subscription.revokeBannedMembers(sub.id);
    if (rotated) return { reason: 'not_found', sub: null };
    // Nothing was revoked after all: either the ban was lifted between the
    // lookup and the write, or a request that raced this one had already
    // re-keyed the licence. Those two want opposite answers, so re-read instead
    // of guessing — guessing `not_found` would make the C++ client throw away
    // a key that is still perfectly good.
    sub = await Subscription.findByLicenseKeyForValidation(licenseKey);
    if (!sub) return { reason: 'not_found', sub: null };
    if (sub.owner_banned) return { reason: 'banned', sub };
  }
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
//
// This is the one licence route that deliberately does NOT go through
// resolveSubscription, so it keeps working for a banned account: giving a seat
// back is not a privilege, it is housekeeping. Refusing it would only leave the
// banned user's seat pinned for the rest of its lease — and a seat that is
// still held is a seat a legitimate team member cannot take.
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
