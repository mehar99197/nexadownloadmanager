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
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Payment = require('../models/Payment');
const Review = require('../models/Review');
const TeamMember = require('../models/TeamMember');
const ContactMessage = require('../models/ContactMessage');
const AuditLog = require('../models/AuditLog');
const { stopBillingBeforeDelete, BILLING_CANCEL_FAILED } = require('../utils/accountDeletion');
const { isTrialActive, isBilled } = require('../utils/license');
const { publicUser } = require('../utils/userView');
const { issueSession, clearSessionCookies, REFRESH_COOKIE } = require('../utils/session');
const DeviceAuth = require('../models/DeviceAuth');
const { subscriptionForUser, effectivePlanFor } = require('../utils/accountPlan');
const { hashRefreshToken } = require('../utils/jwt');
const UserSession = require('../models/UserSession');
const security = require('../utils/securityEvents');
const { passwordProblem } = require('../utils/passwordPolicy');

const BCRYPT_COST = 12;

// A user reading their own profile has no business seeing their own TOTP seed
// or recovery codes either — an XSS or a leaked response body would then be a
// second factor. publicUser() is an allow-list (utils/userView.js), so the
// profile carries exactly the documented fields: hasPassword / hasGoogle for
// the "Set a password" vs "Change password" choice, the camelCase timestamps
// CONTRACT.md promises (the site reads `user.createdAt`), and none of the
// lockout bookkeeping the sign-in form is deliberately told nothing about.
const sanitizeUser = publicUser;

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

/**
 * `viaTeam` is not decoration: it is the difference between "your plan" and
 * "the plan you are a guest on". A member cannot cancel it, cannot manage its
 * billing and must not be offered a trial against it, so the flag rides with
 * the summary rather than being re-derived by each page.
 *
 * A member is shown the team's plan, its expiry and the key that unlocks the
 * app for them — everything /api/team already tells them — but never the
 * owner's cancellation state, which is not theirs to read or act on.
 */
function subscriptionSummary(sub, { viaTeam = false, teamOwner = null } = {}) {
  if (!sub) return null;
  return {
    plan: sub.plan, status: sub.status, expiryDate: sub.expiry_date,
    seats: sub.seats, licenseKey: sub.license_key,
    trial: viaTeam ? false : isTrialActive(sub),
    trialEndsAt: viaTeam ? null : toIso(sub.trial_ends_at),
    cancelAtPeriodEnd: viaTeam ? false : Boolean(Number(sub.cancel_at_period_end)),
    // Same meaning as /subscription/status: a Stripe subscription renews, an
    // admin-granted plan simply ends on its expiry date.
    billed: viaTeam ? false : isBilled(sub),
    viaTeam, teamOwner,
  };
}

// A Team member with no paid plan of their own uses the team's key. The
// membership only counts while the owner's plan is a live Team plan.
async function teamMembership(userId) {
  const m = await TeamMember.findActiveByUserId(userId);
  if (!m || m.owner_plan !== 'team' || m.owner_status !== 'active') return null;
  if (Number(m.owner_banned)) return null; // same rule as accountPlan.teamPlanForUser
  if (m.owner_expiry_date && new Date(m.owner_expiry_date).getTime() < Date.now()) return null;
  return m;
}

router.get(
  '/me', requireAuth,
  asyncHandler(async (req, res) => {
    const [{ subscription, viaTeam, teamOwner }, team] = await Promise.all([
      effectivePlanFor(req.user.id), teamMembership(req.user.id),
    ]);
    return ok(res, {
      user: sanitizeUser(req.user),
      subscription: subscriptionSummary(subscription, { viaTeam, teamOwner }),
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
      await security.record('password.changed', { req, user: req.user, detail: 'every other session ended' });
      ({ token } = await issueSession(req, res, await User.findById(req.user.id)));
    }
    const user = await User.findById(req.user.id);
    return ok(res, { user: sanitizeUser(user), ...(token ? { token } : {}) });
  })
);

/**
 * The account's live browser sessions (models/UserSession.js). `current`
 * marks the one this request's refresh cookie belongs to. Signing one out
 * revokes its family; "everywhere else" keeps only the current one.
 */
router.get(
  '/sessions', requireAuth,
  asyncHandler(async (req, res) => {
    const cookie = req.cookies && req.cookies[REFRESH_COOKIE];
    const currentHash = cookie ? hashRefreshToken(cookie) : null;
    const current = currentHash ? await UserSession.findLive(currentHash) : null;
    const rows = await UserSession.listForUser(req.user.id);
    return ok(res, {
      sessions: rows.map((s) => ({
        id: s.id,
        current: Boolean(current && current.id === s.id),
        userAgent: s.user_agent,
        ip: s.ip,
        createdAt: s.created_at,
        lastUsedAt: s.last_used_at,
        expiresAt: s.expires_at,
      })),
    });
  })
);

router.delete(
  '/sessions/:id', requireAuth, validate(deviceParamsSchema),
  asyncHandler(async (req, res) => {
    const session = await UserSession.findById(Number(req.params.id));
    if (!session || session.user_id !== req.user.id || session.revoked_at)
      return fail(res, 'NOT_FOUND', 'Session not found', 404);
    await UserSession.revokeFamily(session.family);
    await security.record('session.revoked', { req, user: req.user, detail: `session ${session.id} signed out from the account page` });
    return ok(res, { revoked: true });
  })
);

router.post(
  '/sessions/revoke-others', requireAuth,
  asyncHandler(async (req, res) => {
    const cookie = req.cookies && req.cookies[REFRESH_COOKIE];
    const current = cookie ? await UserSession.findLive(hashRefreshToken(cookie)) : null;
    const rows = await UserSession.listForUser(req.user.id);
    let revoked = 0;
    for (const s of rows) {
      if (current && s.family === current.family) continue;
      revoked += await UserSession.revokeFamily(s.family);
    }
    await security.record('session.revoked', { req, user: req.user, detail: `${revoked} other session(s) signed out from the account page` });
    return ok(res, { revoked });
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
    // The key that actually unlocks the app for this account: the team's for a
    // member, their own otherwise — the same answer /me and the licence
    // endpoints give, from the same helper.
    const { subscription: sub, viaTeam, teamOwner } = await effectivePlanFor(req.user.id);
    if (!sub) return fail(res, 'NOT_FOUND', 'No subscription found', 404);
    return ok(res, {
      licenseKey: sub.license_key, plan: sub.plan, status: sub.status, expiryDate: sub.expiry_date,
      trial: viaTeam ? false : isTrialActive(sub),
      trialEndsAt: viaTeam ? null : toIso(sub.trial_ends_at),
      // The dashboard labels expiryDate "Renews" only for a billed plan.
      billed: viaTeam ? false : isBilled(sub),
      viaTeam, ...(viaTeam ? { teamOwner } : {}),
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
    // Two views of "my machines", merged by fingerprint: the seat leases on
    // the subscription those machines actually use, and the machines signed
    // in to this account with the desktop app (which a licence key never
    // produces, so they would otherwise be invisible here).
    //
    // "The subscription those machines use" is the team's for a member, their
    // own otherwise. Reading their own row told a Team member their machines
    // held no seat and their plan had no seat limit — both false, because
    // their seat lives on the owner's plan.
    const [own, tokens] = await Promise.all([
      findUserSubscription(req.user.id),
      DeviceAuth.listForUser(req.user.id),
    ]);
    const sub = (await subscriptionForUser(req.user.id)) || own;
    const onSomebodyElsesPlan = Boolean(sub && own && sub.id !== own.id);
    const [allActivations, activeSeats] = await Promise.all([
      sub ? Subscription.listActivations(sub.id) : [],
      sub ? Subscription.activeSeatCount(sub.id) : 0,
    ]);
    // A team plan's activation rows belong to every member. Show only this
    // account's own machines: which computers a colleague runs is none of a
    // member's business, and the seat COUNT already says how full the plan is.
    const mine = new Set(tokens.map((t) => t.device_fingerprint));
    const activations = onSomebodyElsesPlan
      ? allActivations.filter((d) => mine.has(d.device_fingerprint))
      : allActivations;
    const byFingerprint = new Map();
    for (const d of activations) {
      byFingerprint.set(d.device_fingerprint, {
        id: d.id,
        tokenId: null,
        // Never expose the full fingerprint — a short prefix is enough for the
        // user to tell two machines apart.
        shortId: String(d.device_fingerprint).slice(0, 8),
        name: d.device_name || 'Unnamed device',
        signedIn: false,
        appVersion: null,
        active: Boolean(Number(d.active)),
        leaseExpiresAt: toIso(d.lease_expires_at),
        lastSeenAt: toIso(d.last_seen_at),
        firstSeenAt: toIso(d.created_at),
      });
    }
    for (const t of tokens) {
      const seen = toIso(t.last_seen_at);
      const entry = byFingerprint.get(t.device_fingerprint);
      if (entry) {
        entry.tokenId = t.id;
        entry.signedIn = true;
        entry.appVersion = t.app_version || null;
        if (entry.name === 'Unnamed device' && t.device_name) entry.name = t.device_name;
        if (seen && (!entry.lastSeenAt || seen > entry.lastSeenAt)) entry.lastSeenAt = seen;
      } else {
        byFingerprint.set(t.device_fingerprint, {
          id: null,
          tokenId: t.id,
          shortId: String(t.device_fingerprint).slice(0, 8),
          name: t.device_name || 'Unnamed device',
          signedIn: true,
          appVersion: t.app_version || null,
          active: false,
          leaseExpiresAt: null,
          lastSeenAt: seen,
          firstSeenAt: toIso(t.created_at),
        });
      }
    }
    const devices = [...byFingerprint.values()].sort((a, b) =>
      Number(b.active) - Number(a.active)
      || Number(b.signedIn) - Number(a.signedIn)
      || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
    return ok(res, {
      seats: sub ? Number(sub.seats) || 1 : 0,
      activeSeats,
      // The Free plan does not ration seats (Subscription.acquireSeat), so the
      // "n/m in use" badge would only confuse on it.
      seatsEnforced: Boolean(sub && sub.plan !== 'free'),
      devices,
    });
  })
);

/**
 * Sign a machine out of the account: its device token is revoked, so the
 * app's next validation answers `signed_out` and it forgets the token, and
 * the seat it holds is freed. The activation row stays (device history).
 */
router.delete(
  '/devices/tokens/:id', requireAuth, validate(deviceParamsSchema),
  asyncHandler(async (req, res) => {
    const token = (await DeviceAuth.listForUser(req.user.id)).find((t) => t.id === Number(req.params.id));
    if (!token) return fail(res, 'NOT_FOUND', 'That device is not signed in to this account', 404);
    await DeviceAuth.revoke(token.id, 'dashboard');
    const sub = await subscriptionForUser(req.user.id);
    if (sub) await Subscription.releaseSeat(sub.id, token.device_fingerprint);
    await security.record('device.signed_out', {
      req, user: req.user, detail: `"${token.device_name || 'a device'}" signed out from the dashboard`,
    });
    return ok(res, { signedOut: true });
  })
);

/**
 * Everything we hold about this account, as one JSON document. This is the
 * self-service side of a data-access request; no admin has to be involved.
 *
 * "Everything" is the promise, so every table that keeps rows about the
 * person is here: the account, subscriptions and their machines, payments,
 * the review, team rows (as a member or invitee, and the roster of a team
 * they own), browser sessions, desktop sign-ins, security events and contact
 * messages. What is NEVER here is anything that works as a credential or
 * derives from one: no password / refresh / device-token / invite hashes, no
 * TOTP secret or recovery codes, no Google subject id, no device or user
 * codes, and device fingerprints only as the same 8-character prefix the
 * dashboard shows. Keys are only ever added to this document, never renamed,
 * so a script written against an older export still reads a newer one.
 */
router.get(
  '/export', requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const subs = await Subscription.findByUserId(userId);
    const u = req.user;
    // Rows filed under the ADDRESS rather than the account (a contact message
    // sent while signed out, a failed sign-in) only belong in this file once
    // the address is proven to be this person's.
    const byEmail = { includeByEmail: Boolean(u.email_verified) };
    const [payments, review, devicesBySub, team, rostersBySub, teamRows,
           sessions, deviceTokens, deviceCodes, securityEvents, contactMessages] = await Promise.all([
      Payment.findByUserId(userId, { page: 1, limit: 500 }),
      Review.findByUserId(userId),
      Promise.all(subs.map((s) => Subscription.listActivations(s.id))),
      TeamMember.findActiveByUserId(userId),
      Promise.all(subs.map((s) => TeamMember.listBySubscription(s.id))),
      TeamMember.listForExport(userId, u.email),
      UserSession.listAllForExport(userId),
      DeviceAuth.listAllForExport(userId),
      DeviceAuth.listCodesForExport(userId),
      security.listForUser(userId, u.email, byEmail),
      ContactMessage.listForExport(userId, u.email, byEmail),
    ]);
    const document = {
      exportedAt: new Date().toISOString(),
      account: {
        id: u.id, name: u.name, email: u.email, role: u.role,
        emailVerified: Boolean(u.email_verified), trialUsed: Boolean(u.trial_used),
        createdAt: toIso(u.created_at), updatedAt: toIso(u.updated_at),
        // Presence, never the value: the Google subject id is an identifier
        // for the account at Google, and a password is a hash.
        hasPassword: Boolean(u.password_hash),
        googleLinked: Boolean(u.google_id),
        avatarUrl: u.avatar_url || null,
      },
      // On or off only — the shared secret and the recovery codes stay here.
      twoFactor: { enabled: Boolean(Number(u.totp_enabled)) },
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
      // Every team row about this person — accepted, or an invitation still
      // waiting — whoever's team it is.
      teamMemberships: teamRows.map((m) => ({
        ownerName: m.owner_name, email: m.email, status: m.status,
        invitedAt: toIso(m.invited_at), acceptedAt: toIso(m.accepted_at),
      })),
      // The roster of a team this person owns: whom they invited.
      teamInvitesSent: subs.flatMap((s, i) => (rostersBySub[i] || []).map((m) => ({
        subscriptionId: s.id, email: m.email, name: m.user_name || null, status: m.status,
        invitedAt: toIso(m.invited_at), acceptedAt: toIso(m.accepted_at),
      }))),
      sessions: sessions.map((x) => ({
        id: x.id, ip: x.ip || null, userAgent: x.user_agent || null,
        createdAt: toIso(x.created_at), lastUsedAt: toIso(x.last_used_at),
        rotatedAt: toIso(x.rotated_at), expiresAt: toIso(x.expires_at),
        revokedAt: toIso(x.revoked_at),
      })),
      // Machines signed in to the account with the desktop app, and the
      // sign-in requests approved for them.
      deviceSignIns: deviceTokens.map((d) => ({
        id: d.id, name: d.device_name || null, appVersion: d.app_version || null,
        fingerprintPrefix: String(d.device_fingerprint).slice(0, 8),
        createdAt: toIso(d.created_at), lastUsedAt: toIso(d.last_seen_at),
        revokedAt: toIso(d.revoked_at), revokedReason: d.revoked_reason || null,
      })),
      deviceSignInRequests: deviceCodes.map((c) => ({
        id: c.id, deviceName: c.device_name || null, appVersion: c.app_version || null,
        ip: c.ip || null, status: c.status, createdAt: toIso(c.created_at),
      })),
      securityEvents: securityEvents.map((e) => ({
        kind: e.kind, severity: e.severity, ip: e.ip || null, userAgent: e.user_agent || null,
        detail: e.detail || null, createdAt: toIso(e.created_at),
      })),
      contactMessages: contactMessages.map((m) => ({
        id: m.id, name: m.name, email: m.email, topic: m.topic, message: m.message,
        status: m.status, ip: m.ip || null, userAgent: m.user_agent || null,
        createdAt: toIso(m.created_at), repliedAt: toIso(m.replied_at),
        replies: m.replies.map((r) => ({ body: r.body, sentAt: toIso(r.created_at) })),
      })),
    };
    // Sent bare, NOT through ok() (AUDIT.md L-03). This response is a file the
    // person downloads and keeps: wrapping it in {"ok":true,"data":{…}} means
    // nexa-account-7.json is not the export, it is the export inside a
    // transport envelope that only makes sense to this API. Every other route
    // here is read by our own client and keeps the envelope.
    res.setHeader('Content-Disposition', `attachment; filename="nexa-account-${u.id}.json"`);
    res.type('application/json');
    return res.send(`${JSON.stringify(document, null, 2)}\n`);
  })
);

/**
 * Self-service account deletion. Irreversible: the row cascades to
 * subscriptions, activations, reviews and team rows; payments are kept for the
 * books with their user detached (ON DELETE SET NULL). A paid Stripe
 * subscription is cancelled first so nobody is billed for a deleted account,
 * and the account is NOT deleted when that cancel fails.
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

    // Stripe first, and no deletion if it cannot be stopped — see
    // utils/accountDeletion.js for why logging and carrying on was the worst
    // of the available answers.
    const billing = await stopBillingBeforeDelete(user.id);
    if (!billing.ok)
      return fail(res, BILLING_CANCEL_FAILED.code, BILLING_CANCEL_FAILED.message, BILLING_CANCEL_FAILED.status);
    const subs = await Subscription.findByUserId(user.id);
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
    await security.record('account.deleted', { req, user, detail: 'deleted by the account owner' });
    await User.remove(user.id);
    clearSessionCookies(res);
    return ok(res, { deleted: true });
  })
);

router.delete(
  '/devices/:id', requireAuth, validate(deviceParamsSchema),
  asyncHandler(async (req, res) => {
    // The same subscription GET /devices listed the seat on — a Team member's
    // seat is a row on the owner's plan, so their own row would never match.
    const own = await findUserSubscription(req.user.id);
    const sub = (await subscriptionForUser(req.user.id)) || own;
    if (!sub) return fail(res, 'NOT_FOUND', 'No subscription for this account', 404);
    // …but a member may only free their OWN machines. The rows on a team plan
    // belong to every member and their ids are sequential, so without this a
    // member could knock a colleague off their seat by guessing a number.
    if (own && sub.id !== own.id) {
      const [rows, tokens] = await Promise.all([
        Subscription.listActivations(sub.id),
        DeviceAuth.listForUser(req.user.id),
      ]);
      const mine = new Set(tokens.map((t) => t.device_fingerprint));
      const row = rows.find((d) => Number(d.id) === Number(req.params.id));
      if (!row || !mine.has(row.device_fingerprint))
        return fail(res, 'NOT_FOUND', 'Device not found on this licence', 404);
    }
    const released = await Subscription.releaseSeatById(sub.id, Number(req.params.id));
    if (!released) return fail(res, 'NOT_FOUND', 'Device not found on this licence', 404);
    return ok(res, { released: true, activeSeats: await Subscription.activeSeatCount(sub.id) });
  })
);

module.exports = router;
