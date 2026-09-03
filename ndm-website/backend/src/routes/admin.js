'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');

const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Payment = require('../models/Payment');
const Review = require('../models/Review');
const Release = require('../models/Release');
const Ad = require('../models/Ad');
const AuditLog = require('../models/AuditLog');
const ContactMessage = require('../models/ContactMessage');
const config = require('../config/env');
const { getPool } = require('../config/db');

const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const { requireAdmin, ipWhitelist } = require('../middleware/adminAuth');
const { adminLoginLimiter, adminRefreshLimiter } = require('../middleware/rateLimiter');
const { ok, fail } = require('../utils/respond');
const { signAdminToken, generateRefreshToken, hashRefreshToken } = require('../utils/jwt');
const { thresholds: sharingThresholdsFor, SHARING_WINDOW_DAYS } = require('../utils/licenseAbuse');
const { recentRejections } = require('../utils/tokenAbuse');

// Shown alongside the flagged list so an admin can see what the numbers mean
// rather than having to guess why a licence was flagged.
const sharingThresholds = {
  windowDays: SHARING_WINDOW_DAYS,
  perSeat: sharingThresholdsFor(1),
};
const { generateLicenseKey, planSeats, planExpiry, expiryForPlanChange } = require('../utils/license');
const { mountTwoFactor, signChallenge } = require('./twoFactor');
const { storeUpload, removeStored, artifactFor } = require('../utils/releaseFiles');
const { ctr } = require('../utils/ads');

// Admin SPA session: opaque token in an httpOnly cookie scoped to /api/admin;
// only its SHA-256 hash is stored (users.admin_refresh_token_hash). Lifetime
// matches the 8h admin JWT so a page refresh can mint a new bearer token.
const ADMIN_REFRESH_COOKIE = 'ndm_admin_refresh';
const ADMIN_REFRESH_PATH = '/api/admin';

function adminRefreshCookieOptions() {
  return {
    httpOnly: true, sameSite: 'lax', secure: config.secureCookies,
    maxAge: 8 * 60 * 60 * 1000, path: ADMIN_REFRESH_PATH,
  };
}

async function issueAdminSession(res, user) {
  const { token: refreshToken, hash } = generateRefreshToken();
  await User.update(user.id, { adminRefreshTokenHash: hash });
  res.cookie(ADMIN_REFRESH_COOKIE, refreshToken, adminRefreshCookieOptions());
}

function adminIdentity(user) {
  return { id: String(user.id), name: user.name, email: user.email, role: user.role };
}

const {
  adminLoginSchema, createAdminUserSchema, resetUserPasswordSchema,
  updateUserSchema, updateReviewSchema, updateSubscriptionSchema,
  createSubscriptionSchema, reviewListQuerySchema, bulkReviewSchema,
  createReleaseSchema, updateReleaseSchema, releaseArtifactParamsSchema, listQuerySchema,
  idParamSchema, deleteUserSchema,
} = require('../schemas/admin.schema');
const {
  createAdSchema, updateAdSchema, adIdParamSchema,
} = require('../schemas/ad.schema');
const {
  contactListQuerySchema, contactIdParamSchema,
  updateContactStatusSchema, contactReplySchema,
} = require('../schemas/contact.schema');
const { sendContactReply } = require('../utils/email');
const { stripSensitive } = require('../utils/sanitize');

function monthlyPrice(plan) {
  if (plan === 'pro') return 5;
  if (plan === 'team') return 15;
  return 0;
}

// Never hand-roll this list again: /users/:id/details reads the row with
// SELECT *, so anything missed here reaches a staff admin — including, when it
// stripped only these three hashes, the creator's TOTP secret and recovery
// hashes. utils/sanitize.js is the single definition.
const safeUser = stripSensitive;

/**
 * A staff admin may only act on ordinary customer accounts. Banning, resetting
 * or revoking a fellow admin — and above all the creator — is reserved for the
 * root panel (/api/root/admins). A root token passing through here keeps its
 * reach, since req.isRoot is only ever set by the root token family.
 */
function blockedStaffTarget(req, res, user) {
  if (req.isRoot || user.role === 'user') return false;
  fail(res, 'FORBIDDEN', 'Only the creator can modify a control-panel account', 403);
  return true;
}

async function audit(req, action, entityType, entityId, summary, metadata) {
  await AuditLog.create({
    adminUserId: req.admin && req.admin.id,
    action,
    entityType,
    entityId,
    summary,
    metadata,
  });
}

router.post(
  '/login', adminLoginLimiter, ipWhitelist, validate(adminLoginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findByEmail(email);
    // A Google-created account has NO password hash. bcrypt.compare against
    // null throws, so an account promoted to admin that way answered 500 to
    // every sign-in attempt instead of a plain rejection.
    if (!user || user.role !== 'admin' || !user.password_hash)
      return fail(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return fail(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
    if (user.banned) return fail(res, 'FORBIDDEN', 'Account is banned', 403);
    // Second factor on: no session yet — hand back a short-lived challenge
    // that only POST /login/2fa (with a valid code) can turn into one.
    if (user.totp_enabled) {
      return ok(res, {
        requiresTwoFactor: true,
        challenge: signChallenge(user, { secret: config.JWT_ADMIN_SECRET, realm: 'admin' }),
      });
    }
    return ok(res, await finishAdminLogin(res, user));
  })
);

async function finishAdminLogin(res, user) {
  await issueAdminSession(res, user);
  return { token: signAdminToken(user), admin: adminIdentity(user) };
}

mountTwoFactor(router, {
  realm: 'admin',
  secret: config.JWT_ADMIN_SECRET,
  eligible: (user) => user.role === 'admin',
  finishLogin: finishAdminLogin,
  gate: requireAdmin,
  audit: (req, action, user, summary) => audit({ admin: req.admin || user }, action, 'user', user.id, summary),
});

// Mint a fresh admin bearer token from the ndm_admin_refresh cookie (rotated on
// every call). Open like /login: IP gate + login limiter, no bearer required.
router.post(
  '/refresh', adminRefreshLimiter, ipWhitelist,
  asyncHandler(async (req, res) => {
    const cookie = req.cookies && req.cookies[ADMIN_REFRESH_COOKIE];
    if (!cookie) return fail(res, 'NO_REFRESH_TOKEN', 'Missing admin refresh token', 401);
    const user = await User.findByAdminRefreshTokenHash(hashRefreshToken(cookie));
    if (!user || user.role !== 'admin') {
      res.clearCookie(ADMIN_REFRESH_COOKIE, { path: ADMIN_REFRESH_PATH });
      return fail(res, 'INVALID_REFRESH_TOKEN', 'Admin session is invalid or has expired', 401);
    }
    if (user.banned) {
      await User.update(user.id, { adminRefreshTokenHash: null });
      res.clearCookie(ADMIN_REFRESH_COOKIE, { path: ADMIN_REFRESH_PATH });
      return fail(res, 'FORBIDDEN', 'Account is banned', 403);
    }
    await issueAdminSession(res, user);
    return ok(res, { token: signAdminToken(user) });
  })
);

router.post(
  '/logout', ipWhitelist,
  asyncHandler(async (req, res) => {
    const cookie = req.cookies && req.cookies[ADMIN_REFRESH_COOKIE];
    if (cookie) {
      const user = await User.findByAdminRefreshTokenHash(hashRefreshToken(cookie));
      if (user) await User.update(user.id, { adminRefreshTokenHash: null });
    }
    res.clearCookie(ADMIN_REFRESH_COOKIE, { path: ADMIN_REFRESH_PATH });
    return ok(res, { loggedOut: true });
  })
);

router.use(requireAdmin);

router.get(
  '/me',
  asyncHandler(async (req, res) => ok(res, {
    ...adminIdentity(req.admin), twoFactorEnabled: Boolean(req.admin.totp_enabled),
  }))
);

router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const [totalUsers, activeSubscriptions, paidSubs, signupAgg,
           pendingReviews, recentPayments, planDistribution,
           revenueSeries, recentActivity, ads, contact] = await Promise.all([
      User.count(),
      Subscription.countActive(),
      Subscription.findPaidActive(),
      User.signupAgg(30),
      Review.count({ status: 'pending' }),
      Payment.listRecent(10),
      Subscription.countByPlan(),
      Payment.revenueByMonth(6),
      AuditLog.listRecent(12),
      Ad.stats(),
      ContactMessage.stats(),
    ]);

    const mrr = paidSubs.reduce((sum, s) => sum + monthlyPrice(s.plan), 0);
    const newSignups = (signupAgg || []).map((g) => ({ date: g.date, count: g.count }));

    return ok(res, {
      totalUsers,
      activeSubscriptions,
      mrr,
      newSignups,
      pendingReviews,
      recentPayments,
      planDistribution,
      revenueSeries,
      recentActivity,
      ads,
      contact,
      lastUpdated: new Date().toISOString(),
      system: {
        node: process.version,
        environment: config.NODE_ENV,
        stripe: config.stripeMode,
        email: config.isEmailMock ? 'mock' : 'live',
      },
    });
  })
);

router.get(
  '/health',
  asyncHandler(async (req, res) => {
    const started = Date.now();
    const pool = await getPool();
    await pool.query('SELECT 1');
    return ok(res, {
      database: 'connected',
      latencyMs: Date.now() - started,
      stripe: config.stripeMode,
      email: config.isEmailMock ? 'mock' : 'configured',
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
    });
  })
);

router.get(
  '/activity',
  asyncHandler(async (req, res) => {
    return ok(res, await AuditLog.listRecent(req.query.limit || 50));
  })
);

router.post(
  '/users', validate(createAdminUserSchema),
  asyncHandler(async (req, res) => {
    const { name, email, password, plan } = req.body;
    if (await User.findByEmail(email)) return fail(res, 'EMAIL_EXISTS', 'An account with this email already exists', 409);
    const user = await User.create({
      name,
      email,
      passwordHash: await bcrypt.hash(password, 12),
      role: 'user',
      emailVerified: true,
    });
    const subscription = await Subscription.create({
      userId: user.id,
      plan,
      status: 'active',
      licenseKey: generateLicenseKey(),
      seats: planSeats(plan),
      startDate: new Date(),
      expiryDate: planExpiry(plan),
    });
    await audit(req, 'user.created', 'user', user.id, `Created user ${email}`, { role: 'user', plan });
    return ok(res, { user: safeUser(user), subscription }, 201);
  })
);

// Exports are capped so one click cannot pull the whole users table into
// memory. The cap is shared with /subscriptions/export and reported back, so
// the panel can say the file is truncated instead of silently losing rows.
const EXPORT_MAX = 5000;

router.get(
  '/users/export',
  asyncHandler(async (req, res) => {
    const users = await User.listAll({
      limit: EXPORT_MAX,
      q: req.query.q,
      role: req.query.role,
      banned: req.query.banned === undefined ? undefined : req.query.banned === 'true',
      emailVerified: req.query.emailVerified === undefined ? undefined : req.query.emailVerified === 'true',
    });
    return ok(res, users.map(safeUser));
  })
);

router.get(
  '/users', validate(listQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, limit, q, role, banned, emailVerified } = req.query;
    const { users, totalCount } = await User.list({
      page,
      limit,
      q,
      role,
      banned: banned === undefined ? undefined : banned === 'true',
      emailVerified: emailVerified === undefined ? undefined : emailVerified === 'true',
    });
    const ids = users.map((u) => u.id);
    const subs = await Subscription.findByUserIds(ids);
    const subByUser = new Map();
    for (const s of subs) {
      // Results are newest first; keep the current subscription for each user.
      if (!subByUser.has(s.user_id)) subByUser.set(s.user_id, s);
    }

    const withPlan = users.map((u) => {
      const sub = subByUser.get(u.id) || null;
      return { ...u, plan: sub ? sub.plan : 'free', subscription: sub };
    });

    return ok(res, { users: withPlan, page, limit, totalCount });
  })
);

router.get(
  '/users/:id/details', validate(idParamSchema),
  asyncHandler(async (req, res) => {
    const user = await User.findById(Number(req.params.id));
    if (!user) return fail(res, 'NOT_FOUND', 'User not found', 404);
    const [subscriptions, payments, reviews] = await Promise.all([
      Subscription.findByUserId(user.id),
      Payment.findByUserId(user.id),
      Review.listByUserId(user.id),
    ]);
    return ok(res, { user: safeUser(user), subscriptions, payments, reviews });
  })
);

router.put(
  '/users/:id', validate(updateUserSchema),
  asyncHandler(async (req, res) => {
    const { banned, plan } = req.body;
    const user = await User.findById(Number(req.params.id));
    if (!user) return fail(res, 'NOT_FOUND', 'User not found', 404);
    if (blockedStaffTarget(req, res, user)) return undefined;

    const updates = {};
    if (banned !== undefined) updates.banned = banned;
    if (req.body.emailVerified !== undefined) updates.emailVerified = req.body.emailVerified;
    if (user.id === req.admin.id && banned === true)
      return fail(res, 'SELF_LOCKOUT', 'You cannot disable your own admin account', 400);
    if (Object.keys(updates).length) await User.update(user.id, updates);

    if (plan !== undefined) {
      const currentSubscription = (await Subscription.findByUserId(user.id))[0] || null;
      if (currentSubscription) {
        // An explicit admin plan change ends any running trial so lazy trial
        // expiry cannot silently undo it later, and moves the expiry date with
        // the plan (see expiryForPlanChange — free's is ~100 years out, so
        // carrying it across a change is wrong in both directions).
        const implied = expiryForPlanChange(
          currentSubscription.plan, plan, currentSubscription.expiry_date
        );
        await Subscription.updateCurrentByUserId(user.id, {
          plan, seats: planSeats(plan), trialEndsAt: null,
          ...(implied === undefined ? {} : { expiryDate: implied }),
        });
      } else {
        await Subscription.create({
          userId: user.id,
          plan,
          status: 'active',
          licenseKey: generateLicenseKey(),
          seats: planSeats(plan),
          startDate: new Date(),
          expiryDate: planExpiry(plan),
        });
      }
    }

    const sub = (await Subscription.findByUserId(user.id))[0] || null;
    const fresh = await User.findById(user.id);
    await audit(req, 'user.updated', 'user', user.id, `Updated user ${fresh.email}`, req.body);
    return ok(res, { user: safeUser(fresh), subscription: sub });
  })
);

/**
 * DELETE /admin/users/:id — erase a customer account and everything it owns.
 *
 * Irreversible, and the only admin action that destroys data rather than
 * changing it, so it is fenced three ways:
 *
 *  - `blockedStaffTarget` keeps staff to `role:'user'` accounts. A staff admin
 *    cannot delete a colleague or the creator; only the root console can reach
 *    those, and a root token passing through here keeps its own reach.
 *  - the body must repeat the target's exact address, so a mis-clicked row
 *    cannot destroy an account.
 *  - the audit row is written BEFORE the delete, because
 *    `audit_logs.admin_user_id` is ON DELETE SET NULL and the record has to
 *    outlive the cascade.
 *
 * The cascade is the schema's, not this route's: subscriptions, payments,
 * reviews and (through subscriptions) licence activations and team rows are
 * ON DELETE CASCADE, while audit logs, ads and contact messages are
 * ON DELETE SET NULL so the history of what was done survives the person.
 */
router.delete(
  '/users/:id', validate(deleteUserSchema),
  asyncHandler(async (req, res) => {
    const user = await User.findById(Number(req.params.id));
    if (!user) return fail(res, 'NOT_FOUND', 'Account not found', 404);
    // Self BEFORE the staff-target gate. A staff admin's own row is a
    // control-panel account, so blockedStaffTarget would answer "only the
    // creator can modify a control-panel account" — true, but useless advice
    // for someone who has just tried to delete themselves.
    if (user.id === (req.admin && req.admin.id))
      return fail(res, 'SELF_LOCKOUT', 'You cannot delete your own account', 400);
    // A creator account is never deletable over the API, whoever is asking —
    // including the creator's own console.
    if (user.role === 'root')
      return fail(res, 'FORBIDDEN', 'A creator account cannot be deleted over the API', 403);
    if (blockedStaffTarget(req, res, user)) return undefined;
    if (String(user.email).toLowerCase() !== req.body.confirmEmail)
      return fail(res, 'CONFIRM_MISMATCH', 'The confirmation email does not match this account', 400);

    await audit(req, 'user.deleted', 'user', user.id,
      `Deleted account ${user.email} and all of its data`, { email: user.email, role: user.role });
    await User.remove(user.id);
    return ok(res, { deleted: true });
  })
);

router.post(
  '/users/:id/reset-password', validate(resetUserPasswordSchema),
  asyncHandler(async (req, res) => {
    const user = await User.findById(Number(req.params.id));
    if (!user) return fail(res, 'NOT_FOUND', 'User not found', 404);
    if (blockedStaffTarget(req, res, user)) return undefined;
    await User.update(user.id, { passwordHash: await bcrypt.hash(req.body.password, 12) });
    // Ends every live session, not just the refresh cookies — see
    // User.revokeSessions.
    await User.revokeSessions(user.id);
    await audit(req, 'user.password_reset', 'user', user.id, `Reset password for ${user.email}`);
    return ok(res, { reset: true });
  })
);

router.post(
  '/users/:id/revoke-sessions', validate(idParamSchema),
  asyncHandler(async (req, res) => {
    const user = await User.findById(Number(req.params.id));
    if (!user) return fail(res, 'NOT_FOUND', 'User not found', 404);
    if (blockedStaffTarget(req, res, user)) return undefined;
    await User.revokeSessions(user.id);
    await audit(req, 'user.sessions_revoked', 'user', user.id, `Revoked sessions for ${user.email}`);
    return ok(res, { revoked: true });
  })
);

router.get(
  '/subscriptions', validate(listQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, limit, status, plan, q } = req.query;
    const { subscriptions, totalCount } = await Subscription.list({ page, limit, status, plan, q });
    return ok(res, { subscriptions, page, limit, totalCount });
  })
);

// Licence tokens that arrived but did not verify, bucketed by hour and reason.
//
// A genuine client never produces one: it holds a token this server signed and
// replaces it every five minutes. So `bad_signature` and `bad_algorithm` counts
// are people constructing tokens by hand — the visible trace of somebody
// testing a crack against the API. `expired` is separated out because a client
// with a skewed clock or a long sleep generates those honestly.
router.get(
  '/security/token-rejections',
  asyncHandler(async (req, res) => {
    return ok(res, await recentRejections({ hours: req.query.hours }));
  })
);

// Lift a sharing suspension — the customer is believed, or the flag was wrong.
//
// This also marks the licence exempt from AUTOMATIC suspension, because the
// device history that triggered it does not go away: without that, the next new
// device would re-suspend the licence and the decision made here would last
// minutes. Flagging continues, so a licence that genuinely keeps spreading
// still comes back to this queue for a person to look at again.
router.post(
  '/subscriptions/:id/sharing/clear',
  asyncHandler(async (req, res) => {
    const { cleared } = await Subscription.clearSharingSuspension(req.params.id);
    if (!cleared) return fail(res, 'NOT_FOUND', 'Subscription not found', 404);
    await audit(req, 'subscription.sharing.clear', 'subscription', req.params.id,
      'Lifted sharing suspension and exempted from automatic re-suspension');
    return ok(res, { cleared: true });
  })
);

// Put a licence back under automatic enforcement after it was exempted.
router.post(
  '/subscriptions/:id/sharing/resume',
  asyncHandler(async (req, res) => {
    const { resumed } = await Subscription.resumeSharingEnforcement(req.params.id);
    if (!resumed) return fail(res, 'NOT_FOUND', 'Subscription not found', 404);
    await audit(req, 'subscription.sharing.resume', 'subscription', req.params.id,
      'Returned licence to automatic sharing enforcement');
    return ok(res, { resumed: true });
  })
);

// Licences that look shared, worst first.
//
// This is a review queue, not an enforcement action: nothing here has been
// suspended. A key with far more distinct devices than seats has very probably
// leaked, but the honest reasons (a customer who reimages machines, a fleet of
// VMs from one template) look identical from here, so a person decides. To act
// on one, use the existing "Free seats" control or cancel the subscription.
router.get(
  '/subscriptions/flagged',
  asyncHandler(async (req, res) => {
    const subscriptions = await Subscription.listFlaggedForSharing({ limit: req.query.limit });
    return ok(res, { subscriptions, thresholds: sharingThresholds });
  })
);

router.get(
  '/subscriptions/export',
  asyncHandler(async (req, res) => {
    const { subscriptions } = await Subscription.list({
      page: 1, limit: EXPORT_MAX, status: req.query.status, plan: req.query.plan, q: req.query.q,
    });
    return ok(res, subscriptions);
  })
);

router.post(
  '/subscriptions', validate(createSubscriptionSchema),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.body.userId);
    if (!user) return fail(res, 'NOT_FOUND', 'User not found', 404);
    const plan = req.body.plan;
    const subscription = await Subscription.create({
      userId: user.id,
      plan,
      status: req.body.status,
      licenseKey: generateLicenseKey(),
      seats: req.body.seats || planSeats(plan),
      startDate: new Date(),
      expiryDate: req.body.expiryDate ? new Date(req.body.expiryDate) : planExpiry(plan),
    });
    // The previous licence key must stop working, or the customer walks away
    // holding two that both validate — every read path only ever sees the
    // newest row, so the old one was invisible here but live at /api/license.
    const retired = await Subscription.retireOthers(user.id, subscription.id);
    await audit(req, 'subscription.created', 'subscription', subscription.id,
      `Created ${plan} subscription for ${user.email}`
        + (retired ? ` (retired ${retired} earlier licence(s))` : ''),
      { userId: user.id, plan, retired });
    return ok(res, subscription, 201);
  })
);

router.put(
  '/subscriptions/:id', validate(updateSubscriptionSchema),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const subscription = await Subscription.findById(id);
    if (!subscription) return fail(res, 'NOT_FOUND', 'Subscription not found', 404);

    const { plan, status, seats, expiryDate } = req.body;
    const updates = {};
    if (plan !== undefined) updates.plan = plan;
    if (status !== undefined) updates.status = status;
    if (seats !== undefined) updates.seats = seats;
    if (plan !== undefined && seats === undefined) updates.seats = planSeats(plan);
    // See PUT /users/:id — an explicit plan change ends a running trial.
    if (plan !== undefined) updates.trialEndsAt = null;
    // An explicit expiry always wins over the one a plan change implies — that
    // is the point of being able to set it.
    if (plan !== undefined) {
      const implied = expiryForPlanChange(subscription.plan, plan, subscription.expiry_date);
      if (implied !== undefined) updates.expiryDate = implied;
    }
    if (expiryDate !== undefined) updates.expiryDate = expiryDate;
    await Subscription.update(id, updates);
    const fresh = await Subscription.findById(id);
    await audit(req, 'subscription.updated', 'subscription', id, `Updated subscription ${id}`, req.body);
    return ok(res, fresh);
  })
);

router.post(
  '/subscriptions/:id/revoke-device', validate(idParamSchema),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const subscription = await Subscription.findById(id);
    if (!subscription) return fail(res, 'NOT_FOUND', 'Subscription not found', 404);
    // Drop every live seat lease. The activation rows stay, so the devices are
    // still listed and can re-take a seat — this frees the seats, it does not
    // blacklist the machines.
    const freed = await Subscription.releaseAllSeats(id);
    await Subscription.update(id, { deviceFingerprint: null });
    await audit(req, 'subscription.device_revoked', 'subscription', id,
      `Released ${freed} seat lease(s) for subscription ${id}`, { freed });
    return ok(res, await Subscription.findById(id));
  })
);

router.get(
  '/reviews', validate(reviewListQuerySchema),
  asyncHandler(async (req, res) => {
    const { reviews, totalCount } = await Review.list(req.query);
    return ok(res, { reviews, page: req.query.page, limit: req.query.limit, totalCount });
  })
);

router.get(
  '/reviews/pending',
  asyncHandler(async (req, res) => {
    const reviews = await Review.listPending();
    return ok(res, reviews);
  })
);

router.put(
  '/reviews/bulk', validate(bulkReviewSchema),
  asyncHandler(async (req, res) => {
    const affected = await Review.updateMany(req.body.ids, req.body.status);
    await audit(req, 'review.bulk_moderated', 'review', null, `Marked ${affected} reviews ${req.body.status}`, req.body);
    return ok(res, { affected });
  })
);

router.put(
  '/reviews/:id', validate(updateReviewSchema),
  asyncHandler(async (req, res) => {
    const { status } = req.body;
    const review = await Review.updateStatus(Number(req.params.id), status);
    if (!review) return fail(res, 'NOT_FOUND', 'Review not found', 404);
    await audit(req, 'review.moderated', 'review', Number(req.params.id), `Marked review ${req.params.id} ${status}`, { status });
    return ok(res, review);
  })
);

router.get(
  '/releases',
  asyncHandler(async (req, res) => {
    const releases = await Release.listAll();
    return ok(res, releases);
  })
);

router.post(
  '/releases', validate(createReleaseSchema),
  asyncHandler(async (req, res) => {
    const { version, windowsUrl, linuxUrl, changelog, isLatest, windowsSha256, linuxSha256 } = req.body;
    // One row per version (uq_releases_version). Say so instead of a 500.
    if (await Release.findByVersion(version))
      return fail(res, 'VERSION_EXISTS', `Release v${version} already exists — edit it instead`, 409);
    if (isLatest) await Release.unsetLatest();
    const release = await Release.create({
      version, windowsUrl, linuxUrl, changelog, isLatest, windowsSha256, linuxSha256,
    });
    await audit(req, 'release.created', 'release', release.id, `Created release v${version}`, { isLatest: Boolean(isLatest) });
    return ok(res, release, 201);
  })
);

router.put(
  '/releases/:id', validate(updateReleaseSchema),
  asyncHandler(async (req, res) => {
    const { isLatest, ...rest } = req.body;
    if (rest.version !== undefined) {
      const clash = await Release.findByVersion(rest.version);
      if (clash && clash.id !== Number(req.params.id))
        return fail(res, 'VERSION_EXISTS', `Release v${rest.version} already exists`, 409);
    }
    if (isLatest === true) await Release.unsetLatestExcept(Number(req.params.id));
    const updates = {};
    if (rest.version !== undefined) updates.version = rest.version;
    if (rest.windowsUrl !== undefined) updates.windowsUrl = rest.windowsUrl;
    if (rest.linuxUrl !== undefined) updates.linuxUrl = rest.linuxUrl;
    if (rest.windowsSha256 !== undefined) updates.windowsSha256 = rest.windowsSha256;
    if (rest.linuxSha256 !== undefined) updates.linuxSha256 = rest.linuxSha256;
    if (rest.changelog !== undefined) updates.changelog = rest.changelog;
    if (isLatest !== undefined) updates.isLatest = isLatest;
    await Release.update(Number(req.params.id), updates);
    const release = await Release.findById(Number(req.params.id));
    if (!release) return fail(res, 'NOT_FOUND', 'Release not found', 404);
    await audit(req, 'release.updated', 'release', release.id, `Updated release v${release.version}`, req.body);
    return ok(res, release);
  })
);

/**
 * Upload the installer for one OS.
 *
 * The body is the raw file (Content-Type: application/octet-stream) rather than
 * multipart: an installer is hundreds of megabytes, and streaming the request
 * straight to disk keeps memory flat and avoids pulling in a parser just for
 * this one route. `express.json` only claims application/json, so the request
 * stream arrives here untouched.
 *
 * The SHA-256 is computed while streaming and stored, so the desktop updater's
 * checksum enforcement works for uploads without anyone typing a hash by hand.
 */
router.put(
  '/releases/:id/artifact/:os', validate(releaseArtifactParamsSchema),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { os } = req.params;
    const release = await Release.findById(id);
    if (!release) return fail(res, 'NOT_FOUND', 'Release not found', 404);

    const originalName = req.get('x-filename') || `nexa-${release.version}-${os}`;
    let stored;
    try {
      stored = await storeUpload(req, {
        os,
        version: release.version,
        originalName,
        maxBytes: config.MAX_RELEASE_UPLOAD_MB * 1024 * 1024,
      });
    } catch (err) {
      if (err && err.status) return fail(res, err.code || 'UPLOAD_FAILED', err.message, err.status);
      throw err;
    }

    // Replacing an artifact: remove the previous file only after the new one is
    // safely on disk, so a failed upload never leaves the release with nothing.
    const previous = os === 'windows' ? release.windows_file : release.linux_file;

    await Release.update(id, os === 'windows'
      ? {
        windowsFile: stored.file, windowsFilename: stored.filename,
        windowsSize: stored.size, windowsSha256: stored.sha256,
      }
      : {
        linuxFile: stored.file, linuxFilename: stored.filename,
        linuxSize: stored.size, linuxSha256: stored.sha256,
      });
    if (previous && previous !== stored.file) await removeStored(previous);

    await audit(req, 'release.artifact_uploaded', 'release', id,
      `Uploaded ${os} installer for v${release.version} (${stored.filename})`,
      { os, size: stored.size, sha256: stored.sha256 });
    return ok(res, { ...stored, release: await Release.findById(id) });
  })
);

router.delete(
  '/releases/:id/artifact/:os', validate(releaseArtifactParamsSchema),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { os } = req.params;
    const release = await Release.findById(id);
    if (!release) return fail(res, 'NOT_FOUND', 'Release not found', 404);
    const artifact = artifactFor(release, os);
    if (!artifact) return fail(res, 'NOT_FOUND', `No uploaded ${os} installer on this release`, 404);

    await Release.update(id, os === 'windows'
      ? { windowsFile: null, windowsFilename: null, windowsSize: null, windowsSha256: null }
      : { linuxFile: null, linuxFilename: null, linuxSize: null, linuxSha256: null });
    await removeStored(artifact.storedName);
    await audit(req, 'release.artifact_removed', 'release', id,
      `Removed ${os} installer from v${release.version}`, { os });
    return ok(res, { removed: true, release: await Release.findById(id) });
  })
);

router.delete(
  '/releases/:id', validate(idParamSchema),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const release = await Release.findById(id);
    if (!release) return fail(res, 'NOT_FOUND', 'Release not found', 404);
    if (release.is_latest) return fail(res, 'LATEST_RELEASE', 'Set another release as latest before deleting this one', 400);
    await Release.remove(id);
    // Drop the installers too — otherwise deleting releases silently fills the
    // disk with orphaned multi-hundred-MB files nothing references.
    await Promise.all([
      release.windows_file ? removeStored(release.windows_file) : null,
      release.linux_file ? removeStored(release.linux_file) : null,
    ]);
    await audit(req, 'release.deleted', 'release', id, `Deleted release v${release.version}`);
    return ok(res, { deleted: true });
  })
);

// ---- Ads (shown to free installs only; see utils/ads.js) -------------------

router.get(
  '/ads',
  asyncHandler(async (req, res) => {
    const ads = await Ad.listAll();
    return ok(res, ads.map((ad) => ({ ...ad, ctr: ctr(ad) })));
  })
);

router.get(
  '/ads/stats',
  asyncHandler(async (req, res) => {
    return ok(res, await Ad.stats());
  })
);

router.post(
  '/ads', validate(createAdSchema),
  asyncHandler(async (req, res) => {
    const ad = await Ad.create({ ...req.body, createdBy: req.admin && req.admin.id });
    await audit(req, 'ad.created', 'ad', ad.id, `Created ad "${ad.title}"`, {
      placement: ad.placement, active: Boolean(ad.active),
    });
    return ok(res, { ...ad, ctr: ctr(ad) }, 201);
  })
);

router.put(
  '/ads/:id', validate(updateAdSchema),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await Ad.findById(id))) return fail(res, 'NOT_FOUND', 'Ad not found', 404);
    await Ad.update(id, req.body);
    const ad = await Ad.findById(id);
    await audit(req, 'ad.updated', 'ad', id, `Updated ad "${ad.title}"`, req.body);
    return ok(res, { ...ad, ctr: ctr(ad) });
  })
);

router.delete(
  '/ads/:id', validate(adIdParamSchema),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const ad = await Ad.findById(id);
    if (!ad) return fail(res, 'NOT_FOUND', 'Ad not found', 404);
    await Ad.remove(id);
    await audit(req, 'ad.deleted', 'ad', id, `Deleted ad "${ad.title}"`);
    return ok(res, { deleted: true });
  })
);

// ---- Contact inbox (messages from the website's contact form) ---------------
//
// The form stores every message (routes/contact.js) and this is where they are
// worked: filtered, read with their reply history, answered by email, and moved
// through new → open → replied → closed (or marked spam). Every reply is both
// emailed to the visitor and kept on the thread, so the conversation can be read
// back later by a different admin.

router.get(
  '/contact', validate(contactListQuerySchema),
  asyncHandler(async (req, res) => {
    const { messages, totalCount } = await ContactMessage.list(req.query);
    return ok(res, {
      messages, page: req.query.page, limit: req.query.limit, totalCount,
      stats: await ContactMessage.stats(),
    });
  })
);

router.get(
  '/contact/stats',
  asyncHandler(async (req, res) => ok(res, await ContactMessage.stats()))
);

// Opening a thread is what marks it read: a 'new' message becomes 'open' so the
// unread badge reflects what nobody has looked at yet.
router.get(
  '/contact/:id', validate(contactIdParamSchema),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    let message = await ContactMessage.findById(id);
    if (!message) return fail(res, 'NOT_FOUND', 'Message not found', 404);
    if (message.status === 'new') message = await ContactMessage.updateStatus(id, 'open');
    return ok(res, { message, replies: await ContactMessage.listReplies(id) });
  })
);

router.put(
  '/contact/:id', validate(updateContactStatusSchema),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await ContactMessage.findById(id)))
      return fail(res, 'NOT_FOUND', 'Message not found', 404);
    const message = await ContactMessage.updateStatus(id, req.body.status);
    await audit(req, 'contact.status_changed', 'contact_message', id,
      `Marked contact message ${id} ${req.body.status}`, { status: req.body.status });
    return ok(res, message);
  })
);

/**
 * POST /contact/:id/reply — email the visitor and record the reply.
 *
 * The email is attempted FIRST: a reply that never left the building must not be
 * shown as sent. A delivery failure answers 502 with the reason and still stores
 * the reply (marked undelivered) so the text an admin typed is never lost, and
 * the thread's status is left alone so it stays in the queue.
 */
router.post(
  '/contact/:id/reply', validate(contactReplySchema),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const message = await ContactMessage.findById(id);
    if (!message) return fail(res, 'NOT_FOUND', 'Message not found', 404);

    const adminName = (req.admin && req.admin.name) || '';
    let deliveryError = null;
    try {
      await sendContactReply({
        to: message.email,
        name: message.name,
        topic: message.topic,
        replyBody: req.body.body,
        originalMessage: message.message,
        adminName,
      });
    } catch (err) {
      deliveryError = err.message;
      // eslint-disable-next-line no-console
      console.error('[admin] contact reply email failed:', err.message);
    }

    const reply = await ContactMessage.addReply({
      messageId: id,
      adminUserId: req.admin && req.admin.id,
      adminName,
      body: req.body.body,
      delivered: !deliveryError,
      deliveryError,
    });

    if (deliveryError) {
      return fail(res, 'EMAIL_SEND_FAILED',
        'The reply was saved but could not be emailed. Check the SMTP settings and try again.',
        502, { replyId: reply.id });
    }

    let updated = await ContactMessage.markReplied(id, req.admin && req.admin.id);
    if (req.body.close) updated = await ContactMessage.updateStatus(id, 'closed');
    await audit(req, 'contact.replied', 'contact_message', id,
      `Replied to contact message ${id} (${message.email})`, { closed: Boolean(req.body.close) });

    return ok(res, {
      message: updated,
      reply,
      replies: await ContactMessage.listReplies(id),
    }, 201);
  })
);

router.delete(
  '/contact/:id', validate(contactIdParamSchema),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const message = await ContactMessage.findById(id);
    if (!message) return fail(res, 'NOT_FOUND', 'Message not found', 404);
    // Replies cascade with the thread (FK ON DELETE CASCADE).
    await ContactMessage.remove(id);
    await audit(req, 'contact.deleted', 'contact_message', id,
      `Deleted contact message ${id} from ${message.email}`);
    return ok(res, { deleted: true });
  })
);

module.exports = router;
