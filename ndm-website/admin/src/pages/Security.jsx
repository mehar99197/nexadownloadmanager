import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import api, { unwrap } from '../api/client.js';
import Button from '../components/Button.jsx';
import Badge from '../components/Badge.jsx';
import Input from '../components/Input.jsx';
import Modal from '../components/Modal.jsx';
import DataTable from '../components/DataTable.jsx';
import { useAdminAuth } from '../context/AdminAuthContext.jsx';
import { AUTH_NS, IS_ROOT } from '../realm.js';
import { formatDateTime } from '../utils.js';

function errorMessage(err, fallback) {
  // A 4xx makes axios throw before unwrap() runs, so the server's message
  // lives on the response; err.message would be "Request failed with status code 400".
  return err?.response?.data?.error?.message || err?.message || fallback;
}

/**
 * Two-factor authentication for the signed-in control-panel account.
 *
 * Flow: "Turn on" → the API mints a secret (stored, not yet active) → QR code
 * + manual key → the first correct code enables it and returns eight one-time
 * recovery codes, shown exactly once. "Turn off" needs the password and a
 * current code. Everything is per realm: the creator's 2FA is separate from
 * a staff admin's, because they are separate logins.
 */
const SEVERITY_TONE = { critical: 'danger', warning: 'warning', info: 'info' };
const WINDOWS = [
  { hours: 24, label: 'Last 24 hours' },
  { hours: 24 * 7, label: 'Last 7 days' },
  { hours: 24 * 30, label: 'Last 30 days' },
];

/**
 * The security-event feed (GET /api/admin/security/events): failed and
 * locked sign-ins, two-factor outcomes, session replays, Google nonce and
 * token rejections, panel logins — what a SIEM would show, without one.
 * The critical ones also went out by email when they happened
 * (utils/securityEvents.js RULES).
 */
function SecurityEvents() {
  const [hours, setHours] = useState(24);
  const [kind, setKind] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { hours, limit: 200 };
      if (kind) params.kind = kind;
      setData(await unwrap(api.get('/admin/security/events', { params })));
    } catch (err) {
      setError(errorMessage(err, 'Unable to load security events.'));
    } finally {
      setLoading(false);
    }
  }, [hours, kind]);

  useEffect(() => { load(); }, [load]);

  const columns = [
    { key: 'time', header: 'Time', render: (e) => <span className="whitespace-nowrap text-xs text-admin-muted">{formatDateTime(e.created_at)}</span> },
    { key: 'severity', header: 'Severity', render: (e) => <Badge tone={SEVERITY_TONE[e.severity] || 'default'}>{e.severity}</Badge> },
    { key: 'kind', header: 'Event', render: (e) => <span className="rounded-full border border-admin-cyan/20 bg-admin-cyan/10 px-2.5 py-1 text-xs font-semibold text-admin-cyan">{e.kind}</span> },
    { key: 'who', header: 'Account', render: (e) => <div><p className="text-admin-text">{e.email || '—'}</p>{e.user_id && <p className="text-xs text-admin-faint">user #{e.user_id}</p>}</div> },
    { key: 'ip', header: 'From', render: (e) => <div><p className="font-mono text-xs text-admin-text">{e.ip || '—'}</p><p className="max-w-[16rem] truncate text-xs text-admin-faint" title={e.user_agent || ''}>{e.user_agent || ''}</p></div> },
    { key: 'detail', header: 'Detail', render: (e) => <span className="text-admin-muted">{e.detail || ''}</span> },
  ];

  const counts = data?.counts || [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="admin-eyebrow text-admin-faint">Threat detection</p>
          <h3 className="mt-1 text-xl font-bold tracking-tight">Security events</h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-admin-muted">
            Failed and locked sign-ins, two-factor outcomes, session replays and rejected Google credentials.
            Critical events are also emailed to the security contact as they happen.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Time window"
            className="admin-input !w-auto"
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          >
            {WINDOWS.map((w) => <option key={w.hours} value={w.hours}>{w.label}</option>)}
          </select>
          <Button variant="secondary" onClick={load} disabled={loading}>Refresh</Button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-admin-danger/30 bg-admin-danger/10 px-4 py-3 text-sm text-admin-danger">{error}</div>}

      {counts.length > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="security-event-counts">
          <button
            type="button"
            onClick={() => setKind('')}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${kind === '' ? 'border-admin-cyan bg-admin-cyan/10 text-admin-cyan' : 'border-admin-border text-admin-muted'}`}
          >
            All ({counts.reduce((n, c) => n + c.n, 0)})
          </button>
          {counts.map((c) => (
            <button
              key={`${c.kind}-${c.severity}`}
              type="button"
              onClick={() => setKind(c.kind)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${kind === c.kind ? 'border-admin-cyan bg-admin-cyan/10 text-admin-cyan' : 'border-admin-border text-admin-muted'}`}
            >
              {c.kind} ({c.n})
            </button>
          ))}
        </div>
      )}

      <div className="admin-card !p-0">
        <DataTable
          columns={columns}
          rows={data?.events || []}
          loading={loading}
          emptyMessage="Nothing recorded in this window."
          caption="Recent security events"
        />
      </div>
    </div>
  );
}

export default function Security() {
  const { admin, refreshAdmin, mustEnrol } = useAdminAuth();
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  // Enrolment
  const [setup, setSetup] = useState(null);       // { secret, otpauthUrl, qr }
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState(null);

  // Disable
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableForm, setDisableForm] = useState({ password: '', code: '' });

  const load = useCallback(async () => {
    try {
      setState(await unwrap(api.get(`${AUTH_NS}/2fa`)));
    } catch (err) {
      setError(errorMessage(err, 'Unable to load two-factor status.'));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const startSetup = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const data = await unwrap(api.post(`${AUTH_NS}/2fa/setup`));
      const qr = await QRCode.toDataURL(data.otpauthUrl, { margin: 1, width: 196, errorCorrectionLevel: 'M' });
      setSetup({ ...data, qr });
      setCode('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to start the setup.'));
    } finally {
      setBusy(false);
    }
  };

  const enable = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await unwrap(api.post(`${AUTH_NS}/2fa/enable`, { code: code.trim() }));
      setRecoveryCodes(data.recoveryCodes || []);
      setSetup(null);
      setNotice('Two-factor authentication is on. Save your recovery codes now — they are shown only once.');
      await load();
      await refreshAdmin?.();
    } catch (err) {
      setError(errorMessage(err, 'That code did not verify.'));
    } finally {
      setBusy(false);
    }
  };

  const disable = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await unwrap(api.post(`${AUTH_NS}/2fa/disable`, disableForm));
      setDisableOpen(false);
      setDisableForm({ password: '', code: '' });
      setRecoveryCodes(null);
      setNotice('Two-factor authentication is off.');
      await load();
      await refreshAdmin?.();
    } catch (err) {
      setError(errorMessage(err, 'Unable to turn off two-factor authentication.'));
    } finally {
      setBusy(false);
    }
  };

  const copyCodes = async () => {
    if (!recoveryCodes) return;
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'));
      setNotice('Recovery codes copied.');
    } catch {
      setError('Clipboard is not available — write the codes down.');
    }
  };

  const enabled = Boolean(state?.enabled);

  return (
    <div className="space-y-6">
      <div>
        <p className="admin-eyebrow text-admin-faint">Account security</p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">Two-factor authentication</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-admin-muted">
          A second step on {IS_ROOT ? 'the creator' : 'your staff'} sign-in: a 6-digit code from an
          authenticator app (Google Authenticator, 1Password, Authy, Aegis…). A leaked password alone then
          opens nothing.
        </p>
      </div>

      {mustEnrol && (
        <div role="alert" data-testid="enrol-required" className="rounded-xl border border-admin-warning/40 bg-admin-warning/10 px-4 py-3 text-sm text-admin-text">
          <p className="font-semibold">Two-factor authentication is required for this panel.</p>
          <p className="mt-1 text-admin-muted">
            Every other screen stays locked until this account has an authenticator enrolled. Turn it on below —
            it takes a minute.
          </p>
        </div>
      )}
      {error && <div className="rounded-xl border border-admin-danger/30 bg-admin-danger/10 px-4 py-3 text-sm text-admin-danger">{error}</div>}
      {notice && <div className="rounded-xl border border-admin-success/30 bg-admin-success/10 px-4 py-3 text-sm text-admin-success">{notice}</div>}

      <div className="admin-card">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-admin-text">{admin?.email}</p>
            <p className="mt-1 text-xs text-admin-muted">
              {state === null ? 'Checking…' : enabled
                ? `On · ${state.recoveryCodesLeft} recovery code${state.recoveryCodesLeft === 1 ? '' : 's'} left`
                : 'Off — password only'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Badge tone={enabled ? 'success' : 'warning'}>{enabled ? '2FA on' : '2FA off'}</Badge>
            {enabled ? (
              <Button variant="secondary" onClick={() => setDisableOpen(true)} disabled={busy}>Turn off</Button>
            ) : (
              <Button onClick={startSetup} disabled={busy || Boolean(setup)}>
                {busy && !setup ? 'Preparing…' : 'Turn on'}
              </Button>
            )}
          </div>
        </div>

        {setup && (
          <div className="mt-6 grid gap-6 border-t border-admin-border pt-6 md:grid-cols-[auto_1fr]">
            <div className="rounded-xl bg-white p-2">
              <img src={setup.qr} alt="Scan this QR code with your authenticator app" width="196" height="196" className="block" />
            </div>
            <form onSubmit={enable} className="space-y-4">
              <div>
                <p className="text-sm font-semibold text-admin-text">1. Scan the code</p>
                <p className="mt-1 text-xs text-admin-muted">
                  Or enter this key by hand:{' '}
                  <code className="rounded bg-admin-surface-2 px-1.5 py-0.5 font-mono text-[0.75rem] tracking-wider text-admin-text">
                    {setup.secret.replace(/(.{4})/g, '$1 ').trim()}
                  </code>
                </p>
              </div>
              <div>
                <p className="text-sm font-semibold text-admin-text">2. Enter the 6-digit code it shows</p>
                <Input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  placeholder="123456"
                  className="mt-2 max-w-[12rem]"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  required
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy || code.length !== 6}>{busy ? 'Verifying…' : 'Verify and turn on'}</Button>
                <Button variant="ghost" onClick={() => setSetup(null)} disabled={busy}>Cancel</Button>
              </div>
            </form>
          </div>
        )}

        {recoveryCodes && (
          <div className="mt-6 border-t border-admin-border pt-6">
            <p className="text-sm font-semibold text-admin-text">Recovery codes</p>
            <p className="mt-1 text-xs text-admin-muted">
              Each code signs you in once if you lose your phone. Store them somewhere safe — this is the only
              time they are shown.
            </p>
            <ul data-testid="recovery-codes" className="mt-3 grid max-w-md grid-cols-2 gap-2 font-mono text-sm text-admin-text">
              {recoveryCodes.map((c) => (
                <li key={c} className="rounded-lg border border-admin-border bg-admin-surface-2 px-3 py-1.5 tracking-wider">{c}</li>
              ))}
            </ul>
            <div className="mt-3 flex gap-2">
              <Button variant="secondary" size="sm" onClick={copyCodes}>Copy codes</Button>
              <Button variant="ghost" size="sm" onClick={() => setRecoveryCodes(null)}>I have saved them</Button>
            </div>
          </div>
        )}
      </div>

      <div className="admin-card">
        <p className="text-sm font-semibold text-admin-text">Lost your authenticator?</p>
        <p className="mt-1 text-sm leading-6 text-admin-muted">
          Sign in with one of your recovery codes, then turn 2FA off and on again to enrol a new device.
          {IS_ROOT
            ? ' As the creator you can also reset a staff admin’s 2FA from the Admins screen.'
            : ' With no codes left, ask the creator to reset your 2FA from the root console.'}
        </p>
      </div>

      {!mustEnrol && <SecurityEvents />}

      <Modal
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        title="Turn off two-factor authentication"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setDisableOpen(false)}>Keep it on</Button>
            <Button variant="danger" onClick={disable} disabled={busy || !disableForm.password || disableForm.code.length < 6}>
              {busy ? 'Turning off…' : 'Turn off'}
            </Button>
          </>
        )}
      >
        <form onSubmit={disable} className="space-y-4">
          <p className="text-sm text-admin-muted">Confirm with your password and a current code (or a recovery code).</p>
          <Input
            label="Password"
            name="password"
            type="password"
            placeholder="Enter your password"
            autoComplete="current-password"
            value={disableForm.password}
            onChange={(e) => setDisableForm((f) => ({ ...f, password: e.target.value }))}
          />
          <Input
            label="Authenticator or recovery code"
            name="code"
            placeholder="123456 or a recovery code"
            autoComplete="one-time-code"
            value={disableForm.code}
            onChange={(e) => setDisableForm((f) => ({ ...f, code: e.target.value }))}
          />
        </form>
      </Modal>
    </div>
  );
}
