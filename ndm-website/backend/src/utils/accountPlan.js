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

async function teamSubscriptionForUser(userId) {
  const m = await TeamMember.findActiveByUserId(userId);
  if (!m || m.owner_plan !== 'team' || m.owner_status !== 'active') return null;
  const row = await Subscription.findById(m.subscription_id);
  if (!row) return null;
  const sub = await Subscription.current(row);
  // current() may just have downgraded a lapsed team to Free: then it is no
  // longer a team the member can draw on.
  return sub && sub.plan === 'team' && sub.status === 'active' ? sub : null;
}

async function ownSubscriptionForUser(userId) {
  const active = await Subscription.findActiveByUserId(userId);
  const sub = active || (await Subscription.findByUserId(userId))[0] || null;
  return sub ? Subscription.current(sub) : null;
}

async function subscriptionForUser(userId) {
  return (await teamSubscriptionForUser(userId)) || ownSubscriptionForUser(userId);
}

module.exports = { subscriptionForUser, teamSubscriptionForUser, ownSubscriptionForUser };
