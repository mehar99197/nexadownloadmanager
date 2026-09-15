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
const { assessSharing, autoSuspendReason, SHARING_WINDOW_DAYS } = require('../utils/licenseAbuse');
const config = require('../config/env');
const { entitlementsFor } = require('../config/plans');
const DeviceAuth = require('../models/DeviceAuth');
const { subscriptionForUser } = require('../utils/accountPlan');
const security = require('../utils/securityEvents');

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

// A resolved subscription is usable only in the states somebody left it in
// on purpose; everything that merely ran out was already folded to Free by
// Subscription.current (see resolveSubscription).
function usabilityReason(sub) {
  if (sub.status === 'cancelled') return 'cancelled';
  if (sub.status === 'expired') return 'expired';
  if (sub.status !== 'active') return 'invalid';
  if (sub.sharing_suspended_at) return 'seat_limit';
  return null;
}

/**
 * Resolve the request's credential — a licence key, or a signed-in machine's
 * device token (routes/device.js) — to the subscription it may use.
 *
 * Returns { reason, sub, account, tokenSubject }. `tokenSubject` is what goes
 * in the licence token's `sub`: the key for a key, `user:<id>` for an
 * account, so a signed-in Team member's machine never learns the owner's key
 * from its own token. `account` is set for device tokens only.
 *
 * A device token is refused (reason `signed_out`, the one answer that makes
 * the app forget it) when it is unknown, revoked, or presented by a machine
 * other than the one it was issued to — that last case also revokes it: a
 * copied token is dead everywhere, and the legitimate machine signs in again.
 */
async function resolveCredential(req) {
  const { license_key, device_token, device_fingerprint, device_name, app_version } = req.body;
  if (!device_token) {
    const resolved = await resolveSubscription(license_key);
    return { ...resolved, account: null, tokenSubject: license_key };
  }

  const row = await DeviceAuth.findLiveToken(device_token);
  if (!row) return { reason: 'signed_out', sub: null, account: null };
  const account = { id: row.user_id, email: row.user_email, name: row.user_name };
  if (row.device_fingerprint !== device_fingerprint) {
    await DeviceAuth.revoke(row.id, 'device_mismatch');
    await security.record('device.token_misuse', {
      req, user: { id: row.user_id, email: row.user_email }, severity: 'critical',
      detail: `device token issued to "${row.device_name || 'a device'}" was presented by a different machine and has been revoked`,
    });
    return { reason: 'signed_out', sub: null, account: null };
  }
  // A banned account, or one promoted to the control panel since it signed
  // in, is signed out on the spot — the same line /api/auth draws.
  if (row.user_banned || row.user_role !== 'user') {
    await DeviceAuth.revoke(row.id, row.user_banned ? 'banned' : 'role');
    return { reason: 'signed_out', sub: null, account: null };
  }
  await DeviceAuth.touch(row.id, { deviceName: device_name || null, appVersion: app_version || null });

  const sub = await subscriptionForUser(row.user_id);
  if (!sub) return { reason: 'not_found', sub: null, account, tokenSubject: `user:${row.user_id}` };
  return { reason: usabilityReason(sub), sub, account, tokenSubject: `user:${row.user_id}` };
}

// Resolve a licence key to a usable subscription, or the reason it is not.
async function resolveSubscription(licenseKey) {
  let sub = await Subscription.findByLicenseKey(licenseKey);
  if (!sub) return { reason: 'not_found', sub: null };
  // Lazy downgrade: a finished no-card trial — or a paid plan whose period
  // lapsed — falls back to free/active, so the client keeps a working Free key
  // instead of being told `expired` and deleting it.
  sub = await Subscription.current(sub);
  // Whether the PERIOD ran out is entirely Subscription.current's business
  // now: it downgrades a lapsed paid plan to Free (after a grace window that
  // absorbs a slow renewal webhook), so a row reaching here is either usable or
  // has been deliberately stopped. Re-checking expiry_date here as well made
  // the two disagree — a licence one day past its date reported `expired`
  // inside the very grace period that exists to prevent that, and the desktop
  // client deletes a key it is told is expired.
  //
  // What remains are the two states somebody chose: an admin expiring a licence
  // (which is also how a replaced key is retired) and a cancellation.
  // A licence the sharing check suspended answers exactly like a full one
  // (usabilityReason → `seat_limit`).
  //
  // Two reasons it is `seat_limit` and not a reason of its own. Practically:
  // the desktop client already handles it well — it keeps the stored key, stops
  // beating, and tells the user to close Nexa elsewhere — whereas `cancelled`
  // or `expired` would make it delete the key, which is not something to do to
  // someone a heuristic merely suspects. And a distinct reason would teach
  // whoever is sharing the key exactly what was detected and what to change.
  return { reason: usabilityReason(sub), sub };
}

// The account block a signed-in machine shows ("Signed in as …"); absent for
// a licence key. Display only — the entitlement is inside the signed token.
const accountBlock = (account) => (account ? { account: { id: account.id, email: account.email, name: account.name } } : {});

router.post(
  '/validate', licenseLimiter, validate(validateLicenseSchema),
  asyncHandler(async (req, res) => {
    const { device_fingerprint, device_name } = req.body;
    const { reason, sub, account, tokenSubject } = await resolveCredential(req);
    if (reason) return invalid(res, reason, sub, accountBlock(account));

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
        ...accountBlock(account),
      });
    }

    // A brand-new machine on this licence is the only event worth re-assessing
    // on: renewals say nothing new, and this keeps the check off the hot path.
    //
    // It deliberately only *records* a verdict — it never suspends the
    // subscription. Fingerprints change for innocent reasons (a reinstall, a
    // replaced NIC, a reimaged laptop), and a heuristic that locks out paying
    // customers unattended costs far more than the piracy it prevents. The
    // seat limit is still doing the real enforcement underneath; this exists so
    // a human can see which keys have leaked and revoke them deliberately.
    //
    // Wrapped because a failure here must never break an activation. The Free
    // plan is skipped: it has no seats to share, so a household with three
    // machines on it is not a "spread" of anything.
    if (seat.reason === 'acquired' && sub.plan !== 'free') {
      try {
        const spread = await Subscription.deviceSpread(sub.id, SHARING_WINDOW_DAYS);
        const verdict = assessSharing({ seats: seat.seats, ...spread });
        await Subscription.recordSharingAssessment(sub.id, verdict);

        // Suspending is a much higher bar than flagging — see
        // autoSuspendReason(). `sharing_exempt` is an admin having already
        // looked at this licence and decided it is fine; the server does not
        // get to overrule that, though flagging above still records what it
        // sees so a licence that keeps spreading resurfaces for review.
        if (config.LICENSE_AUTO_SUSPEND && !sub.sharing_exempt) {
          const reason = autoSuspendReason({ seats: seat.seats, ...spread });
          if (reason) {
            const { suspended } = await Subscription.suspendForSharing(sub.id, reason);
            // Hand back the seat acquireSeat() just granted. The licence is
            // suspended, so the lease serves nothing — and on a one-seat
            // licence it would block the rightful owner for a further fifteen
            // minutes after an admin lifts the suspension, which turns a
            // reversible action into one that visibly is not.
            await Subscription.releaseSeat(sub.id, device_fingerprint);
            if (suspended) {
              console.warn(
                `[SECURITY] licence ${sub.license_key} auto-suspended for sharing: ${reason}`
              );
            }
            // Take effect on this very request rather than the next one.
            return invalid(res, 'seat_limit', sub, {
              seats: seat.seats, activeSeats: seat.activeSeats, ...accountBlock(account),
            });
          }
        }
      } catch (err) {
        req.log?.warn?.({ err, subscriptionId: sub.id }, 'sharing assessment failed');
      }
    }

    const features = entitlementsFor(sub.plan);
    return res.json({
      valid: true,
      plan: sub.plan,
      expires: sub.expiry_date ? new Date(sub.expiry_date).toISOString() : null,
      // The entitlements ride inside the signed token as well as beside it, so
      // a client that rewrites its local copy still cannot make a plan-gated
      // server endpoint agree.
      // `acct` rides in the signature for a signed-in machine so the app can
      // refuse a token minted for another account, the way it refuses one
      // minted for another key.
      token: signLicenseToken({
        sub: tokenSubject, plan: sub.plan, device: device_fingerprint, features,
        ...(account ? { acct: account.id } : {}),
      }),
      trial: isTrialActive(sub),
      features,
      seats: seat.seats,
      activeSeats: seat.activeSeats,
      leaseSeconds: seat.leaseSeconds,
      ...accountBlock(account),
    });
  })
);

// Keeps this device's seat alive, and re-issues the licence token.
//
// Re-issuing here is what lets the token be short-lived. It used to live 24
// hours because /validate — which runs every six hours on the client — was the
// only thing that minted one, so a captured token stayed usable for a day after
// the licence behind it was revoked. A beat already resolves the subscription
// and renews the seat, i.e. it has just done every authorisation check minting
// requires, so handing back a fresh token costs one Ed25519 signature and drops
// that window to the token's TTL.
//
// Still on the general API limiter rather than the strict licence one: a
// 5-minute beat would eat that budget, and the work here is cheap.
router.post(
  '/heartbeat', apiLimiter, validate(heartbeatSchema),
  asyncHandler(async (req, res) => {
    const { device_fingerprint, device_name } = req.body;
    const { reason, sub, account, tokenSubject } = await resolveCredential(req);
    if (reason) return invalid(res, reason, sub, accountBlock(account));

    // renewOnly: a beat keeps a seat this device already holds, but must never
    // take one back after it was deliberately freed. Re-taking it is what made
    // the admin panel's "Free seats" button a no-op against a running client.
    const seat = await Subscription.acquireSeat(sub.id, device_fingerprint, {
      deviceName: device_name || null,
      renewOnly: true,
    });
    if (!seat.ok) {
      // seat_unknown_device means this machine never activated — it went
      // straight to beating. Answer `seat_limit`, the one rejection the client
      // keeps its stored key for: a genuine client cannot reach this, and a
      // modified one is sent back through /validate, where the sharing
      // assessment it was avoiding actually runs.
      const wire = seat.reason === 'seat_unknown_device' ? 'seat_limit' : seat.reason;
      return invalid(res, wire, sub, {
        seats: seat.seats, activeSeats: seat.activeSeats, ...accountBlock(account),
      });
    }
    const features = entitlementsFor(sub.plan);
    return res.json({
      valid: true, plan: sub.plan, trial: isTrialActive(sub),
      // Same claims as /validate, so the client can simply replace the token it
      // holds. Entitlements are re-derived from the CURRENT plan, which means a
      // mid-session downgrade reaches the client on the next beat rather than
      // waiting for the six-hourly revalidation.
      token: signLicenseToken({
        sub: tokenSubject, plan: sub.plan, device: device_fingerprint, features,
        ...(account ? { acct: account.id } : {}),
      }),
      features,
      seats: seat.seats, activeSeats: seat.activeSeats,
      leaseSeconds: seat.leaseSeconds,
      ...accountBlock(account),
    });
  })
);

// Clean shutdown: hand the seat back now rather than waiting out the lease.
// Always answers 200 — a client quitting must never block on this.
router.post(
  '/release', apiLimiter, validate(releaseSeatSchema),
  asyncHandler(async (req, res) => {
    const { license_key, device_token, device_fingerprint } = req.body;
    let sub = null;
    if (device_token) {
      const row = await DeviceAuth.findLiveToken(device_token);
      if (row && row.device_fingerprint === device_fingerprint)
        sub = await subscriptionForUser(row.user_id);
    } else {
      sub = await Subscription.findByLicenseKey(license_key);
    }
    if (!sub) return res.json({ released: false });
    const result = await Subscription.releaseSeat(sub.id, device_fingerprint);
    return res.json({ released: result.released, leaseSeconds: SEAT_LEASE_SECONDS });
  })
);

module.exports = router;
