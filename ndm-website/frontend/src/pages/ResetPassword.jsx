import { useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import api, { unwrap } from '../api/client';
import { useToast } from '../components/Toast';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Input from '../components/Input';

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <Section className="auth-section flex min-h-[70vh] items-center">
        <div className="mx-auto w-full max-w-md">
          <Card className="auth-card !p-8 text-center sm:!p-9">
            <h1 className="text-2xl font-bold text-white">Invalid link</h1>
            <p className="mt-3 text-zinc-400">
              This reset link is missing a token. Please request a new one.
            </p>
            <div className="mt-6">
              <Link to="/forgot-password" className="btn btn-primary">
                Request new link
              </Link>
            </div>
          </Card>
        </div>
      </Section>
    );
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
      toast.success('Password reset successfully.');
    } catch (err) {
      const msg =
        err?.response?.data?.error?.message ||
        err?.message ||
        'Reset failed. The link may have expired.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <Section className="flex min-h-[70vh] items-center">
        <div className="mx-auto w-full max-w-md">
          <Card className="!p-8 text-center">
            <h1 className="text-2xl font-bold text-white">Password reset</h1>
            <p className="mt-3 text-zinc-400">
              Your password has been updated. You can now sign in.
            </p>
            <div className="mt-6">
              <Link to="/login" className="btn btn-primary">
                Sign in
              </Link>
            </div>
          </Card>
        </div>
      </Section>
    );
  }

  return (
    <Section className="auth-section flex min-h-[70vh] items-center">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-5 text-center">
          <span className="eyebrow"><span className="eyebrow-dot" />Secure reset</span>
        </div>
        <Card className="auth-card !p-8 sm:!p-9">
          <h1 className="text-3xl font-extrabold tracking-tight text-white">Set a new <span className="text-gradient">password.</span></h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Choose a strong password for your account.
          </p>

          <form onSubmit={handleSubmit} className="mt-7 space-y-4" noValidate>
            <Input
              label="New password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              hint="At least 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Input
              label="Confirm password"
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />

            {error && (
              <div className="rounded-xl border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Resetting…' : 'Reset password'}
            </Button>
          </form>
        </Card>
      </div>
    </Section>
  );
}
