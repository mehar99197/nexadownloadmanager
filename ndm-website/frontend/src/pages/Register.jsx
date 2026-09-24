import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { markPendingTrial, startTrial, clearPendingTrial } from '../api/trial';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Input from '../components/Input';
import Turnstile, { turnstileEnabled } from '../components/Turnstile';
import GoogleButton, { googleAuthEnabled } from '../components/GoogleButton';

export default function Register() {
  usePageMeta({
    title: 'Create account',
    description: 'Create a free Nexa Download Manager account. Every account gets a 7-day Pro trial — no card needed.',
  });

  const { register, loginWithGoogle, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const wantsTrial = searchParams.get('trial') === '1';
  // Only same-site paths are honoured, so a crafted link cannot bounce elsewhere.
  const rawNext = searchParams.get('next') || '';
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/dashboard';

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [error, setError] = useState('');
  const [turnstileToken, setTurnstileToken] = useState(null);
  const [turnstileReset, setTurnstileReset] = useState(0);

  // A signed-in visitor lands on the dashboard. <Navigate> instead of calling
  // navigate() here: a state update during render is a React error.
  if (isAuthenticated) return <Navigate to={next} replace />;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setSubmitting(true);
    try {
      await register({ name, email, password, turnstileToken });
      // Register never returns a session (CONTRACT.md), so the trial is
      // redeemed by the first authenticated page — VerifyEmail or Dashboard.
      // Trying here was a guaranteed 401 plus the interceptor's doomed
      // /auth/refresh on every single signup.
      if (wantsTrial) markPendingTrial();
      toast.success(
        wantsTrial
          ? 'Account created! Sign in to start your 7-day Pro trial.'
          : 'Account created! Please check your email to verify.'
      );
      // The toast is gone in a few seconds; the sign-in page also gets the
      // address (to prefill) and the fact that it is fresh, so it can keep
      // saying "check your inbox" for as long as the person is looking at it.
      navigate(`/login?next=${encodeURIComponent(next)}&registered=1`, {
        replace: true, state: { registeredEmail: email, wantsTrial },
      });
    } catch (err) {
      const msg =
        err?.response?.data?.error?.message ||
        err?.message ||
        'Registration failed. Please try again.';
      setError(msg);
      setTurnstileReset((n) => n + 1);
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * "Continue with Google" from the sign-up page. Unlike password registration,
   * this returns a live session straight away — so a ?trial=1 sign-up can redeem
   * its Pro trial here and land on the dashboard instead of the login page.
   */
  const handleGoogle = async (credential, nonce) => {
    setError('');
    setGoogleBusy(true);
    try {
      // Google signs an EXISTING user straight in, so this page cannot assume it
      // created anything — `created` is what tells the two apart.
      const result = await loginWithGoogle(credential, nonce);
      if (result?.twoFactor) {
        // An existing account with two-factor on: finish on the sign-in page,
        // which owns the code prompt. The trial intent is kept for after that.
        if (wantsTrial) markPendingTrial();
        navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true, state: { challenge: result.challenge } });
        return;
      }
      const { created } = result;
      let trialStarted = false;
      if (wantsTrial) {
        markPendingTrial();
        try {
          const { started } = await startTrial();
          if (started) {
            clearPendingTrial();
            trialStarted = true;
          }
        } catch {
          // Dashboard will pick the pending trial up.
        }
      }
      toast.success(
        trialStarted
          ? (created
            ? 'Account ready — your 7-day Pro trial has started.'
            : 'Welcome back — your 7-day Pro trial has started.')
          : (created
            ? 'Account created — welcome to Nexa!'
            : 'Welcome back — signed in with Google.')
      );
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
          <span className="eyebrow"><span className="eyebrow-dot" />{wantsTrial ? '7-day Pro trial · no card needed' : 'Start moving faster'}</span>
        </div>
        <Card className="auth-card !p-8 sm:!p-9">
          <h1 className="text-3xl font-extrabold tracking-tight text-white">Create your <span className="text-gradient">account.</span></h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            {wantsTrial
              ? 'Your Pro trial starts the moment you sign in. No card, no auto-charge.'
              : 'Start downloading faster — it’s free.'}
          </p>

          {googleAuthEnabled() && (
            <div className="mt-7">
              <GoogleButton
                onCredential={handleGoogle}
                onError={setError}
                disabled={busy}
                text="signup_with"
                fallback="Google sign-up could not load. Create your account with the form below."
              />
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-7 space-y-4" noValidate>
            <Input
              label="Name"
              name="name"
              placeholder="John Doe"
              type="text"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
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
            <Input
              label="Password"
              name="password"
              placeholder="At least 8 characters"
              type="password"
              autoComplete="new-password"
              required
              hint="At least 8 characters — not your email, and not one seen in a data breach"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            {error && (
              <div role="alert" className="rounded-[var(--radius-2)] border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            )}

            <Turnstile onToken={setTurnstileToken} resetKey={turnstileReset} />

            <Button type="submit" className="w-full" disabled={busy || (turnstileEnabled() && !turnstileToken)}>
              {submitting ? 'Creating account…' : googleBusy ? 'Continuing with Google…' : wantsTrial ? 'Create account & start trial' : 'Create account'}
            </Button>
          </form>

          <p className="mt-6 text-center text-xs leading-5 text-slate-500">
            By creating an account you agree to the{' '}
            {/* Underlined, not just tinted: these sat inside slate-500 prose as
                slate-300 with a hover-only underline, so on a static page the
                only thing marking them as links was a shade of grey. */}
            <Link to="/terms" className="text-slate-300 underline underline-offset-2 hover:text-brand-300">Terms</Link> and{' '}
            <Link to="/privacy" className="text-slate-300 underline underline-offset-2 hover:text-brand-300">Privacy Policy</Link>.
          </p>
          <p className="mt-4 text-center text-sm text-slate-500">
            Already have an account?{' '}
            <Link
              to="/login"
              className="font-medium text-brand-300 hover:text-brand-200 hover:underline"
            >
              Sign in
            </Link>
          </p>
        </Card>
      </div>
    </Section>
  );
}
