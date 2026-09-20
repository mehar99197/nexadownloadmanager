import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import api, { unwrap, setAccessToken } from '../api/client';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Input from '../components/Input';
import Spinner from '../components/Spinner';
import usePageMeta from '../hooks/usePageMeta';

/**
 * "Your data" — self-service export and deletion, so a data-access or
 * erasure request never has to go through support.
 */
function DataCard({ user }) {
  const { logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [exporting, setExporting] = useState(false);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmWord, setConfirmWord] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const exportData = async () => {
    setExporting(true);
    try {
      const data = unwrap(await api.get('/user/export'));
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nexa-account-${user.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Your data was downloaded as JSON.');
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Could not export your data.');
    } finally {
      setExporting(false);
    }
  };

  const closeDialog = () => {
    setOpen(false);
    setPassword('');
    setConfirmWord('');
    setError('');
  };

  const deleteAccount = async (e) => {
    e.preventDefault();
    setError('');
    setDeleting(true);
    try {
      await api.delete('/user/account', { data: { password, confirm: confirmWord.trim() } });
      closeDialog();
      await logout();
      navigate('/', { replace: true });
      toast.success('Your account and its data were deleted.');
    } catch (err) {
      setError(err?.response?.data?.error?.message || 'Could not delete the account.');
    } finally {
      setDeleting(false);
    }
  };

  const isStaff = user.role && user.role !== 'user';
  const ready = password.length > 0 && confirmWord.trim() === 'DELETE';

  return (
    <Card className="card-hover !p-7">
      <h3 className="text-lg font-bold text-white">Your data</h3>
      <p className="mt-2 text-sm leading-6 text-slate-400">
        Download everything we hold about this account as one JSON file — profile, plans, licence keys,
        devices, payments and your review.
      </p>
      <div className="mt-4">
        <Button variant="ghost" onClick={exportData} disabled={exporting}>
          {exporting ? 'Preparing…' : 'Download my data'}
        </Button>
      </div>

      <div className="mt-7 border-t border-[var(--color-surface-border)] pt-6">
        <h4 className="font-semibold text-red-300">Delete account</h4>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          Permanently removes your account, licence keys, devices, payment history, review and team
          membership. A paid plan is cancelled first so nothing is charged afterwards. This cannot be undone.
        </p>
        {isStaff ? (
          <p className="note-warn mt-4 rounded-xl px-4 py-3 text-sm">
            Control-panel accounts are removed by the creator, not from here.
          </p>
        ) : (
          <div className="mt-4">
            <Button
              variant="ghost"
              className="!border-red-400/40 !text-red-200 hover:!border-red-400"
              onClick={() => setOpen(true)}
            >
              Delete my account…
            </Button>
          </div>
        )}
      </div>

      {/* Portalled to <body>: the card is overflow-hidden and gains a transform on
          hover, either of which would trap a position:fixed dialog inside it. */}
      {open && createPortal(
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
          <button type="button" aria-label="Close" className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={closeDialog} />
          <form
            onSubmit={deleteAccount}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-account-title"
            className="card relative w-full max-w-md !p-6"
          >
            <h2 id="delete-account-title" className="text-lg font-bold text-white">Delete your account?</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              Everything tied to <span className="font-semibold text-slate-200">{user.email}</span> is erased
              immediately. Confirm with your password and type <span className="font-mono font-semibold text-slate-200">DELETE</span>.
            </p>
            <div className="mt-5 space-y-4">
              <Input
                label="Password"
                name="deletePassword"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <Input
                label="Type DELETE to confirm"
                name="deleteConfirm"
                type="text"
                autoComplete="off"
                placeholder="DELETE"
                value={confirmWord}
                onChange={(e) => setConfirmWord(e.target.value)}
              />
              {error && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
                  {error}
                </div>
              )}
            </div>
            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <Button variant="ghost" onClick={closeDialog} disabled={deleting}>Keep my account</Button>
              <Button
                type="submit"
                className="!bg-none !bg-red-500 hover:!bg-red-400 !shadow-none"
                disabled={!ready || deleting}
              >
                {deleting ? 'Deleting…' : 'Delete everything'}
              </Button>
            </div>
          </form>
        </div>,
        document.body,
      )}
    </Card>
  );
}

export default function Profile() {
  usePageMeta({ title: "Profile", description: "Update your Nexa Download Manager account name and password." });

  const { user, refreshMe } = useAuth();
  const toast = useToast();

  const [name, setName] = useState(user?.name || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Password form
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [pwError, setPwError] = useState('');

  if (!user) return <Spinner center />;

  const handleSaveName = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.put('/user/profile', { name: name.trim() });
      await refreshMe();
      toast.success('Profile updated.');
    } catch (err) {
      const msg =
        err?.response?.data?.error?.message ||
        err?.message ||
        'Failed to update profile.';
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPwError('');
    if (newPassword.length < 8) {
      setPwError('New password must be at least 8 characters.');
      return;
    }
    setChangingPassword(true);
    try {
      // /auth/change-password signs every OTHER browser out and keeps this one.
      // An account created with Google has no current password to send; the
      // field is left out rather than sent empty, which the API would reject.
      const result = unwrap(await api.post('/auth/change-password', {
        ...(currentPassword ? { currentPassword } : {}),
        newPassword,
      }));
      // Every bearer is bound to its session, and the change just replaced
      // this browser's session — so the token in hand is dead and the response
      // carries its successor. Adopt it here rather than let the next request
      // discover the 401 and take the refresh round trip.
      if (result?.token) setAccessToken(result.token);
      toast.success('Password changed. Any other signed-in devices were signed out.');
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      const msg =
        err?.response?.data?.error?.message ||
        err?.message ||
        'Failed to change password.';
      setPwError(msg);
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <Section>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-4xl font-extrabold tracking-tight text-white">Your <span className="text-gradient">profile.</span></h1>
          <p className="mt-2 text-sm text-slate-400">
            Manage your account details.
          </p>
        </div>
        <div className="flex gap-3">
          <Link to="/dashboard" className="btn btn-ghost">Dashboard</Link>
          <Link to="/billing" className="btn btn-ghost">Billing</Link>
        </div>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <Card className="card-hover !p-7">
          <h3 className="text-lg font-bold text-white">Account Info</h3>
          <form onSubmit={handleSaveName} className="mt-5 space-y-4">
            <Input
              label="Email"
              name="email"
              type="email"
              value={user.email || ''}
              disabled
              hint="Contact support to change your email."
            />
            <Input
              label="Name"
              name="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />

            {error && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
                {error}
              </div>
            )}

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
              <p className="text-xs text-zinc-500">
                Member since{' '}
                {user.createdAt
                  ? new Date(user.createdAt).toLocaleDateString()
                  : '—'}
              </p>
            </div>
          </form>
        </Card>

        <Card className="card-hover !p-7">
          <h3 className="text-lg font-bold text-white">Change Password</h3>
          <form onSubmit={handleChangePassword} className="mt-5 space-y-4">
            <Input
              label="Current password"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
            <Input
              label="New password"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              hint="At least 8 characters"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />

            {pwError && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
                {pwError}
              </div>
            )}

            <Button type="submit" disabled={changingPassword}>
              {changingPassword ? 'Changing…' : 'Change password'}
            </Button>
          </form>
        </Card>

        <div className="lg:col-span-2">
          <DataCard user={user} />
        </div>
      </div>
    </Section>
  );
}
