import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../api/client';
import { useToast } from '../components/Toast';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Input from '../components/Input';
import GoogleButton, { googleAuthEnabled } from '../components/GoogleButton';
import usePageMeta from '../hooks/usePageMeta';

export default function Login() {
  usePageMeta({ title: "Sign in", description: "Sign in to your Nexa Download Manager account to manage your plan, license key and billing." });

  const { login, loginWithGoogle, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams] = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [error, setError] = useState('');
  // Set when the server refuses a sign-in because the address is unverified.
  // Without an offer to re-send, that refusal is a dead end: the original link
  // expires after an hour and there is no signed-in page to ask from.
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resending, setResending] = useState(false);

  const resendVerification = async () => {
    setResending(true);
    try {
      await api.post('/auth/resend-verification', { email });
      toast.success('If that address needs verifying, a new link is on its way.');
      setNeedsVerification(false);
    } catch {
      toast.error('Could not send the link. Please try again in a moment.');
    } finally {
      setResending(false);
    }
  };

  // Where to go after signing in. Only same-site paths are honoured, so a
  // crafted link cannot bounce a visitor to another origin.
  const rawNext = searchParams.get('next') || '';
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/dashboard';

  // A signed-in visitor is sent on to `next`. This branch also fires the
  // instant login() resolves (isAuthenticated flips before navigate() runs),
  // so it MUST honour `next` too — sending everyone to /dashboard here broke
  // every ?next= link, e.g. accepting a team invitation.
  if (isAuthenticated) return <Navigate to={next} replace />;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setNeedsVerification(false);
    setSubmitting(true);
    try {
      await login(email, password);
      toast.success('Logged in successfully.');
      navigate(next, { replace: true });
    } catch (err) {
      const msg =
        err?.response?.data?.error?.message ||
        err?.message ||
        'Login failed. Please try again.';
      setNeedsVerification(err?.response?.data?.error?.code === 'EMAIL_NOT_VERIFIED');
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  // The Google button hands back an ID token; the backend verifies it and
  // creates or links the account, so there is no separate "sign up with Google".
  const handleGoogle = async (credential) => {
    setError('');
    setGoogleBusy(true);
    try {
      const { created } = await loginWithGoogle(credential);
      toast.success(created ? 'Account created — welcome to Nexa!' : 'Logged in successfully.');
      navigate(next, { replace: true });
    } catch (err) {
      setError(
        err?.response?.data?.error?.message ||
        err?.message ||
        'Google sign-in failed. Please try again.'
      );
    } finally {
      setGoogleBusy(false);
    }
  };

  const busy = submitting || googleBusy;

  return (
    <Section className="auth-section flex min-h-[70vh] items-center">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-5 text-center">
          <span className="eyebrow"><span className="eyebrow-dot" />Account access</span>
        </div>
        <Card className="auth-card !p-8 sm:!p-9">
          <h1 className="text-3xl font-extrabold tracking-tight text-white">Welcome <span className="text-gradient">back.</span></h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Welcome back. Enter your credentials to continue.
          </p>

          {googleAuthEnabled() && (
            <div className="mt-7">
              <GoogleButton onCredential={handleGoogle} onError={setError} disabled={busy} />
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-7 space-y-4" noValidate>
            <Input
              label="Email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Input
              label="Password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            {error && (
              // role=alert, so a failed sign-in is spoken. Focus stays on the
              // submit button after a rejected POST, and nothing else on the
              // page changes, so without this the form silently does nothing.
              <div role="alert" className="rounded-[var(--radius-2)] border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-200">
                {error}
                {needsVerification && (
                  <button
                    type="button"
                    onClick={resendVerification}
                    disabled={resending || !email}
                    className="mt-2 block font-semibold text-red-100 underline underline-offset-2 hover:text-white disabled:opacity-60"
                  >
                    {resending ? 'Sending…' : 'Send me a new verification link'}
                  </button>
                )}
                {/*
                  The server deliberately cannot tell us that THIS address was
                  created with Google — a distinct answer for an address that
                  exists is a membership oracle for anyone who types one. So the
                  hint is given here, unconditionally, after any failed sign-in:
                  it helps the person who needs it and confirms nothing to
                  anyone else.
                */}
                {!needsVerification && (
                  <p className="mt-2 text-xs text-red-200/80">
                    Created your account with Google? Use “Continue with Google” below.
                    Never set a password? Use “Forgot password”.
                  </p>
                )}
              </div>
            )}

            <Link
              to="/forgot-password"
              className="block text-sm font-medium text-brand-300 hover:text-brand-200 hover:underline"
            >
              Forgot password?
            </Link>

            <Button type="submit" className="w-full" disabled={busy}>
              {submitting ? 'Signing in…' : googleBusy ? 'Signing in with Google…' : 'Sign in'}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-500">
            Don&apos;t have an account?{' '}
            <Link
              to="/register"
              className="font-medium text-brand-300 hover:text-brand-200 hover:underline"
            >
              Create one
            </Link>
          </p>
        </Card>
      </div>
    </Section>
  );
}
