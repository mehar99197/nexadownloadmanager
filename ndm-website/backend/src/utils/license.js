'use strict';

const { customAlphabet } = require('nanoid');
const { PLANS, seatsFor } = require('../config/plans');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const nano4 = customAlphabet(ALPHABET, 4);

// Length of the no-card Pro trial.
const TRIAL_DAYS = 7;
const TRIAL_PLAN = 'pro';

// NDM-XXXX-XXXX-XXXX (uppercase A-Z0-9)
function generateLicenseKey() {
  return `NDM-${nano4()}-${nano4()}-${nano4()}`;
}

function planSeats(plan) {
  return seatsFor(plan);
}

// How long a device holds a seat after its last heartbeat. Seats are concurrent
// ("5 machines at a time"), not permanent registrations, so a crashed or
// uninstalled client must free its seat on its own. The desktop app heartbeats
// every 5 minutes; this is deliberately three intervals so one or two dropped
// requests on a flaky connection do not evict a user mid-download.
const SEAT_LEASE_SECONDS = 15 * 60;

// Returns the expiry Date for a plan + billing cycle.
// free → far-future (effectively non-expiring; null-safe for callers).
function planExpiry(plan, billingCycle) {
  const now = new Date();
  if (plan === 'free') {
    // Far future so "active" checks pass; callers may treat as never-expires.
    return new Date(now.getFullYear() + 100, now.getMonth(), now.getDate());
  }
  const d = new Date(now);
  if (billingCycle === 'yearly') {
    d.setFullYear(d.getFullYear() + 1);
  } else {
    // default + monthly
    d.setMonth(d.getMonth() + 1);
  }
  return d;
}

/**
 * The expiry a subscription should carry after an admin moves it between plans,
 * or `undefined` for "leave the existing date alone".
 *
 * The free plan's expiry is deliberately ~100 years out, so carrying a date
 * across a plan change gets it wrong in both directions: a free → pro grant
 * kept the far-future date and quietly handed out a permanent Pro licence,
 * while a pro → free downgrade kept the paid date, so the customer's FREE
 * licence expired a month later and the desktop app deleted their key.
 *
 * A lateral paid move (pro ⇄ team) keeps its date: the customer has already
 * paid for that period and should not lose or gain time by being switched.
 */
function expiryForPlanChange(fromPlan, toPlan, currentExpiry, billingCycle) {
  if (fromPlan === toPlan) return undefined;
  if (toPlan === 'free') return planExpiry('free');
  if (fromPlan === 'free' || !currentExpiry) return planExpiry(toPlan, billingCycle);
  return undefined;
}

/**
 * How long a lapsed paid plan keeps working before it falls back to Free.
 *
 * Stripe retries a failed charge for days before giving up, and a renewal
 * webhook can be delayed or replayed. Downgrading the instant expiry_date
 * passes would punish customers for our plumbing, so a paid plan is only
 * considered lapsed once it is this far past its date.
 */
const PAID_GRACE_DAYS = 3;

function toTime(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const d = value instanceof Date ? value : new Date(value);
  return d.getTime();
}

// End of a trial started at `now` (defaults to the current time).
function trialEndsAt(now = new Date()) {
  const start = now instanceof Date ? now : new Date(now);
  return new Date(start.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

// A subscription row "is a trial" when it carries trial_ends_at and is not a
// paid Stripe subscription (paid activation clears trial_ends_at and sets
// stripe_subscription_id).
function hasTrial(sub) {
  return Boolean(sub && sub.trial_ends_at && !sub.stripe_subscription_id);
}

// Trial currently running: active row whose trial end is still in the future.
function isTrialActive(sub, now = new Date()) {
  if (!hasTrial(sub)) return false;
  if (sub.status !== 'active') return false;
  const end = toTime(sub.trial_ends_at);
  return !Number.isNaN(end) && end > toTime(now);
}

// Trial that has run out and should be lazily downgraded to free.
function isTrialExpired(sub, now = new Date()) {
  if (!hasTrial(sub)) return false;
  const end = toTime(sub.trial_ends_at);
  return !Number.isNaN(end) && end <= toTime(now);
}

/**
 * A PAID plan whose period ended and was never renewed.
 *
 * Such a row used to sit there as `active` with a past date, which
 * /api/license/validate reported as `expired` — and the desktop client DELETES
 * the key it is told is expired. Falling back to Free instead is both kinder
 * and more accurate: the person still owns a Free licence, they just stopped
 * paying for Pro. Trials are excluded; isTrialExpired already owns those.
 */
function isPaidPlanLapsed(sub, now = new Date()) {
  if (!sub || (sub.plan !== 'pro' && sub.plan !== 'team')) return false;
  if (sub.status !== 'active') return false;
  if (hasTrial(sub)) return false;
  const end = toTime(sub.expiry_date);
  if (Number.isNaN(end)) return false;
  return end + PAID_GRACE_DAYS * 24 * 60 * 60 * 1000 <= toTime(now);
}

/**
 * A plan that renews — and so has a card, invoices and Stripe's portal behind
 * it. Only a live Stripe subscription on a paid plan does. An admin-granted
 * plan simply ends on its date and a trial is never charged; neither carries a
 * Stripe id. The id alone is not enough, though: expireIfLapsed drops a lapsed
 * plan to Free and leaves the old id on the row.
 *
 * The site reads this to choose between "Renews" and "Active until", and to
 * decide whether "Cancel subscription" and "Manage billing" mean anything.
 */
function isBilled(sub) {
  if (!sub || !sub.stripe_subscription_id || sub.status !== 'active') return false;
  return sub.plan === 'pro' || sub.plan === 'team';
}

module.exports = {
  generateLicenseKey, planSeats, planExpiry, expiryForPlanChange, SEAT_LEASE_SECONDS,
  TRIAL_DAYS, TRIAL_PLAN, PAID_GRACE_DAYS,
  trialEndsAt, isTrialActive, isTrialExpired, isPaidPlanLapsed, isBilled,
};
