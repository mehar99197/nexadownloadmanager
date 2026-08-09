'use strict';

const { customAlphabet } = require('nanoid');
const { PLANS } = require('../config/plans');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const nano4 = customAlphabet(ALPHABET, 4);

// NDM-XXXX-XXXX-XXXX (uppercase A-Z0-9)
function generateLicenseKey() {
  return `NDM-${nano4()}-${nano4()}-${nano4()}`;
}

function planSeats(plan) {
  const p = PLANS[plan];
  if (!p) return 1;
  return p.seats || 1;
}

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

module.exports = { generateLicenseKey, planSeats, planExpiry };
