import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Input from '../components/Input';
import Turnstile, { turnstileEnabled } from '../components/Turnstile';
import usePageMeta from '../hooks/usePageMeta';

export default function ForgotPassword() {
  usePageMeta({ title: "Reset password", description: "Request a password reset link for your Nexa Download Manager account." });

  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState(null);
  const [turnstileReset, setTurnstileReset] = useState(0);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await api.post('/auth/forgot-password', { email, ...(turnstileToken ? { turnstileToken } : {}) });
      setSent(true);
    } catch (err) {
      const msg =
        err?.response?.data?.error?.message ||
        err?.message ||
        'Something went wrong. Please try again.';
      setError(msg);
      setTurnstileReset((n) => n + 1);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Section className="auth-section flex min-h-[70vh] items-center">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-5 text-center">
          <span className="eyebrow"><span className="eyebrow-dot" />Account recovery</span>
        </div>
        <Card className="auth-card !p-8 sm:!p-9">
          <h1 className="text-3xl font-extrabold tracking-tight text-white">Reset your <span className="text-gradient">password.</span></h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Enter your email and we&apos;ll send you a reset link.
          </p>

          {sent ? (
            <div className="mt-7 space-y-4">
              <div className="rounded-xl border border-brand-400/25 bg-brand-400/10 px-4 py-3 text-sm text-brand-100">
                If an account with that email exists, a reset link has been sent.
                Check your inbox and spam folder.
              </div>
                <Link
                  to="/login"
                  className="inline-flex min-h-6 items-center text-sm font-medium text-brand-300 hover:text-brand-200 hover:underline"
              >
                &larr; Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-7 space-y-4" noValidate>
              <Input
                label="Email"
                name="email"
                placeholder="you@example.com"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />

              {error && (
                <div role="alert" className="rounded-[var(--radius-2)] border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-200">
                  {error}
                </div>
              )}

              <Turnstile onToken={setTurnstileToken} resetKey={turnstileReset} />

              <Button type="submit" className="w-full" disabled={submitting || (turnstileEnabled() && !turnstileToken)}>
                {submitting ? 'Sending…' : 'Send reset link'}
              </Button>

              <p className="text-center text-sm text-zinc-500">
                <Link
                  to="/login"
                  className="inline-flex min-h-6 items-center font-medium text-brand-300 hover:text-brand-200 hover:underline"
                >
                  &larr; Back to sign in
                </Link>
              </p>
            </form>
          )}
        </Card>
      </div>
    </Section>
  );
}
