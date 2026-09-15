import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../api/client';
import { useToast } from '../components/Toast';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Input from '../components/Input';
import GoogleButton, { googleAuthEnabled, refreshNonce } from '../components/GoogleButton';
import usePageMeta from '../hooks/usePageMeta';

export default function Login() {
  usePageMeta({ title: "Sign in", description: "Sign in to your Nexa Download Manager account to manage your plan, license key and billing." });

  const { login, completeTwoFactor, loginWithGoogle, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  // Arriving straight from a successful registration: the address is known
  // (router state survives the redirect; the query flag survives a reload),
  // so prefill it and keep the "verify first" notice on screen rather than
  // relying on a toast that vanished before the page finished loading.
  const justRegistered = searchParams.get('registered') === '1';
  const registeredEmail = (location.state && location.state.registeredEmail) || '';

  const [email, setEmail] = useState(registeredEmail);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [error, setError] = useState('');
  // Set when the server refuses a sign-in because the address is unverified.
  // Without an offer to re-send, that refusal is a dead end: the original link
  // expires after an hour and there is no signed-in page to ask from.
  const [needsVerification, setNeedsVerification] = useState(false);
  // Two-factor: the password (or Google) checked out and the server handed
  // back a short-lived challenge; the code from the authenticator app (or a
  // recovery code) turns it into a session.
  const [challenge, setChallenge] = useState((location.state && location.state.challenge) || null);
  const [code, setCode] = useState('');
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
      const result = await login(email, password);
      if (result?.twoFactor) {
        setChallenge(result.challenge);
        setCode('');
        return;
      }
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
  const handleGoogle = async (credential, nonce) => {
    setError('');
    setGoogleBusy(true);
    try {
      const result = await loginWithGoogle(credential, nonce);
      if (result?.twoFactor) {
        setChallenge(result.challenge);
        setCode('');
        return;
      }
      toast.success(result.created ? 'Account created — welcome to Nexa!' : 'Logged in successfully.');
      navigate(next, { replace: true });
    } catch (err) {
      if (err?.response?.data?.error?.code === 'GOOGLE_NONCE_INVALID') {
        // The 30-minute nonce lapsed while the page sat open: mint a new one so
        // the next click works, instead of asking for a reload.
        refreshNonce().catch(() => {});
      }
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

  const handleCode = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await completeTwoFactor(challenge, code.trim());
      toast.success('Logged in successfully.');
      navigate(next, { replace: true });
    } catch (err) {
      const errCode = err?.response?.data?.error?.code;
      if (errCode === 'INVALID_CHALLENGE') {
        // The five-minute prompt lapsed: back to the password step.
        setChallenge(null);
        setError('That code prompt has expired. Please sign in again.');
      } else {
        setError(err?.response?.data?.error?.message || err?.message || 'That code is not valid.');
      }
    } finally {
      setSubmitting(false);
    }
  };

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

          {justRegistered && (
            <div role="status" className="mt-5 rounded-[var(--radius-2)] border border-emerald-400/25 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100">
              <strong className="font-semibold">Account created.</strong> We sent a verification
              link{registeredEmail ? <> to <span className="font-semibold">{registeredEmail}</span></> : null}.
              Open it, then sign in here{location.state && location.state.wantsTrial ? ' to start your 7-day Pro trial' : ''}.
              Nothing in your inbox? Check spam, or use the button below after a first sign-in attempt to get a new link.
            </div>
          )}

          {googleAuthEnabled() && (
            <div className="mt-7">
              <GoogleButton onCredential={handleGoogle} onError={setError} disabled={busy} />
            </div>
          )}

          {challenge ? (
            <form onSubmit={handleCode} className="mt-7 space-y-4" noValidate aria-labelledby="two-factor-title">
              <h2 id="two-factor-title" className="text-lg font-bold text-white">Enter your verification code</h2>
              <p className="text-sm text-slate-300">
                Open your authenticator app and type the 6-digit code for Nexa Download Manager.
                Lost the device? A recovery code works here too.
              </p>
              <Input
                label="Verification code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              {error && (
                <div role="alert" className="rounded-[var(--radius-2)] border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-200">
                  {error}
                </div>
              )}
              <Button type="submit" className="w-full" disabled={submitting || !code.trim()}>
                {submitting ? 'Checking…' : 'Verify and sign in'}
              </Button>
              <button
                type="button"
                onClick={() => { setChallenge(null); setError(''); }}
                className="block w-full text-center text-sm text-slate-400 underline underline-offset-2 hover:text-white"
              >
                Back to sign in
              </button>
            </form>
          ) : (
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

                  A staff/creator line used to sit here too. It was safe by the
                  same argument — shown for every failed sign-in, including
                  addresses with no account — but it earned nothing: it read as
                  an accusation to the one person who typed the creator's
                  address, and it told every other visitor that this site has an
                  admin console and who might hold one. The person who actually
                  needs to know is told privately, in the mailbox that owns the
                  account (sendControlPanelSignInAttemptEmail), which is where
                  the explanation belongs.
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
          )}

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
