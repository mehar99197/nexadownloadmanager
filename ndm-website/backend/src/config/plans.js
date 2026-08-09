'use strict';

// Plan catalog — single source of truth for pricing + features.
// Feature arrays mirror the pricing table in websiteplan.md.
const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    price: 0,
    features: [
      '3 concurrent downloads',
      'Basic download speed',
      'Browser extension',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    monthly: 5,
    yearly: 45,
    features: [
      'Unlimited concurrent downloads',
      'Maximum download speed',
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
      '5 seats',
      'All Pro features',
      'Shared team dashboard',
    ],
  },
};

module.exports = { PLANS };
