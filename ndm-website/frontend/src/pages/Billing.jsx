import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import api, { unwrap } from '../api/client';
import { useToast } from '../components/Toast';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Spinner from '../components/Spinner';

function PaymentRow({ payment }) {
  return (
    <tr className="border-b border-white/10 last:border-0">
      <td className="py-3 pr-4 text-sm text-slate-200">
        {new Date(payment.createdAt || payment.created_at).toLocaleDateString()}
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
  const toast = useToast();
  const [payments, setPayments] = useState([]);
  const [subStatus, setSubStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
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

  const handleCancel = async () => {
    if (!confirm('Are you sure you want to cancel your subscription?')) return;
    setCancelling(true);
    try {
      await api.post('/subscription/cancel');
      toast.success('Subscription cancelled.');
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

  if (loading) return <Spinner center />;

  return (
    <Section>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-4xl font-extrabold tracking-tight text-white">Keep your <span className="text-gradient">flow moving.</span></h1>
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
          <h3 className="text-lg font-bold text-white">Current Plan</h3>
          {subStatus ? (
            <div className="mt-4 space-y-3">
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
                    subStatus.status === 'active'
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : 'bg-amber-500/15 text-amber-300'
                  }`}
                >
                  {subStatus.status}
                </span>
              </div>
              {subStatus.expiryDate && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-zinc-400">Expires</span>
                  <span className="text-sm text-white">
                    {new Date(subStatus.expiryDate).toLocaleDateString()}
                  </span>
                </div>
              )}
              {subStatus.seats != null && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-zinc-400">Seats</span>
                  <span className="text-sm text-white">{subStatus.seats}</span>
                </div>
              )}
              {subStatus.status === 'active' && (
                <div className="border-t border-[var(--color-surface-border)] pt-4">
                  <Button
                    variant="ghost"
                    onClick={handleCancel}
                    disabled={cancelling}
                    className="border-red-500/30 text-red-300 hover:border-red-500/60"
                  >
                    {cancelling ? 'Cancelling…' : 'Cancel Subscription'}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <p className="mt-4 text-sm text-zinc-500">No active subscription.</p>
          )}
        </Card>

        <Card className="card-hover !p-7">
          <h3 className="text-lg font-bold text-white">Payment History</h3>
          {payments.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500">No payments yet.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
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
            </div>
          )}
        </Card>
      </div>
    </Section>
  );
}
