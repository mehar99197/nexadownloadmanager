import { useCallback, useEffect, useState } from 'react';
import api, { unwrap } from '../api/client.js';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import DataTable from '../components/DataTable.jsx';
import Pagination from '../components/Pagination.jsx';
import Badge from '../components/Badge.jsx';
import Button from '../components/Button.jsx';
import Input from '../components/Input.jsx';
import Modal from '../components/Modal.jsx';
import { SkeletonText } from '../components/Skeleton.jsx';
import { downloadCsv, formatDate } from '../utils.js';

const LIMIT = 12;
const EMPTY_CREATE = { userId: '', plan: 'free', status: 'active', seats: 1 };

function errorMessage(err, fallback) {
  return err?.response?.data?.error?.message || err?.message || fallback;
}

/**
 * A stored expiry as <input type="datetime-local"> wants it (local time, no
 * zone, minute precision) — and back again as the ISO instant the API takes.
 * The free plan's expiry sits ~100 years out, which the input renders fine.
 */
function toLocalInput(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export default function Subscriptions() {
  const confirm = useConfirm();
  const [data, setData] = useState({ subscriptions: [], totalCount: 0 });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [plan, setPlan] = useState('');
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ plan: 'free', status: 'active', seats: 1, expiryDate: '' });
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(EMPTY_CREATE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadSubscriptions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await unwrap(api.get('/admin/subscriptions', { params: { page, limit: LIMIT, q: query || undefined, status: status || undefined, plan: plan || undefined } }));
      setData(result || { subscriptions: [], totalCount: 0 });
    } catch (err) {
      setError(errorMessage(err, 'Unable to load subscriptions.'));
    } finally {
      setLoading(false);
    }
  }, [page, plan, query, status]);

  useEffect(() => { loadSubscriptions(); }, [loadSubscriptions]);

  const openEditor = (subscription) => {
    setEditing(subscription);
    setForm({
      plan: subscription.plan, status: subscription.status, seats: subscription.seats || 1,
      expiryDate: toLocalInput(subscription.expiry_date),
    });
  };

  const saveSubscription = async () => {
    setSaving(true);
    setError('');
    try {
      // Only what the admin changed. Sending every field on every save ended a
      // trial when just its expiry was corrected, and left a Pro -> Team
      // change on Pro's one seat because the seat count was always "set".
      const changes = {};
      if (form.plan !== editing.plan) changes.plan = form.plan;
      if (form.status !== editing.status) changes.status = form.status;
      if (Number(form.seats) !== Number(editing.seats || 1)) changes.seats = Number(form.seats);
      // Absent leaves the date to the server; present overrides everything,
      // including the date a plan change would otherwise imply.
      const changedExpiry = form.expiryDate !== toLocalInput(editing.expiry_date)
        ? fromLocalInput(form.expiryDate) : null;
      if (changedExpiry) changes.expiryDate = changedExpiry;
      // Nothing changed is nothing to send (the API refuses an empty edit).
      if (Object.keys(changes).length) await unwrap(api.put(`/admin/subscriptions/${editing.id}`, changes));
      setEditing(null);
      await loadSubscriptions();
    } catch (err) {
      setError(errorMessage(err, 'Unable to update subscription.'));
    } finally {
      setSaving(false);
    }
  };

  const createSubscription = async () => {
    setSaving(true);
    setError('');
    try {
      await unwrap(api.post('/admin/subscriptions', { ...createForm, userId: Number(createForm.userId), seats: Number(createForm.seats) }));
      setCreateOpen(false);
      setCreateForm(EMPTY_CREATE);
      await loadSubscriptions();
    } catch (err) {
      setError(errorMessage(err, 'Unable to create subscription.'));
    } finally {
      setSaving(false);
    }
  };

  const revokeDevice = async (subscription) => {
    const sure = await confirm({
      title: `Free every seat on ${subscription.userEmail}'s licence?`,
      message: 'Machines currently using it drop to Free until they re-validate. Nothing is blacklisted — the same devices can take a seat again.',
      confirmLabel: 'Free seats',
      danger: true,
    });
    if (!sure) return;
    try {
      await unwrap(api.post(`/admin/subscriptions/${subscription.id}/revoke-device`));
      await loadSubscriptions();
    } catch (err) {
      setError(errorMessage(err, 'Unable to free the seats.'));
    }
  };

  const exportSubscriptions = async () => {
    try {
      const rows = await unwrap(api.get('/admin/subscriptions/export', { params: { q: query || undefined, status: status || undefined, plan: plan || undefined } }));
      downloadCsv('nexa-subscriptions.csv', rows || [], [
        { label: 'ID', value: (row) => row.id },
        { label: 'User', value: (row) => row.userName },
        { label: 'Email', value: (row) => row.userEmail },
        { label: 'Plan', value: (row) => row.plan },
        { label: 'Status', value: (row) => row.status },
        { label: 'Seats', value: (row) => row.seats },
        { label: 'License', value: (row) => row.license_key },
        { label: 'Expires', value: (row) => row.expiry_date },
      ]);
    } catch (err) {
      setError(errorMessage(err, 'Unable to export subscriptions.'));
    }
  };

  const columns = [
    { key: 'subscriber', header: 'Subscriber', render: (subscription) => <div><p className="font-semibold text-admin-text">{subscription.userName || 'Unknown user'}</p><p className="mt-0.5 text-xs text-admin-faint">{subscription.userEmail}</p></div> },
    { key: 'plan', header: 'Plan', render: (subscription) => <Badge tone={subscription.plan === 'free' ? 'default' : 'info'}>{subscription.plan}</Badge> },
    { key: 'status', header: 'Status', render: (subscription) => <Badge status={subscription.status} /> },
    { key: 'seats', header: 'Seats' },
    { key: 'license', header: 'License', render: (subscription) => <span className="font-mono text-xs text-admin-muted">{subscription.license_key}</span> },
    { key: 'started', header: 'Started', render: (subscription) => formatDate(subscription.start_date) },
    { key: 'expires', header: 'Expires', render: (subscription) => formatDate(subscription.expiry_date) },
    { key: 'actions', header: '', className: 'text-right', render: (subscription) => <div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => revokeDevice(subscription)}>Free seats</Button><Button variant="secondary" size="sm" onClick={() => openEditor(subscription)}>Manage</Button></div> },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between"><div><p className="admin-eyebrow text-admin-cyan">Revenue & licenses</p><h2 className="mt-2 text-3xl font-extrabold tracking-tight text-admin-text">Subscriptions</h2><p className="mt-2 max-w-2xl text-sm text-admin-muted">Search billing records, change access, free a licence's seats, issue a manual license, or export the full catalog.</p></div><div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={exportSubscriptions}>Export CSV</Button><Button onClick={() => setCreateOpen(true)}>Issue subscription</Button></div></div>
      <div className="admin-card grid gap-3 lg:grid-cols-[1.5fr_0.7fr_0.7fr_auto_auto] lg:items-end"><form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); setPage(1); setQuery(search.trim()); }}><Input aria-label="Search subscriptions" name="subscriptionSearch" label="Search" placeholder="Name or email" value={search} onChange={(event) => setSearch(event.target.value)} /><Button type="submit" variant="secondary">Search</Button></form><label className="block"><span className="admin-label">Plan</span><select className="admin-input" value={plan} onChange={(event) => { setPlan(event.target.value); setPage(1); }}><option value="">All plans</option><option value="free">Free</option><option value="pro">Pro</option><option value="team">Team</option></select></label><label className="block"><span className="admin-label">Status</span><select className="admin-input" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option><option value="active">Active</option><option value="expired">Expired</option><option value="cancelled">Cancelled</option></select></label><Button variant="ghost" onClick={() => { setSearch(''); setQuery(''); setPlan(''); setStatus(''); setPage(1); }}>Clear</Button><Button variant="ghost" onClick={loadSubscriptions} disabled={loading}>Refresh</Button></div>
      {error && <div className="rounded-xl border border-admin-danger/30 bg-admin-danger/10 px-4 py-3 text-sm text-admin-danger">{error}</div>}
      <div className="admin-card !p-0"><div className="border-b border-admin-border px-5 py-4"><p className="text-sm text-admin-muted"><span className="font-bold text-admin-text">{loading ? <SkeletonText chars={3} /> : data.totalCount}</span> matching subscriptions</p></div><DataTable columns={columns} rows={data.subscriptions} loading={loading} emptyMessage="No subscriptions match these filters." caption="Subscriptions matching the current filters" /></div>
      <Pagination page={page} totalPages={Math.ceil((data.totalCount || 0) / LIMIT)} onPageChange={setPage} />

      <Modal open={Boolean(editing)} onClose={() => !saving && setEditing(null)} title="Manage subscription" footer={(<><Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>Cancel</Button><Button onClick={saveSubscription} disabled={saving}>{saving ? 'Saving...' : 'Save changes'}</Button></>)}>{editing && <div className="space-y-5"><div className="rounded-xl border border-admin-border bg-admin-surface-2/60 p-4"><p className="font-semibold text-admin-text">{editing.userName}</p><p className="mt-1 text-xs text-admin-muted">{editing.userEmail} / license {editing.license_key}</p></div><label className="block"><span className="admin-label">Plan</span><select className="admin-input" value={form.plan} onChange={(event) => setForm((current) => ({ ...current, plan: event.target.value }))}><option value="free">Free</option><option value="pro">Pro</option><option value="team">Team</option></select></label><label className="block"><span className="admin-label">Status</span><select className="admin-input" value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value }))}><option value="active">Active</option><option value="expired">Expired</option><option value="cancelled">Cancelled</option></select></label><label className="block"><span className="admin-label">Seats</span><input className="admin-input" type="number" min="1" max="100" value={form.seats} onChange={(event) => setForm((current) => ({ ...current, seats: event.target.value }))} /></label><label className="block"><span className="admin-label">Expires</span><input className="admin-input" type="datetime-local" value={form.expiryDate} onChange={(event) => setForm((current) => ({ ...current, expiryDate: event.target.value }))} /><span className="mt-1 block text-xs text-admin-faint">When the paid period ends. A few days after this the account falls back to Free on its own — it is not an instant cut-off, so use Status for that. Leave it alone to let a plan change set it; edit it to extend a customer whose renewal did not land.</span></label></div>}</Modal>
      <Modal open={createOpen} onClose={() => !saving && setCreateOpen(false)} title="Issue manual subscription" footer={(<><Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={saving}>Cancel</Button><Button onClick={createSubscription} disabled={saving || !createForm.userId}>{saving ? 'Issuing...' : 'Issue license'}</Button></>)}><div className="space-y-4"><Input label="User ID" name="subscriptionUserId" type="number" min="1" placeholder="Find the ID in Users" value={createForm.userId} onChange={(event) => setCreateForm((current) => ({ ...current, userId: event.target.value }))} /><div className="grid gap-4 sm:grid-cols-3"><label className="block"><span className="admin-label">Plan</span><select className="admin-input" value={createForm.plan} onChange={(event) => setCreateForm((current) => ({ ...current, plan: event.target.value }))}><option value="free">Free</option><option value="pro">Pro</option><option value="team">Team</option></select></label><label className="block"><span className="admin-label">Status</span><select className="admin-input" value={createForm.status} onChange={(event) => setCreateForm((current) => ({ ...current, status: event.target.value }))}><option value="active">Active</option><option value="expired">Expired</option><option value="cancelled">Cancelled</option></select></label><label className="block"><span className="admin-label">Seats</span><input className="admin-input" type="number" min="1" max="100" value={createForm.seats} onChange={(event) => setCreateForm((current) => ({ ...current, seats: event.target.value }))} /></label></div></div></Modal>
    </div>
  );
}
