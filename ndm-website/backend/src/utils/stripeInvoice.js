'use strict';

/**
 * Pure readers for a Stripe Invoice object.
 *
 * An invoice carries none of the metadata a Checkout Session does: `plan` and
 * `billingCycle` were set on the session, not on the recurring invoices Stripe
 * mints every period afterwards. Everything the renewal handlers need is
 * therefore read off the invoice's own shape (or, for the plan, off our
 * subscription row) — never off `invoice.metadata`.
 *
 * Stripe has also moved these fields around between API versions, so each
 * reader accepts every shape we have shipped against. No config, no DB access:
 * the shapes can be unit-tested against captured payloads.
 */

const firstLine = (invoice) => (invoice && invoice.lines && invoice.lines.data && invoice.lines.data[0]) || null;

/** The Stripe subscription id this invoice bills for, or null. */
function subscriptionId(invoice) {
  if (!invoice) return null;
  const line = firstLine(invoice);
  const id = invoice.subscription
    || invoice.parent?.subscription_details?.subscription
    || line?.subscription
    || line?.parent?.subscription_item_details?.subscription;
  return id ? String(id) : null;
}

/** 'monthly' | 'yearly', from the line item's recurring interval. */
function billingCycle(invoice, fallback = 'monthly') {
  const line = firstLine(invoice);
  const interval = line?.price?.recurring?.interval
    || line?.plan?.interval
    || line?.pricing?.price_details?.recurring?.interval;
  if (interval === 'year') return 'yearly';
  if (interval === 'month') return 'monthly';
  return fallback;
}

/**
 * End of the period this invoice paid for, as a Date, or null.
 *
 * Preferred over recomputing "+1 month" ourselves: taking Stripe's own period
 * end is what keeps our expiry_date from drifting away from their billing clock
 * over a year of renewals.
 */
function periodEnd(invoice) {
  const end = firstLine(invoice)?.period?.end ?? invoice?.period_end;
  if (end === null || end === undefined || end === '' || !Number.isFinite(Number(end))) return null;
  const date = new Date(Number(end) * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Amount in major units (Stripe reports cents). */
function amount(invoice) {
  const cents = typeof invoice?.amount_paid === 'number' ? invoice.amount_paid
    : typeof invoice?.amount_due === 'number' ? invoice.amount_due
      : typeof invoice?.amount === 'number' ? invoice.amount : 0;
  return cents / 100;
}

/** Idempotency key for the payments table: the intent, else the invoice id. */
function paymentId(invoice) {
  const id = invoice?.payment_intent || invoice?.id;
  return id ? String(id) : null;
}

/** Where the customer can read the real invoice, or null. */
function invoiceUrl(invoice) {
  return invoice?.hosted_invoice_url || invoice?.invoice_url || null;
}

/**
 * Is this a genuine renewal rather than the first invoice of a new
 * subscription? The first one is already covered by the licence + receipt pair
 * that checkout.session.completed sends, so it must not be thanked twice.
 */
function isRenewal(invoice) {
  const reason = invoice?.billing_reason;
  return !reason || reason === 'subscription_cycle';
}

/**
 * Which of OUR plans an invoice is for, from the line item's price.
 *
 * Needed when our own row cannot say: a subscription that lapsed to Free and is
 * then renewed by a card retry that finally succeeded has to be put BACK on the
 * plan it was paying for, and the stored plan is 'free' by then.
 */
function planFromInvoice(inv, plans) {
  const line = firstLine(inv);
  const price = line?.price || line?.plan;
  const interval = price?.recurring?.interval || price?.interval;
  const cents = Number(price?.unit_amount ?? price?.amount ?? inv?.amount_paid ?? inv?.amount_due);
  if (!interval || !Number.isFinite(cents)) return null;
  const field = interval === 'year' ? 'yearly' : 'monthly';
  for (const [id, plan] of Object.entries(plans || {})) {
    if (typeof plan[field] === 'number' && plan[field] * 100 === cents) return id;
  }
  return null;
}

/* ------------------------------------------------- subscription objects -- */

/**
 * Which of OUR plans a Stripe subscription is on.
 *
 * Checkout builds prices ad hoc (`price_data`), so there is no price id to look
 * up — the amount and interval are the only identifying facts on the object.
 * Returns null when nothing matches, and the caller then leaves the stored plan
 * alone rather than guessing: a plan we cannot identify must never silently
 * downgrade somebody.
 */
function planFromSubscription(subscription, plans) {
  const item = subscription?.items?.data?.[0];
  const price = item?.price || item?.plan;
  const interval = price?.recurring?.interval || price?.interval;
  const cents = Number(price?.unit_amount ?? price?.amount);
  if (!interval || !Number.isFinite(cents)) return null;
  const field = interval === 'year' ? 'yearly' : 'monthly';
  for (const [id, plan] of Object.entries(plans || {})) {
    if (typeof plan[field] === 'number' && plan[field] * 100 === cents) return id;
  }
  return null;
}

/** 'monthly' | 'yearly' for a subscription object. */
function subscriptionCycle(subscription, fallback = 'monthly') {
  const item = subscription?.items?.data?.[0];
  const interval = item?.price?.recurring?.interval || item?.plan?.interval;
  if (interval === 'year') return 'yearly';
  if (interval === 'month') return 'monthly';
  return fallback;
}

/** End of the current period, as a Date, or null. */
function subscriptionPeriodEnd(subscription) {
  const end = subscription?.current_period_end
    ?? subscription?.items?.data?.[0]?.current_period_end;
  if (end === null || end === undefined || !Number.isFinite(Number(end))) return null;
  const date = new Date(Number(end) * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * What a Stripe subscription status means for OUR `subscriptions.status`, or
 * null for "leave it alone".
 *
 * `past_due` and `unpaid` deliberately map to nothing: Stripe is still retrying
 * the charge, and customer.subscription.deleted is what finally ends access.
 * Cutting somebody off the moment one payment bounces would be wrong.
 */
function statusFromSubscription(subscription) {
  switch (subscription?.status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'canceled':
    case 'incomplete_expired':
      return 'cancelled';
    default:
      return null;
  }
}

module.exports = {
  subscriptionId, billingCycle, periodEnd, amount, paymentId, invoiceUrl, isRenewal,
  planFromInvoice, planFromSubscription, subscriptionCycle, subscriptionPeriodEnd, statusFromSubscription,
};
