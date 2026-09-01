import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { unwrap } from '../api/client.js';
import StatCard from '../components/StatCard.jsx';
import BarChart from '../components/BarChart.jsx';
import Badge from '../components/Badge.jsx';
import Button from '../components/Button.jsx';
import { formatDate, formatDateTime, formatMoney } from '../utils.js';

function MetricIcon({ children }) {
  return <span className="text-lg">{children}</span>;
}

function HealthPill({ label, value, tone = 'success' }) {
  const colors = {
    success: 'border-admin-success/25 bg-admin-success/10 text-admin-success',
    warning: 'border-admin-warning/25 bg-admin-warning/10 text-admin-warning',
    info: 'border-admin-cyan/25 bg-admin-cyan/10 text-admin-cyan',
  };
  return <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${colors[tone] || colors.info}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{label}: {value}</span>;
}

function ActivityFeed({ items }) {
  if (!items?.length) return <p className="py-8 text-center text-sm text-admin-muted">No admin activity recorded yet.</p>;
  return <div className="divide-y divide-admin-border/70">{items.map((item) => <div key={item.id} className="flex gap-3 py-3 first:pt-0 last:pb-0"><span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-admin-cyan shadow-[0_0_10px_rgba(53,201,255,0.8)]" /><div className="min-w-0"><p className="text-sm leading-5 text-admin-text">{item.summary}</p><p className="mt-1 text-xs text-admin-faint">{item.admin_name || 'System'} · {formatDateTime(item.created_at)}</p></div></div>)}</div>;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState(null);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextStats, nextHealth] = await Promise.all([
        unwrap(api.get('/admin/stats')),
        unwrap(api.get('/admin/health')),
      ]);
      setStats(nextStats);
      setHealth(nextHealth);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Unable to load dashboard metrics.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  const signupData = (stats?.newSignups || []).slice(-14).map((item) => ({ label: formatDate(item.date, { month: 'short', day: 'numeric' }), value: item.count }));
  const revenueData = (stats?.revenueSeries || []).map((item) => ({ label: item.month?.slice(5) || '-', value: Number(item.revenue) || 0 }));
  const plans = stats?.planDistribution || [];
  const maxPlan = Math.max(...plans.map((item) => Number(item.count) || 0), 1);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div><p className="text-xs font-bold uppercase tracking-[0.18em] text-admin-cyan">Operational overview</p><h2 className="mt-2 text-3xl font-extrabold tracking-tight text-admin-text">Command center</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-admin-muted">A live view of growth, revenue, user health, moderation, releases, and the services powering NexaDownloadManager.</p></div>
        <div className="flex flex-wrap gap-2"><Link to="/users" className="btn-admin-secondary">Manage users</Link><Link to="/releases" className="btn-admin-primary">Publish release</Link><Button variant="secondary" onClick={loadDashboard} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh data'}</Button></div>
      </div>

      {error && <div className="rounded-xl border border-admin-danger/30 bg-admin-danger/10 px-4 py-3 text-sm text-admin-danger">{error}</div>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total users" value={stats?.totalUsers ?? '-'} hint="All registered accounts" icon={<MetricIcon>◉</MetricIcon>} accent="text-admin-cyan" />
        <StatCard label="Active subscriptions" value={stats?.activeSubscriptions ?? '-'} hint="Currently active plans" icon={<MetricIcon>◆</MetricIcon>} accent="text-accent-400" />
        <StatCard label="Monthly recurring revenue" value={formatMoney(stats?.mrr)} hint="Active paid plans" icon={<MetricIcon>$</MetricIcon>} accent="text-admin-success" />
        <StatCard label="Pending reviews" value={stats?.pendingReviews ?? '-'} hint="Waiting for moderation" icon={<MetricIcon>★</MetricIcon>} accent="text-admin-warning" />
      </div>

      <section className="admin-card flex flex-wrap items-center gap-3 !p-4">
        <span className="mr-1 text-xs font-bold uppercase tracking-[0.16em] text-admin-faint">Service health</span>
        <HealthPill label="Database" value={health?.database || 'checking'} />
        <HealthPill label="Stripe" value={health?.stripe || stats?.system?.stripe || 'checking'} tone={health?.stripe === 'mock' ? 'warning' : 'success'} />
        <HealthPill label="Email" value={health?.email || stats?.system?.email || 'checking'} tone={health?.email === 'mock' ? 'warning' : 'success'} />
        <span className="ml-auto text-xs text-admin-faint">{health ? `${health.latencyMs}ms response · ${Math.floor((health.uptimeSeconds || 0) / 60)}m uptime` : 'Connecting...'}</span>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="admin-card"><div className="flex items-start justify-between gap-4"><div><h3 className="text-base font-bold text-admin-text">New signups</h3><p className="mt-1 text-xs text-admin-muted">Daily registrations over the last 30 days.</p></div><span className="rounded-full border border-admin-cyan/20 bg-admin-cyan/10 px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-[0.12em] text-admin-cyan">Growth</span></div><div className="mt-6"><BarChart data={signupData} height={220} barClassName="bg-gradient-to-t from-admin-accent to-admin-cyan" /></div></section>
        <section className="admin-card"><div className="flex items-start justify-between gap-4"><div><h3 className="text-base font-bold text-admin-text">Revenue trend</h3><p className="mt-1 text-xs text-admin-muted">Paid revenue by month for the latest six months.</p></div><span className="rounded-full border border-admin-success/20 bg-admin-success/10 px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-[0.12em] text-admin-success">MRR {formatMoney(stats?.mrr)}</span></div><div className="mt-6"><BarChart data={revenueData} height={220} valueFormatter={formatMoney} barClassName="bg-gradient-to-t from-admin-success to-admin-cyan" /></div></section>
      </div>

      <div className="grid gap-6 xl:grid-cols-[0.82fr_1.18fr]">
        <section className="admin-card"><div className="flex items-start justify-between"><div><h3 className="text-base font-bold text-admin-text">Plan mix</h3><p className="mt-1 text-xs text-admin-muted">Current subscription distribution.</p></div><Link to="/subscriptions" className="text-xs font-semibold text-admin-cyan hover:text-white">Open billing</Link></div><div className="mt-6 space-y-4">{['free', 'pro', 'team'].map((name) => { const row = plans.find((item) => item.plan === name); const count = Number(row?.count || 0); return <div key={name}><div className="flex justify-between text-sm"><span className="font-semibold capitalize text-admin-text">{name}</span><span className="text-admin-muted">{count}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-admin-surface-2"><div className={`h-full rounded-full ${name === 'free' ? 'bg-admin-faint' : name === 'pro' ? 'bg-admin-accent' : 'bg-admin-cyan'}`} style={{ width: `${Math.max(count ? 4 : 0, (count / maxPlan) * 100)}%` }} /></div></div>; })}</div></section>
        <section className="admin-card"><div className="flex items-start justify-between"><div><h3 className="text-base font-bold text-admin-text">Admin activity</h3><p className="mt-1 text-xs text-admin-muted">A traceable history of changes made in the control room.</p></div><Link to="/users" className="text-xs font-semibold text-admin-cyan hover:text-white">Manage access</Link></div><div className="mt-5"><ActivityFeed items={stats?.recentActivity} /></div></section>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
        <section className="admin-card !p-0"><div className="flex items-center justify-between border-b border-admin-border px-5 py-4"><div><h3 className="text-base font-bold text-admin-text">Recent payments</h3><p className="mt-1 text-xs text-admin-muted">Latest billing activity across the platform.</p></div><Link to="/subscriptions" className="text-sm font-semibold text-admin-cyan hover:text-white">View subscriptions</Link></div><div className="overflow-x-auto"><table className="admin-table"><thead><tr><th>User</th><th>Plan</th><th>Amount</th><th>Date</th><th>Status</th></tr></thead><tbody>{(stats?.recentPayments || []).length === 0 ? <tr><td colSpan="5" className="px-4 py-8 text-center text-admin-muted">No payments yet.</td></tr> : stats.recentPayments.map((payment) => <tr key={payment.id}><td><div className="font-medium text-admin-text">{payment.userName || 'Unknown user'}</div><div className="text-xs text-admin-faint">{payment.userEmail}</div></td><td className="capitalize">{payment.plan}</td><td>{payment.currency?.toUpperCase()} {payment.amount}</td><td>{formatDate(payment.created_at)}</td><td><Badge status={payment.status} /></td></tr>)}</tbody></table></div></section>
        <section className="admin-card"><div><h3 className="text-base font-bold text-admin-text">Moderation & publishing</h3><p className="mt-1 text-xs leading-5 text-admin-muted">Keep the public experience fresh without leaving the dashboard.</p></div><div className="mt-5 space-y-3"><Link to="/reviews" className="flex items-center justify-between rounded-xl border border-admin-border bg-admin-surface-2/60 p-4 transition hover:border-admin-warning/50"><span><span className="block text-sm font-semibold text-admin-text">Review queue</span><span className="mt-1 block text-xs text-admin-muted">{stats?.pendingReviews || 0} waiting for approval</span></span><span className="text-admin-warning">-&gt;</span></Link><Link to="/contact" className="flex items-center justify-between rounded-xl border border-admin-border bg-admin-surface-2/60 p-4 transition hover:border-admin-cyan/50"><span><span className="block text-sm font-semibold text-admin-text">Contact inbox</span><span className="mt-1 block text-xs text-admin-muted">{stats?.contact?.awaiting || 0} awaiting a reply · {stats?.contact?.unread || 0} unread</span></span><span className="text-admin-cyan">-&gt;</span></Link><Link to="/releases" className="flex items-center justify-between rounded-xl border border-admin-border bg-admin-surface-2/60 p-4 transition hover:border-admin-cyan/50"><span><span className="block text-sm font-semibold text-admin-text">Release catalog</span><span className="mt-1 block text-xs text-admin-muted">Publish builds and update links</span></span><span className="text-admin-cyan">-&gt;</span></Link></div></section>
      </div>
    </div>
  );
}
