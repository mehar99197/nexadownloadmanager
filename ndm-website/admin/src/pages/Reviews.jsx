import { useCallback, useEffect, useState } from 'react';
import api, { unwrap } from '../api/client.js';
import DataTable from '../components/DataTable.jsx';
import Pagination from '../components/Pagination.jsx';
import Badge from '../components/Badge.jsx';
import Button from '../components/Button.jsx';
import { downloadCsv, formatDate } from '../utils.js';

const LIMIT = 15;

function errorMessage(err, fallback) {
  return err?.response?.data?.error?.message || err?.message || fallback;
}

function Stars({ value }) {
  const rating = Number(value) || 0;
  // aria-label on a role-less <span> is dropped by browsers, so this was
  // announced as a run of star characters. The stars are hidden and the rating
  // carried as real text instead.
  return <span className="tracking-widest text-admin-warning"><span aria-hidden="true">{'★'.repeat(rating)}<span className="text-admin-border">{'★'.repeat(Math.max(0, 5 - rating))}</span></span><span className="sr-only">{`${rating} out of 5 stars`}</span></span>;
}

export default function Reviews() {
  const [data, setData] = useState({ reviews: [], totalCount: 0 });
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('pending');
  const [rating, setRating] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadReviews = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await unwrap(api.get('/admin/reviews', { params: { page, limit: LIMIT, status: status || undefined, rating: rating || undefined } }));
      setData(result || { reviews: [], totalCount: 0 });
      setSelected(new Set());
    } catch (err) {
      setError(errorMessage(err, 'Unable to load reviews.'));
    } finally {
      setLoading(false);
    }
  }, [page, rating, status]);

  useEffect(() => { loadReviews(); }, [loadReviews]);

  const moderateSelected = async (nextStatus) => {
    if (!selected.size) return;
    setBusy(true);
    setError('');
    try {
      await unwrap(api.put('/admin/reviews/bulk', { ids: [...selected], status: nextStatus }));
      await loadReviews();
    } catch (err) {
      setError(errorMessage(err, 'Unable to update selected reviews.'));
    } finally {
      setBusy(false);
    }
  };

  const exportReviews = async () => {
    try {
      const result = await unwrap(api.get('/admin/reviews', { params: { page: 1, limit: 200, status: status || undefined, rating: rating || undefined } }));
      downloadCsv('nexa-reviews.csv', result?.reviews || [], [
        { label: 'ID', value: (row) => row.id },
        { label: 'User', value: (row) => row.user_name },
        { label: 'Rating', value: (row) => row.rating },
        { label: 'Status', value: (row) => row.status },
        { label: 'Comment', value: (row) => row.comment },
        { label: 'Created', value: (row) => row.created_at },
      ]);
    } catch (err) {
      setError(errorMessage(err, 'Unable to export reviews.'));
    }
  };

  const toggleSelected = (id) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const allSelected = data.reviews.length > 0 && data.reviews.every((review) => selected.has(review.id));
  const columns = [
    { key: 'select', header: <input aria-label="Select all reviews" type="checkbox" className="h-4 w-4 accent-admin-accent" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(data.reviews.map((review) => review.id)))} />, render: (review) => <input aria-label={`Select review ${review.id}`} type="checkbox" className="h-4 w-4 accent-admin-accent" checked={selected.has(review.id)} onChange={() => toggleSelected(review.id)} /> },
    { key: 'reviewer', header: 'Reviewer', render: (review) => <div><p className="font-semibold text-admin-text">{review.user_name}</p><p className="mt-0.5 text-xs text-admin-faint">User #{review.user_id}</p></div> },
    { key: 'rating', header: 'Rating', render: (review) => <Stars value={review.rating} /> },
    { key: 'comment', header: 'Feedback', render: (review) => <p className="max-w-xl whitespace-normal leading-6 text-admin-muted">{review.comment}</p> },
    { key: 'date', header: 'Submitted', render: (review) => formatDate(review.created_at) },
    { key: 'status', header: 'Status', render: (review) => <Badge status={review.status} /> },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between"><div><p className="admin-eyebrow text-admin-cyan">Community quality</p><h2 className="mt-2 text-3xl font-extrabold tracking-tight text-admin-text">Review moderation</h2><p className="mt-2 max-w-2xl text-sm text-admin-muted">Review every submission, filter by sentiment signal, and moderate in bulk with an auditable trail.</p></div><div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={exportReviews}>Export CSV</Button><Button variant="ghost" onClick={loadReviews} disabled={loading}>Refresh</Button></div></div>
      <div className="admin-card flex flex-wrap items-end gap-3"><label className="block"><span className="admin-label">Status</span><select className="admin-input w-44" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">All reviews</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></label><label className="block"><span className="admin-label">Rating</span><select className="admin-input w-36" value={rating} onChange={(event) => { setRating(event.target.value); setPage(1); }}><option value="">All ratings</option>{[5, 4, 3, 2, 1].map((value) => <option key={value} value={value}>{value} stars</option>)}</select></label><div className="ml-auto flex items-center gap-2"><span className="text-xs text-admin-muted">{selected.size} selected</span><Button size="sm" onClick={() => moderateSelected('approved')} disabled={!selected.size || busy}>Approve selected</Button><Button size="sm" variant="danger" onClick={() => moderateSelected('rejected')} disabled={!selected.size || busy}>Reject selected</Button></div></div>
      {error && <div className="rounded-xl border border-admin-danger/30 bg-admin-danger/10 px-4 py-3 text-sm text-admin-danger">{error}</div>}
      <div className="admin-card !p-0"><div className="border-b border-admin-border px-5 py-4"><p className="text-sm text-admin-muted"><span className="font-bold text-admin-warning">{data.totalCount}</span> matching reviews</p></div><DataTable columns={columns} rows={data.reviews} loading={loading} emptyMessage="No reviews match these filters." caption="Customer reviews awaiting or past moderation" /></div>
      <Pagination page={page} totalPages={Math.ceil((data.totalCount || 0) / LIMIT)} onPageChange={setPage} />
    </div>
  );
}
