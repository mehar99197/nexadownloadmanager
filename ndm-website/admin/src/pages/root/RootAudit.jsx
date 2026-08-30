import { useCallback, useEffect, useMemo, useState } from 'react';
import api, { unwrap } from '../../api/client.js';
import DataTable from '../../components/DataTable.jsx';
import Button from '../../components/Button.jsx';
import { formatDateTime } from '../../utils.js';

function errorMessage(err, fallback) {
  return err?.response?.data?.error?.message || err?.message || fallback;
}

/**
 * Creator-only: the complete audit trail.
 *
 * The staff panel's Activity screen reads the same table through
 * /api/admin/activity; this one reads /api/root/audit, goes deeper (200 rows),
 * and adds the metadata payload a staff admin never sees.
 */
export default function RootAudit() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setItems((await unwrap(api.get('/root/audit', { params: { limit: 200 } }))) || []);
    } catch (err) {
      setError(errorMessage(err, 'Unable to load the audit trail.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => [item.action, item.summary, item.admin_email, item.entity_type]
      .filter(Boolean).some((field) => String(field).toLowerCase().includes(needle)));
  }, [items, filter]);

  const columns = [
    {
      key: 'time', header: 'Time',
      render: (item) => <span className="whitespace-nowrap text-xs text-admin-muted">{formatDateTime(item.created_at)}</span>,
    },
    {
      key: 'actor', header: 'Actor',
      render: (item) => (
        <div>
          <p className="font-semibold text-admin-text">{item.admin_name || 'System'}</p>
          <p className="text-xs text-admin-faint">{item.admin_email || 'account deleted'}</p>
        </div>
      ),
    },
    {
      key: 'action', header: 'Action',
      render: (item) => {
        const destructive = /delete|demote|ban|revoke|reset/.test(item.action || '');
        const tone = destructive
          ? 'border-admin-danger/20 bg-admin-danger/10 text-admin-danger'
          : 'border-admin-cyan/20 bg-admin-cyan/10 text-admin-cyan';
        return <span className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold ${tone}`}>{item.action}</span>;
      },
    },
    { key: 'summary', header: 'Summary', render: (item) => <span className="text-admin-muted">{item.summary}</span> },
    {
      key: 'entity', header: 'Entity',
      render: (item) => <span className="text-xs capitalize text-admin-faint">{item.entity_type}{item.entity_id ? ` #${item.entity_id}` : ''}</span>,
    },
    {
      key: 'metadata', header: 'Details',
      render: (item) => (item.metadata
        ? <code className="block max-w-xs truncate text-xs text-admin-faint" title={JSON.stringify(item.metadata)}>{JSON.stringify(item.metadata)}</code>
        : <span className="text-xs text-admin-faint">—</span>),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-admin-warning">Creator only</p>
          <h2 className="mt-2 text-3xl font-extrabold tracking-tight text-admin-text">Audit trail</h2>
          <p className="mt-2 max-w-2xl text-sm text-admin-muted">
            Every action taken by every control-panel account, including the metadata payload.
            Rows survive account deletion — the actor is simply unlinked.
          </p>
        </div>
        <Button variant="secondary" onClick={load} disabled={loading}>Refresh</Button>
      </div>

      {error && <div className="rounded-xl border border-admin-danger/30 bg-admin-danger/10 px-4 py-3 text-sm text-admin-danger">{error}</div>}

      <div className="admin-card">
        <label className="block">
          <span className="admin-label">Filter</span>
          <input
            className="admin-input" value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder="Action, summary, actor email, entity..."
          />
        </label>
        <p className="mt-2 text-xs text-admin-faint">
          Showing {rows.length} of {items.length} most recent entries.
        </p>
      </div>

      <div className="admin-card !p-0">
        <DataTable columns={columns} rows={rows} loading={loading} emptyMessage="Nothing has been recorded yet." />
      </div>
    </div>
  );
}
