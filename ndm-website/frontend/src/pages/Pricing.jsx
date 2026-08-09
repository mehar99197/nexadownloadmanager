import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api, { unwrap } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Spinner from '../components/Spinner';

const CYCLE = { monthly: 'per month', yearly: 'per year' };

function PlanCard({ plan, billingCycle, onSelect, loading }) {
  const price =
    billingCycle === 'yearly' ? plan.yearly || plan.price : plan.monthly || plan.price;
  const isFree = price === 0;

  return (
    <Card className={`relative flex flex-col !p-7 ${plan.id === 'pro' ? 'border-accent-400/60 shadow-[0_0_44px_-16px_rgba(150,92,244,0.72)]' : ''}`}>
      {plan.id === 'pro' && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full border border-white/20 bg-gradient-to-r from-accent-500 to-brand-500 px-4 py-1 text-[0.65rem] font-bold uppercase tracking-[0.12em] text-white shadow-[0_8px_18px_-8px_rgba(150,92,244,0.9)]">
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
        <Button
          className="w-full"
          variant={plan.id === 'pro' ? 'primary' : 'ghost'}
          disabled={loading || isFree}
          onClick={() => onSelect(plan.id)}
        >
          {isFree ? 'Current Plan' : plan.id === 'pro' ? 'Upgrade to Pro' : 'Get Team'}
        </Button>
      </div>
    </Card>
  );
}

export default function Pricing() {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [plans, setPlans] = useState(null);
  const [billingCycle, setBillingCycle] = useState('yearly');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      setLoading(true);
      try {
        const res = await api.get('/subscription/plans');
        if (!cancelled) setPlans(unwrap(res));
      } catch {
        if (!cancelled) setError('Failed to load plans.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetch();
    return () => { cancelled = true; };
  }, []);

  const handleSelect = async (planId) => {
    if (!isAuthenticated) {
      navigate('/login?next=/pricing');
      return;
    }
    if (planId === 'free') return;

    setError('');
    setChecking(true);
    try {
      const res = await api.post('/subscription/checkout', {
        plan: planId,
        billingCycle,
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

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />Simple by design</span>
        <h1 className="mt-5 text-white">More speed. <span className="text-gradient">No surprises.</span></h1>
        <p>Start free, upgrade when your workflow needs more power, and stay in control of every transfer.</p>
      </div>

      {loading ? (
        <Spinner center />
      ) : error && !plans ? (
        <div className="mt-10 text-center">
          <p className="text-red-300">{error}</p>
        </div>
      ) : plans ? (
        <>
          <div className="mt-8 flex justify-center">
            <div className="inline-flex rounded-xl border border-[rgba(93,117,170,0.4)] bg-[rgba(17,24,39,0.82)] p-1 shadow-[0_16px_35px_-25px_rgba(126,108,255,0.8)]">
              {['monthly', 'yearly'].map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`rounded-lg px-5 py-2 text-sm font-medium transition capitalize ${
                    billingCycle === c
                      ? 'bg-gradient-to-r from-accent-500 to-brand-500 text-white shadow-[0_8px_18px_-10px_rgba(150,92,244,0.9)]'
                      : 'text-slate-400 hover:text-white'
                  }`}
                  onClick={() => setBillingCycle(c)}
                >
                  {c}
                  {c === 'yearly' && (
                    <span className="ml-1.5 rounded bg-brand-400/15 px-1.5 py-0.5 text-[11px] text-brand-300">
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

          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {['free', 'pro', 'team'].map((id) => (
              <PlanCard
                key={id}
                plan={plans[id]}
                billingCycle={billingCycle}
                onSelect={handleSelect}
                loading={checking}
              />
            ))}
          </div>

          <p className="mx-auto mt-8 max-w-lg text-center text-xs text-zinc-500">
            All plans include a 7-day free trial of Pro features. Payment
            processing is handled securely by Stripe. You can cancel anytime
            from your billing dashboard.
          </p>
        </>
      ) : null}
    </Section>
  );
}
