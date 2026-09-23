import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api, { unwrap } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Skeleton from '../components/Skeleton';

/**
 * /team/join?token=… — the landing page of a Team invitation email.
 *
 * Shows who invited whom before asking for anything. A signed-out visitor is
 * sent to sign in (or register) with `next` pointing back here, so the accept
 * happens on the account that owns the invited address.
 */
export default function TeamJoin() {
  usePageMeta({ title: 'Join a team', description: 'Accept an invitation to a Nexa Download Manager Team license.' });

  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const { user, loading: authLoading, refreshMe } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [invite, setInvite] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setError('This link is missing its invitation token.');
      setLoading(false);
      return undefined;
    }
    api.get(`/team/invites/${encodeURIComponent(token)}`)
      .then((res) => { if (!cancelled) setInvite(unwrap(res)); })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.response?.data?.error?.message || 'This invitation is no longer valid.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  const here = `/team/join?token=${encodeURIComponent(token)}`;
  const emailMatches = user && invite && String(user.email).toLowerCase() === String(invite.email).toLowerCase();

  const accept = async () => {
    setAccepting(true);
    try {
      await api.post('/team/join', { token });
      await refreshMe();
      toast.success(`You're on ${invite.ownerName}'s team. The license key is on your dashboard.`);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err?.response?.data?.error?.message || 'Could not accept the invitation.');
    } finally {
      setAccepting(false);
    }
  };

  return (
    <Section className="auth-section flex min-h-[70vh] items-center">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-5 text-center">
          <span className="eyebrow"><span className="eyebrow-dot" />Team invitation</span>
        </div>
        <Card className="auth-card !p-8 sm:!p-9">
          {loading || authLoading ? (
            // The invitation card as it will land: who invited whom, a
            // paragraph, and the two ways to accept.
            <div role="status" aria-label="Loading the invitation">
              <Skeleton className="h-8 w-4/5 rounded-lg" />
              {['w-full', 'w-full', 'w-3/5'].map((w, i) => (
                <Skeleton key={i} className={`h-3.5 rounded ${w} ${i ? 'mt-2.5' : 'mt-4'}`} />
              ))}
              <Skeleton className="mt-6 h-11 w-full rounded-[var(--radius-2)]" />
              <Skeleton className="mt-3 h-11 w-full rounded-[var(--radius-2)]" />
            </div>
          ) : error && !invite ? (
            <>
              <h1 className="text-2xl font-extrabold tracking-tight text-white">Invitation not found.</h1>
              <p className="mt-3 text-sm leading-6 text-slate-400">{error}</p>
              <p className="mt-4 text-sm text-slate-500">
                Ask the team owner to send a new invitation from their dashboard.
              </p>
              <div className="mt-6">
                <Button to="/" variant="ghost">Back to home</Button>
              </div>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-extrabold tracking-tight text-white">
                Join <span className="text-gradient">{invite.ownerName}&rsquo;s team.</span>
              </h1>
              <p className="mt-3 text-sm leading-6 text-slate-400">
                {invite.ownerName} invited <span className="font-semibold text-slate-200">{invite.email}</span> to
                their Nexa <span className="capitalize">{invite.plan}</span> plan. Accepting puts the team&rsquo;s
                license key on your dashboard and unlocks Pro features in the app.
              </p>

              {error && (
                <div role="alert" className="mt-4 rounded-[var(--radius-2)] border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-200">
                  {error}
                </div>
              )}

              {!user ? (
                <div className="mt-6 space-y-3">
                  <Button to={`/login?next=${encodeURIComponent(here)}`} className="w-full">
                    Sign in to accept
                  </Button>
                  <Button to={`/register?next=${encodeURIComponent(here)}`} variant="ghost" className="w-full">
                    Create an account
                  </Button>
                  <p className="text-center text-xs text-slate-500">
                    Use <span className="break-all font-medium text-slate-300">{invite.email}</span> — only that address can accept.
                  </p>
                </div>
              ) : emailMatches ? (
                <div className="mt-6 flex flex-wrap gap-3">
                  <Button onClick={accept} disabled={accepting}>
                    {accepting ? 'Joining…' : 'Accept invitation'}
                  </Button>
                  <Button to="/dashboard" variant="ghost">Not now</Button>
                </div>
              ) : (
                <div className="mt-6 space-y-3">
                  <p className="note-warn rounded-xl px-4 py-3 text-sm">
                    You are signed in as <span className="font-semibold">{user.email}</span>, but this invitation
                    is for <span className="font-semibold">{invite.email}</span>. Sign in with that address to accept it.
                  </p>
                  <Link to={`/login?next=${encodeURIComponent(here)}`} className="btn btn-ghost w-full">
                    Switch account
                  </Link>
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </Section>
  );
}
