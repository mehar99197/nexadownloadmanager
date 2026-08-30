'use strict';

/**
 * Feature gating is only a boundary if it fails closed. These assert the two
 * properties the desktop app relies on:
 *   - an unknown / absent / forged plan resolves to Free, never to something
 *     more generous;
 *   - the paid entitlements are exactly what the Pro and Team tiers advertise.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { entitlementsFor, seatsFor, FREE_THEMES, PLANS } = require('../src/config/plans');

test('free is the floor for every unrecognised plan', () => {
  const free = entitlementsFor('free');
  for (const bogus of [undefined, null, '', 'FREE_TRIAL', 'enterprise', 'root', 0, {}, 'pro ']) {
    const e = entitlementsFor(bogus);
    assert.equal(e.plan, 'free', `${JSON.stringify(bogus)} must resolve to free`);
    assert.deepEqual(e, free);
  }
});

test('free is restricted exactly as the pricing page claims', () => {
  const e = entitlementsFor('free');
  assert.equal(e.maxConcurrentDownloads, 3);
  assert.equal(e.themes, 'basic');
  assert.equal(e.authSiteDownloads, false);   // Udemy, Coursera, LinkedIn Learning…
  assert.equal(e.aiRename, false);
  assert.equal(e.adFree, false);
  assert.equal(e.seats, 1);
});

test('pro unlocks themes, login-gated sites and removes ads', () => {
  const e = entitlementsFor('pro');
  assert.equal(e.themes, 'all');
  assert.equal(e.authSiteDownloads, true);
  assert.equal(e.aiRename, true);
  assert.equal(e.adFree, true);
  assert.equal(e.maxConcurrentDownloads, 0);  // 0 = unlimited
  assert.equal(e.seats, 1);
});

test('team is pro with five concurrent seats', () => {
  const pro = entitlementsFor('pro');
  const team = entitlementsFor('team');
  assert.equal(team.seats, 5);
  assert.equal(pro.seats, 1);
  for (const key of ['themes', 'authSiteDownloads', 'aiRename', 'adFree', 'maxConcurrentDownloads']) {
    assert.equal(team[key], pro[key], `team must match pro on ${key}`);
  }
});

test('plan case and surrounding whitespace do not change the answer', () => {
  assert.equal(entitlementsFor('PRO').themes, 'all');
  assert.equal(entitlementsFor('Team').seats, 5);
  // A padded value is NOT a known plan, so it must fall back to free.
  assert.equal(entitlementsFor(' pro').plan, 'free');
});

test('adFree is derived from the ads module, not restated', () => {
  const { isAdFreePlan } = require('../src/utils/ads');
  for (const plan of ['free', 'pro', 'team', 'nonsense']) {
    assert.equal(entitlementsFor(plan).adFree, isAdFreePlan(entitlementsFor(plan).plan));
  }
});

test('free theme ids match the desktop app’s built-in ids', () => {
  // src/ui/Theme.cpp registers "dark" and "light"; "system" resolves to one of
  // them. A rename there without a change here would silently lock a Free user
  // out of every theme.
  assert.deepEqual(FREE_THEMES, ['system', 'dark', 'light']);
});

test('seatsFor agrees with the entitlements table and the plan catalog', () => {
  assert.equal(seatsFor('free'), 1);
  assert.equal(seatsFor('pro'), 1);
  assert.equal(seatsFor('team'), 5);
  assert.equal(seatsFor('bogus'), 1);
  // The catalog's advertised seat count must not drift from what is enforced.
  assert.equal(seatsFor('team'), PLANS.team.seats);
});
