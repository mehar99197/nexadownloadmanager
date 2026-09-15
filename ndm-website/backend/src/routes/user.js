'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');

const asyncHandler = require('../utils/asyncHandler');
const { ok, fail } = require('../utils/respond');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { licenseRotateLimiter } = require('../middleware/rateLimiter');
const { sendLicenseEmail } = require('../utils/email');
const { updateProfileSchema, deleteAccountSchema, deviceParamsSchema } = require('../schemas/user.schema');
const { signAccessToken, generateRefreshToken } = require('../utils/jwt');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Payment = require('../models/Payment');
const Review = require('../models/Review');
const TeamMember = require('../models/TeamMember');
const AuditLog = require('../models/AuditLog');
const stripe = require('../utils/stripe');
const { isTrialActive } = require('../utils/license');
const { stripSensitive } = require('../utils/sanitize');
const { refreshCookieOptions } = require('../utils/cookies');
const { passwordProblem } = require('../utils/passwordPolicy');

const BCRYPT_COST = 12;
const REFRESH_COOKIE = 'ndm_refresh';
const SESSION_HINT_COOKIE = 'ndm_session';

function sanitizeUser(user) {
  // stripSensitive() removes every credential column, including the ones this
  // used to miss (totp_secret, totp_recovery, token_version) — a user reading
  // their own profile has no business seeing their own TOTP seed either, since
  // an XSS or a leaked response body would then be a second factor.
  const safe = stripSensitive(user);
  const password_hash = user.password_hash;
  // The site needs to know whether password sign-in is available for this
  // account without ever seeing the hash: a Google-created account shows
  // "Set a password" instead of "Change password".
  safe.hasPassword = Boolean(password_hash);
  safe.hasGoogle = Boolean(user.google_id);
  // CONTRACT.md describes the User as carrying `createdAt`/`updatedAt` and
  // `emailVerified`, but stripSensitive() copies the DB row, which is
  // snake_case. The site read `user.createdAt` and got undefined every time,
  // so the profile page said "Member since —" for every account that has ever
  // existed. Expose the documented names (the raw columns stay for anything
  // already reading them).
  safe.createdAt = toIso(user.created_at);
  safe.updatedAt = toIso(user.updated_at);
  safe.emailVerified = Boolean(user.email_verified);
  // Lockout bookkeeping is the server's business (and the admin panel's); the
  // sign-in form is deliberately told nothing about it, so the profile must
  // not become the place it leaks from either.
  delete safe.failed_logins;
  delete safe.locked_until;
  delete safe.lock_level;
  delete safe.lock_notified_at;
  return safe;
}

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Current subscription, with lazy trial expiry and lazy paid lapse applied.
async function findUserSubscription(userId) {
  const active = await Subscription.findActiveByUserId(userId);
  const sub = active || (await Subscription.findByUserId(userId))[0] || null;
  return Subscription.current(sub);
}

function subscriptionSummary(sub) {
  if (!sub) return null;
  return {
    plan: sub.plan, status: sub.status, expiryDate: sub.expiry_date,
    seats: sub.seats, licenseKey: sub.license_key,
    trial: isTrialActive(sub), trialEndsAt: toIso(sub.trial_ends_at),
    cancelAtPeriodEnd: Boolean(Number(sub.cancel_at_period_end)),
  };
}

// A Team member with no paid plan of their own uses the team's key. The
// membership only counts while the owner's plan is a live Team plan.
async function teamMembership(userId) {
  const m = await TeamMember.findActiveByUserId(userId);
  if (!m || m.owner_plan !== 'team' || m.owner_status !== 'active') return null;
  if (m.owner_expiry_date && new Date(m.owner_expiry_date).getTime() < Date.now()) return null;
  return m;
}

router.get(
  '/me', requireAuth,
  asyncHandler(async (req, res) => {
    const [sub, team] = await Promise.all([
      findUserSubscription(req.user.id), teamMembership(req.user.id),
    ]);
    return ok(res, {
      user: sanitizeUser(req.user),
      subscription: subscriptionSummary(sub),
      team: team ? { role: 'member', ownerName: team.owner_name, plan: team.owner_plan } : null,
    });
  })
);

router.put(
  '/profile', requireAuth, validate(updateProfileSchema),
  asyncHandler(async (req, res) => {
    const { name, currentPassword, newPassword } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (newPassword !== undefined) {
      // A Google-created account has no password yet; the session alone is
      // enough to set the first one. Every account that already has one must
      // still prove it, so a hijacked tab cannot silently change it.
      if (req.user.password_hash) {
        if (!currentPassword)
          return fail(res, 'VALIDATION_ERROR', 'Current password is required to set a new password', 400);
        const matches = await bcrypt.compare(currentPassword, req.user.password_hash);
        if (!matches) return fail(res, 'INVALID_PASSWORD', 'Current password is incorrect', 400);
      }
      const problem = await passwordProblem(newPassword, { email: req.user.email });
      if (problem) return fail(res, 'WEAK_PASSWORD', problem, 400);
      updates.passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    }
    if (Object.keys(updates).length) await User.update(req.user.id, updates);
    // Changing a password is how somebody responds to "I think another person
    // is in my account", so every OTHER session has to end. The caller keeps
    // working: they are issued a token on the new generation below.
    let token;
    if (newPassword !== undefined) {
      await User.revokeSessions(req.user.id);
      const { token: refreshToken, hash } = generateRefreshToken();
      await User.update(req.user.id, { refreshTokenHash: hash });
      res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions('/api/auth', 30 * 24 * 60 * 60 * 1000));
      token = signAccessToken(await User.findById(req.user.id));
    }
    const user = await User.findById(req.user.id);
    return ok(res, { user: sanitizeUser(user), ...(token ? { token } : {}) });
  })
);

/**
 * The licence key for this account.
 *
 * Gated on a verified address. The key is the product: handing one to an
 * address nobody has proved they own means a sign-up form with a stranger's
 * email yields a working licence. requireAuth already refuses an unverified
 * account while EMAIL_VERIFICATION_REQUIRED is on, so this is the second lock
 * on the same door — and the one that still holds if that setting is ever
 * turned off.
 */
router.get(
  '/license', requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.user.email_verified)
      return fail(res, 'EMAIL_NOT_VERIFIED',
        'Verify your email address to receive your license key', 403, { canResend: true });
    const sub = await findUserSubscription(req.user.id);
    // A team member on the Free plan gets the team's key here, so the
    // dashboard shows the key that actually unlocks the app for them.
    const ownPaid = sub && sub.status === 'active' && sub.plan !== 'free';
    if (!ownPaid) {
      const team = await teamMembership(req.user.id);
      if (team) {
        return ok(res, {
          licenseKey: team.owner_license_key, plan: team.owner_plan, status: team.owner_status,
          expiryDate: team.owner_expiry_date, trial: false, trialEndsAt: null,
          viaTeam: true, teamOwner: team.owner_name,
        });
      }
    }
    if (!sub) return fail(res, 'NOT_FOUND', 'No subscription found', 404);
    return ok(res, {
      licenseKey: sub.license_key, plan: sub.plan, status: sub.status, expiryDate: sub.expiry_date,
      trial: isTrialActive(sub), trialEndsAt: toIso(sub.trial_ends_at), viaTeam: false,
    });
  })
);

/**
 * POST /user/license/rotate — issue a new licence key and cut every machine
 * using the old one loose.
 *
 * Without this there was no way to take a leaked key back. Removing somebody
 * from a Team plan left them holding the owner's real key (they are handed it
 * by design — it is what unlocks the app for them), and no activation row
 * records WHO created it, so nothing on the server could tell that member's
 * machine from the owner's. "Remove member" was a roster edit and nothing more.
 *
 * Only the owner of a paid subscription may rotate: a team member's key is not
 * theirs to invalidate, and a Free key is not worth the support call.
 */
router.post(
  '/license/rotate', requireAuth, licenseRotateLimiter,
  asyncHandler(async (req, res) => {
    const sub = await findUserSubscription(req.user.id);
    if (!sub) return fail(res, 'NOT_FOUND', 'No subscription found', 404);
    if (sub.plan === 'free')
      return fail(res, 'NOT_ROTATABLE', 'Only a paid licence key can be rotated', 400);
    if (sub.status !== 'active')
      return fail(res, 'NOT_ROTATABLE', 'This licence is not active', 400);

    const result = await Subscription.rotateLicenseKey(sub.id);
    if (!result.ok) return fail(res, 'ROTATE_FAILED', 'Could not issue a new licence key', 500);

    await AuditLog.create({
      adminUserId: null, action: 'license.rotated', entityType: 'subscription', entityId: sub.id,
      summary: `${req.user.email} rotated their ${sub.plan} licence key`.slice(0, 255),
      metadata: { devicesRevoked: result.devicesRevoked },
    });
    // Best-effort, like every other outbound mail: the key is already rotated
    // and is on screen in the response, so a mail failure must not report the
    // rotation as failed and invite a second one.
    await sendLicenseEmail(req.user, result.licenseKey, sub.plan).catch((err) =>
      // eslint-disable-next-line no-console
      console.error('[user] licence rotation email failed:', err.message));

    return ok(res, {
      licenseKey: result.licenseKey,
      plan: sub.plan,
      devicesRevoked: result.devicesRevoked,
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

/**
 * The devices currently holding a seat on this account's licence.
 *
 * Seats are concurrent, so a user who hits the limit needs a way to free one
 * themselves — otherwise a laptop left running at home locks them out of their
 * own licence until the lease times out.
 */
router.get(
  '/devices', requireAuth,
  asyncHandler(async (req, res) => {
    const sub = await findUserSubscription(req.user.id);
    if (!sub) return ok(res, { seats: 0, activeSeats: 0, devices: [] });
    const [devices, activeSeats] = await Promise.all([
      Subscription.listActivations(sub.id),
      Subscription.activeSeatCount(sub.id),
    ]);
    return ok(res, {
      seats: Number(sub.seats) || 1,
      activeSeats,
      devices: devices.map((d) => ({
        id: d.id,
        // Never expose the full fingerprint — a short prefix is enough for the
        // user to tell two machines apart.
        shortId: String(d.device_fingerprint).slice(0, 8),
        name: d.device_name || 'Unnamed device',
        active: Boolean(Number(d.active)),
        leaseExpiresAt: toIso(d.lease_expires_at),
        lastSeenAt: toIso(d.last_seen_at),
        firstSeenAt: toIso(d.created_at),
      })),
    });
  })
);

/**
 * Everything we hold about this account, as one JSON document. This is the
 * self-service side of a data-access request; no admin has to be involved.
 */
router.get(
  '/export', requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const subs = await Subscription.findByUserId(userId);
    const [payments, review, devicesBySub, team] = await Promise.all([
      Payment.findByUserId(userId, { page: 1, limit: 500 }),
      Review.findByUserId(userId),
      Promise.all(subs.map((s) => Subscription.listActivations(s.id))),
      TeamMember.findActiveByUserId(userId),
    ]);
    const u = req.user;
    const document = {
      exportedAt: new Date().toISOString(),
      account: {
        id: u.id, name: u.name, email: u.email, role: u.role,
        emailVerified: Boolean(u.email_verified), trialUsed: Boolean(u.trial_used),
        createdAt: toIso(u.created_at), updatedAt: toIso(u.updated_at),
      },
      subscriptions: subs.map((s, i) => ({
        id: s.id, plan: s.plan, status: s.status, licenseKey: s.license_key, seats: s.seats,
        startDate: toIso(s.start_date), expiryDate: toIso(s.expiry_date),
        trialEndsAt: toIso(s.trial_ends_at), stripeCustomerId: s.stripe_customer_id || null,
        devices: (devicesBySub[i] || []).map((d) => ({
          name: d.device_name || null, fingerprintPrefix: String(d.device_fingerprint).slice(0, 8),
          firstSeenAt: toIso(d.created_at), lastSeenAt: toIso(d.last_seen_at),
        })),
      })),
      payments: (payments || []).map((p) => ({
        id: p.id, amount: p.amount, currency: p.currency, plan: p.plan,
        billingCycle: p.billing_cycle, status: p.status, createdAt: toIso(p.created_at),
      })),
      review: review ? {
        rating: review.rating, comment: review.comment, status: review.status,
        createdAt: toIso(review.created_at), updatedAt: toIso(review.updated_at),
      } : null,
      team: team ? { ownerName: team.owner_name, joinedAt: toIso(team.accepted_at) } : null,
    };
    res.setHeader('Content-Disposition', `attachment; filename="nexa-account-${u.id}.json"`);
    return ok(res, document);
  })
);

/**
 * Self-service account deletion. Irreversible: the row cascades to
 * subscriptions, activations, payments, reviews and team rows. A paid Stripe
 * subscription is cancelled first so nobody is billed for a deleted account.
 * Control-panel accounts are excluded — the creator removes those.
 */
router.delete(
  '/account', requireAuth, validate(deleteAccountSchema),
  asyncHandler(async (req, res) => {
    const user = req.user;
    if (user.role !== 'user')
      return fail(res, 'FORBIDDEN', 'Control-panel accounts are removed by the creator, not from here', 403);
    // A Google-created account has no password to check; typing DELETE while
    // holding a valid session is the whole proof available for it. Every account
    // that does have a password must still supply it.
    if (user.password_hash) {
      if (!req.body.password)
        return fail(res, 'INVALID_PASSWORD', 'Password is required to delete this account', 400);
      const matches = await bcrypt.compare(req.body.password, user.password_hash);
      if (!matches) return fail(res, 'INVALID_PASSWORD', 'Password is incorrect', 400);
    }

    const subs = await Subscription.findByUserId(user.id);
    for (const s of subs) {
      if (s.stripe_subscription_id && s.status === 'active') {
        // Immediate, unlike /subscription/cancel: the account is going away,
        // so there is no remaining period to hand back to anybody.
        try { await stripe.cancelSubscription(s.stripe_subscription_id, { atPeriodEnd: false }); }
        catch (err) {
          // eslint-disable-next-line no-console
          console.error('[user] stripe cancel on delete failed:', err.message);
        }
      }
    }
    const members = subs.length
      ? (await Promise.all(subs.map((s) => TeamMember.countBySubscription(s.id)))).reduce((a, b) => a + b, 0)
      : 0;

    // Audit first: admin_user_id is null here anyway, but the summary must
    // outlive the row it describes.
    await AuditLog.create({
      adminUserId: null, action: 'user.self_deleted', entityType: 'user', entityId: user.id,
      summary: `${user.email} deleted their own account`,
      metadata: { plans: subs.map((s) => s.plan), teamMembersDropped: members },
    });
    await User.remove(user.id);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    res.clearCookie(SESSION_HINT_COOKIE, { path: '/' });
    return ok(res, { deleted: true });
  })
);

router.delete(
  '/devices/:id', requireAuth, validate(deviceParamsSchema),
  asyncHandler(async (req, res) => {
    const sub = await findUserSubscription(req.user.id);
    if (!sub) return fail(res, 'NOT_FOUND', 'No subscription for this account', 404);
    const released = await Subscription.releaseSeatById(sub.id, Number(req.params.id));
    if (!released) return fail(res, 'NOT_FOUND', 'Device not found on this licence', 404);
    return ok(res, { released: true, activeSeats: await Subscription.activeSeatCount(sub.id) });
  })
);

module.exports = router;
