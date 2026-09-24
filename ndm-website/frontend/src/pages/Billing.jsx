import { useEffect, useState, useCallback, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api, { unwrap } from '../api/client';
import { formatDate, formatDateShort } from '../utils/formatDate';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import ScrollRegion from '../components/ScrollRegion';
import Skeleton, { useArrival } from '../components/Skeleton';
import usePageMeta from '../hooks/usePageMeta';

/** "Current plan" as it will land: four label/value rows and the actions. */
function PlanSkeleton() {
  return (
    <div className="mt-4 space-y-3" role="status" aria-label="Loading your plan">
      {['w-16', 'w-20', 'w-24', 'w-10'].map((w, i) => (
        <div key={i} className="flex items-center justify-between">
          <Skeleton className="h-4 w-14 rounded" />
          <Skeleton className={`h-4 rounded ${w}`} />
        </div>
      ))}
      <div className="flex flex-wrap gap-3 border-t border-[var(--color-surface-border)] pt-4">
        <Skeleton className="h-11 w-52 rounded-[var(--radius-2)]" />
        <Skeleton className="h-11 w-44 rounded-[var(--radius-2)]" />
      </div>
    </div>
  );
}

/** "Payment history" as it will land: the table's header and three rows. */
function PaymentsSkeleton() {
  return (
    <div className="mt-4" role="status" aria-label="Loading your payments">
      <div className="flex gap-4 border-b border-[var(--color-surface-border)] pb-2">
        {['w-10', 'w-10', 'w-14', 'w-12'].map((w, i) => (
          <Skeleton key={i} className={`h-3 flex-1 rounded ${w}`} />
        ))}
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-4 border-b border-white/10 py-3.5 last:border-0">
          <Skeleton className="h-4 flex-1 rounded" />
          <Skeleton className="h-4 flex-1 rounded" />
          <Skeleton className="h-4 flex-1 rounded" />
          <Skeleton className="h-5 flex-1 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function PaymentRow({ payment }) {
  return (
    <tr className="border-b border-white/10 last:border-0">
      <td className="py-3 pr-4 text-sm text-slate-200">
        {formatDateShort(payment.createdAt || payment.created_at) || '—'}
      </td>
      <td className="py-3 pr-4 text-sm text-slate-200 capitalize">
        {payment.plan || 'pro'}
      </td>
      <td className="py-3 pr-4 text-sm text-slate-200">
        {payment.currency ? `${payment.currency.toUpperCase()} ` : '$'}
        {payment.amount}
      </td>
      <td className="py-3 text-sm">
        <span
          className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${
            payment.status === 'paid'
              ? 'bg-emerald-500/15 text-emerald-300'
              : payment.status === 'refunded'
              ? 'bg-amber-500/15 text-amber-300'
              : 'bg-red-500/15 text-red-300'
          }`}
        >
          {payment.status || 'completed'}
        </span>
      </td>
    </tr>
  );
}

export default function Billing() {
  usePageMeta({ title: "Billing", description: "Manage your Nexa Download Manager subscription and view payment history." });

  const toast = useToast();
  const confirm = useConfirm();
  const [payments, setPayments] = useState([]);
  const [subStatus, setSubStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  // Only the FIRST load draws the outlines. A refresh after cancelling or
  // resuming keeps what is on screen until the new answer replaces it — it
  // used to swap the whole page for a spinner and back.
  const [loaded, setLoaded] = useState(false);
  const arrive = useArrival(!loaded);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [portalBusy, setPortalBusy] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const mockCompleted = useRef(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [billingRes, statusRes] = await Promise.all([
        api.get('/user/billing'),
        api.get('/subscription/status'),
      ]);
      setPayments(unwrap(billingRes)?.payments || []);
      setSubStatus(unwrap(statusRes));
    } catch {
      setError('Failed to load billing data.');
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (mockCompleted.current || searchParams.get('mock_success') !== '1') {
      loadData();
      return;
    }
    mockCompleted.current = true;
    const plan = searchParams.get('plan');
    const billingCycle = searchParams.get('billingCycle') || 'monthly';
    if (plan === 'pro' || plan === 'team') {
      api.post('/subscription/mock-complete', { plan, billingCycle })
        .then(() => toast.success('Development checkout completed.'))
        .catch((err) => setError(err?.response?.data?.error?.message || 'Mock checkout failed.'))
        .finally(() => {
          setSearchParams({}, { replace: true });
          loadData();
        });
    } else {
      setSearchParams({}, { replace: true });
      loadData();
    }
  }, [loadData, searchParams, setSearchParams, toast]);
  const handlePortal = async () => {
    setPortalBusy(true);
    try {
      const data = unwrap(await api.post('/subscription/portal'));
      if (data?.url) {
        window.location.href = data.url;
        return;
      }
      // No Stripe customer yet (a trial, or a plan granted by an admin).
      toast.info('Nothing to manage yet — this plan was not paid through Stripe.');
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Could not open the billing portal.');
    } finally {
      setPortalBusy(false);
    }
  };


  const handleResume = async () => {
    setCancelling(true);
    try {
      await api.post('/subscription/resume');
      toast.success('Subscription resumed — it will renew as usual.');
      loadData();
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Could not resume the subscription.');
    } finally {
      setCancelling(false);
    }
  };

  // A trial is never billed, so there is no future charge to call off: the
  // only thing "cancel" can mean is "stop it now". Both consequences are said
  // plainly before the click, because neither is reversible.
  const handleEndTrial = async () => {
    const sure = await confirm({
      title: 'End your Pro trial now?',
      message: 'Pro features stop immediately and the account returns to Free. '
        + 'Your license key and downloads are untouched, but the trial cannot be started again.',
      confirmLabel: 'End trial now',
      cancelLabel: 'Keep my trial',
      danger: true,
    });
    if (!sure) return;
    setCancelling(true);
    try {
      await api.post('/subscription/trial/cancel');
      toast.success('Trial ended. Your account is on the Free plan.');
      loadData();
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Could not end the trial.');
    } finally {
      setCancelling(false);
    }
  };

  const handleCancel = async () => {
    const sure = await confirm({
      title: 'Cancel your subscription?',
      message: 'Your plan stays active until the end of the period you already paid for. After that the account returns to Free — nothing is deleted.',
      confirmLabel: 'Cancel subscription',
      cancelLabel: 'Keep my plan',
      danger: true,
    });
    if (!sure) return;
    setCancelling(true);
    try {
      await api.post('/subscription/cancel');
      toast.success('Cancelled. Your plan stays active until it expires.');
      loadData();
    } catch (err) {
      const msg =
        err?.response?.data?.error?.message ||
        err?.message ||
        'Cancellation failed.';
      toast.error(msg);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <Section>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-4xl font-extrabold tracking-tight text-white">Plan &amp; <span className="text-gradient">billing.</span></h1>
          <p className="mt-2 text-sm text-slate-400">
            Manage your subscription and payment history.
          </p>
        </div>
        <div className="flex gap-3">
          <Link to="/dashboard" className="btn btn-ghost">Dashboard</Link>
          <Link to="/pricing" className="btn btn-ghost">Plans</Link>
        </div>
      </div>

      {error && (
        <div className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card className="card-hover !p-7">
          <h3 className="text-lg font-bold text-white">Current plan</h3>
          {!loaded ? (
            <PlanSkeleton />
          ) : subStatus ? (
            <div className={`mt-4 space-y-3 ${arrive}`.trim()} aria-busy={loading || undefined}>
              <div className="flex items-center justify-between">
                <span className="text-sm text-zinc-400">Plan</span>
                <span className="text-sm font-semibold text-white capitalize">
                  {subStatus.plan}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-zinc-400">Status</span>
                <span
                  className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${
                    subStatus.status === 'active' && !subStatus.cancelAtPeriodEnd
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : 'bg-amber-500/15 text-amber-300'
                  }`}
                >
                  {subStatus.cancelAtPeriodEnd ? 'Ending' : subStatus.status}
                </span>
              </div>
              {/* Free has no date worth printing: its stored expiry is a
                  century out, and "Expires 2126" sat right above "The free
                  plan never expires". */}
              {subStatus.expiryDate && subStatus.plan !== 'free' && (
                <div className="flex items-center justify-between">
                  {/* Only a Stripe subscription renews. A plan granted without
                      a payment used to read "Renews" here beside an empty
                      payment history, with no card that could renew it. */}
                  <span className="text-sm text-zinc-400">
                    {subStatus.cancelAtPeriodEnd ? 'Ends'
                      : subStatus.trial ? 'Trial ends'
                      : subStatus.billed ? 'Renews' : 'Active until'}
                  </span>
                  <span className="text-sm text-white">
                    {formatDate(subStatus.expiryDate) || '—'}
                  </span>
                </div>
              )}
              {subStatus.seats != null && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-zinc-400">Seats</span>
                  <span className="text-sm text-white">{subStatus.seats}</span>
                </div>
              )}
              {subStatus.status === 'active' && subStatus.plan !== 'free' && !subStatus.trial && !subStatus.viaTeam
                && (subStatus.billed || subStatus.cancelAtPeriodEnd) && (
                <div className="flex flex-wrap gap-3 border-t border-[var(--color-surface-border)] pt-4">
                  {/* Stripe's own portal handles cards, invoices and receipts —
                      things we deliberately never store ourselves. A plan with
                      no Stripe subscription has none of those to show. */}
                  {subStatus.billed && (
                    <Button variant="ghost" onClick={handlePortal} disabled={portalBusy}>
                      {portalBusy ? 'Opening…' : 'Manage billing & invoices'}
                    </Button>
                  )}
                  {subStatus.cancelAtPeriodEnd ? (
                    <Button onClick={handleResume} disabled={cancelling}>
                      {cancelling ? 'Resuming…' : 'Resume subscription'}
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      onClick={handleCancel}
                      disabled={cancelling}
                      className="border-red-500/30 text-red-300 hover:border-red-500/60"
                    >
                      {cancelling ? 'Cancelling…' : 'Cancel subscription'}
                    </Button>
                  )}
                </div>
              )}
              {subStatus.status === 'active' && subStatus.plan !== 'free' && !subStatus.trial && !subStatus.viaTeam
                && !subStatus.billed && !subStatus.cancelAtPeriodEnd && (
                <p className="border-t border-[var(--color-surface-border)] pt-4 text-xs leading-6 text-slate-500">
                  This plan is not billed: it was added to your account without a payment, so
                  nothing renews and there is nothing to cancel. It stays active until{' '}
                  {formatDate(subStatus.expiryDate) || 'its end date'}.
                </p>
              )}
              {subStatus.cancelAtPeriodEnd && (
                <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs leading-6 text-amber-200">
                  Your {subStatus.plan} plan is set to end on{' '}
                  {formatDate(subStatus.expiryDate) || 'its renewal date'}.
                  Everything keeps working until then, and your account returns to Free afterwards —
                  nothing is deleted. Change your mind any time before that.
                </p>
              )}
            </div>
          ) : (
            <p className="mt-4 text-sm text-zinc-500">No active subscription.</p>
          )}
          {subStatus?.viaTeam && (
            <p className="mt-4 border-t border-[var(--color-surface-border)] pt-4 text-xs leading-6 text-slate-500">
              This plan comes from{' '}
              <span className="font-medium text-slate-300">{subStatus.teamOwner || 'the team'}</span>&rsquo;s
              Team subscription, so there is nothing to pay or cancel here. Leaving the team, from your{' '}
              <Link to="/dashboard" className="text-slate-300 hover:text-brand-300">dashboard</Link>, returns
              this account to its own plan.
            </p>
          )}
          {subStatus?.plan === 'free' && !subStatus?.viaTeam && (
            <p className="mt-4 border-t border-[var(--color-surface-border)] pt-4 text-xs leading-6 text-slate-500">
              The free plan never expires and has nothing to cancel.{' '}
              <Link to="/pricing" className="text-slate-300 hover:text-brand-300">See what Pro adds</Link>.
            </p>
          )}
          {subStatus?.trial && (
            <div className="mt-4 border-t border-[var(--color-surface-border)] pt-4">
              <p className="text-xs leading-6 text-slate-500">
                You are on the free Pro trial — nothing is billed and nothing renews; it simply ends on{' '}
                {formatDate(subStatus.trialEndsAt || subStatus.expiryDate) || 'its last day'}. You can stop it
                sooner, but it cannot be started again.
              </p>
              <div className="mt-3">
                <Button
                  variant="ghost"
                  onClick={handleEndTrial}
                  disabled={cancelling}
                  className="border-red-500/30 text-red-300 hover:border-red-500/60"
                  data-testid="end-trial"
                >
                  {cancelling ? 'Ending…' : 'End trial now'}
                </Button>
              </div>
            </div>
          )}
        </Card>

        <Card className="card-hover !p-7">
          <h3 className="text-lg font-bold text-white">Payment history</h3>
          {!loaded ? (
            <PaymentsSkeleton />
          ) : payments.length === 0 ? (
            <div className={`flex flex-col items-center justify-center gap-3 py-12 text-center ${arrive}`.trim()}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="text-slate-600" aria-hidden="true">
                <rect x="2" y="5" width="20" height="14" rx="2" />
                <path d="M2 10h20" />
              </svg>
              <p className="text-sm font-semibold text-slate-300">No payments yet</p>
              <p className="max-w-xs text-sm leading-6 text-slate-500">
                A free plan and the Pro trial are never charged. Once you pay for a plan,
                your most recent payments show up here.
              </p>
            </div>
          ) : (
            <ScrollRegion className={`mt-4 ${arrive}`.trim()} label="Payment history — scrolls sideways">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-[var(--color-surface-border)] text-xs text-zinc-500 uppercase">
                    <th className="pb-2 pr-4 font-medium">Date</th>
                    <th className="pb-2 pr-4 font-medium">Plan</th>
                    <th className="pb-2 pr-4 font-medium">Amount</th>
                    <th className="pb-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p, i) => (
                    <PaymentRow key={p.id || i} payment={p} />
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          )}
        </Card>
      </div>
    </Section>
  );
}
