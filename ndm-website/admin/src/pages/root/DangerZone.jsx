import { useCallback, useEffect, useState } from 'react';
import api, { unwrap } from '../../api/client.js';
import Button from '../../components/Button.jsx';
import Badge from '../../components/Badge.jsx';
import Modal from '../../components/Modal.jsx';
import Input from '../../components/Input.jsx';
import DataTable from '../../components/DataTable.jsx';
import { formatDate } from '../../utils.js';
import { useAdminAuth } from '../../context/AdminAuthContext.jsx';

function errorMessage(err, fallback) {
  // A 4xx makes axios throw before unwrap() runs, so the server's message
  // lives on the response; err.message would be "Request failed with status code 400".
  return err?.response?.data?.error?.message || err?.message || fallback;
}

/**
 * Creator-only: irreversible actions.
 *
 * Account deletion cascades to the account's subscriptions, payments, licence
 * activations and reviews. The API demands the target's exact email in the
 * request body, and this screen makes the operator retype it — one confirmation
 * on the client, one on the server.
 */
export default function DangerZone() {
  const { admin: me } = useAdminAuth();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [target, setTarget] = useState(null);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [overview, setOverview] = useState(null);

  useEffect(() => {
    const id = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await unwrap(api.get('/root/overview')));
    } catch {
      // The overview strip is informational; a failure here must not block deletes.
    }
  }, []);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  const loadUsers = useCallback(async () => {
    if (!search) { setUsers([]); return; }
    setLoading(true);
    setError('');
    try {
      // The customer list lives on the staff API; a root token is accepted there.
      const data = await unwrap(api.get('/admin/users', { params: { q: search, limit: 20 } }));
      setUsers(data?.users || []);
    } catch (err) {
      setError(errorMessage(err, 'Unable to search accounts.'));
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const confirmMatches = target && confirmEmail.trim().toLowerCase() === String(target.email).toLowerCase();

  const deleteAccount = async () => {
    if (!target || !confirmMatches) return;
    setDeleting(true);
    setError('');
    setNotice('');
    try {
      await unwrap(api.delete(`/root/users/${target.id}`, { data: { confirmEmail: confirmEmail.trim().toLowerCase() } }));
      setNotice(`${target.email} and all of its data were permanently deleted.`);
      setTarget(null);
      setConfirmEmail('');
      await Promise.all([loadUsers(), loadOverview()]);
    } catch (err) {
      setError(errorMessage(err, 'The account could not be deleted.'));
    } finally {
      setDeleting(false);
    }
  };

  const protectedRow = (row) => row.role === 'root' || String(row.id) === String(me?.id);

  const columns = [
    {
      key: 'account', header: 'Account',
      render: (row) => (
        <div>
          <p className="font-semibold text-admin-text">{row.name}</p>
          <p className="text-xs text-admin-faint">{row.email}</p>
        </div>
      ),
    },
    {
      key: 'role', header: 'Role',
      render: (row) => <Badge tone={row.role === 'root' ? 'warning' : row.role === 'admin' ? 'info' : 'default'}>{row.role}</Badge>,
    },
    { key: 'plan', header: 'Plan', render: (row) => <span className="capitalize text-admin-muted">{row.plan || 'free'}</span> },
    { key: 'joined', header: 'Joined', render: (row) => <span className="whitespace-nowrap text-xs text-admin-muted">{formatDate(row.created_at)}</span> },
    {
      key: 'actions', header: 'Actions',
      render: (row) => (protectedRow(row)
        ? <span className="text-xs text-admin-faint">Protected</span>
        : (
          <Button variant="secondary" size="sm" onClick={() => { setTarget(row); setConfirmEmail(''); }}>
            Delete permanently
          </Button>
        )),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <p className="admin-eyebrow text-admin-danger">Irreversible</p>
        <h2 className="mt-2 text-3xl font-extrabold tracking-tight text-admin-text">Danger zone</h2>
        <p className="mt-2 max-w-2xl text-sm text-admin-muted">
          Permanently delete a customer account. Their subscriptions, payments, licence activations
          and reviews are removed with it. The audit entry is written first, so the record of the
          deletion outlives the account.
        </p>
      </div>

      {overview && (
        <div className="grid gap-3 sm:grid-cols-4">
          {[
            ['Total accounts', overview.totalUsers],
            ['Staff admins', overview.admins],
            ['Creators', overview.roots],
            ['Banned', overview.banned],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-admin-border bg-admin-surface-2/60 p-3">
              <p className="text-xs text-admin-faint">{label}</p>
              <p className="mt-1 text-xl font-bold text-admin-text">{value}</p>
            </div>
          ))}
        </div>
      )}

      {!overview?.rootEmailPinned && (
        <div className="rounded-xl border border-admin-warning/30 bg-admin-warning/10 px-4 py-3 text-sm text-admin-warning">
          <strong>ROOT_ADMIN_EMAIL is not set.</strong> The creator tier is currently anchored by the
          database role alone. Set it in the backend environment so a database write cannot mint a creator.
        </div>
      )}

      {error && <div className="rounded-xl border border-admin-danger/30 bg-admin-danger/10 px-4 py-3 text-sm text-admin-danger">{error}</div>}
      {notice && <div className="rounded-xl border border-admin-success/30 bg-admin-success/10 px-4 py-3 text-sm text-admin-success">{notice}</div>}

      <div className="admin-card">
        <label className="block">
          <span className="admin-label">Find the account to delete</span>
          <input
            className="admin-input" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or email..."
          />
        </label>
        <p className="mt-2 text-xs text-admin-faint">
          Creator accounts and your own account cannot be deleted here.
        </p>
      </div>

      {search && (
        <div className="admin-card !p-0">
          <DataTable columns={columns} rows={users} loading={loading} emptyMessage="No accounts match that search." caption="Accounts matching the search, for permanent deletion" />
        </div>
      )}

      <Modal
        open={Boolean(target)}
        onClose={() => !deleting && setTarget(null)}
        title="Delete this account permanently?"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setTarget(null)} disabled={deleting}>Cancel</Button>
            <Button onClick={deleteAccount} disabled={deleting || !confirmMatches}>
              {deleting ? 'Deleting...' : 'Delete permanently'}
            </Button>
          </>
        )}
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-admin-danger/30 bg-admin-danger/10 p-4 text-sm text-admin-danger">
            This cannot be undone. <strong>{target?.email}</strong> and every subscription, payment,
            licence activation and review belonging to it will be erased.
          </div>
          <Input
            label={`Type ${target?.email || ''} to confirm`}
            name="confirmEmail" placeholder={target?.email || 'user@example.com'} value={confirmEmail}
            onChange={(e) => setConfirmEmail(e.target.value)}
            autoComplete="off"
          />
        </div>
      </Modal>
    </div>
  );
}
