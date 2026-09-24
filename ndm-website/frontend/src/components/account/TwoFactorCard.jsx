import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import api, { unwrap } from '../../api/client';
import Card from '../Card';
import Button from '../Button';
import Input from '../Input';
import Skeleton from '../Skeleton';
import { useToast } from '../Toast';

const errorMessage = (err, fallback) => err?.response?.data?.error?.message || err?.message || fallback;

/**
 * Two-factor authentication for a customer account (POST /auth/2fa/*).
 *
 * Off → "Turn on" fetches a fresh secret, renders it as a QR code (and as text
 * for people who cannot scan), and one correct code from the app switches it
 * on. The recovery codes come back exactly once, so they are shown until the
 * person dismisses them. On → the account shows how many recovery codes are
 * left and a "Turn off" form that wants the password (when the account has
 * one — a Google-created account does not) plus a current code.
 */
export default function TwoFactorCard({ user }) {
  const toast = useToast();
  const [state, setState] = useState(null);          // { enabled, pending, recoveryCodesLeft }
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [setup, setSetup] = useState(null);          // { secret, otpauthUrl, qr }
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState(null);

  const [disableOpen, setDisableOpen] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');

  const load = useCallback(async () => {
    try {
      setState(unwrap(await api.get('/auth/2fa')));
    } catch (err) {
      setError(errorMessage(err, 'Could not load the two-factor status.'));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const startSetup = async () => {
    setBusy(true);
    setError('');
    try {
      const data = unwrap(await api.post('/auth/2fa/setup'));
      const qr = await QRCode.toDataURL(data.otpauthUrl, { margin: 1, width: 196, errorCorrectionLevel: 'M' });
      setSetup({ ...data, qr });
      setCode('');
    } catch (err) {
      setError(errorMessage(err, 'Could not start the setup.'));
    } finally {
      setBusy(false);
    }
  };

  const enable = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = unwrap(await api.post('/auth/2fa/enable', { code: code.trim() }));
      setRecoveryCodes(data.recoveryCodes || []);
      setSetup(null);
      setCode('');
      toast.success('Two-factor authentication is on.');
      await load();
    } catch (err) {
      setError(errorMessage(err, 'That code did not verify.'));
    } finally {
      setBusy(false);
    }
  };

  const disable = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { code: disableCode.trim() };
      if (user.hasPassword) body.password = disablePassword;
      await api.post('/auth/2fa/disable', body);
      setDisableOpen(false);
      setDisablePassword('');
      setDisableCode('');
      setRecoveryCodes(null);
      toast.success('Two-factor authentication is off.');
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not turn off two-factor authentication.'));
    } finally {
      setBusy(false);
    }
  };

  const copyCodes = async () => {
    if (!recoveryCodes) return;
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'));
      toast.success('Recovery codes copied.');
    } catch {
      setError('Clipboard is not available — write the codes down.');
    }
  };

  const enabled = Boolean(state?.enabled);

  return (
    <Card className="card-hover !p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-white">Two-factor authentication</h3>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            A 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password…) is asked for
            at every sign-in, so a stolen password alone cannot open your account.
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold ${
            enabled
              ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
              : 'border-[var(--color-surface-border)] text-slate-400'
          }`}
          data-testid="two-factor-status"
        >
          {state ? (enabled ? 'On' : 'Off') : '…'}
        </span>
      </div>

      {/* Where the button will be, until the status says which one — it
          arriving on its own pushed the sessions card below it down. */}
      {state === null && !error && (
        <div className="mt-5" role="status" aria-label="Loading two-factor status">
          <Skeleton className="h-11 w-28 rounded-[var(--radius-2)]" />
        </div>
      )}

      {error && (
        <div role="alert" className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
          {error}
        </div>
      )}

      {recoveryCodes && (
        <div className="mt-5 rounded-[var(--radius-2)] border border-amber-400/30 bg-amber-400/10 p-4">
          <h4 className="font-semibold text-amber-100">Save your recovery codes</h4>
          <p className="mt-1 text-sm leading-6 text-amber-100/80">
            Each code signs you in once if you lose your phone. They are shown only now.
          </p>
          <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm text-white" data-testid="recovery-codes">
            {recoveryCodes.map((c) => <li key={c}>{c}</li>)}
          </ul>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button variant="ghost" onClick={copyCodes}>Copy codes</Button>
            <Button variant="ghost" onClick={() => setRecoveryCodes(null)}>I have saved them</Button>
          </div>
        </div>
      )}

      {!enabled && !setup && state && (
        <div className="mt-5">
          <Button onClick={startSetup} disabled={busy}>{busy ? 'Preparing…' : 'Turn on'}</Button>
        </div>
      )}

      {!enabled && setup && (
        <form onSubmit={enable} className="mt-5 space-y-4" noValidate>
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
            <img
              src={setup.qr}
              alt="QR code for your authenticator app"
              width="196"
              height="196"
              className="rounded-lg bg-white p-1"
            />
            <div className="min-w-0 text-sm leading-6 text-slate-300">
              <p><span className="font-semibold text-white">1.</span> Scan this with your authenticator app.</p>
              <p className="mt-2"><span className="font-semibold text-white">2.</span> Can&rsquo;t scan? Enter this key by hand:</p>
              <code className="mt-1 block break-all rounded-md bg-black/30 px-2 py-1 font-mono text-xs text-slate-100" data-testid="totp-secret">
                {setup.secret}
              </code>
              <p className="mt-2"><span className="font-semibold text-white">3.</span> Type the 6-digit code it shows.</p>
            </div>
          </div>
          <Input
            label="Code from the app"
            name="totpCode"
            placeholder="123456"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={busy || code.trim().length !== 6}>
              {busy ? 'Checking…' : 'Verify and turn on'}
            </Button>
            <Button variant="ghost" onClick={() => { setSetup(null); setError(''); }} disabled={busy}>Cancel</Button>
          </div>
        </form>
      )}

      {enabled && (
        <div className="mt-5">
          <p className="text-sm text-slate-400">
            {state.recoveryCodesLeft} recovery code{state.recoveryCodesLeft === 1 ? '' : 's'} left.
            {state.recoveryCodesLeft <= 2 && ' Turn two-factor off and on again to get a fresh set.'}
          </p>
          {!disableOpen ? (
            <div className="mt-4">
              <Button variant="ghost" onClick={() => { setDisableOpen(true); setError(''); }}>Turn off…</Button>
            </div>
          ) : (
            <form onSubmit={disable} className="mt-4 space-y-4" noValidate>
              {user.hasPassword && (
                <Input
                  label="Password"
                  name="disablePassword"
                  placeholder="Enter your password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={disablePassword}
                  onChange={(e) => setDisablePassword(e.target.value)}
                />
              )}
              <Input
                label="Code from the app (or a recovery code)"
                name="disableCode"
                placeholder="123456 or a recovery code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
              />
              <div className="flex flex-wrap gap-3">
                <Button
                  type="submit"
                  className="!bg-none !bg-red-500 hover:!bg-red-400 !shadow-none"
                  disabled={busy || !disableCode.trim() || (user.hasPassword && !disablePassword)}
                >
                  {busy ? 'Turning off…' : 'Turn off two-factor'}
                </Button>
                <Button variant="ghost" onClick={() => { setDisableOpen(false); setError(''); }} disabled={busy}>Cancel</Button>
              </div>
            </form>
          )}
        </div>
      )}
    </Card>
  );
}
