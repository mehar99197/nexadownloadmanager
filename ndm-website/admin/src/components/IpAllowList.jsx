import { useCallback, useEffect, useState } from 'react';
import api, { unwrap } from '../api/client.js';
import Button from './Button.jsx';
import Badge from './Badge.jsx';
import Input from './Input.jsx';

/**
 * Who may reach the control panels (AUDIT.md M-06).
 *
 * Rendered on the creator panel only. This list decides who can reach the
 * screen that edits it, so handing it to staff admins would let one of them
 * shut the creator out of their own deployment.
 *
 * The gate has two halves and this shows both. The rows are the editable half.
 * ADMIN_ALLOWED_IPS in the server .env is the other, shown read-only because it
 * is the break-glass: a mistake made here cannot take it away, which is the
 * reason this screen is safe to have at all. The server additionally refuses
 * any change that would leave the caller's own address with no way in — see
 * WOULD_LOCK_YOU_OUT in routes/root.js.
 */

function errorMessage(err, fallback) {
  // A 4xx makes axios throw before unwrap() runs, so the server's message
  // lives on the response; err.message would be "Request failed with status code 409".
  return err?.response?.data?.error?.message || err?.message || fallback;
}

export default function IpAllowList() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ value: '', label: '' });

  const load = useCallback(async () => {
    try {
      const next = await unwrap(api.get('/root/ip-rules'));
      setData(next);
      // Typing your own address by hand is the step most likely to go wrong,
      // and behind a proxy the server is the only thing that knows what it
      // actually sees. Only pre-filled while the field is untouched.
      setForm((f) => (f.value ? f : { ...f, value: next.yourIp || '' }));
    } catch (err) {
      setError(errorMessage(err, 'Unable to load the IP allow-list.'));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (work, okMessage) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      setNotice(okMessage);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'That did not work.'));
    } finally {
      setBusy(false);
    }
  };

  const add = (event) => {
    event.preventDefault();
    return act(
      () => unwrap(api.post('/root/ip-rules', {
        value: form.value.trim(),
        ...(form.label.trim() ? { label: form.label.trim() } : {}),
      })).then(() => setForm({ value: '', label: '' })),
      'Added.'
    );
  };

  const rules = data?.rules || [];
  const envList = data?.envList || [];
  const mine = data?.yourIp;

  return (
    <div className="admin-card space-y-4">
      <div>
        <p className="admin-eyebrow text-admin-faint">Access control</p>
        <h3 className="mt-1 text-xl font-bold tracking-tight">Who can reach the panels</h3>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-admin-muted">
          A sign-in from an address that is not on this list is refused before the password is read
          at all. An entry can be a single address, a range in CIDR form (<code>203.0.113.0/24</code>),
          or <code>*</code> for every address. IPv4 and IPv6 both work.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-admin-danger/30 bg-admin-danger/10 px-4 py-3 text-sm text-admin-danger">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-xl border border-admin-success/30 bg-admin-success/10 px-4 py-3 text-sm text-admin-success">
          {notice}
        </div>
      )}

      {data?.openToEveryone && (
        <div
          role="alert"
          data-testid="ip-open-to-everyone"
          className="rounded-xl border border-admin-warning/40 bg-admin-warning/10 px-4 py-3 text-sm text-admin-text"
        >
          <p className="font-semibold">The gate is open to every address.</p>
          <p className="mt-1 text-admin-muted">
            Something on the list is <code>*</code>, so nothing below is filtering anything. Remove
            it — or narrow <code>ADMIN_ALLOWED_IPS</code> in the server .env, if that is where it
            came from — before the rest of this list means anything.
          </p>
        </div>
      )}

      <div className="rounded-xl border border-admin-border bg-admin-surface-2 px-4 py-3 text-sm">
        <p className="text-admin-muted">
          The server sees you at{' '}
          <code className="rounded bg-admin-surface px-1.5 py-0.5 font-mono text-admin-text">
            {mine || '…'}
          </code>
          . Entries set in the server .env cannot be changed here:{' '}
          {envList.length
            ? envList.map((entry) => (
              <code
                key={entry}
                className="mr-1 rounded bg-admin-surface px-1.5 py-0.5 font-mono text-admin-text"
              >
                {entry}
              </code>
            ))
            : <span className="italic">none</span>}
        </p>
      </div>

      <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Input
          label="Address or range"
          name="value"
          placeholder="203.0.113.7, 203.0.113.0/24, or *"
          value={form.value}
          onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
        />
        <Input
          label="Label (optional)"
          name="label"
          placeholder="Home, office, phone…"
          value={form.label}
          onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
        />
        <Button type="submit" disabled={busy || !form.value.trim()}>
          {busy ? 'Working…' : 'Allow'}
        </Button>
      </form>

      {rules.length === 0 ? (
        <p className="text-sm text-admin-muted">
          Nothing here yet — only the .env entries above can reach the panels.
        </p>
      ) : (
        <ul data-testid="ip-rules" className="divide-y divide-admin-border rounded-xl border border-admin-border">
          {rules.map((rule) => (
            <li key={rule.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-mono text-sm text-admin-text">
                  {rule.value}
                  {mine && rule.value === mine && (
                    <span className="ml-2 font-sans text-xs text-admin-cyan">(you)</span>
                  )}
                </p>
                <p className="truncate text-xs text-admin-muted">
                  {rule.label || 'no label'}
                  {rule.created_by_email ? ` · added by ${rule.created_by_email}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={rule.enabled ? 'success' : 'default'}>
                  {rule.enabled ? 'allowed' : 'off'}
                </Badge>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => act(
                    () => unwrap(api.patch(`/root/ip-rules/${rule.id}`, { enabled: !rule.enabled })),
                    rule.enabled ? 'No longer allowed.' : 'Allowed.'
                  )}
                >
                  {rule.enabled ? 'Stop allowing' : 'Allow'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => act(
                    () => unwrap(api.delete(`/root/ip-rules/${rule.id}`)),
                    'Removed.'
                  )}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
