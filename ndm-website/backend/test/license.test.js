'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TRIAL_DAYS, TRIAL_PLAN, trialEndsAt, isTrialActive, isTrialExpired, planSeats,
  planExpiry, expiryForPlanChange, isPaidPlanLapsed, PAID_GRACE_DAYS,
} = require('../src/utils/license');

const NOW = new Date('2026-08-30T10:00:00.000Z');

function sub(overrides = {}) {
  return {
    id: 1, plan: 'pro', status: 'active', seats: 1,
    trial_ends_at: new Date('2026-09-06T10:00:00.000Z'),
    stripe_subscription_id: null,
    ...overrides,
  };
}

test('trialEndsAt is exactly TRIAL_DAYS (7) after the start', () => {
  assert.equal(TRIAL_DAYS, 7);
  assert.equal(TRIAL_PLAN, 'pro');
  assert.equal(planSeats(TRIAL_PLAN), 1);
  const end = trialEndsAt(NOW);
  assert.equal(end.toISOString(), '2026-09-06T10:00:00.000Z');
  assert.equal(end.getTime() - NOW.getTime(), 7 * 24 * 60 * 60 * 1000);
  assert.equal(trialEndsAt(NOW.getTime()).toISOString(), end.toISOString());
});

test('trialEndsAt defaults to the current time', () => {
  const before = Date.now();
  const end = trialEndsAt();
  assert.ok(end.getTime() - before >= 7 * 24 * 60 * 60 * 1000);
});

test('isTrialActive is true only while the trial end is in the future', () => {
  assert.equal(isTrialActive(sub(), NOW), true);
  assert.equal(isTrialActive(sub(), new Date('2026-09-06T09:59:59.999Z')), true);
  assert.equal(isTrialActive(sub(), new Date('2026-09-06T10:00:00.000Z')), false);
  assert.equal(isTrialActive(sub(), new Date('2026-09-07T00:00:00.000Z')), false);
});

test('isTrialActive accepts string timestamps (as returned by some drivers)', () => {
  assert.equal(isTrialActive(sub({ trial_ends_at: '2026-09-06T10:00:00.000Z' }), NOW), true);
});

test('isTrialActive is false for non-trial, paid, cancelled or missing subscriptions', () => {
  assert.equal(isTrialActive(null, NOW), false);
  assert.equal(isTrialActive(undefined, NOW), false);
  assert.equal(isTrialActive(sub({ trial_ends_at: null }), NOW), false);
  assert.equal(isTrialActive(sub({ stripe_subscription_id: 'sub_123' }), NOW), false);
  assert.equal(isTrialActive(sub({ status: 'cancelled' }), NOW), false);
  assert.equal(isTrialActive(sub({ status: 'expired' }), NOW), false);
});

test('isTrialExpired flags finished no-card trials only', () => {
  const later = new Date('2026-09-10T00:00:00.000Z');
  assert.equal(isTrialExpired(sub(), NOW), false);
  assert.equal(isTrialExpired(sub(), later), true);
  assert.equal(isTrialExpired(sub({ status: 'cancelled' }), later), true);
  assert.equal(isTrialExpired(sub({ stripe_subscription_id: 'sub_123' }), later), false);
  assert.equal(isTrialExpired(sub({ trial_ends_at: null }), later), false);
  assert.equal(isTrialExpired(null, later), false);
  assert.equal(isTrialExpired(sub({ trial_ends_at: 'garbage' }), later), false);
});

/* ------------------------------------------------- plan-change expiry ---- */

test('expiryForPlanChange: free is ~a century out, so it never crosses a plan change', () => {
  const farFuture = planExpiry('free');
  const paidExpiry = new Date('2026-09-30T10:00:00.000Z');

  // free -> paid: keeping free's date would have granted a permanent Pro.
  const upgrade = expiryForPlanChange('free', 'pro', farFuture);
  assert.ok(upgrade instanceof Date);
  assert.ok(upgrade.getTime() < farFuture.getTime());

  // paid -> free: keeping the paid date made the customer's FREE licence
  // expire a month later, and the desktop app deletes an expired key.
  const downgrade = expiryForPlanChange('pro', 'free', paidExpiry);
  assert.ok(downgrade instanceof Date);
  assert.ok(downgrade.getTime() > Date.now() + 50 * 365 * 24 * 60 * 60 * 1000);
});

test('expiryForPlanChange leaves a paid period alone on a lateral move and a no-op', () => {
  const paidExpiry = new Date('2026-09-30T10:00:00.000Z');
  assert.equal(expiryForPlanChange('pro', 'team', paidExpiry), undefined);
  assert.equal(expiryForPlanChange('team', 'pro', paidExpiry), undefined);
  assert.equal(expiryForPlanChange('pro', 'pro', paidExpiry), undefined);
  assert.equal(expiryForPlanChange('free', 'free', paidExpiry), undefined);
});

test('expiryForPlanChange gives a paid plan with no expiry at all a real one', () => {
  const fresh = expiryForPlanChange('pro', 'team', null);
  assert.ok(fresh instanceof Date);
  assert.ok(fresh.getTime() > Date.now());
});

test('expiryForPlanChange honours the billing cycle when it starts a new period', () => {
  const monthly = expiryForPlanChange('free', 'pro', planExpiry('free'), 'monthly');
  const yearly = expiryForPlanChange('free', 'pro', planExpiry('free'), 'yearly');
  assert.ok(yearly.getTime() > monthly.getTime());
});

/* --------------------------------------------------- lapsed paid plans ---- */

test('isPaidPlanLapsed only fires after the grace period, and never on a trial', () => {
  const day = 24 * 60 * 60 * 1000;
  const paid = (expiryOffsetDays, extra = {}) => ({
    plan: 'pro', status: 'active', trial_ends_at: null, stripe_subscription_id: 'sub_1',
    expiry_date: new Date(NOW.getTime() + expiryOffsetDays * day), ...extra,
  });

  // Still inside the period, and just past it: a slow renewal webhook must not
  // downgrade anybody.
  assert.equal(isPaidPlanLapsed(paid(1), NOW), false);
  assert.equal(isPaidPlanLapsed(paid(-1), NOW), false);
  assert.equal(isPaidPlanLapsed(paid(-PAID_GRACE_DAYS + 0.5), NOW), false);
  // Past the grace period, it has genuinely lapsed.
  assert.equal(isPaidPlanLapsed(paid(-PAID_GRACE_DAYS - 0.5), NOW), true);

  // Free never lapses (its expiry is a century out anyway), and a trial is
  // isTrialExpired's business, not this one.
  assert.equal(isPaidPlanLapsed(paid(-30, { plan: 'free' }), NOW), false);
  assert.equal(isPaidPlanLapsed(paid(-30, { status: 'cancelled' }), NOW), false);
  assert.equal(isPaidPlanLapsed(
    { plan: 'pro', status: 'active', trial_ends_at: new Date(NOW.getTime() - 30 * day),
      stripe_subscription_id: null, expiry_date: new Date(NOW.getTime() - 30 * day) }, NOW), false);
  assert.equal(isPaidPlanLapsed(paid(0, { expiry_date: null }), NOW), false);
  assert.equal(isPaidPlanLapsed(null, NOW), false);
});
