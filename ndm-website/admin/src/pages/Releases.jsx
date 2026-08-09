import { useCallback, useEffect, useState } from 'react';
import api, { unwrap } from '../api/client.js';
import DataTable from '../components/DataTable.jsx';
import Badge from '../components/Badge.jsx';
import Button from '../components/Button.jsx';
import Input from '../components/Input.jsx';
import Modal from '../components/Modal.jsx';

const EMPTY_FORM = { version: '', windowsUrl: '', linuxUrl: '', changelog: '', isLatest: false };

function date(value) {
  return value ? new Date(value).toLocaleDateString() : '-';
}

function releaseForm(release) {
  return {
    version: release?.version || '',
    windowsUrl: release?.windows_url || '',
    linuxUrl: release?.linux_url || '',
    changelog: release?.changelog || '',
    isLatest: Boolean(release?.is_latest),
  };
}

function payloadFrom(form) {
  const payload = {
    version: form.version.trim(),
    changelog: form.changelog,
    isLatest: Boolean(form.isLatest),
  };
  if (form.windowsUrl.trim()) payload.windowsUrl = form.windowsUrl.trim();
  if (form.linuxUrl.trim()) payload.linuxUrl = form.linuxUrl.trim();
  return payload;
}

export default function Releases() {
  const [releases, setReleases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const loadReleases = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setReleases((await unwrap(api.get('/admin/releases'))) || []);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Unable to load releases.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadReleases();
  }, [loadReleases]);

  const openCreate = () => {
    setEditing('new');
    setForm(EMPTY_FORM);
  };

  const openEdit = (release) => {
    setEditing(release);
    setForm(releaseForm(release));
  };

  const saveRelease = async () => {
    setSaving(true);
    setError('');
    try {
      const payload = payloadFrom(form);
      if (editing === 'new') await unwrap(api.post('/admin/releases', payload));
      else await unwrap(api.put(`/admin/releases/${editing.id}`, payload));
      setEditing(null);
      await loadReleases();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Unable to save release.');
    } finally {
      setSaving(false);
    }
  };

  const setLatest = async (release) => {
    setError('');
    try {
      await unwrap(api.put(`/admin/releases/${release.id}`, { isLatest: true }));
      await loadReleases();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Unable to publish release.');
    }
  };

  const deleteRelease = async (release) => {
    if (!window.confirm(`Delete release v${release.version}? This cannot be undone.`)) return;
    setError('');
    try {
      await unwrap(api.delete(`/admin/releases/${release.id}`));
      await loadReleases();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Unable to delete release.');
    }
  };

  const columns = [
    { key: 'version', header: 'Version', render: (release) => <div><p className="font-semibold text-admin-text">v{release.version}</p>{release.is_latest ? <Badge tone="success">Latest</Badge> : null}</div> },
    { key: 'platforms', header: 'Platforms', render: (release) => <div className="space-y-1 text-xs text-admin-muted"><p>{release.windows_url ? 'Windows ready' : 'Windows link missing'}</p><p>{release.linux_url ? 'Linux ready' : 'Linux link missing'}</p></div> },
    { key: 'published', header: 'Published', render: (release) => date(release.published_at) },
    { key: 'notes', header: 'Notes', render: (release) => <p className="max-w-sm truncate text-admin-muted">{release.changelog || 'No changelog'}</p> },
    { key: 'actions', header: '', className: 'text-right', render: (release) => <div className="flex justify-end gap-2">{!release.is_latest && <Button size="sm" variant="secondary" onClick={() => setLatest(release)}>Set latest</Button>}<Button size="sm" onClick={() => openEdit(release)}>Edit</Button>{!release.is_latest && <Button size="sm" variant="danger" onClick={() => deleteRelease(release)}>Delete</Button>}</div> },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.18em] text-admin-cyan">Distribution</p><h2 className="mt-2 text-3xl font-extrabold tracking-tight text-admin-text">Releases</h2><p className="mt-2 text-sm text-admin-muted">Publish desktop builds and control which version the public download page promotes.</p></div><div className="flex gap-2"><Button variant="secondary" onClick={loadReleases} disabled={loading}>Refresh</Button><Button onClick={openCreate}>New release</Button></div></div>
      {error && <div className="rounded-xl border border-admin-danger/30 bg-admin-danger/10 px-4 py-3 text-sm text-admin-danger">{error}</div>}
      <div className="admin-card !p-0"><div className="border-b border-admin-border px-5 py-4"><p className="text-sm text-admin-muted"><span className="font-bold text-admin-text">{releases.length}</span> releases in the catalog</p></div><DataTable columns={columns} rows={releases} loading={loading} emptyMessage="No releases have been published." /></div>

      <Modal open={Boolean(editing)} onClose={() => !saving && setEditing(null)} title={editing === 'new' ? 'Create release' : 'Edit release'} size="lg" footer={(<><Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>Cancel</Button><Button onClick={saveRelease} disabled={saving || !form.version.trim()}>{saving ? 'Saving...' : editing === 'new' ? 'Create release' : 'Save release'}</Button></>)}>
        <div className="grid gap-5 sm:grid-cols-2">
          <Input label="Version" name="version" placeholder="2.2.0" required value={form.version} onChange={(event) => setForm((current) => ({ ...current, version: event.target.value }))} />
          <label className="flex items-center gap-3 self-end rounded-xl border border-admin-border bg-admin-surface-2/60 px-4 py-3"><input type="checkbox" className="h-5 w-5 accent-admin-accent" checked={form.isLatest} onChange={(event) => setForm((current) => ({ ...current, isLatest: event.target.checked }))} /><span><span className="block text-sm font-semibold text-admin-text">Set as latest</span><span className="mt-1 block text-xs text-admin-muted">Promote this release immediately.</span></span></label>
          <Input label="Windows download URL" name="windowsUrl" type="url" placeholder="https://..." value={form.windowsUrl} onChange={(event) => setForm((current) => ({ ...current, windowsUrl: event.target.value }))} />
          <Input label="Linux download URL" name="linuxUrl" type="url" placeholder="https://..." value={form.linuxUrl} onChange={(event) => setForm((current) => ({ ...current, linuxUrl: event.target.value }))} />
          <label className="block sm:col-span-2"><span className="admin-label">Changelog</span><textarea className="admin-input min-h-40 resize-y" placeholder="What changed in this release?" value={form.changelog} onChange={(event) => setForm((current) => ({ ...current, changelog: event.target.value }))} /></label>
        </div>
      </Modal>
    </div>
  );
}
