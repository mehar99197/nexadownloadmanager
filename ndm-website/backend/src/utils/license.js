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

module.exports = {
  generateLicenseKey, planSeats, planExpiry, SEAT_LEASE_SECONDS,
  TRIAL_DAYS, TRIAL_PLAN, trialEndsAt, isTrialActive, isTrialExpired,
};
