'use strict';

// Plan catalog — single source of truth for pricing + features.
// Feature arrays mirror the pricing table in ndm-website/CONTRACT.md §9 (PLANS catalog).

const { isAdFreePlan } = require('../utils/ads');

const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    price: 0,
    features: [
      '3 concurrent downloads',
      'Up to 16 connections per file',
      'Browser extension, video grabber, torrents',
      '2 core themes',
      'Supported by in-app promos',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    monthly: 5,
    yearly: 45,
    features: [
      'Everything in Free',
      'Unlimited concurrent downloads',
      '32 connections per file — double the Free limit',
      'No ads',
      'All 64 themes',
      'Udemy, Coursera & other login-gated sites',
      'AI smart rename',
      'Priority support',
    ],
  },
  team: {
    id: 'team',
    name: 'Team',
    monthly: 15,
    yearly: 135,
    seats: 5,
    features: [
      'Everything in Pro',
      '5 seats — five machines at a time on one key',
      'Free a seat from the website any time',
      'Ad-free for the whole team',
    ],
  },
};

/**
 * Machine-readable entitlements sent to the desktop app.
 *
 * The app mirrors these as its own gate, but this object is authoritative: it
 * rides inside the signed licence token, so a client that edits its local copy
 * still cannot make the server agree. Keep the shape flat and additive — old
 * app builds ignore keys they do not know.
 *
 * `themes: 'basic'` means only the two hand-tuned palettes (Nexa Dark / Nexa
 * Light); 'all' unlocks the full catalogue.
 * `maxConcurrentDownloads: 0` means unlimited.
 */
// Theme ids exactly as the desktop app stores them (see src/ui/Theme.cpp):
// the two hand-tuned palettes plus "system", which only resolves to one of them.
const FREE_THEMES = ['system', 'dark', 'light'];

const ENTITLEMENTS = {
  free: {
    maxConcurrentDownloads: 3,
    maxConnectionsPerFile: 16,
    themes: 'basic',
    freeThemes: FREE_THEMES,
    authSiteDownloads: false,
    aiRename: false,
    seats: 1,
  },
  pro: {
    maxConcurrentDownloads: 0,
    maxConnectionsPerFile: 32,
    themes: 'all',
    freeThemes: FREE_THEMES,
    authSiteDownloads: true,
    aiRename: true,
    seats: 1,
  },
  team: {
    maxConcurrentDownloads: 0,
    maxConnectionsPerFile: 32,
    themes: 'all',
    freeThemes: FREE_THEMES,
    authSiteDownloads: true,
    aiRename: true,
    seats: 5,
  },
};

/**
 * Entitlements for a plan. Unknown/absent/forged plan names resolve to `free`,
 * never to something more permissive — the same fail-closed rule the ad code
 * uses. `adFree` is derived from utils/ads.js rather than restated here, so
 * there is still exactly one place that decides who sees ads.
 */
function entitlementsFor(plan) {
  const key = String(plan || '').toLowerCase();
  const base = ENTITLEMENTS[key] || ENTITLEMENTS.free;
  return { ...base, plan: ENTITLEMENTS[key] ? key : 'free', adFree: isAdFreePlan(key) };
}

/** Seats included with a plan, used when a subscription row is created. */
function seatsFor(plan) {
  return entitlementsFor(plan).seats;
}

module.exports = { PLANS, ENTITLEMENTS, FREE_THEMES, entitlementsFor, seatsFor };
