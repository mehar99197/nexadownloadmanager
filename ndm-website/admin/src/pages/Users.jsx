import { useCallback, useEffect, useState } from 'react';
import api, { unwrap } from '../api/client.js';
import DataTable from '../components/DataTable.jsx';
import Pagination from '../components/Pagination.jsx';
import Badge from '../components/Badge.jsx';
import Button from '../components/Button.jsx';
import Input from '../components/Input.jsx';
import Modal from '../components/Modal.jsx';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import { downloadCsv, formatDate } from '../utils.js';

const LIMIT = 12;
// No `role` here: this panel only ever creates ordinary customers. Staff admins
// are minted by the creator at /root/admins, and the API rejects a role field.
const EMPTY_CREATE = { name: '', email: '', password: '', plan: 'free' };

function errorMessage(err, fallback) {
  return err?.response?.data?.error?.message || err?.message || fallback;
}

export default function Users() {
  const confirm = useConfirm();
  const [data, setData] = useState({ users: [], totalCount: 0 });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState({ role: '', banned: '', emailVerified: '' });
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ banned: false, emailVerified: false, plan: 'free' });
  const [details, setDetails] = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(EMPTY_CREATE);
  const [resetTarget, setResetTarget] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  // Deletion is the one action here that destroys data, so it gets its own
  // modal and its own typed confirmation rather than a yes/no dialog.
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page, limit: LIMIT, q: query || undefined };
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params[key] = value;
      });
      const result = await unwrap(api.get('/admin/users', {
        params,
      }));
      setData(result || { users: [], totalCount: 0 });
    } catch (err) {
      setError(errorMessage(err, 'Unable to load users.'));
    } finally {
      setLoading(false);
    }
  }, [filters, page, query]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const openEditor = (user) => {
    setEditing(user);
    setForm({
      banned: Boolean(user.banned),
      emailVerified: Boolean(user.email_verified),
      plan: user.plan || 'free',
    });
  };

  const openDetails = async (user) => {
    setDetails({ user });
    setDetailsLoading(true);
    try {
      setDetails(await unwrap(api.get(`/admin/users/${user.id}/details`)));
    } catch (err) {
      setError(errorMessage(err, 'Unable to load user details.'));
    } finally {
      setDetailsLoading(false);
    }
  };

  const saveUser = async () => {
    setSaving(true);
    setError('');
    try {
      await unwrap(api.put(`/admin/users/${editing.id}`, form));
      setEditing(null);
      await loadUsers();
    } catch (err) {
      setError(errorMessage(err, 'Unable to update user.'));
    } finally {
      setSaving(false);
    }
  };

  const createUser = async () => {
    setSaving(true);
    setError('');
    try {
      await unwrap(api.post('/admin/users', createForm));
      setCreateOpen(false);
      setCreateForm(EMPTY_CREATE);
      await loadUsers();
    } catch (err) {
      setError(errorMessage(err, 'Unable to create user.'));
    } finally {
      setSaving(false);
    }
  };

  const resetUserPassword = async () => {
    if (!resetTarget || resetPassword.length < 8) return;
    setSaving(true);
    setError('');
    try {
      await unwrap(api.post(`/admin/users/${resetTarget.id}/reset-password`, { password: resetPassword }));
      setResetTarget(null);
      setResetPassword('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to reset password.'));
    } finally {
      setSaving(false);
    }
  };

  // The typed address must match exactly — the same guard the creator's Danger
  // Zone uses, and the same one the API enforces independently, so a mis-clicked
  // row cannot erase a customer.
  const deleteMatches = Boolean(deleteTarget)
    && deleteConfirm.trim().toLowerCase() === String(deleteTarget.email).toLowerCase();

  const deleteUser = async () => {
    if (!deleteMatches) return;
    setSaving(true);
    setError('');
    try {
      await unwrap(api.delete(`/admin/users/${deleteTarget.id}`, {
        data: { confirmEmail: deleteConfirm.trim().toLowerCase() },
      }));
      setDeleteTarget(null);
      setDeleteConfirm('');
      setDetails(null);
      await loadUsers();
    } catch (err) {
      setError(errorMessage(err, 'Unable to delete this account.'));
    } finally {
      setSaving(false);
    }
  };

  const revokeSessions = async (user) => {
    const sure = await confirm({
      title: `Revoke all sessions for ${user.email}?`,
      message: 'They are signed out everywhere and must sign in again. Their password is unchanged.',
      confirmLabel: 'Revoke sessions',
      danger: true,
    });
    if (!sure) return;
    try {
      await unwrap(api.post(`/admin/users/${user.id}/revoke-sessions`));
    } catch (err) {
      setError(errorMessage(err, 'Unable to revoke sessions.'));
    }
  };

  const exportUsers = async () => {
    try {
      const params = { q: query || undefined };
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params[key] = value;
      });
      const rows = await unwrap(api.get('/admin/users/export', { params }));
      downloadCsv('nexa-users.csv', rows || [], [
        { label: 'ID', value: (row) => row.id },
        { label: 'Name', value: (row) => row.name },
        { label: 'Email', value: (row) => row.email },
        { label: 'Role', value: (row) => row.role },
        { label: 'Verified', value: (row) => row.email_verified ? 'yes' : 'no' },
        { label: 'Banned', value: (row) => row.banned ? 'yes' : 'no' },
        { label: 'Joined', value: (row) => row.created_at },
      ]);
    } catch (err) {
      setError(errorMessage(err, 'Unable to export users.'));
    }
  };

  const totalPages = Math.ceil((data.totalCount || 0) / LIMIT);
  const columns = [
    { key: 'user', header: 'User', render: (user) => <button type="button" className="text-left" onClick={() => openDetails(user)}><p className="font-semibold text-admin-text hover:text-admin-cyan">{user.name}</p><p className="mt-0.5 text-xs text-admin-faint">{user.email}</p></button> },
    { key: 'role', header: 'Role', render: (user) => <Badge tone={user.role === 'root' ? 'warning' : user.role === 'admin' ? 'info' : 'default'}>{user.role}</Badge> },
    { key: 'plan', header: 'Plan', render: (user) => <Badge tone={user.plan === 'pro' || user.plan === 'team' ? 'info' : 'default'}>{user.plan || 'free'}</Badge> },
    { key: 'status', header: 'Status', render: (user) => <Badge status={user.banned ? 'banned' : 'active'} /> },
    { key: 'verified', header: 'Verified', render: (user) => <Badge tone={user.email_verified ? 'success' : 'warning'}>{user.email_verified ? 'Yes' : 'No'}</Badge> },
    { key: 'created', header: 'Joined', render: (user) => formatDate(user.created_at) },
    { key: 'actions', header: '', className: 'text-right', render: (user) => <div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => openDetails(user)}>Details</Button><Button variant="secondary" size="sm" onClick={() => openEditor(user)}>Manage</Button></div> },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div><p className="text-xs font-bold uppercase tracking-[0.18em] text-admin-cyan">People & access</p><h2 className="mt-2 text-3xl font-extrabold tracking-tight text-admin-text">Users</h2><p className="mt-2 max-w-2xl text-sm text-admin-muted">Search, inspect, provision, secure, and manage every account from one place.</p></div>
        <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={exportUsers}>Export CSV</Button><Button onClick={() => setCreateOpen(true)}>Create user</Button></div>
      </div>

      <div className="admin-card grid gap-3 lg:grid-cols-[1.4fr_repeat(3,0.7fr)_auto] lg:items-end">
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); setPage(1); setQuery(search.trim()); }}><Input aria-label="Search users" name="search" label="Search" placeholder="Name or email" value={search} onChange={(event) => setSearch(event.target.value)} /><Button type="submit" variant="secondary">Search</Button></form>
        <label className="block"><span className="admin-label">Role</span><select className="admin-input" value={filters.role} onChange={(event) => { setFilters((current) => ({ ...current, role: event.target.value })); setPage(1); }}><option value="">All roles</option><option value="user">User</option><option value="admin">Admin</option><option value="root">Root</option></select></label>
        <label className="block"><span className="admin-label">Account state</span><select className="admin-input" value={filters.banned} onChange={(event) => { setFilters((current) => ({ ...current, banned: event.target.value })); setPage(1); }}><option value="">All states</option><option value="false">Active</option><option value="true">Banned</option></select></label>
        <label className="block"><span className="admin-label">Verification</span><select className="admin-input" value={filters.emailVerified} onChange={(event) => { setFilters((current) => ({ ...current, emailVerified: event.target.value })); setPage(1); }}><option value="">All users</option><option value="true">Verified</option><option value="false">Unverified</option></select></label>
        <Button variant="ghost" onClick={() => { setSearch(''); setQuery(''); setFilters({ role: '', banned: '', emailVerified: '' }); setPage(1); }}>Clear</Button>
      </div>

      {error && <div className="rounded-xl border border-admin-danger/30 bg-admin-danger/10 px-4 py-3 text-sm text-admin-danger">{error}</div>}
      <div className="admin-card !p-0"><div className="flex items-center justify-between border-b border-admin-border px-5 py-4"><p className="text-sm text-admin-muted"><span className="font-bold text-admin-text">{data.totalCount}</span> matching users</p><Button variant="ghost" size="sm" onClick={loadUsers} disabled={loading}>Refresh</Button></div><DataTable columns={columns} rows={data.users} loading={loading} emptyMessage="No users match these filters." /></div>
      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      <Modal open={Boolean(editing)} onClose={() => !saving && setEditing(null)} title={editing ? `Manage ${editing.name}` : 'Manage user'} footer={(<><Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>Cancel</Button><Button onClick={saveUser} disabled={saving}>{saving ? 'Saving...' : 'Save changes'}</Button></>)}>
        {editing && <div className="space-y-5"><div className="rounded-xl border border-admin-border bg-admin-surface-2/60 p-4"><p className="font-semibold text-admin-text">{editing.email}</p><p className="mt-1 text-xs text-admin-muted">User ID #{editing.id}</p></div><label className="flex items-center justify-between gap-4 rounded-xl border border-admin-border bg-admin-surface-2/50 p-4"><span><span className="block text-sm font-semibold text-admin-text">Account banned</span><span className="mt-1 block text-xs text-admin-muted">Banned users cannot sign in.</span></span><input type="checkbox" className="h-5 w-5 accent-admin-accent" checked={form.banned} onChange={(event) => setForm((current) => ({ ...current, banned: event.target.checked }))} /></label><label className="flex items-center justify-between gap-4 rounded-xl border border-admin-border bg-admin-surface-2/50 p-4"><span><span className="block text-sm font-semibold text-admin-text">Email verified</span><span className="mt-1 block text-xs text-admin-muted">Override verification for support cases.</span></span><input type="checkbox" className="h-5 w-5 accent-admin-accent" checked={form.emailVerified} onChange={(event) => setForm((current) => ({ ...current, emailVerified: event.target.checked }))} /></label><div className="block"><span className="admin-label">Role</span><p className="admin-input !cursor-default capitalize text-admin-muted">{editing.role}</p><p className="mt-1 text-xs text-admin-faint">Roles are managed by the creator in the root console.</p></div><label className="block"><span className="admin-label">Subscription plan</span><select className="admin-input" value={form.plan} onChange={(event) => setForm((current) => ({ ...current, plan: event.target.value }))}><option value="free">Free</option><option value="pro">Pro</option><option value="team">Team</option></select></label><div className="flex flex-wrap gap-2 border-t border-admin-border pt-4"><Button variant="secondary" size="sm" onClick={() => { setEditing(null); setResetTarget(editing); }}>Reset password</Button><Button variant="ghost" size="sm" onClick={() => revokeSessions(editing)}>Revoke sessions</Button></div>{editing.role === 'user' && <div className="rounded-xl border border-admin-danger/30 bg-admin-danger/5 p-4"><p className="text-sm font-semibold text-admin-danger">Delete account</p><p className="mt-1 text-xs text-admin-muted">Permanently erases this account with its subscriptions, payments, reviews and licence activations. This cannot be undone — ban the account instead if you only need to stop them signing in.</p><Button variant="danger" size="sm" className="mt-3" onClick={() => { setDeleteConfirm(''); setDeleteTarget(editing); setEditing(null); }}>Delete account</Button></div>}</div>}
      </Modal>

      <Modal open={Boolean(details)} onClose={() => setDetails(null)} title={details?.user ? `User details: ${details.user.name}` : 'User details'} size="lg">
        {detailsLoading ? <div className="py-10 text-center text-sm text-admin-muted">Loading account history...</div> : details?.user && <div className="space-y-6"><div className="grid gap-3 sm:grid-cols-4"><div className="rounded-xl border border-admin-border bg-admin-surface-2/60 p-3"><p className="text-xs text-admin-faint">Email</p><p className="mt-1 truncate text-sm font-semibold text-admin-text">{details.user.email}</p></div><div className="rounded-xl border border-admin-border bg-admin-surface-2/60 p-3"><p className="text-xs text-admin-faint">Joined</p><p className="mt-1 text-sm font-semibold text-admin-text">{formatDate(details.user.created_at)}</p></div><div className="rounded-xl border border-admin-border bg-admin-surface-2/60 p-3"><p className="text-xs text-admin-faint">Role</p><p className="mt-1 capitalize text-sm font-semibold text-admin-text">{details.user.role}</p></div><div className="rounded-xl border border-admin-border bg-admin-surface-2/60 p-3"><p className="text-xs text-admin-faint">State</p><p className="mt-1 text-sm font-semibold text-admin-text">{details.user.banned ? 'Banned' : 'Active'}</p></div></div><div><h4 className="text-sm font-bold text-admin-text">Subscriptions</h4><div className="mt-3 space-y-2">{details.subscriptions?.length ? details.subscriptions.map((subscription) => <div key={subscription.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-admin-border bg-admin-surface-2/50 p-3"><span className="font-semibold capitalize text-admin-text">{subscription.plan} <span className="ml-2 text-xs font-normal text-admin-faint">{subscription.license_key}</span></span><span className="flex items-center gap-3"><Badge status={subscription.status} /><span className="text-xs text-admin-muted">{subscription.seats} seat(s)</span></span></div>) : <p className="text-sm text-admin-muted">No subscriptions.</p>}</div></div><div><h4 className="text-sm font-bold text-admin-text">Payment history</h4><div className="mt-3 overflow-x-auto"><table className="admin-table"><thead><tr><th>Date</th><th>Plan</th><th>Amount</th><th>Status</th></tr></thead><tbody>{details.payments?.length ? details.payments.map((payment) => <tr key={payment.id}><td>{formatDate(payment.created_at)}</td><td className="capitalize">{payment.plan}</td><td>{payment.currency?.toUpperCase()} {payment.amount}</td><td><Badge status={payment.status} /></td></tr>) : <tr><td colSpan="4" className="text-center text-admin-muted">No payments.</td></tr>}</tbody></table></div></div><div><h4 className="text-sm font-bold text-admin-text">Reviews</h4><div className="mt-3 space-y-2">{details.reviews?.length ? details.reviews.map((review) => <div key={review.id} className="rounded-xl border border-admin-border bg-admin-surface-2/50 p-3"><div className="flex justify-between gap-3"><span className="text-admin-warning">{'★'.repeat(review.rating)}</span><Badge status={review.status} /></div><p className="mt-2 text-sm leading-6 text-admin-muted">{review.comment}</p></div>) : <p className="text-sm text-admin-muted">No reviews.</p>}</div></div></div>}
      </Modal>

      <Modal open={createOpen} onClose={() => !saving && setCreateOpen(false)} title="Create user" footer={(<><Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={saving}>Cancel</Button><Button onClick={createUser} disabled={saving || !createForm.name || !createForm.email || createForm.password.length < 8}>{saving ? 'Creating...' : 'Create user'}</Button></>)}><div className="space-y-4"><Input label="Name" name="newName" value={createForm.name} onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))} /><Input label="Email" name="newEmail" type="email" value={createForm.email} onChange={(event) => setCreateForm((current) => ({ ...current, email: event.target.value }))} /><Input label="Temporary password" name="newPassword" type="password" hint="At least 8 characters" value={createForm.password} onChange={(event) => setCreateForm((current) => ({ ...current, password: event.target.value }))} /><label className="block"><span className="admin-label">Plan</span><select className="admin-input" value={createForm.plan} onChange={(event) => setCreateForm((current) => ({ ...current, plan: event.target.value }))}><option value="free">Free</option><option value="pro">Pro</option><option value="team">Team</option></select></label><p className="text-xs text-admin-faint">New accounts are always created as ordinary users. Staff admins are created by the creator in the root console.</p></div></Modal>

      <Modal open={Boolean(deleteTarget)} onClose={() => !saving && setDeleteTarget(null)} title={`Delete ${deleteTarget?.email || 'account'}`} footer={(<><Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={saving}>Cancel</Button><Button variant="danger" onClick={deleteUser} disabled={saving || !deleteMatches}>{saving ? 'Deleting...' : 'Delete permanently'}</Button></>)}>
        <div className="space-y-4">
          <p className="text-sm leading-6 text-admin-muted">This erases <span className="font-semibold text-admin-text">{deleteTarget?.email}</span> and everything the account owns: its subscriptions and licence keys, payment records, reviews and every activated device. Admin activity remains in the audit log.</p>
          <p className="text-sm leading-6 text-admin-muted">There is no undo and no export step. If you only want to stop them signing in, cancel and use <span className="font-semibold text-admin-text">Account banned</span> instead.</p>
          <Input label="Type the account email to confirm" name="deleteConfirm" autoComplete="off" value={deleteConfirm} onChange={(event) => setDeleteConfirm(event.target.value)} hint={deleteTarget?.email} />
        </div>
      </Modal>

      <Modal open={Boolean(resetTarget)} onClose={() => !saving && setResetTarget(null)} title={`Reset password: ${resetTarget?.name || ''}`} footer={(<><Button variant="ghost" onClick={() => setResetTarget(null)} disabled={saving}>Cancel</Button><Button onClick={resetUserPassword} disabled={saving || resetPassword.length < 8}>{saving ? 'Resetting...' : 'Reset password'}</Button></>)}><Input label="New password" name="resetPassword" type="password" hint="At least 8 characters. Existing sessions will be revoked." value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} /></Modal>
    </div>
  );
}
