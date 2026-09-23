import { useEffect, useState } from 'react';
import { lastRead, readPublic } from '../api/reads';

const PLANS = '/subscription/plans';

/**
 * Whether anything can be bought yet, from a /subscription/plans answer.
 * `billing` is 'disabled' until Stripe is configured on the server. An answer
 * without the field (an older API) counts as open, as the pricing page always
 * assumed before the field existed.
 */
export const isBillingOpen = (plans) => !plans || plans.billing !== 'disabled';

/**
 * The same, for a page that does not otherwise load the plans: true or false
 * once the answer is in, null until then or if it cannot be had. Callers treat
 * null like false, because a button that promises an upgrade and lands on
 * "coming soon" is the failure this exists to prevent.
 */
export default function useBillingOpen() {
  const [open, setOpen] = useState(() => {
    const cached = lastRead(PLANS);
    return cached === undefined ? null : isBillingOpen(cached);
  });

  useEffect(() => {
    let cancelled = false;
    readPublic(PLANS)
      .then((plans) => { if (!cancelled) setOpen(isBillingOpen(plans)); })
      .catch(() => { /* keep what we had; unknown reads as closed */ });
    return () => { cancelled = true; };
  }, []);

  return open;
}
