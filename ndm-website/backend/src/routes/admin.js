'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');

const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Payment = require('../models/Payment');
const Review = require('../models/Review');
const Release = require('../models/Release');
const AuditLog = require('../models/AuditLog');
const config = require('../config/env');
const { getPool } = require('../config/db');

const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const { requireAdmin, ipWhitelist } = require('../middleware/adminAuth');
const { adminLoginLimiter } = require('../middleware/rateLimiter');
const { ok, fail } = require('../utils/respond');
const { signAdminToken } = require('../utils/jwt');
const { generateLicenseKey, planSeats, planExpiry } = require('../utils/license');

const {
  adminLoginSchema, createAdminUserSchema, resetUserPasswordSchema,
  updateUserSchema, updateReviewSchema, updateSubscriptionSchema,
  createSubscriptionSchema, reviewListQuerySchema, bulkReviewSchema,
  createReleaseSchema, updateReleaseSchema, listQuerySchema,
} = require('../schemas/admin.schema');

function monthlyPrice(plan) {
  if (plan === 'pro') return 5;
  if (plan === 'team') return 15;
  return 0;
}

function safeUser(user) {
  if (!user) return null;
  const { password_hash, refresh_token_hash, ...safe } = user;
  return safe;
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
    if (!user || user.role !== 'admin')
      return fail(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return fail(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
    return ok(res, {
      token: signAdminToken(user),
      admin: { id: String(user.id), name: user.name, email: user.email },
    });
  })
);

router.use(requireAdmin);

router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const [totalUsers, activeSubscriptions, paidSubs, signupAgg,
           pendingReviews, recentPayments, planDistribution,
           revenueSeries, recentActivity] = await Promise.all([
      User.count(),
      Subscription.countActive(),
      Subscription.findPaidActive(),
      User.signupAgg(30),
      Review.count({ status: 'pending' }),
      Payment.listRecent(10),
      Subscription.countByPlan(),
      Payment.revenueByMonth(6),
      AuditLog.listRecent(12),
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
      lastUpdated: new Date().toISOString(),
      system: {
        node: process.version,
        environment: config.NODE_ENV,
        stripe: config.isStripeMock ? 'mock' : 'live',
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
      stripe: config.isStripeMock ? 'mock' : 'configured',
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
    const { name, email, password, role, plan } = req.body;
    if (await User.findByEmail(email)) return fail(res, 'EMAIL_EXISTS', 'An account with this email already exists', 409);
    const user = await User.create({
      name,
      email,
      passwordHash: await bcrypt.hash(password, 12),
      role,
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
    await audit(req, 'user.created', 'user', user.id, `Created user ${email}`, { role, plan });
    return ok(res, { user: safeUser(user), subscription }, 201);
  })
);

router.get(
  '/users/export',
  asyncHandler(async (req, res) => {
    const users = await User.listAll({
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
  '/users/:id/details',
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
    const { banned, plan, role } = req.body;
    const user = await User.findById(Number(req.params.id));
    if (!user) return fail(res, 'NOT_FOUND', 'User not found', 404);

    const updates = {};
    if (banned !== undefined) updates.banned = banned;
    if (req.body.emailVerified !== undefined) updates.emailVerified = req.body.emailVerified;
    if (role !== undefined) updates.role = role;
    if (user.id === req.admin.id && (banned === true || role === 'user'))
      return fail(res, 'SELF_LOCKOUT', 'You cannot disable or demote your own admin account', 400);
    if (Object.keys(updates).length) await User.update(user.id, updates);

    if (plan !== undefined) {
      const currentSubscription = (await Subscription.findByUserId(user.id))[0] || null;
      if (currentSubscription) {
        await Subscription.updateByUserId(user.id, { plan, seats: planSeats(plan) });
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

router.post(
  '/users/:id/reset-password', validate(resetUserPasswordSchema),
  asyncHandler(async (req, res) => {
    const user = await User.findById(Number(req.params.id));
    if (!user) return fail(res, 'NOT_FOUND', 'User not found', 404);
    await User.update(user.id, {
      passwordHash: await bcrypt.hash(req.body.password, 12),
      refreshTokenHash: null,
    });
    await audit(req, 'user.password_reset', 'user', user.id, `Reset password for ${user.email}`);
    return ok(res, { reset: true });
  })
);

router.post(
  '/users/:id/revoke-sessions',
  asyncHandler(async (req, res) => {
    const user = await User.findById(Number(req.params.id));
    if (!user) return fail(res, 'NOT_FOUND', 'User not found', 404);
    await User.update(user.id, { refreshTokenHash: null });
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

router.get(
  '/subscriptions/export',
  asyncHandler(async (req, res) => {
    const { subscriptions } = await Subscription.list({ page: 1, limit: 200, status: req.query.status, plan: req.query.plan, q: req.query.q });
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
    await audit(req, 'subscription.created', 'subscription', subscription.id, `Created ${plan} subscription for ${user.email}`, { userId: user.id, plan });
    return ok(res, subscription, 201);
  })
);

router.put(
  '/subscriptions/:id', validate(updateSubscriptionSchema),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const subscription = await Subscription.findById(id);
    if (!subscription) return fail(res, 'NOT_FOUND', 'Subscription not found', 404);

    const { plan, status, seats } = req.body;
    const updates = {};
    if (plan !== undefined) updates.plan = plan;
    if (status !== undefined) updates.status = status;
    if (seats !== undefined) updates.seats = seats;
    if (plan !== undefined && seats === undefined) updates.seats = planSeats(plan);
    await Subscription.update(id, updates);
    const fresh = await Subscription.findById(id);
    await audit(req, 'subscription.updated', 'subscription', id, `Updated subscription ${id}`, req.body);
    return ok(res, fresh);
  })
);

router.post(
  '/subscriptions/:id/revoke-device',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const subscription = await Subscription.findById(id);
    if (!subscription) return fail(res, 'NOT_FOUND', 'Subscription not found', 404);
    await Subscription.update(id, { deviceFingerprint: null });
    await audit(req, 'subscription.device_revoked', 'subscription', id, `Revoked device for subscription ${id}`);
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
    const { version, windowsUrl, linuxUrl, changelog, isLatest } = req.body;
    if (isLatest) await Release.unsetLatest();
    const release = await Release.create({ version, windowsUrl, linuxUrl, changelog, isLatest });
    await audit(req, 'release.created', 'release', release.id, `Created release v${version}`, { isLatest: Boolean(isLatest) });
    return ok(res, release, 201);
  })
);

router.put(
  '/releases/:id', validate(updateReleaseSchema),
  asyncHandler(async (req, res) => {
    const { isLatest, ...rest } = req.body;
    if (isLatest === true) await Release.unsetLatestExcept(Number(req.params.id));
    const updates = {};
    if (rest.version !== undefined) updates.version = rest.version;
    if (rest.windowsUrl !== undefined) updates.windowsUrl = rest.windowsUrl;
    if (rest.linuxUrl !== undefined) updates.linuxUrl = rest.linuxUrl;
    if (rest.changelog !== undefined) updates.changelog = rest.changelog;
    if (isLatest !== undefined) updates.isLatest = isLatest;
    await Release.update(Number(req.params.id), updates);
    const release = await Release.findById(Number(req.params.id));
    if (!release) return fail(res, 'NOT_FOUND', 'Release not found', 404);
    await audit(req, 'release.updated', 'release', release.id, `Updated release v${release.version}`, req.body);
    return ok(res, release);
  })
);

router.delete(
  '/releases/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const release = await Release.findById(id);
    if (!release) return fail(res, 'NOT_FOUND', 'Release not found', 404);
    if (release.is_latest) return fail(res, 'LATEST_RELEASE', 'Set another release as latest before deleting this one', 400);
    await Release.remove(id);
    await audit(req, 'release.deleted', 'release', id, `Deleted release v${release.version}`);
    return ok(res, { deleted: true });
  })
);

module.exports = router;
