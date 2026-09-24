import { useCallback, useEffect, useState } from 'react';
import api, { unwrap } from '../../api/client.js';
import { useConfirm } from '../../components/ConfirmDialog.jsx';
import DataTable from '../../components/DataTable.jsx';
import Badge from '../../components/Badge.jsx';
import Button from '../../components/Button.jsx';
import { formatDate, formatDateTime } from '../../utils.js';

function errorMessage(err, fallback) {
  return err?.response?.data?.error?.message || err?.message || fallback;
}

const LEVEL_TONE = { suspected: 'danger', watch: 'warning' };

/**
 * Licences the sharing check has flagged (GET /admin/subscriptions/flagged),
 * with the two decisions only a person can make about them.
 *
 * Automatic suspension is on by default (LICENSE_AUTO_SUSPEND). A suspended
 * licence keeps status `active` — it answers `seat_limit` to the app instead —
 * so in the subscription table below a wrongly suspended paying customer looks
 * perfectly fine. Before this queue there was no way to find them from the
 * panel, and no way to lift it: both routes existed and nothing called them.
 *
 * - Clear suspension lifts it AND exempts the licence from automatic
 *   re-suspension (the device history that triggered it does not go away, so
 *   without the exemption the next new device would suspend it again).
 *   Flagging continues, so a licence that keeps spreading comes back here.
 * - Resume enforcement undoes that exemption.
 */
export default function SharingQueue({ onChanged }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState([]);
  const [thresholds, setThresholds] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await unwrap(api.get('/admin/subscriptions/flagged'));
      setRows(result?.subscriptions || []);
      setThresholds(result?.thresholds || null);
    } catch (err) {
      setError(errorMessage(err, 'Unable to load the sharing queue.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (row, kind) => {
    const suspended = Boolean(row.sharing_suspended_at);
    const sure = await confirm(kind === 'clear' ? {
      title: suspended
        ? `Lift the sharing suspension on ${row.email}'s licence?`
        : `Clear the sharing flag on ${row.email}'s licence?`,
      message: 'The licence works on its devices again straight away, and it is exempted from automatic re-suspension — its device history stays, so without that the next new device would suspend it again. It is still checked, and comes back to this queue if it keeps spreading.',
      confirmLabel: suspended ? 'Clear suspension' : 'Clear flag',
    } : {
      title: `Put ${row.email}'s licence back under automatic enforcement?`,
      message: 'It loses its exemption. If it is still spread over too many devices, the next check can suspend it again without anybody deciding to.',
      confirmLabel: 'Resume enforcement',
      danger: true,
    });
    if (!sure) return;
    setBusyId(row.id);
    setError('');
    setNotice('');
    try {
      await unwrap(api.post(`/admin/subscriptions/${row.id}/sharing/${kind}`));
      setNotice(kind === 'clear'
        ? `${row.email}: ${suspended ? 'suspension lifted' : 'flag cleared'}, and exempted from automatic re-suspension.`
        : `${row.email}: back under automatic enforcement.`);
      await load();
      if (onChanged) await onChanged();
    } catch (err) {
      setError(errorMessage(err, kind === 'clear' ? 'Unable to clear this suspension.' : 'Unable to resume enforcement.'));
    } finally {
      setBusyId(null);
    }
  };

  const columns = [
    {
      key: 'licence', header: 'Licence',
      render: (row) => (
        <div>
          <p className="font-semibold text-admin-text">{row.email}</p>
          <p className="mt-0.5 text-xs capitalize text-admin-faint">{row.plan} · {row.seats} seat{Number(row.seats) === 1 ? '' : 's'} · {row.status}</p>
        </div>
      ),
    },
    { key: 'level', header: 'Level', render: (row) => <Badge tone={LEVEL_TONE[row.sharing_level] || 'default'}>{row.sharing_level}</Badge> },
    { key: 'devices', header: 'Devices', render: (row) => <span className="tabular-nums text-admin-text">{Number(row.sharing_devices) || 0}</span> },
    { key: 'reason', header: 'Reason', render: (row) => <p className="max-w-xs text-xs leading-5 text-admin-muted">{row.sharing_reason || '—'}</p> },
    {
      key: 'suspended', header: 'Suspended?',
      render: (row) => (
        <div className="space-y-1">
          {row.sharing_suspended_at
            ? <Badge tone="danger">Since {formatDate(row.sharing_suspended_at)}</Badge>
            : <Badge>No</Badge>}
          {row.sharing_exempt ? <p className="text-xs text-admin-faint">Exempt from auto-suspension</p> : null}
          {row.sharing_checked_at && <p className="text-xs text-admin-faint">Checked {formatDateTime(row.sharing_checked_at)}</p>}
        </div>
      ),
    },
    {
      key: 'actions', header: '', className: 'text-right',
      render: (row) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" disabled={busyId === row.id} onClick={() => act(row, 'clear')}>
            {row.sharing_suspended_at ? 'Clear suspension' : 'Clear flag'}
          </Button>
          {row.sharing_exempt ? (
            <Button size="sm" variant="ghost" disabled={busyId === row.id} onClick={() => act(row, 'resume')}>Resume enforcement</Button>
          ) : null}
        </div>
      ),
    },
  ];

  const one = thresholds?.perSeat;
  return (
    <section className="admin-card !p-0" aria-labelledby="sharing-queue-title">
      <div className="flex flex-col gap-2 border-b border-admin-border px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id="sharing-queue-title" className="text-base font-bold text-admin-text">Flagged for sharing</h3>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-admin-muted">
            Licences seen on more devices than their seats explain. A suspended licence still shows as active below — the desktop app is told the seats are full instead.
            {one ? ` For one seat: watched at ${one.watch} devices, suspected at ${one.suspected}, suspended automatically at ${one.suspend}, counted over ${thresholds.windowDays} days.` : ''}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={load} disabled={loading}>Refresh</Button>
      </div>
      {error && <div role="alert" className="mx-5 mt-4 rounded-xl border border-admin-danger/30 bg-admin-danger/10 px-4 py-3 text-sm text-admin-danger">{error}</div>}
      {notice && <div role="status" className="mx-5 mt-4 rounded-xl border border-admin-success/30 bg-admin-success/10 px-4 py-3 text-sm text-admin-success">{notice}</div>}
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading && rows.length === 0}
        loadingRows={2}
        emptyMessage="Nothing flagged — no licence looks shared."
        caption="Licences flagged for sharing"
      />
    </section>
  );
}
