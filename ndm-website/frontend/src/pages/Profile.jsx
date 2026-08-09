import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import api, { unwrap } from '../api/client';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Input from '../components/Input';
import Spinner from '../components/Spinner';

export default function Profile() {
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
      const res = await api.put('/user/profile', { name: name.trim() });
      const data = unwrap(res);
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
      await api.put('/user/profile', {
        currentPassword,
        newPassword,
      });
      toast.success('Password changed.');
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
      </div>
    </Section>
  );
}
