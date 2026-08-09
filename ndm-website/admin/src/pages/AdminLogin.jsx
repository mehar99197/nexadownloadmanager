import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAdminAuth } from '../context/AdminAuthContext.jsx';
import Button from '../components/Button.jsx';
import Input from '../components/Input.jsx';

export default function AdminLogin() {
  const { login } = useAdminAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(email.trim(), password);
      const destination = location.state?.from?.pathname || '/dashboard';
      navigate(destination, { replace: true });
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Unable to sign in.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-6">
      <div className="pointer-events-none absolute -left-24 -top-32 h-96 w-96 rounded-full bg-accent-500/15 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-24 h-96 w-96 rounded-full bg-admin-cyan/10 blur-3xl" />
      <div className="admin-card relative w-full max-w-md !p-8 sm:!p-10">
        <div className="text-center">
          <img src="/admin/nexa-logo-final.svg" alt="NexaDownloadManager" className="mx-auto h-20 w-20" />
          <p className="mt-5 text-xs font-bold uppercase tracking-[0.18em] text-admin-cyan">Secure control room</p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight">Nexa<span className="bg-gradient-to-r from-accent-400 to-admin-cyan bg-clip-text text-transparent"> Admin</span></h1>
          <p className="mt-3 text-sm leading-6 text-admin-muted">Manage your users, subscriptions, reviews, and releases from one place.</p>
        </div>

        <form onSubmit={handleSubmit} className="mt-8 space-y-4" noValidate>
          <Input
            label="Admin email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Input
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />

          {error && (
            <div className="rounded-xl border border-admin-danger/30 bg-admin-danger/10 px-4 py-3 text-sm text-admin-danger">
              {error}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? 'Signing in...' : 'Sign in to control room'}
          </Button>
        </form>
      </div>
    </div>
  );
}
