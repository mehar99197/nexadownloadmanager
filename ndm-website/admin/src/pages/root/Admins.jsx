import { useCallback, useEffect, useState } from 'react';
import api, { unwrap } from '../../api/client.js';
import DataTable from '../../components/DataTable.jsx';
import Button from '../../components/Button.jsx';
import Badge from '../../components/Badge.jsx';
import Modal from '../../components/Modal.jsx';
import Input from '../../components/Input.jsx';
import { useConfirm } from '../../components/ConfirmDialog.jsx';
import { formatDate } from '../../utils.js';
import { useAdminAuth } from '../../context/AdminAuthContext.jsx';

const EMPTY_CREATE = { name: '', email: '', password: '' };
const MIN_PASSWORD = 12;

function errorMessage(err, fallback) {
  // A 4xx makes axios throw before unwrap() runs, so the server's message
  // lives on the response; err.message would be "Request failed with status code 400".
  return err?.response?.data?.error?.message || err?.message || fallback;
}

/**
 * Creator-only: manage the staff admins.
 *
 * Everything here talks to /api/root/*, which a staff token cannot reach. Root
 * rows are rendered read-only because the API refuses to modify them too — a
 * creator account is changed only by the create-root CLI script.
 */
export default function Admins() {
  const { admin: me } = useAdminAuth();
  const confirm = useConfirm();
  const [admins, setAdmins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(EMPTY_CREATE);
  const [resetTarget, setResetTarget] = useState(null);
  const [resetPassword, setResetPassword] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await unwrap(api.get('/root/admins'));
      setAdmins(data?.admins || []);
    } catch (err) {
      setError(errorMessage(err, 'Unable to load control-panel accounts.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function run(action, successMessage) {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(successMessage);
      await load();
      return true;
    } catch (err) {
      setError(errorMessage(err, 'The action could not be completed.'));
      return false;
    } finally {
      setSaving(false);
    }
  }

  const createAdmin = async () => {
    const okDone = await run(
      () => unwrap(api.post('/root/admins', createForm)),
      `Staff admin ${createForm.email} created.`,
    );
    if (okDone) {
      setCreateOpen(false);
      setCreateForm(EMPTY_CREATE);
    }
  };

  const resetAdminPassword = async () => {
    if (!resetTarget || resetPassword.length < MIN_PASSWORD) return;
    const okDone = await run(
      () => unwrap(api.post(`/root/admins/${resetTarget.id}/reset-password`, { password: resetPassword })),
      `Password reset for ${resetTarget.email}. Their sessions were revoked.`,
    );
    if (okDone) {
      setResetTarget(null);
      setResetPassword('');
    }
  };

  const isSelf = (row) => String(row.id) === String(me?.id);
  const isCreator = (row) => row.role === 'root';

  const columns = [
    {
      key: 'account',
      header: 'Account',
      render: (row) => (
        <div>
          <p className="font-semibold text-admin-text">{row.name}</p>
          <p className="text-xs text-admin-faint">{row.email}</p>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      render: (row) => (
        <Badge tone={isCreator(row) ? 'warning' : 'info'}>
          {isCreator(row) ? 'creator' : 'staff admin'}
        </Badge>
      ),
    },
    {
      key: 'state',
      header: 'State',
      render: (row) => <Badge tone={row.banned ? 'danger' : 'success'}>{row.banned ? 'Banned' : 'Active'}</Badge>,
    },
    {
      key: 'twoFactor',
      header: '2FA',
      render: (row) => (
        <Badge tone={row.totp_enabled ? 'success' : 'warning'}>{row.totp_enabled ? 'On' : 'Off'}</Badge>
      ),
    },
    {
      key: 'created',
      header: 'Added',
      render: (row) => <span className="whitespace-nowrap text-xs text-admin-muted">{formatDate(row.created_at)}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (row) => {
        if (isCreator(row)) {
          return (
            <span className="text-xs text-admin-faint">
              {isSelf(row) ? 'This is you' : 'Creator'} — managed by the create-root script
            </span>
          );
        }
        return (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary" size="sm" disabled={saving}
              onClick={() => run(
                () => unwrap(api.put(`/root/admins/${row.id}`, { banned: !row.banned })),
                `${row.email} ${row.banned ? 'unbanned' : 'banned'}.`,
              )}
            >
              {row.banned ? 'Unban' : 'Ban'}
            </Button>
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => { setResetTarget(row); setResetPassword(''); }}>
              Reset password
            </Button>
            <Button
              variant="ghost" size="sm" disabled={saving}
              onClick={() => run(
                () => unwrap(api.post(`/root/admins/${row.id}/revoke-sessions`)),
                `Sessions revoked for ${row.email}.`,
              )}
            >
              Revoke sessions
            </Button>
            {Boolean(row.totp_enabled) && (
              <Button
                variant="ghost" size="sm" disabled={saving}
                onClick={async () => {
                  const sure = await confirm({
                    title: `Reset two-factor authentication for ${row.email}?`,
                    message: 'Their authenticator is unlinked and every session is revoked. They sign in with their password only until they enrol again. Do this only after confirming who is asking.',
                    confirmLabel: 'Reset 2FA',
                    danger: true,
                  });
                  if (!sure) return;
                  await run(
                    () => unwrap(api.post(`/root/admins/${row.id}/reset-2fa`)),
                    `Two-factor authentication reset for ${row.email}.`,
                  );
                }}
              >
                Reset 2FA
              </Button>
            )}
            <Button
              variant="ghost" size="sm" disabled={saving}
              onClick={() => run(
                () => unwrap(api.delete(`/root/admins/${row.id}`)),
                `${row.email} demoted to an ordinary user.`,
              )}
            >
              Demote
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="admin-eyebrow text-admin-warning">Creator only</p>
          <h2 className="mt-2 text-3xl font-extrabold tracking-tight text-admin-text">Admins</h2>
          <p className="mt-2 max-w-2xl text-sm text-admin-muted">
            Staff admins sign in at <code className="text-admin-cyan">/admin</code> and can manage customers,
            reviews, releases and ads. They cannot change anyone&apos;s role, touch another control-panel
            account, or reach this console.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={load} disabled={loading}>Refresh</Button>
          <Button onClick={() => { setCreateForm(EMPTY_CREATE); setCreateOpen(true); }}>Add staff admin</Button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-admin-danger/30 bg-admin-danger/10 px-4 py-3 text-sm text-admin-danger">{error}</div>}
      {notice && <div className="rounded-xl border border-admin-success/30 bg-admin-success/10 px-4 py-3 text-sm text-admin-success">{notice}</div>}

      <div className="admin-card !p-0">
        <DataTable columns={columns} rows={admins} loading={loading} emptyMessage="No control-panel accounts yet." caption="Control-panel accounts and their roles" />
      </div>

      <Modal
        open={createOpen}
        onClose={() => !saving && setCreateOpen(false)}
        title="Add staff admin"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={saving}>Cancel</Button>
            <Button
              onClick={createAdmin}
              disabled={saving || !createForm.name || !createForm.email || createForm.password.length < MIN_PASSWORD}
            >
              {saving ? 'Creating...' : 'Create admin'}
            </Button>
          </>
        )}
      >
        <div className="space-y-4">
          <Input label="Name" name="adminName" placeholder="John Doe" value={createForm.name}
            onChange={(e) => setCreateForm((c) => ({ ...c, name: e.target.value }))} />
          <Input label="Email" name="adminEmail" type="email" placeholder="you@example.com" value={createForm.email}
            onChange={(e) => setCreateForm((c) => ({ ...c, email: e.target.value }))} />
          <Input label="Temporary password" name="adminPassword" type="password" placeholder="At least 12 characters"
            hint={`At least ${MIN_PASSWORD} characters`} value={createForm.password}
            onChange={(e) => setCreateForm((c) => ({ ...c, password: e.target.value }))} />
          <p className="text-xs text-admin-faint">
            This account signs in at <code className="text-admin-cyan">/admin/login</code>, never here.
          </p>
        </div>
      </Modal>

      <Modal
        open={Boolean(resetTarget)}
        onClose={() => !saving && setResetTarget(null)}
        title={`Reset password — ${resetTarget?.email || ''}`}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setResetTarget(null)} disabled={saving}>Cancel</Button>
            <Button onClick={resetAdminPassword} disabled={saving || resetPassword.length < MIN_PASSWORD}>
              {saving ? 'Resetting...' : 'Reset password'}
            </Button>
          </>
        )}
      >
        <div className="space-y-4">
          <Input label="New password" name="newAdminPassword" type="password" placeholder="At least 12 characters"
            hint={`At least ${MIN_PASSWORD} characters`} value={resetPassword}
            onChange={(e) => setResetPassword(e.target.value)} />
          <p className="text-xs text-admin-faint">All of their active sessions are revoked immediately.</p>
        </div>
      </Modal>
    </div>
  );
}
