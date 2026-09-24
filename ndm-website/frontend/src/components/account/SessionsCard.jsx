import { useCallback, useEffect, useState } from 'react';
import api, { unwrap } from '../../api/client';
import Card from '../Card';
import Button from '../Button';
import Skeleton, { useArrival } from '../Skeleton';
import { useToast } from '../Toast';

const errorMessage = (err, fallback) => err?.response?.data?.error?.message || err?.message || fallback;

/**
 * A readable label for a User-Agent string — "Chrome on Windows", "Safari on
 * iPhone". Deliberately coarse: the point is that the person recognises their
 * own devices in the list, not forensic accuracy.
 */
export function describeUserAgent(ua) {
  const s = String(ua || '');
  if (!s) return 'Unknown browser';
  const os =
    /iPhone|iPad/.test(s) ? (/iPad/.test(s) ? 'iPad' : 'iPhone')
      : /Android/.test(s) ? 'Android'
        : /Windows/.test(s) ? 'Windows'
          : /Mac OS X|Macintosh/.test(s) ? 'macOS'
            : /CrOS/.test(s) ? 'ChromeOS'
              : /Linux/.test(s) ? 'Linux'
                : null;
  const browser =
    /Edg\//.test(s) ? 'Edge'
      : /OPR\/|Opera/.test(s) ? 'Opera'
        : /SamsungBrowser/.test(s) ? 'Samsung Internet'
          : /Firefox\//.test(s) ? 'Firefox'
            : /Chrome\/|CriOS/.test(s) ? 'Chrome'
              : /Safari\//.test(s) ? 'Safari'
                : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || s.slice(0, 40);
}

function relative(value) {
  if (!value) return '—';
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The browsers this account is signed in on (GET /user/sessions). Each row is
 * one refresh-token family; signing one out revokes it on the server, so the
 * next request from that browser fails even if it still holds a valid access
 * token for a few minutes.
 */
export default function SessionsCard() {
  const toast = useToast();
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const arrive = useArrival(sessions === null && !error);

  const load = useCallback(async () => {
    try {
      const data = unwrap(await api.get('/user/sessions'));
      setSessions(data.sessions || []);
    } catch (err) {
      setError(errorMessage(err, 'Could not load your sessions.'));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const revoke = async (id) => {
    setBusyId(id);
    setError('');
    try {
      await api.delete(`/user/sessions/${id}`);
      toast.success('That session was signed out.');
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not sign out that session.'));
    } finally {
      setBusyId(null);
    }
  };

  const revokeOthers = async () => {
    setBusyId('others');
    setError('');
    try {
      const data = unwrap(await api.post('/user/sessions/revoke-others'));
      toast.success(data.revoked ? `Signed out ${data.revoked} other session${data.revoked === 1 ? '' : 's'}.` : 'No other sessions.');
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not sign out the other sessions.'));
    } finally {
      setBusyId(null);
    }
  };

  const others = (sessions || []).filter((s) => !s.current).length;

  return (
    <Card className="card-hover !p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-white">Where you&rsquo;re signed in</h3>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Every browser holding a session on this account. Sign out anything you don&rsquo;t recognise —
            then change your password.
          </p>
        </div>
        <Button variant="ghost" onClick={revokeOthers} disabled={busyId !== null || others === 0}>
          {busyId === 'others' ? 'Signing out…' : 'Sign out everywhere else'}
        </Button>
      </div>

      {error && (
        <div role="alert" className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
          {error}
        </div>
      )}

      {sessions === null ? (
        error ? null : (
          // Two rows as they will land — the browser, when it was last used,
          // and the button to sign it out.
          <div className="mt-5 divide-y divide-[var(--color-surface-border)]" role="status" aria-label="Loading your sessions">
            {[0, 1].map((i) => (
              <div key={i} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <Skeleton className="h-4 w-40 rounded" />
                  <Skeleton className="mt-2 h-3 w-56 max-w-full rounded" />
                </div>
                <Skeleton className="h-11 w-24 shrink-0 rounded-[var(--radius-2)]" />
              </div>
            ))}
          </div>
        )
      ) : sessions.length === 0 ? (
        <p className={`mt-5 text-sm text-slate-500 ${arrive}`.trim()}>No sessions.</p>
      ) : (
        <ul className={`mt-5 divide-y divide-[var(--color-surface-border)] ${arrive}`.trim()} data-testid="session-list">
          {sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-medium text-white">
                  {describeUserAgent(s.userAgent)}
                  {s.current && (
                    <span className="ml-2 rounded-full border border-brand-400/40 bg-brand-400/10 px-2 py-0.5 text-[11px] font-semibold text-brand-200">
                      This browser
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {s.ip || 'unknown address'} · last active {relative(s.lastUsedAt || s.createdAt)}
                </p>
              </div>
              {!s.current && (
                <Button variant="ghost" className="!py-1.5 !text-sm" onClick={() => revoke(s.id)} disabled={busyId !== null}>
                  {busyId === s.id ? 'Signing out…' : 'Sign out'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
