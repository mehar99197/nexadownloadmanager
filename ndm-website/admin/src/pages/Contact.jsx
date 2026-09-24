import { useCallback, useEffect, useState } from 'react';
import api, { unwrap } from '../api/client.js';
import DataTable from '../components/DataTable.jsx';
import Pagination from '../components/Pagination.jsx';
import Badge from '../components/Badge.jsx';
import Button from '../components/Button.jsx';
import Modal from '../components/Modal.jsx';
import ModalError from '../components/ModalError.jsx';
import StatCard from '../components/StatCard.jsx';
import { SkeletonText } from '../components/Skeleton.jsx';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import { downloadCsv, formatDateTime } from '../utils.js';

const LIMIT = 12;

const STATUSES = ['new', 'open', 'replied', 'closed', 'spam'];
const TOPICS = [
  { value: 'general', label: 'General question' },
  { value: 'bug', label: 'Bug report' },
  { value: 'billing', label: 'Billing & refunds' },
  { value: 'license', label: 'License & seats' },
  { value: 'macos', label: 'macOS interest' },
  { value: 'feature', label: 'Feature request' },
  { value: 'other', label: 'Other' },
];

// 'new' and 'open' have no entry in Badge's STATUS_TONE, so they are given a
// tone explicitly rather than falling through to the flat default.
const STATUS_TONE = { new: 'info', open: 'warning', spam: 'danger' };

function errorMessage(err, fallback) {
  return err?.response?.data?.error?.message || err?.message || fallback;
}

function topicLabel(value) {
  return TOPICS.find((t) => t.value === value)?.label || value;
}

export default function Contact() {
  const confirm = useConfirm();
  const [data, setData] = useState({ messages: [], totalCount: 0, stats: null });
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [topic, setTopic] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [thread, setThread] = useState(null);       // { message, replies }
  const [threadLoading, setThreadLoading] = useState(false);
  const [reply, setReply] = useState('');
  const [closeOnReply, setCloseOnReply] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadMessages = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await unwrap(api.get('/admin/contact', {
        params: {
          page, limit: LIMIT,
          status: status || undefined,
          topic: topic || undefined,
          q: query || undefined,
        },
      }));
      setData(result || { messages: [], totalCount: 0, stats: null });
    } catch (err) {
      setError(errorMessage(err, 'Unable to load contact messages.'));
    } finally {
      setLoading(false);
    }
  }, [page, query, status, topic]);

  useEffect(() => { loadMessages(); }, [loadMessages]);

  // Opening a thread is what marks a 'new' message read (the API flips it to
  // 'open'), so the list is refreshed afterwards to keep the badges honest.
  const openThread = async (message) => {
    setThread({ message, replies: [] });
    setThreadLoading(true);
    setReply('');
    setCloseOnReply(false);
    setNotice('');
    try {
      const wasNew = message.status === 'new';
      setThread(await unwrap(api.get(`/admin/contact/${message.id}`)));
      if (wasNew) await loadMessages();
    } catch (err) {
      setError(errorMessage(err, 'Unable to load this message.'));
      setThread(null);
    } finally {
      setThreadLoading(false);
    }
  };

  const sendReply = async () => {
    if (reply.trim().length < 2) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const result = await unwrap(api.post(`/admin/contact/${thread.message.id}/reply`, {
        body: reply.trim(), close: closeOnReply,
      }));
      setThread({ message: result.message, replies: result.replies });
      setReply('');
      setNotice(`Reply emailed to ${result.message.email}.`);
      await loadMessages();
    } catch (err) {
      // A 502 EMAIL_SEND_FAILED means the reply WAS stored, marked not
      // delivered — only the email failed. This used to leave the thread as it
      // was and the text in the box, with the reason shown behind the dialog,
      // so the obvious next move was Send again: a second stored copy, and a
      // third. Now the thread is re-read, so the stored reply appears with its
      // delivery error, and the box is emptied because its text is on the
      // thread. Sending it again once email works is a deliberate new reply.
      const undelivered = err?.response?.status === 502
        || err?.response?.data?.error?.code === 'EMAIL_SEND_FAILED'
        || err?.code === 'EMAIL_SEND_FAILED';
      if (undelivered) {
        setReply('');
        try {
          setThread(await unwrap(api.get(`/admin/contact/${thread.message.id}`)));
          await loadMessages();
        } catch {
          /* the error below already says what matters */
        }
        // After the reload, which clears the page error as it starts.
        setError(`${errorMessage(err, 'The reply was saved but could not be emailed.')} It is kept on the thread below, marked not delivered.`);
      } else {
        setError(errorMessage(err, 'Unable to send this reply.'));
      }
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (id, nextStatus) => {
    setSaving(true);
    setError('');
    try {
      const message = await unwrap(api.put(`/admin/contact/${id}`, { status: nextStatus }));
      setThread((current) => (current ? { ...current, message } : current));
      await loadMessages();
    } catch (err) {
      setError(errorMessage(err, 'Unable to update this message.'));
    } finally {
      setSaving(false);
    }
  };

  const removeMessage = async (message) => {
    const confirmed = await confirm({
      title: 'Delete this message?',
      message: `The message from ${message.email} and every reply on it will be erased. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    setSaving(true);
    setError('');
    try {
      await unwrap(api.delete(`/admin/contact/${message.id}`));
      setThread(null);
      await loadMessages();
    } catch (err) {
      setError(errorMessage(err, 'Unable to delete this message.'));
    } finally {
      setSaving(false);
    }
  };
  const exportMessages = async () => {
    try {
      const result = await unwrap(api.get('/admin/contact', {
        params: {
          page: 1, limit: 200,
          status: status || undefined, topic: topic || undefined, q: query || undefined,
        },
      }));
      downloadCsv('nexa-contact-messages.csv', result?.messages || [], [
        { label: 'ID', value: (row) => row.id },
        { label: 'Name', value: (row) => row.name },
        { label: 'Email', value: (row) => row.email },
        { label: 'Topic', value: (row) => topicLabel(row.topic) },
        { label: 'Status', value: (row) => row.status },
        { label: 'Replies', value: (row) => row.reply_count },
        { label: 'Message', value: (row) => row.message },
        { label: 'Received', value: (row) => row.created_at },
      ]);
    } catch (err) {
      setError(errorMessage(err, 'Unable to export messages.'));
    }
  };

  const submitSearch = (event) => {
    event.preventDefault();
    setQuery(search.trim());
    setPage(1);
  };

  const stats = data.stats || { total: 0, unread: 0, awaiting: 0, replied: 0 };

  const columns = [
    {
      key: 'from',
      header: 'From',
      render: (message) => (
        <div className="min-w-0">
          <p className="font-semibold text-admin-text">{message.name || 'Anonymous'}</p>
          <p className="mt-0.5 truncate text-xs text-admin-faint">{message.email}</p>
        </div>
      ),
    },
    { key: 'topic', header: 'Topic', render: (message) => <span className="text-sm text-admin-muted">{topicLabel(message.topic)}</span> },
    {
      key: 'message',
      header: 'Message',
      render: (message) => (
        <p className="max-w-md truncate text-admin-muted" title={message.message}>{message.message}</p>
      ),
    },
    { key: 'received', header: 'Received', render: (message) => <span className="whitespace-nowrap text-xs text-admin-muted">{formatDateTime(message.created_at)}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (message) => (
        <span className="flex items-center gap-2">
          <Badge tone={STATUS_TONE[message.status]} status={message.status} />
          {Number(message.reply_count) > 0 && (
            <span className="text-xs text-admin-faint">{message.reply_count} repl{Number(message.reply_count) === 1 ? 'y' : 'ies'}</span>
          )}
          {!message.email_delivered && (
            <span className="text-xs text-admin-warning" title="The support notification email did not go out. The message itself is safely stored.">not emailed</span>
          )}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (message) => (
        <div className="flex justify-end">
          <Button size="sm" variant="secondary" onClick={() => openThread(message)}>Open</Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="admin-eyebrow text-admin-cyan">Customer support</p>
          <h2 className="mt-2 text-3xl font-extrabold tracking-tight text-admin-text">Contact inbox</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-admin-muted">
            Every message sent from the website&apos;s contact form. Read it, reply by email
            without leaving the panel, and move the thread through the queue.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={exportMessages}>Export CSV</Button>
          <Button variant="ghost" onClick={loadMessages} disabled={loading}>Refresh</Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total messages" value={stats.total} loading={loading && !data.stats} icon="✉" />
        <StatCard label="Unread" value={stats.unread} loading={loading && !data.stats} hint="Nobody has opened these yet" icon="●" accent="text-admin-cyan" />
        <StatCard label="Awaiting reply" value={stats.awaiting} loading={loading && !data.stats} hint="New + opened, not yet answered" icon="◷" accent="text-admin-warning" />
        <StatCard label="Replied" value={stats.replied} loading={loading && !data.stats} icon="↩" accent="text-admin-success" />
      </div>

      <div className="admin-card flex flex-wrap items-end gap-3">
        <form onSubmit={submitSearch} className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="admin-label">Search</span>
            <input
              className="admin-input w-64"
              placeholder="Name, email or message text..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <Button type="submit" variant="secondary">Search</Button>
        </form>
        <label className="block">
          <span className="admin-label">Status</span>
          <select
            className="admin-input w-40"
            value={status}
            onChange={(event) => { setStatus(event.target.value); setPage(1); }}
          >
            <option value="">All statuses</option>
            {STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="admin-label">Topic</span>
          <select
            className="admin-input w-48"
            value={topic}
            onChange={(event) => { setTopic(event.target.value); setPage(1); }}
          >
            <option value="">All topics</option>
            {TOPICS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
      </div>

      {error && <div className="rounded-xl border border-admin-danger/30 bg-admin-danger/10 px-4 py-3 text-sm text-admin-danger">{error}</div>}

      <div className="admin-card !p-0">
        <div className="border-b border-admin-border px-5 py-4">
          <p className="text-sm text-admin-muted">
            <span className="font-bold text-admin-warning">{loading ? <SkeletonText chars={3} /> : data.totalCount}</span> matching messages
          </p>
        </div>
        <DataTable
          columns={columns}
          rows={data.messages}
          loading={loading}
          emptyMessage="No contact messages match these filters."
          caption="Contact messages matching the current filters"
        />
      </div>

      <Pagination page={page} totalPages={Math.ceil((data.totalCount || 0) / LIMIT)} onPageChange={setPage} />

      <Modal
        open={Boolean(thread)}
        onClose={() => !saving && setThread(null)}
        title={thread ? `${thread.message.name || 'Anonymous'} — ${topicLabel(thread.message.topic)}` : ''}
        size="lg"
        footer={(
          <>
            <Button variant="ghost" onClick={() => removeMessage(thread.message)} disabled={saving}>Delete</Button>
            <Button variant="secondary" onClick={() => setThread(null)} disabled={saving}>Close</Button>
            <Button onClick={sendReply} disabled={saving || reply.trim().length < 2}>
              {saving ? 'Sending...' : 'Send reply'}
            </Button>
          </>
        )}
      >
        {thread && (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-admin-border bg-admin-surface-2/60 p-3">
                <p className="text-xs text-admin-faint">Email</p>
                <p className="mt-1 truncate text-sm font-semibold text-admin-text">{thread.message.email}</p>
              </div>
              <div className="rounded-xl border border-admin-border bg-admin-surface-2/60 p-3">
                <p className="text-xs text-admin-faint">Received</p>
                <p className="mt-1 text-sm font-semibold text-admin-text">{formatDateTime(thread.message.created_at)}</p>
              </div>
              <div className="rounded-xl border border-admin-border bg-admin-surface-2/60 p-3">
                <p className="text-xs text-admin-faint">Account</p>
                <p className="mt-1 text-sm font-semibold text-admin-text">{thread.message.user_id ? `User #${thread.message.user_id}` : 'Not registered'}</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[thread.message.status]} status={thread.message.status} />
              {STATUSES.filter((value) => value !== thread.message.status).map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={value === 'spam' ? 'danger' : 'ghost'}
                  onClick={() => changeStatus(thread.message.id, value)}
                  disabled={saving}
                >
                  Mark {value}
                </Button>
              ))}
            </div>

            <div>
              <h4 className="text-sm font-bold text-admin-text">Message</h4>
              <p className="mt-2 whitespace-pre-wrap rounded-xl border border-admin-border bg-admin-surface-2/50 p-4 text-sm leading-6 text-admin-muted">
                {thread.message.message}
              </p>
              {thread.message.user_agent && (
                <p className="mt-2 text-xs text-admin-faint">Browser: {thread.message.user_agent}</p>
              )}
            </div>

            <div>
              <h4 className="text-sm font-bold text-admin-text">
                Replies {threadLoading ? '(loading...)' : `(${thread.replies?.length || 0})`}
              </h4>
              <div className="mt-3 space-y-3">
                {thread.replies?.length ? thread.replies.map((item) => (
                  <div key={item.id} className="rounded-xl border border-admin-border bg-admin-surface-2/40 p-4">
                    <p className="text-xs text-admin-faint">
                      {item.admin_name || 'Admin'} · {formatDateTime(item.created_at)}
                      {!item.delivered && <span className="ml-2 text-admin-danger">not delivered</span>}
                    </p>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-admin-muted">{item.body}</p>
                    {item.delivery_error && (
                      <p className="mt-2 text-xs text-admin-danger">Delivery error: {item.delivery_error}</p>
                    )}
                  </div>
                )) : <p className="text-sm text-admin-muted">No replies sent yet.</p>}
              </div>
            </div>

            {notice && (
              <div className="rounded-xl border border-admin-success/30 bg-admin-success/10 px-4 py-3 text-sm text-admin-success">{notice}</div>
            )}
            <ModalError>{error}</ModalError>

            <div>
              <label className="block" htmlFor="contactReply">
                <span className="admin-label">Your reply</span>
                <textarea
                  id="contactReply"
                  className="admin-input min-h-32"
                  rows={6}
                  placeholder={`This is emailed to ${thread.message.email} from the support address.`}
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                />
              </label>
              <label className="mt-3 flex items-center gap-2 text-xs text-admin-muted">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-admin-accent"
                  checked={closeOnReply}
                  onChange={(event) => setCloseOnReply(event.target.checked)}
                />
                Close this thread after sending
              </label>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

