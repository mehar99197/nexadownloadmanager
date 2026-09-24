'use strict';

const { PLANS } = require('../config/plans');

/**
 * What one billed subscription is worth per month, at list price.
 *
 * Prices come from config/plans.js — the same catalogue checkout charges from —
 * so the dashboard cannot drift from what Stripe is asked to bill. A yearly plan
 * counts as its yearly price over twelve months, not as a monthly one: a Pro
 * year is $45, which is $3.75 a month, and counting it as $5 overstated MRR by a
 * third. List price, not the amount actually charged: coupons are not modelled
 * here, which errs on the high side by at most the discount.
 */
function monthlyValue(plan, billingCycle) {
  const catalog = PLANS[plan];
  if (!catalog || !catalog.monthly) return 0;
  if (billingCycle === 'yearly' && catalog.yearly) return catalog.yearly / 12;
  return catalog.monthly;
}

/**
 * Monthly recurring revenue over rows from Subscription.findBilledActive():
 * Stripe-billed Pro/Team plans in force. Trials and admin-granted plans never
 * reach this — they are not billed — so with billing switched off it is,
 * honestly, zero. Rounded to cents.
 */
function monthlyRecurringRevenue(rows) {
  const total = (rows || []).reduce((sum, row) => sum + monthlyValue(row.plan, row.billing_cycle), 0);
  return Math.round(total * 100) / 100;
}

/**
 * The last `months` calendar months, oldest first, as 'YYYY-MM' (UTC — the
 * database session is pinned to UTC, see config/db.js), ending with the
 * current one.
 */
function lastMonths(months, now = new Date()) {
  const out = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

module.exports = { monthlyValue, monthlyRecurringRevenue, lastMonths };
