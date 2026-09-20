'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');

const User = require('../models/User');
const UserSession = require('../models/UserSession');
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
const { generateLicenseKey, planSeats, planExpiry } = require('../utils/license');
const { mountTwoFactor, signChallenge } = require('./twoFactor');
const {
  storeUpload, removeStored, artifactFor, resolveStoredPath,
} = require('../utils/releaseFiles');
const { artifactVersionFromFile, versionsMatch } = require('../utils/artifactVersion');
const { ctr } = require('../utils/ads');
const { publicUser } = require('../utils/userView');

// Admin SPA session: opaque token in an httpOnly cookie scoped to /api/admin;
// only its SHA-256 hash is stored, as a user_sessions row of realm 'admin'
// (the old single slot, users.admin_refresh_token_hash, is retired — see
// config/schema.js). Eight hours is the whole sitting: the bearer token is
// short-lived (utils/jwt.js) and /refresh below mints a new one from the
// cookie for as long as the row is alive, so a page reload never signs the
// admin out and a revocation signs them out at once.
const ADMIN_REFRESH_COOKIE = 'ndm_admin_refresh';
const ADMIN_REFRESH_PATH = '/api/admin';
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;

function adminRefreshCookieOptions() {
  return {
    httpOnly: true, sameSite: 'lax', secure: config.isProd,
    maxAge: ADMIN_SESSION_MS, path: ADMIN_REFRESH_PATH,
  };
}

function adminSessionExpiry() {
  return new Date(Date.now() + ADMIN_SESSION_MS);
}

function clearAdminCookie(res) {
  res.clearCookie(ADMIN_REFRESH_COOKIE, { path: ADMIN_REFRESH_PATH });
}

// Open a NEW panel session for this browser and hand the row back, so the
// bearer can be minted against it. Same shape as routes/auth.js openSession.
async function issueAdminSession(req, res, user) {
  const { token: refreshToken, hash } = generateRefreshToken();
  const session = await UserSession.create({
    userId: user.id, tokenHash: hash, realm: 'admin',
    userAgent: req.get('user-agent') || null, ip: req.ip || null,
    expiresAt: adminSessionExpiry(),
  });
  res.cookie(ADMIN_REFRESH_COOKIE, refreshToken, adminRefreshCookieOptions());
  return session;
}

function adminIdentity(user) {
  return { id: String(user.id), name: user.name, email: user.email, role: user.role };
}

const {
  adminLoginSchema, createAdminUserSchema, resetUserPasswordSchema,
  updateUserSchema, updateReviewSchema, updateSubscriptionSchema,
  createSubscriptionSchema, reviewListQuerySchema, bulkReviewSchema,
  createReleaseSchema, updateReleaseSchema, releaseArtifactParamsSchema, listQuerySchema,
  idParamSchema,
} = require('../schemas/admin.schema');
const {
  createAdSchema, updateAdSchema, adIdParamSchema,
} = require('../schemas/ad.schema');
const {
  contactListQuerySchema, contactIdParamSchema,
  updateContactStatusSchema, contactReplySchema,
} = require('../schemas/contact.schema');
const { sendContactReply } = require('../utils/email');

function monthlyPrice(plan) {
  if (plan === 'pro') return 5;
  if (plan === 'team') return 15;
  return 0;
}

/**
 * A staff admin may only act on ordinary customer accounts. Banning, resetting
 * or revoking a fellow admin — and above all the creator — is reserved for the
 * root panel (/api/root/admins), and so is reading one: the details view is
 * the account's whole row. A root token passing through here keeps its reach,
 * since req.isRoot is only ever set by the root token family. `verb` keeps the
 * refusal truthful for a read ("view") as well as a write.
 */
function blockedStaffTarget(req, res, user, verb = 'modify') {
  if (req.isRoot || user.role === 'user') return false;
  fail(res, 'FORBIDDEN', `Only the creator can ${verb} a control-panel account`, 403);
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
    if (!user || user.role !== 'admin')
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
    return ok(res, await finishAdminLogin(req, res, user));
  })
);

async function finishAdminLogin(req, res, user) {
  const session = await issueAdminSession(req, res, user);
  return { token: signAdminToken(user, session), admin: adminIdentity(user) };
}

mountTwoFactor(router, {
  realm: 'admin',
  secret: config.JWT_ADMIN_SECRET,
  eligible: (user) => user.role === 'admin',
  finishLogin: finishAdminLogin,
  gate: requireAdmin,
  audit: (req, action, user, summary) => audit({ admin: req.admin || user }, action, 'user', user.id, summary),
});

// Mint a fresh admin bearer token from the ndm_admin_refresh cookie (rotated
// in place on every call, so the session row — and the `sid` every bearer
// carries — stays the same). Open like /login: IP gate + login limiter, no
// bearer required.
router.post(
  '/refresh', adminRefreshLimiter, ipWhitelist,
  asyncHandler(async (req, res) => {
    const cookie = req.cookies && req.cookies[ADMIN_REFRESH_COOKIE];
    if (!cookie) return fail(res, 'NO_REFRESH_TOKEN', 'Missing admin refresh token', 401);
    const hash = hashRefreshToken(cookie);
    const invalid = () => {
      clearAdminCookie(res);
      return fail(res, 'INVALID_REFRESH_TOKEN', 'Admin session is invalid or has expired', 401);
    };

    const session = await UserSession.findLiveByTokenHash(hash, 'admin');
    if (!session) return invalid();
    const user = await User.findById(session.user_id);
    // A demoted admin's cookie is dead, not dormant: drop the row so it is
    // not sitting there waiting for a re-promotion to revive it.
    if (!user || user.role !== 'admin') {
      await UserSession.removeByTokenHash(hash);
      return invalid();
    }
    if (user.banned) {
      await UserSession.removeByTokenHash(hash);
      clearAdminCookie(res);
      return fail(res, 'FORBIDDEN', 'Account is banned', 403);
    }

    const { token: rt, hash: newHash } = generateRefreshToken();
    // Conditional on the OLD hash: two tabs refreshing at once cannot both
    // win, and the loser is told to sign in rather than handed a cookie that
    // the winner's rotation has already superseded.
    if (!(await UserSession.rotate(session.id, hash, newHash, adminSessionExpiry())))
      return invalid();
    res.cookie(ADMIN_REFRESH_COOKIE, rt, adminRefreshCookieOptions());
    return ok(res, { token: signAdminToken(user, session) });
  })
);

router.post(
  '/logout', ipWhitelist,
  asyncHandler(async (req, res) => {
    const cookie = req.cookies && req.cookies[ADMIN_REFRESH_COOKIE];
    // Only THIS browser's panel session ends; the bearer it issued dies with
    // the row, since the gate re-checks the row on every request.
    if (cookie) await UserSession.removeByTokenHash(hashRefreshToken(cookie));
    clearAdminCookie(res);
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
        stripe: config.billingMode,
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
      stripe: config.billingMode,
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
    return ok(res, { user: publicUser(user), subscription }, 201);
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
    return ok(res, users.map(publicUser));
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
      // User.list already selects a narrow column set; the projection keeps
      // that true if the query is ever widened.
      return { ...publicUser(u), plan: sub ? sub.plan : 'free', subscription: sub };
    });

    return ok(res, { users: withPlan, page, limit, totalCount });
  })
);

router.get(
  '/users/:id/details', validate(idParamSchema),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) return fail(res, 'NOT_FOUND', 'User not found', 404);
    // Reading is gated like writing: a fellow admin's or the creator's account
    // is the root panel's business, not a staff admin's.
    if (blockedStaffTarget(req, res, user, 'view')) return undefined;
    const [subscriptions, payments, reviews] = await Promise.all([
      Subscription.findByUserId(user.id),
      Payment.findByUserId(user.id),
      Review.listByUserId(user.id),
    ]);
    return ok(res, { user: publicUser(user), subscriptions, payments, reviews });
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
    // A ban must take effect on every device the user is signed in on, not
    // only the next one that tries to sign in.
    if (banned === true) await UserSession.removeAllForUser(user.id);

    if (plan !== undefined) {
      const currentSubscription = (await Subscription.findByUserId(user.id))[0] || null;
      if (currentSubscription) {
        // An explicit admin plan change ends any running trial so lazy trial
        // expiry cannot silently undo it later. The NEWEST row and only that
        // one — it is the row every reader shows, and the row PUT
        // /subscriptions/:id edits; writing every row for the account made
        // the two paths disagree about which subscription is "the" one.
        await Subscription.update(currentSubscription.id, { plan, seats: planSeats(plan), trialEndsAt: null });
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
    return ok(res, { user: publicUser(fresh), subscription: sub });
  })
);

router.post(
  '/users/:id/reset-password', validate(resetUserPasswordSchema),
  asyncHandler(async (req, res) => {
    const user = await User.findById(Number(req.params.id));
    if (!user) return fail(res, 'NOT_FOUND', 'User not found', 404);
    if (blockedStaffTarget(req, res, user)) return undefined;
    // refreshTokenHash is the pre-sessions site cookie slot, still honoured
    // once by /auth/refresh, so it goes with the rows.
    await User.update(user.id, {
      passwordHash: await bcrypt.hash(req.body.password, 12),
      refreshTokenHash: null,
    });
    await UserSession.removeAllForUser(user.id);
    await audit(req, 'user.password_reset', 'user', user.id, `Reset password for ${user.email}`);
    return ok(res, { reset: true });
  })
);

// Sign the account out everywhere, and mean it: every bearer token is bound
// to one of these rows and refused once it is gone, so the count reported
// here is the number of browsers that lost access with this request.
router.post(
  '/users/:id/revoke-sessions', validate(idParamSchema),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) return fail(res, 'NOT_FOUND', 'User not found', 404);
    if (blockedStaffTarget(req, res, user)) return undefined;
    await User.update(user.id, { refreshTokenHash: null });
    const sessions = await UserSession.removeAllForUser(user.id);
    await audit(req, 'user.sessions_revoked', 'user', user.id,
      `Revoked sessions for ${user.email}`, { sessions });
    return ok(res, { revoked: true, sessions });
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

// One subscription per account. Every reader in the codebase takes the
// account's newest row and ignores the rest, so a second row would be one
// that keeps `status = 'active'` and its own licence key for ever while
// nothing on the site ever shows it — and /license/validate would honour that
// key regardless. Registration already gives every account a free row, so
// this route is for the rare account that has none; anything else is an edit.
router.post(
  '/subscriptions', validate(createSubscriptionSchema),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.body.userId);
    if (!user) return fail(res, 'NOT_FOUND', 'User not found', 404);
    if (blockedStaffTarget(req, res, user)) return undefined;
    const existing = (await Subscription.findByUserId(user.id))[0];
    if (existing) {
      return fail(res, 'SUBSCRIPTION_EXISTS',
        `${user.email} already has a ${existing.plan} subscription (#${existing.id}) — edit that one instead of creating a second.`,
        409, { subscriptionId: existing.id, plan: existing.plan, status: existing.status });
    }
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
    const id = req.params.id;
    const subscription = await Subscription.findById(id);
    if (!subscription) return fail(res, 'NOT_FOUND', 'Subscription not found', 404);
    // The subscription is the account's: a staff admin may no more alter the
    // creator's plan than the creator's account. user_id is a foreign key, so
    // the owner always exists.
    if (blockedStaffTarget(req, res, await User.findById(subscription.user_id))) return undefined;

    const { plan, status, seats } = req.body;
    const updates = {};
    if (plan !== undefined) updates.plan = plan;
    if (status !== undefined) updates.status = status;
    if (seats !== undefined) updates.seats = seats;
    if (plan !== undefined && seats === undefined) updates.seats = planSeats(plan);
    // See PUT /users/:id — an explicit plan change ends a running trial.
    if (plan !== undefined) updates.trialEndsAt = null;
    await Subscription.update(id, updates);
    const fresh = await Subscription.findById(id);
    await audit(req, 'subscription.updated', 'subscription', id, `Updated subscription ${id}`, req.body);
    return ok(res, fresh);
  })
);

router.post(
  '/subscriptions/:id/revoke-device', validate(idParamSchema),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
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
 *
 * The checksum says the bytes arrived intact; it cannot say they are the
 * RIGHT bytes. WP-03 was exactly that: /download advertised 0.3.0 while
 * serving nexa_0.2.0_amd64.deb with a perfectly matching hash, because nothing
 * compared the installer's own idea of its version with the release row it
 * was attached to. So once the file is on disk, the version it declares about
 * itself (utils/artifactVersion.js — the PE version resource, the .deb control
 * file) is read back and checked against the row:
 *
 *   - a definite mismatch is refused with 409 VERSION_MISMATCH, the file is
 *     removed and the row is left exactly as it was;
 *   - a version that cannot be read is accepted — refusing would block every
 *     format the reader does not know — but the response and the audit row
 *     carry a `versionWarning` saying it went unchecked, so the operator can
 *     look rather than trust.
 */
router.put(
  '/releases/:id/artifact/:os', validate(releaseArtifactParamsSchema),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
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

    const declared = await artifactVersionFromFile(resolveStoredPath(stored.file), os);
    if (declared.version && !versionsMatch(declared.version, release.version)) {
      await removeStored(stored.file);
      return fail(res, 'VERSION_MISMATCH',
        `This installer says it is version ${declared.version}, but the release is ${release.version}. Upload the ${release.version} build, or attach this file to the ${declared.version} release.`,
        409, { artifactVersion: declared.version, releaseVersion: release.version });
    }
    const versionWarning = declared.version ? null
      : `Could not read a version from the ${os} installer (${declared.reason}); it was not checked against release ${release.version}.`;

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
      `Uploaded ${os} installer for v${release.version} (${stored.filename})`
        + (versionWarning ? ' — version unchecked' : ''),
      { os, size: stored.size, sha256: stored.sha256, artifactVersion: declared.version, versionWarning });
    return ok(res, {
      ...stored, artifactVersion: declared.version, versionWarning,
      release: await Release.findById(id),
    });
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
    const id = req.params.id;
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
