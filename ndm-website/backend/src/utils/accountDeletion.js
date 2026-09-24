'use strict';

const stripe = require('./stripe');
const Subscription = require('../models/Subscription');
const { isBilled } = require('./license');

/**
 * Stop Stripe billing an account that is about to be deleted.
 *
 * Every path that deletes a user — the owner's own DELETE /user/account, the
 * staff panel and the creator console — must call this first and must NOT
 * delete when it reports failure. Deleting anyway is the one outcome that is
 * worse than refusing: the row that ties the Stripe subscription to a person
 * is gone, so nothing on our side can ever stop the charges, and Stripe goes on
 * billing somebody who no longer has an account. (Self-delete used to log the
 * failure and carry on; the two admin paths never asked Stripe at all.)
 *
 * The cancel is immediate, unlike /subscription/cancel: the account is going
 * away, so there is no remaining period to honour.
 *
 * Returns { ok: true, cancelled: [ids] } or { ok: false, error, cancelled }.
 */
async function stopBillingBeforeDelete(userId) {
  const subs = await Subscription.findByUserId(userId);
  const billed = subs.filter(isBilled);
  // A row that lapsed to Free keeps its old Stripe id (expireIfLapsed leaves
  // it), and Stripe may still be retrying that subscription's last invoice.
  // Worth stopping too, but only best-effort: it has usually ended already, and
  // Stripe then refuses the cancel — which must not make the account undeletable.
  const leftovers = subs.filter((s) => !isBilled(s) && s.stripe_subscription_id && s.status === 'active');
  if (!billed.length && !leftovers.length) return { ok: true, cancelled: [] };

  // With billing disabled there is no Stripe key to cancel anything with, and
  // nothing can have been sold through this server in that state. Refusing
  // here would make accounts undeletable on a site that takes no payments.
  if (stripe.disabled) {
    if (billed.length) {
      // eslint-disable-next-line no-console
      console.warn(`[delete] user ${userId} has Stripe subscription(s) `
        + `${billed.map((s) => s.stripe_subscription_id).join(', ')} but billing is disabled; not cancelled`);
    }
    return { ok: true, cancelled: [] };
  }

  const cancelled = [];
  for (const s of billed) {
    try {
      await stripe.cancelSubscription(s.stripe_subscription_id, { atPeriodEnd: false });
      cancelled.push(s.stripe_subscription_id);
    } catch (err) {
      // Stripe no longer knows the subscription: there is nothing left to bill.
      if (err && err.code === 'resource_missing') { cancelled.push(s.stripe_subscription_id); continue; }
      // eslint-disable-next-line no-console
      console.error(`[delete] could not cancel Stripe subscription ${s.stripe_subscription_id} `
        + `for user ${userId}:`, err && err.message);
      return { ok: false, error: err, cancelled };
    }
  }
  for (const s of leftovers) {
    try {
      await stripe.cancelSubscription(s.stripe_subscription_id, { atPeriodEnd: false });
      cancelled.push(s.stripe_subscription_id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[delete] leftover Stripe subscription ${s.stripe_subscription_id} for user ${userId} `
        + `not cancelled (${err && err.message}); the plan had already lapsed`);
    }
  }
  return { ok: true, cancelled };
}

/** The refusal every delete route answers with when stopBillingBeforeDelete fails. */
const BILLING_CANCEL_FAILED = Object.freeze({
  code: 'BILLING_CANCEL_FAILED',
  message: 'The subscription could not be cancelled with the payment provider, so the account was not deleted. '
    + 'Please try again in a few minutes.',
  status: 502,
});

module.exports = { stopBillingBeforeDelete, BILLING_CANCEL_FAILED };
