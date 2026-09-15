import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api, { unwrap } from '../api/client';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Input from '../components/Input';
import usePageMeta from '../hooks/usePageMeta';

const errorMessage = (err, fallback) => err?.response?.data?.error?.message || err?.message || fallback;
const errorCode = (err) => err?.response?.data?.error?.code;

/** "abcd1234" / "ABCD-1234" / "abcd 1234" → "ABCD-1234"; '' while incomplete. */
export function normaliseCode(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

function minutesAgo(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(t)) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m === 0 ? 'just now' : `${m} min ago`;
}

/**
 * /activate — the website half of signing in to the desktop app.
 *
 * The app shows a short code and opens this page with it filled in. The
 * person, signed in here, sees which machine is asking and approves or
 * denies it; the app, polling in the background, then receives a device
 * token bound to that machine. No licence key changes hands at any point.
 */
export default function Activate() {
  usePageMeta({ title: 'Connect a device', description: 'Approve the Nexa Download Manager app on a computer you are signing in on.' });
  const { user } = useAuth();
  const [params] = useSearchParams();
  const [code, setCode] = useState(() => normaliseCode(params.get('code')));
  const [device, setDevice] = useState(null);
  const [looking, setLooking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errCode, setErrCode] = useState('');
  const [outcome, setOutcome] = useState(null);   // 'approved' | 'denied'

  const lookUp = useCallback(async (value) => {
    const c = normaliseCode(value);
    if (c.length !== 9) return;
    setLooking(true);
    setError('');
    setErrCode('');
    setDevice(null);
    try {
      setDevice(unwrap(await api.get(`/device/code/${encodeURIComponent(c)}`)));
    } catch (err) {
      setErrCode(errorCode(err) || '');
      setError(errorMessage(err, 'Could not find that code.'));
    } finally {
      setLooking(false);
    }
  }, []);

  useEffect(() => { lookUp(code); }, [lookUp, code]);

  const decide = async (approve) => {
    setBusy(true);
    setError('');
    setErrCode('');
    try {
      await api.post(approve ? '/device/approve' : '/device/deny', { user_code: normaliseCode(code) });
      setOutcome(approve ? 'approved' : 'denied');
    } catch (err) {
      setErrCode(errorCode(err) || '');
      setError(errorMessage(err, approve ? 'Could not approve that device.' : 'Could not deny that device.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section>
      <div className="mx-auto max-w-lg">
        <span className="eyebrow"><span className="eyebrow-dot" />Connect a device</span>
        <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-white">
          {outcome === 'approved' ? 'You’re signed in.' : outcome === 'denied' ? 'Sign-in denied.' : 'Sign in on this computer?'}
        </h1>

        {outcome === 'approved' && (
          <Card className="mt-6 !p-6" data-testid="activate-approved">
            <p className="text-sm leading-6 text-slate-300">
              <span className="font-semibold text-white">{device?.deviceName || 'The app'}</span> is now signed in as{' '}
              <span className="font-semibold text-white">{user?.email}</span>. Go back to Nexa Download Manager — it picks this
              up on its own within a few seconds. You can close this tab.
            </p>
            <p className="mt-4 text-xs text-slate-500">
              Not you? Sign the device out from your <Link to="/dashboard" className="text-slate-300 underline-offset-2 hover:text-brand-300 hover:underline">dashboard</Link> and change your password.
            </p>
          </Card>
        )}

        {outcome === 'denied' && (
          <Card className="mt-6 !p-6" data-testid="activate-denied">
            <p className="text-sm leading-6 text-slate-300">
              That sign-in was refused and the code is now useless. If you did not start it yourself, someone had
              physical access to that computer — nothing on your account changed.
            </p>
            <div className="mt-4"><Link to="/dashboard" className="btn btn-ghost">Back to dashboard</Link></div>
          </Card>
        )}

        {!outcome && (
          <Card className="mt-6 !p-6">
            <p className="text-sm leading-6 text-slate-400">
              Nexa Download Manager on a computer is asking to use <span className="font-semibold text-slate-200">{user?.email}</span>.
              Check the code matches the one the app shows, then approve it.
            </p>
            <div className="mt-5">
              <Input
                label="Code shown in the app"
                name="code"
                placeholder="ABCD-1234"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                value={code}
                onChange={(e) => setCode(normaliseCode(e.target.value))}
                className="font-mono text-lg tracking-[0.2em]"
              />
            </div>

            {looking && <p className="mt-4 text-sm text-slate-500">Looking up that code…</p>}

            {device && (
              <div className="mt-5 rounded-[var(--radius-2)] border border-[var(--color-surface-border)] bg-black/20 p-4" data-testid="activate-device">
                <p className="text-sm font-semibold text-white">{device.deviceName}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {device.appVersion ? `Nexa ${device.appVersion} · ` : ''}asked {minutesAgo(device.requestedAt)}
                </p>
              </div>
            )}

            {error && (
              <div role="alert" className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
                {error}
                {errCode === 'EMAIL_NOT_VERIFIED' && (
                  <p className="mt-1 text-red-200/80">
                    Open the verification link we emailed you, or request a new one from the{' '}
                    <Link to="/login" className="underline underline-offset-2">sign-in page</Link>.
                  </p>
                )}
              </div>
            )}

            <div className="mt-6 flex flex-wrap gap-3">
              <Button onClick={() => decide(true)} disabled={busy || !device}>
                {busy ? 'Working…' : 'Approve this computer'}
              </Button>
              <Button variant="ghost" onClick={() => decide(false)} disabled={busy || !device}>Deny</Button>
            </div>
            <p className="mt-4 text-xs leading-5 text-slate-500">
              Only approve a code you are looking at yourself. Approving signs that computer in to your account —
              it appears on your dashboard, where you can sign it out at any time.
            </p>
          </Card>
        )}
      </div>
    </Section>
  );
}
