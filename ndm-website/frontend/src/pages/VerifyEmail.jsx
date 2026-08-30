import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import { hasPendingTrial, startTrial } from '../api/trial';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';
import Spinner from '../components/Spinner';

export default function VerifyEmail() {
  usePageMeta({ title: 'Verify email', description: 'Confirm your Nexa Download Manager account email address.' });

  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const [status, setStatus] = useState('pending');
  const trialPending = hasPendingTrial();

  useEffect(() => {
    if (!token) {
      setStatus('missing');
      return;
    }

    let cancelled = false;
    const verify = async () => {
      try {
        await api.post('/auth/verify-email', { token });
        if (!cancelled) setStatus('success');
        // A registration that asked for the trial: try now (works if a session
        // exists), otherwise Dashboard redeems the pending flag after sign-in.
        if (hasPendingTrial()) {
          try {
            await startTrial();
          } catch {
            // not signed in yet — ignored
          }
        }
      } catch {
        if (!cancelled) setStatus('error');
      }
    };
    verify();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (status === 'pending') {
    return (
      <Section className="auth-section flex min-h-[60vh] items-center">
        <div className="mx-auto text-center">
          <Spinner size={32} />
          <p className="mt-4 text-zinc-400">Verifying your email…</p>
        </div>
      </Section>
    );
  }

  if (status === 'missing') {
    return (
      <Section className="auth-section flex min-h-[60vh] items-center">
        <div className="mx-auto w-full max-w-md">
          <Card className="auth-card !p-8 text-center sm:!p-9">
            <h1 className="text-2xl font-bold text-white">Invalid link</h1>
            <p className="mt-3 text-zinc-400">
              This verification link is missing a token. Please check your email
              for the correct link.
            </p>
          </Card>
        </div>
      </Section>
    );
  }

  return (
    <Section className="auth-section flex min-h-[60vh] items-center">
      <div className="mx-auto w-full max-w-md">
        <Card className="auth-card !p-8 text-center sm:!p-9">
          {status === 'success' ? (
            <>
              <div className="mx-auto mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-brand-400/25 bg-brand-400/10 text-brand-300 shadow-[0_0_26px_-10px_rgba(43,199,255,0.9)]">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              </div>
              <h1 className="text-2xl font-bold text-white">Email verified</h1>
              <p className="mt-3 text-zinc-400">
                {trialPending
                  ? 'Your email is confirmed. Sign in and your 7-day Pro trial starts automatically.'
                  : 'Your email has been confirmed. You can now sign in to your account.'}
              </p>
              <div className="mt-6">
                <Link to="/login?next=/dashboard" className="btn btn-primary">
                  Sign in
                </Link>
              </div>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-white">Verification failed</h1>
              <p className="mt-3 text-zinc-400">
                The verification link is invalid or has expired. Please request a
                new one or contact support.
              </p>
              <div className="mt-6">
                <Link to="/login" className="btn btn-primary">
                  Back to sign in
                </Link>
              </div>
            </>
          )}
        </Card>
      </div>
    </Section>
  );
}
