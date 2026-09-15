import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAdminAuth } from '../context/AdminAuthContext.jsx';
import Button from '../components/Button.jsx';
import Input from '../components/Input.jsx';
import { IS_ROOT, PANEL_LABEL } from '../realm.js';

const LOGO = `${import.meta.env.BASE_URL}nexa-logo-final.svg`;

export default function AdminLogin() {
  const { login, completeTwoFactor } = useAdminAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // Second step: set once the password verified for an account with 2FA on.
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState('');

  const finish = () => {
    const destination = location.state?.from?.pathname || '/dashboard';
    navigate(destination, { replace: true });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const result = await login(email.trim(), password);
      if (result?.requiresTwoFactor) {
        setChallenge(result.challenge);
        setPassword('');
        return;
      }
      finish();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Unable to sign in.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCode = async (event) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await completeTwoFactor(challenge, code.trim());
      finish();
    } catch (err) {
      const message = err?.response?.data?.error?.message || err?.message || 'That code did not verify.';
      setError(message);
      // An expired challenge means starting over from the password.
      if (err?.code === 'INVALID_CHALLENGE' || err?.response?.data?.error?.code === 'INVALID_CHALLENGE') {
        setChallenge(null);
        setCode('');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (challenge) {
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-6">
        <div className="pointer-events-none absolute -left-24 -top-32 h-96 w-96 rounded-full bg-accent-500/15 blur-3xl" />
        <div className="admin-card relative w-full max-w-md !p-8 sm:!p-10">
          <div className="text-center">
            <img src={LOGO} alt="NexaDownloadManager" className="admin-brand-logo mx-auto h-16 w-16" />
            <p className={`mt-5 admin-eyebrow ${IS_ROOT ? 'text-admin-warning' : 'text-admin-cyan'}`}>Second step</p>
            <h1 className="mt-2 text-2xl font-extrabold tracking-tight">Enter your authenticator code</h1>
            <p className="mt-3 text-sm leading-6 text-admin-muted">
              Open your authenticator app and type the 6-digit code for <span className="text-admin-text">{email.trim()}</span>.
              A recovery code works too.
            </p>
          </div>
          <form onSubmit={handleCode} className="mt-8 space-y-4" noValidate>
            <Input
              label="Code"
              name="code"
              autoComplete="one-time-code"
              inputMode="text"
              autoFocus
              required
              placeholder="123456"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            {error && (
              <div className="rounded-xl border border-admin-danger/30 bg-admin-danger/10 px-4 py-3 text-sm text-admin-danger">
                {error}
              </div>
            )}
            <Button type="submit" className="w-full" disabled={submitting || code.trim().length < 6}>
              {submitting ? 'Verifying…' : 'Verify and sign in'}
            </Button>
            <Button type="button" variant="ghost" className="w-full" onClick={() => { setChallenge(null); setCode(''); setError(''); }}>
              Back to password
            </Button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-6">
      <div className="pointer-events-none absolute -left-24 -top-32 h-96 w-96 rounded-full bg-accent-500/15 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-24 h-96 w-96 rounded-full bg-admin-cyan/10 blur-3xl" />
      <div className="admin-card relative w-full max-w-md !p-8 sm:!p-10">
        <div className="text-center">
          <img src={LOGO} alt="NexaDownloadManager" className="admin-brand-logo mx-auto h-20 w-20" />
          <p className={`mt-5 admin-eyebrow ${IS_ROOT ? 'text-admin-warning' : 'text-admin-cyan'}`}>
            {IS_ROOT ? 'Creator access only' : 'Secure control room'}
          </p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight">Nexa<span className={`bg-clip-text text-transparent ${IS_ROOT ? 'bg-gradient-to-r from-admin-warning to-admin-danger' : 'bg-gradient-to-r from-accent-400 to-admin-cyan'}`}> {PANEL_LABEL}</span></h1>
          <p className="mt-3 text-sm leading-6 text-admin-muted">
            {IS_ROOT
              ? 'Owner console — manage staff admins, read the full audit trail, and run irreversible actions.'
              : 'Manage your users, subscriptions, reviews, and releases from one place.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-8 space-y-4" noValidate>
          <Input
            label={IS_ROOT ? 'Creator email' : 'Admin email'}
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
            {submitting ? 'Signing in...' : IS_ROOT ? 'Sign in to creator console' : 'Sign in to control room'}
          </Button>
        </form>
      </div>
    </div>
  );
}
