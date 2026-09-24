'use strict';

/**
 * The pricing cards are served by the API (GET /api/subscription/plans →
 * PLANS in src/config/plans.js), so every line on them is a promise made in
 * the backend's name. These pin each promise to what the product does:
 *
 *  - no card offers "unlimited" anything: the desktop app's own concurrency
 *    setting stops at 32, and the Free cap counts direct (HTTP/FTP) file
 *    downloads only — video grabs and torrents start beside them;
 *  - no card offers priority support: nothing gives a paid plan's messages
 *    any priority;
 *  - the Pro course-site line names exactly the sites the app gates on Pro
 *    (`proOnly` in resources/cloud_providers.json, which is what
 *    `authSiteDownloads` unlocks);
 *  - the Team card says members sign in with their own accounts — the roster
 *    is people (routes/team.js), not one key passed around.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { PLANS, entitlementsFor } = require('../src/config/plans');

const cards = Object.values(PLANS);
const allLines = cards.flatMap((p) => p.features.map((line) => ({ plan: p.id, line })));

test('no card promises anything unlimited or priority support', () => {
  for (const { plan, line } of allLines) {
    assert.doesNotMatch(line, /unlimited/i, `${plan}: "${line}"`);
    assert.doesNotMatch(line, /priority/i, `${plan}: "${line}"`);
  }
});

test('the concurrency lines say what the app enforces', () => {
  assert.ok(PLANS.pro.features.includes('Up to 32 downloads at once'), PLANS.pro.features.join(' | '));
  // Free's number is the entitlement the app enforces, and the card says it
  // is a cap on direct downloads, not on video grabs or torrents.
  const freeCap = PLANS.free.features.find((l) => /at once/i.test(l));
  assert.ok(freeCap, 'the Free card states its cap');
  assert.match(freeCap, new RegExp(`^${entitlementsFor('free').maxConcurrentDownloads} direct downloads at once`));
  assert.match(freeCap, /videos and torrents not counted/);
});

test('the Pro course-site line names the sites the app gates on Pro', () => {
  const line = PLANS.pro.features.find((l) => /^Course sites:/.test(l));
  assert.ok(line, PLANS.pro.features.join(' | '));
  assert.doesNotMatch(line, /other|& more|login-gated/i, 'named, not hinted at');
  const named = line.replace(/^Course sites:\s*/, '').split(/,\s*/).sort();
  assert.deepEqual(named, ['Coursera', 'LinkedIn Learning', 'Pluralsight', 'Skillshare', 'Udemy']);

  // Checked against the desktop app's own gate when the repository is here
  // (a backend-only checkout — the Docker build context — has no app tree).
  const providersFile = path.join(__dirname, '..', '..', '..', 'resources', 'cloud_providers.json');
  if (!fs.existsSync(providersFile)) return;
  const { providers } = JSON.parse(fs.readFileSync(providersFile, 'utf8'));
  const gated = providers.filter((p) => p.proOnly).map((p) => p.label).sort();
  assert.deepEqual(named, gated, 'the card names exactly the proOnly providers');
});

test('the Team card is people signing in with their own accounts', () => {
  const lines = PLANS.team.features;
  const seatsLine = lines.find((l) => /seats/i.test(l));
  assert.ok(seatsLine, lines.join(' | '));
  assert.match(seatsLine, new RegExp(`^${PLANS.team.seats} seats`));
  assert.match(seatsLine, /their own account/);
  assert.doesNotMatch(lines.join(' | '), /on one key/i, 'a team is not one shared key');
  assert.ok(lines.includes('Up to five machines running at once across the team'));
  assert.equal(entitlementsFor('team').seats, PLANS.team.seats);
});
