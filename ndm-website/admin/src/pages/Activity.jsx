import { useCallback, useEffect, useState } from 'react';
import api, { unwrap } from '../api/client.js';
import DataTable from '../components/DataTable.jsx';
import Button from '../components/Button.jsx';
import { formatDateTime } from '../utils.js';

export default function Activity() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadActivity = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setItems((await unwrap(api.get('/admin/activity', { params: { limit: 100 } }))) || []);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Unable to load activity.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadActivity(); }, [loadActivity]);

  const columns = [
    { key: 'time', header: 'Time', render: (item) => <span className="whitespace-nowrap text-xs text-admin-muted">{formatDateTime(item.created_at)}</span> },
    { key: 'admin', header: 'Admin', render: (item) => <div><p className="font-semibold text-admin-text">{item.admin_name || 'System'}</p><p className="text-xs text-admin-faint">{item.admin_email || '-'}</p></div> },
    { key: 'action', header: 'Action', render: (item) => <span className="rounded-full border border-admin-cyan/20 bg-admin-cyan/10 px-2.5 py-1 text-xs font-semibold text-admin-cyan">{item.action}</span> },
    { key: 'summary', header: 'Summary', render: (item) => <span className="text-admin-muted">{item.summary}</span> },
    { key: 'entity', header: 'Entity', render: (item) => <span className="text-xs capitalize text-admin-faint">{item.entity_type}{item.entity_id ? ` #${item.entity_id}` : ''}</span> },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.18em] text-admin-cyan">Governance</p><h2 className="mt-2 text-3xl font-extrabold tracking-tight text-admin-text">Activity log</h2><p className="mt-2 max-w-2xl text-sm text-admin-muted">Every important admin action is recorded here for traceability and support handoffs.</p></div><Button variant="secondary" onClick={loadActivity} disabled={loading}>Refresh log</Button></div>
      {error && <div className="rounded-xl border border-admin-danger/30 bg-admin-danger/10 px-4 py-3 text-sm text-admin-danger">{error}</div>}
      <div className="admin-card !p-0"><DataTable columns={columns} rows={items} loading={loading} emptyMessage="No admin actions have been recorded." /></div>
    </div>
  );
}
