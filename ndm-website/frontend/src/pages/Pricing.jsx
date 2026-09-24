import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api, { unwrap } from '../api/client';
import { startTrial } from '../api/trial';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import { lastRead, readPublic } from '../api/reads';
import { isBillingOpen } from '../hooks/useBillingOpen';
import Skeleton, { useArrival } from '../components/Skeleton';

const CYCLE = { monthly: 'per month', yearly: 'per year' };

/** "pro" -> "Pro". Plan names are proper nouns in the UI. */
function planLabel(id) {
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : 'your plan';
}

/**
 * A plan the visitor cannot act on states its status; it does not render a
 * dead button. "Current plan" as a disabled .btn-primary was the loudest
 * element in the table and did nothing when clicked.
 */
function PlanState({ label, current }) {
  return (
    <p className={`flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-2)] border px-4 text-sm font-semibold ${
      current
        ? 'border-brand-400/35 bg-brand-400/10 text-brand-300'
        : 'border-[var(--color-surface-border)] text-slate-400'
    }`}>
      {current && (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      )}
      {label}
    </p>
  );
}

/**
 * Decide what the plan's button should say and do, based on who is looking.
 * Returns { label, action: 'register' | 'trial' | 'checkout' | 'none', to?, disabled }.
 */
function resolveCta(plan, user, billingOpen = true) {
  const sub = user?.subscription;
  const currentPlan = sub?.plan || (user ? 'free' : null);
  const trialUsed = Boolean(sub?.trialEndsAt);
  const onTrial = Boolean(sub?.trial);

  if (plan.id === 'free') {
    if (!user) return { label: 'Get started free', action: 'link', to: '/register' };
    if (currentPlan === 'free') return { label: 'Current plan', action: 'none', current: true };
    return { label: `Included in ${planLabel(currentPlan)}`, action: 'none' };
  }

  if (plan.id === 'pro') {
    if (!user) return { label: 'Start 7-day free trial', action: 'link', to: '/register?trial=1' };
    // Team includes everything Pro has, so a Team member (or owner) is never
    // shown a trial or an upgrade for it.
    if (currentPlan === 'team') return { label: 'Included in Team', action: 'none' };
    if (currentPlan === 'pro' && !onTrial) return { label: 'Current plan', action: 'none', current: true };
    if (currentPlan === 'free' && !trialUsed) return { label: 'Start 7-day free trial', action: 'trial' };
    // Nothing can be bought until Stripe is configured on the server; say so on
    // the button rather than after a click (the API answers 503 either way).
    if (!billingOpen) return { label: 'Paid plans coming soon', action: 'none' };
    if (currentPlan === 'pro' && onTrial) return { label: 'Keep Pro after trial', action: 'checkout' };
    return { label: 'Upgrade to Pro', action: 'checkout' };
  }

  // team
  if (currentPlan === 'team') return { label: 'Current plan', action: 'none', current: true };
  if (!billingOpen) return { label: 'Coming soon', action: 'none' };
  if (!user) return { label: 'Get Team', action: 'link', to: '/register' };
  return { label: 'Get Team', action: 'checkout' };
}

function PlanCard({ plan, billingCycle, user, onCheckout, onTrial, busy, billingOpen }) {
  const price =
    billingCycle === 'yearly' ? plan.yearly || plan.price : plan.monthly || plan.price;
  const isFree = price === 0;
  const cta = resolveCta(plan, user, billingOpen);
  const highlight = plan.id === 'pro';

  const handleClick = () => {
    if (cta.action === 'checkout') onCheckout(plan.id);
    else if (cta.action === 'trial') onTrial();
  };

  const buttonProps =
    cta.action === 'link' ? { to: cta.to } : { onClick: handleClick, disabled: busy };

  return (
    <Card className={`relative flex flex-col !p-7 ${highlight ? '!overflow-visible border-accent-400/60 shadow-[0_0_44px_-16px_rgba(150,92,244,0.72)]' : ''}`}>
      {highlight && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full border border-white/20 on-brand px-4 py-1 text-xs font-bold uppercase tracking-[0.12em] shadow-[0_8px_18px_-8px_rgba(150,92,244,0.9)]">
          Most popular
        </span>
      )}
      <h3 className="text-lg font-bold text-white capitalize">{plan.name}</h3>
      <div className="mt-4">
        <span className="text-4xl font-extrabold text-white">
          {isFree ? 'Free' : `$${price}`}
        </span>
        {!isFree && (
          <span className="ml-1 text-sm text-zinc-400">
            {CYCLE[billingCycle]}
          </span>
        )}
      </div>
      <ul className="mt-7 flex-1 space-y-3">
        {plan.features.map((f, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
            <svg className="mt-0.5 h-4 w-4 shrink-0 text-brand-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            <span>{f}</span>
          </li>
        ))}
      </ul>
      <div className="mt-7">
        {cta.action === 'none' ? (
          <PlanState label={cta.label} current={cta.current} />
        ) : (
          <Button
            className="w-full"
            variant={highlight ? 'primary' : 'ghost'}
            {...buttonProps}
          >
            {cta.label}
          </Button>
        )}
        {plan.id === 'pro' && user?.subscription?.trial && (
          <p className="mt-2 text-center text-xs text-slate-500">
            You&apos;re on the Pro trial — pick a billing cycle to keep it.
          </p>
        )}
      </div>
    </Card>
  );
}

/**
 * What the page is about to become: the billing toggle, then three plan cards
 * in the same grid at roughly the height they land at. The spinner this
 * replaces was one line tall and centred, so the plans arriving pushed the
 * page down by about 600px and threw away the reader's place.
 */
function PricingSkeleton() {
  return (
    <div role="status" aria-label="Loading the plans">
      <div className="mt-8 flex justify-center">
        <Skeleton className="h-12 w-60 rounded-xl" />
      </div>
      <div className="mx-auto mt-6 flex max-w-md gap-2">
        <Skeleton className="h-11 flex-1 rounded-[var(--radius-2)]" />
        <Skeleton className="h-11 w-24 rounded-[var(--radius-2)]" />
      </div>
      <div className="mt-12 grid gap-6 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Card key={i} className="flex flex-col !p-7">
            <Skeleton className="h-6 w-24 rounded" />
            <Skeleton className="mt-4 h-10 w-36 rounded-lg" />
            <div className="mt-7 flex-1 space-y-3">
              {[0, 1, 2, 3, 4, 5].map((j) => (
                <Skeleton key={j} className={`h-4 rounded ${j % 3 === 2 ? 'w-3/5' : 'w-full'}`} />
              ))}
            </div>
            <Skeleton className="mt-7 h-11 w-full rounded-[var(--radius-2)]" />
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function Pricing() {
  usePageMeta({
    title: 'Pricing',
    description:
      'Nexa Download Manager is free forever for up to 3 concurrent downloads. Pro is $5/month or $45/year and every account gets a 7-day Pro trial with no card required.',
  });

  const { user, isAuthenticated, refreshMe } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  // A revisit starts from the last answer (api/reads.js) and asks again underneath.
  const [plans, setPlans] = useState(() => lastRead('/subscription/plans') ?? null);
  // 'live' | 'mock' | 'disabled' — from /subscription/plans.
  const billingOpen = isBillingOpen(plans);
  const [billingCycle, setBillingCycle] = useState('yearly');
  const [loading, setLoading] = useState(() => lastRead('/subscription/plans') === undefined);
  const arrive = useArrival(loading);
  const [checking, setChecking] = useState(false);
  const [coupon, setCoupon] = useState('');
  const [couponState, setCouponState] = useState({ status: 'idle', message: '' });
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    readPublic('/subscription/plans')
      .then((data) => {
        if (!cancelled) setPlans(data);
      })
      .catch(() => {
        if (!cancelled && lastRead('/subscription/plans') === undefined) setError('Failed to load plans.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Check the code before checkout so the price shown is the price charged.
  const handleApplyCoupon = async (event) => {
    event.preventDefault();
    const code = coupon.trim();
    if (!code) return;
    setCouponState({ status: 'checking', message: '' });
    try {
      const data = unwrap(await api.post('/subscription/coupon', { couponCode: code }));
      const off = data.percentOff
        ? `${data.percentOff}% off`
        : data.amountOff
          ? `$${data.amountOff} off`
          : 'discount applied';
      setCouponState({ status: 'valid', message: `${data.code} — ${off}` });
    } catch (err) {
      setCouponState({
        status: 'invalid',
        message: err?.response?.data?.error?.message || 'That code is not valid.',
      });
    }
  };

  const handleCheckout = async (planId) => {
    if (!isAuthenticated) {
      navigate('/login?next=/pricing');
      return;
    }
    setError('');
    setChecking(true);
    try {
      const res = await api.post('/subscription/checkout', {
        plan: planId,
        billingCycle,
        ...(coupon.trim() ? { couponCode: coupon.trim() } : {}),
      });
      const data = unwrap(res);
      if (data?.url) {
        window.location.href = data.url;
      } else {
        toast.success('Subscription updated! Check your billing page.');
        navigate('/billing');
      }
    } catch (err) {
      const msg =
        err?.response?.data?.error?.message ||
        err?.message ||
        'Checkout failed.';
      setError(msg);
    } finally {
      setChecking(false);
    }
  };

  const handleTrial = async () => {
    if (!isAuthenticated) {
      navigate('/register?trial=1');
      return;
    }
    setError('');
    setChecking(true);
    try {
      const result = await startTrial();
      if (result.started) {
        toast.success('Your 7-day Pro trial has started.');
      } else {
        toast.info('This account has already used its Pro trial.');
      }
      await refreshMe();
      navigate('/dashboard');
    } catch (err) {
      const msg =
        err?.response?.data?.error?.message ||
        err?.message ||
        'Could not start the trial.';
      setError(msg);
    } finally {
      setChecking(false);
    }
  };

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />Simple by design</span>
        <h1 className="mt-5 text-white">More speed. <span className="text-gradient">No surprises.</span></h1>
        <p>Start free, upgrade when your workflow needs more power, and stay in control of every transfer.</p>
      </div>

      {loading ? (
        <PricingSkeleton />
      ) : error && !plans ? (
        <div className="mt-10 text-center">
          <p className="text-red-300">{error}</p>
        </div>
      ) : plans ? (
        <div className={arrive || undefined}>
          <div className="mt-8 flex justify-center">
            <div className="billing-toggle inline-flex rounded-xl border p-1 shadow-[0_16px_35px_-25px_rgba(126,108,255,0.8)]">
              {['monthly', 'yearly'].map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`min-h-11 rounded-lg px-5 py-2 text-sm font-medium transition capitalize ${
                    billingCycle === c
                      ? 'on-brand shadow-[0_8px_18px_-10px_rgba(150,92,244,0.9)]'
                      : 'text-slate-400 hover:text-white'
                  }`}
                  onClick={() => setBillingCycle(c)}
                >
                  {c}
                  {/* No text-white on the active chip: the light theme redefines
                      --color-white to near-black ("strongest text"), so on a
                      brand-coloured surface that utility paints the opposite of
                      what it says. .on-brand already sets #fff — inherit it. */}
                  {c === 'yearly' && plans.pro?.monthly && plans.pro?.yearly && (
                    <span className={`ml-1.5 rounded px-1.5 py-0.5 text-xs ${
                      billingCycle === c ? 'bg-black/20' : 'bg-brand-400/15 text-brand-300'
                    }`}>
                      Save {Math.round(((plans.pro.monthly * 12 - plans.pro.yearly) / (plans.pro.monthly * 12)) * 100)}%
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div className="mx-auto mt-6 max-w-md rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-center text-sm text-red-300">
              {error}
            </div>
          )}

          {/* The promo field's slot, so the toggle above stays where the
              outline drew it. With billing off there is no checkout for a
              code to apply to; the slot says so instead, BEFORE the prices —
              it used to be a 12px footnote under the cards, reached only after
              a reader had flipped the cycle and tried a code. */}
          {!billingOpen && (
            <div role="note" className="note-warn mx-auto mt-6 max-w-2xl rounded-xl px-4 py-3 text-sm leading-6">
              <p className="font-bold">Paid plans are not on sale yet.</p>
              <p className="mt-1">
                Every account can start the 7-day Pro trial with no card. Beyond that, nothing on
                this page can be bought yet and nobody is charged — the prices below are what Pro
                and Team will cost when payments open.
              </p>
            </div>
          )}
          {billingOpen && (
            <form onSubmit={handleApplyCoupon} className="mx-auto mt-6 flex max-w-md items-center gap-2">
              <label htmlFor="coupon" className="sr-only">Promotion code</label>
              <input
                id="coupon"
                value={coupon}
                onChange={(e) => {
                  setCoupon(e.target.value);
                  setCouponState({ status: 'idle', message: '' });
                }}
                placeholder="Promotion code (optional)"
                autoComplete="off"
                className="input-field flex-1"
              />
              <Button
                type="submit"
                variant="ghost"
                disabled={!coupon.trim() || couponState.status === 'checking'}
              >
                {couponState.status === 'checking' ? 'Checking…' : 'Apply'}
              </Button>
            </form>
          )}
          {billingOpen && couponState.message && (
            <p
              role="status"
              className={`mx-auto mt-2 max-w-md text-center text-sm ${
                couponState.status === 'valid' ? 'text-emerald-300' : 'text-red-300'
              }`}
            >
              {couponState.message}
            </p>
          )}

          <div data-stagger className="mt-12 grid gap-6 md:grid-cols-3">
            {['free', 'pro', 'team'].filter((id) => plans[id]).map((id) => (
              <PlanCard
                key={id}
                plan={plans[id]}
                billingCycle={billingCycle}
                user={user}
                onCheckout={handleCheckout}
                onTrial={handleTrial}
                busy={checking}
                billingOpen={billingOpen}
              />
            ))}
          </div>

          {billingOpen && (
            <p className="mx-auto mt-8 max-w-lg text-center text-xs leading-6 text-zinc-500">
              Every account gets a 7-day Pro trial — no card needed. Payment
              processing is handled securely by Stripe. Cancel anytime from your
              billing dashboard; refunds within 14 days of a charge, see the{' '}
              <a href="/terms" className="text-slate-300 hover:text-brand-300">terms</a>.
            </p>
          )}
        </div>
      ) : null}
    </Section>
  );
}
