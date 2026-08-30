'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TRIAL_DAYS, TRIAL_PLAN, trialEndsAt, isTrialActive, isTrialExpired, planSeats,
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
