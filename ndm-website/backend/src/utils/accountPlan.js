'use strict';

/**
 * Which subscription an ACCOUNT is entitled to use in the app.
 *
 * With a licence key the answer was the key's own row. A signed-in machine
 * presents an account instead, and an account can be entitled two ways: its
 * own subscription, or a Team it was invited onto (the member's own row stays
 * Free — the seats belong to the owner's plan). The Team wins while it is a
 * live Team plan; otherwise the account's own current subscription, with the
 * usual lazy trial/lapse handling applied.
 *
 * Shared by routes/license.js (validate / heartbeat / release), routes/device.js
 * (sign-out frees the seat on the right row) and routes/user.js.
 */

const Subscription = require('../models/Subscription');
const TeamMember = require('../models/TeamMember');

// The membership plus who it belongs to, or null when it grants nothing.
async function teamPlanForUser(userId) {
  const m = await TeamMember.findActiveByUserId(userId);
  if (!m || m.owner_plan !== 'team' || m.owner_status !== 'active') return null;
  const row = await Subscription.findById(m.subscription_id);
  if (!row) return null;
  const sub = await Subscription.current(row);
  // current() may just have downgraded a lapsed team to Free: then it is no
  // longer a team the member can draw on.
  if (!(sub && sub.plan === 'team' && sub.status === 'active')) return null;
  return { subscription: sub, ownerName: m.owner_name, ownerEmail: m.owner_email };
}

async function teamSubscriptionForUser(userId) {
  const team = await teamPlanForUser(userId);
  return team ? team.subscription : null;
}

async function ownSubscriptionForUser(userId) {
  const active = await Subscription.findActiveByUserId(userId);
  const sub = active || (await Subscription.findByUserId(userId))[0] || null;
  return sub ? Subscription.current(sub) : null;
}

async function subscriptionForUser(userId) {
  return (await teamSubscriptionForUser(userId)) || ownSubscriptionForUser(userId);
}

/**
 * The plan this account HAS — the one every page should show.
 *
 * A Team member keeps their own Free row (the seats belong to the owner's
 * plan), and reading that row is why the site told them "Free", offered them
 * the Pro trial they already have, and said "you are on X's team" three lines
 * below. The entitlement already came from the team everywhere it mattered
 * (licence validation, seats); this is the same answer for the pages.
 *
 * → { subscription, viaTeam, teamOwner }
 */
async function effectivePlanFor(userId) {
  const team = await teamPlanForUser(userId);
  if (team) return { subscription: team.subscription, viaTeam: true, teamOwner: team.ownerName };
  return { subscription: await ownSubscriptionForUser(userId), viaTeam: false, teamOwner: null };
}

module.exports = {
  subscriptionForUser, teamSubscriptionForUser, ownSubscriptionForUser,
  teamPlanForUser, effectivePlanFor,
};
