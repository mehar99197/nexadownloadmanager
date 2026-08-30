'use strict';

/**
 * Team invites — mounted at /api/team (every route requires a signed-in user).
 *
 * Owner (an account whose current subscription is an active, paid Team plan):
 *   GET    /                  → { role:'owner', seats, members:[…], canInvite }
 *   POST   /invites {email}   → sends the invitation email, returns the member row
 *   POST   /invites/:id/resend
 *   DELETE /members/:id       → removes an invite or a member
 *
 * Invitee:
 *   GET    /invites/:token    → { ownerName, email, plan } (no auth: shown before sign-in)
 *   POST   /join {token}      → accepts; the signed-in email must match the invite
 *   POST   /leave
 *
 * Member: GET / → { role:'member', owner:{name,email}, licenseKey, plan, status }
 *
 * The roster is capped at the plan's seats (owner included) so a five-seat
 * team is five people, and the desktop app keeps counting seats per device.
 */

const router = require('express').Router();
const crypto = require('crypto');

const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { teamInviteLimiter, apiLimiter } = require('../middleware/rateLimiter');
const { ok, fail } = require('../utils/respond');
const Subscription = require('../models/Subscription');
const TeamMember = require('../models/TeamMember');
const AuditLog = require('../models/AuditLog');
const { sendTeamInviteEmail } = require('../utils/email');
const { isTrialActive } = require('../utils/license');
const {
  inviteSchema, memberIdSchema, joinSchema, inviteLookupSchema,
} = require('../schemas/team.schema');

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function newInviteToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: crypto.createHash('sha256').update(token).digest('hex') };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** The subscription this user owns, if it is a usable Team plan. */
async function ownedTeam(userId) {
  const active = await Subscription.findActiveByUserId(userId);
  const sub = await Subscription.expireTrialIfNeeded(active || (await Subscription.findByUserId(userId))[0] || null);
  if (!sub || sub.plan !== 'team') return null;
  return sub;
}

function teamUsable(sub) {
  if (!sub || sub.plan !== 'team' || sub.status !== 'active') return false;
  if (isTrialActive(sub)) return false;
  if (sub.expiry_date && new Date(sub.expiry_date).getTime() < Date.now()) return false;
  return true;
}

function memberView(m) {
  return {
    id: m.id,
    email: m.email,
    name: m.user_name || null,
    status: m.status,
    invitedAt: toIso(m.invited_at),
    acceptedAt: toIso(m.accepted_at),
  };
}

async function ownerPayload(sub) {
  const members = await TeamMember.listBySubscription(sub.id);
  const seats = Math.max(1, Number(sub.seats) || 1);
  return {
    role: 'owner',
    plan: sub.plan,
    status: sub.status,
    usable: teamUsable(sub),
    seats,
    // The owner occupies one place on the roster.
    used: members.length + 1,
    canInvite: teamUsable(sub) && members.length + 1 < seats,
    members: members.map(memberView),
  };
}

function memberPayload(m) {
  return {
    role: 'member',
    owner: { name: m.owner_name, email: m.owner_email },
    plan: m.owner_plan,
    status: m.owner_status,
    usable: teamUsable({
      plan: m.owner_plan, status: m.owner_status, expiry_date: m.owner_expiry_date, trial_ends_at: null,
    }),
    licenseKey: m.owner_license_key,
    acceptedAt: toIso(m.accepted_at),
  };
}

// Public: what an invite link points at, so the join page can say who invited
// whom before the visitor signs in. Reveals only the owner's name and the
// invited address (which the visitor already has — it is their inbox).
router.get(
  '/invites/:token', apiLimiter, validate(inviteLookupSchema),
  asyncHandler(async (req, res) => {
    const invite = await TeamMember.findByTokenHash(hashToken(req.params.token));
    if (!invite || invite.status !== 'invited')
      return fail(res, 'INVITE_NOT_FOUND', 'This invitation is no longer valid', 404);
    return ok(res, { ownerName: invite.owner_name, email: invite.email, plan: invite.owner_plan });
  })
);

router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const owned = await ownedTeam(req.user.id);
    if (owned) return ok(res, await ownerPayload(owned));
    const membership = await TeamMember.findActiveByUserId(req.user.id);
    if (membership) return ok(res, memberPayload(membership));
    return ok(res, { role: 'none' });
  })
);

router.post(
  '/invites', teamInviteLimiter, validate(inviteSchema),
  asyncHandler(async (req, res) => {
    const sub = await ownedTeam(req.user.id);
    if (!sub) return fail(res, 'NOT_TEAM_OWNER', 'Only a Team plan can invite members', 403);
    if (!teamUsable(sub)) return fail(res, 'TEAM_INACTIVE', 'This Team plan is not active', 400);

    const { email } = req.body;
    if (email === String(req.user.email).toLowerCase())
      return fail(res, 'SELF_INVITE', 'You are already on your own team', 400);
    if (await TeamMember.findBySubscriptionAndEmail(sub.id, email))
      return fail(res, 'ALREADY_INVITED', 'That address is already on this team', 409);
    const count = await TeamMember.countBySubscription(sub.id);
    const seats = Math.max(1, Number(sub.seats) || 1);
    if (count + 1 >= seats)
      return fail(res, 'TEAM_FULL', `This plan covers ${seats} people including you`, 400);

    const { token, hash } = newInviteToken();
    const member = await TeamMember.create({
      subscriptionId: sub.id, email, tokenHash: hash, invitedBy: req.user.id,
    });
    await sendTeamInviteEmail({ to: email, ownerName: req.user.name, token });
    await AuditLog.create({
      adminUserId: null, action: 'team.invited', entityType: 'subscription', entityId: sub.id,
      summary: `${req.user.email} invited ${email} to their team`, metadata: { memberId: member.id },
    });
    return ok(res, memberView(member), 201);
  })
);

router.post(
  '/invites/:id/resend', teamInviteLimiter, validate(memberIdSchema),
  asyncHandler(async (req, res) => {
    const sub = await ownedTeam(req.user.id);
    if (!sub) return fail(res, 'NOT_TEAM_OWNER', 'Only a Team plan can invite members', 403);
    const member = await TeamMember.findById(Number(req.params.id));
    if (!member || member.subscription_id !== sub.id)
      return fail(res, 'NOT_FOUND', 'Invitation not found', 404);
    if (member.status !== 'invited')
      return fail(res, 'ALREADY_ACCEPTED', 'That person has already joined', 400);
    const { token, hash } = newInviteToken();
    await TeamMember.rotateToken(member.id, hash);
    await sendTeamInviteEmail({ to: member.email, ownerName: req.user.name, token });
    return ok(res, { sent: true });
  })
);

router.delete(
  '/members/:id', validate(memberIdSchema),
  asyncHandler(async (req, res) => {
    const sub = await ownedTeam(req.user.id);
    if (!sub) return fail(res, 'NOT_TEAM_OWNER', 'Only a Team plan can manage members', 403);
    const member = await TeamMember.findById(Number(req.params.id));
    if (!member || member.subscription_id !== sub.id)
      return fail(res, 'NOT_FOUND', 'Member not found', 404);
    await TeamMember.remove(member.id, sub.id);
    await AuditLog.create({
      adminUserId: null, action: 'team.member_removed', entityType: 'subscription', entityId: sub.id,
      summary: `${req.user.email} removed ${member.email} from their team`,
    });
    return ok(res, { removed: true });
  })
);

router.post(
  '/join', validate(joinSchema),
  asyncHandler(async (req, res) => {
    const invite = await TeamMember.findByTokenHash(hashToken(req.body.token));
    if (!invite || invite.status !== 'invited')
      return fail(res, 'INVITE_NOT_FOUND', 'This invitation is no longer valid', 404);
    // The link may have been forwarded; only the invited address may accept.
    if (invite.email !== String(req.user.email).toLowerCase())
      return fail(res, 'EMAIL_MISMATCH', `This invitation was sent to ${invite.email}. Sign in with that address to accept it.`, 403);
    if (invite.owner_user_id === req.user.id)
      return fail(res, 'SELF_INVITE', 'You own this team', 400);
    const existing = await TeamMember.findActiveByUserId(req.user.id);
    if (existing && existing.subscription_id !== invite.subscription_id)
      return fail(res, 'ALREADY_ON_TEAM', 'Leave your current team before joining another', 409);

    const accepted = await TeamMember.accept(invite.id, req.user.id);
    if (!accepted) return fail(res, 'INVITE_NOT_FOUND', 'This invitation is no longer valid', 404);
    await AuditLog.create({
      adminUserId: null, action: 'team.joined', entityType: 'subscription', entityId: invite.subscription_id,
      summary: `${req.user.email} joined ${invite.owner_name}'s team`,
    });
    const membership = await TeamMember.findActiveByUserId(req.user.id);
    return ok(res, memberPayload(membership));
  })
);

router.post(
  '/leave',
  asyncHandler(async (req, res) => {
    const membership = await TeamMember.findActiveByUserId(req.user.id);
    if (!membership) return fail(res, 'NOT_A_MEMBER', 'You are not on a team', 400);
    await TeamMember.remove(membership.id, membership.subscription_id);
    await AuditLog.create({
      adminUserId: null, action: 'team.left', entityType: 'subscription', entityId: membership.subscription_id,
      summary: `${req.user.email} left ${membership.owner_name}'s team`,
    });
    return ok(res, { left: true });
  })
);

module.exports = router;
