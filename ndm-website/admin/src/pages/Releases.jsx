import { useCallback, useEffect, useRef, useState } from 'react';
import api, { unwrap } from '../api/client.js';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import DataTable from '../components/DataTable.jsx';
import Badge from '../components/Badge.jsx';
import Button from '../components/Button.jsx';
import Input from '../components/Input.jsx';
import Modal from '../components/Modal.jsx';
import { formatBytes } from '../utils.js';

// Metadata only. The installer itself is uploaded separately (see the Installers
// panel) because a multi-hundred-MB file cannot ride along in a JSON body.
const EMPTY_FORM = { version: '', changelog: '', isLatest: false, windowsUrl: '', linuxUrl: '' };

const OSES = [
  { key: 'windows', label: 'Windows', hint: '.exe or .msi installer' },
  { key: 'linux', label: 'Linux', hint: '.deb, .rpm or .AppImage' },
];

function date(value) {
  return value ? new Date(value).toLocaleDateString() : '-';
}

function count(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function errorMessage(err, fallback) {
  return err?.response?.data?.error?.message || err?.message || fallback;
}

function releaseForm(release) {
  return {
    version: release?.version || '',
    changelog: release?.changelog || '',
    isLatest: Boolean(release?.is_latest ?? release?.isLatest),
    windowsUrl: release?.windows_url || '',
    linuxUrl: release?.linux_url || '',
  };
}

/** What a release actually offers for one OS: an uploaded file, or a legacy URL. */
function artifactState(release, os) {
  const file = os === 'windows' ? release?.windows_file : release?.linux_file;
  const name = os === 'windows' ? release?.windows_filename : release?.linux_filename;
  const size = os === 'windows' ? release?.windows_size : release?.linux_size;
  const sha = os === 'windows' ? release?.windows_sha256 : release?.linux_sha256;
  const url = os === 'windows' ? release?.windows_url : release?.linux_url;
  if (file) return { kind: 'file', name: name || file, size: Number(size) || 0, sha: sha || '' };
  if (url) return { kind: 'url', url };
  return { kind: 'none' };
}

export default function Releases() {
  const confirm = useConfirm();
  const [releases, setReleases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showLegacyUrls, setShowLegacyUrls] = useState(false);

  // Upload panel state
  const [uploadFor, setUploadFor] = useState(null);   // the release being filled
  const [progress, setProgress] = useState({});        // { windows: 0..100 }
  const fileInputs = { windows: useRef(null), linux: useRef(null) };

  const formInvalid = !form.version.trim();

  const loadReleases = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setReleases((await unwrap(api.get('/admin/releases'))) || []);
    } catch (err) {
      setError(errorMessage(err, 'Unable to load releases.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadReleases(); }, [loadReleases]);

  // Keep the open upload panel pointed at the freshest row after any refresh.
  const refreshAnd = useCallback(async (id) => {
    const list = (await unwrap(api.get('/admin/releases'))) || [];
    setReleases(list);
    if (id) setUploadFor(list.find((r) => r.id === id) || null);
  }, []);

  const openCreate = () => { setEditing('new'); setForm(EMPTY_FORM); setShowLegacyUrls(false); };
  const openEdit = (release) => { setEditing(release); setForm(releaseForm(release)); setShowLegacyUrls(false); };

  const saveRelease = async () => {
    if (formInvalid) return;
    setSaving(true);
    setError('');
    try {
      const payload = {
        version: form.version.trim(),
        changelog: form.changelog,
        isLatest: Boolean(form.isLatest),
      };
      // Only send the legacy URLs when the operator actually opened that section
      // — otherwise editing a file-backed release would blank its own fields.
      if (showLegacyUrls) {
        payload.windowsUrl = form.windowsUrl.trim();
        payload.linuxUrl = form.linuxUrl.trim();
      }
      if (editing === 'new') {
        const created = await unwrap(api.post('/admin/releases', payload));
        setEditing(null);
        await refreshAnd(created?.id);
        // Straight into the upload step — a release with no installer is useless.
        if (created?.id) setUploadFor(created);
        setNotice(`Release v${payload.version} created. Now upload the installers.`);
        return;
      }
      await unwrap(api.put(`/admin/releases/${editing.id}`, payload));
      setEditing(null);
      await loadReleases();
    } catch (err) {
      setError(errorMessage(err, 'Unable to save release.'));
    } finally {
      setSaving(false);
    }
  };

  const uploadArtifact = async (release, os, file) => {
    if (!file) return;
    setError('');
    setNotice('');
    setProgress((p) => ({ ...p, [os]: 0 }));
    try {
      // Raw binary body, not multipart: the server streams it straight to disk
      // and hashes it in flight, so nothing is ever buffered whole in memory.
      const result = await unwrap(api.put(`/admin/releases/${release.id}/artifact/${os}`, file, {
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': file.name },
        timeout: 0,
        onUploadProgress: (event) => {
          const total = event.total || file.size || 1;
          setProgress((p) => ({ ...p, [os]: Math.round((event.loaded / total) * 100) }));
        },
      }));
      // The server reads the version the installer declares about itself and
      // refuses a mismatch outright (that arrives as an error below). A build
      // it could not read is accepted but flagged, and that flag is the one
      // thing worth showing here — a checksum alone cannot catch the wrong file.
      if (result?.versionWarning) {
        setNotice(`${file.name} uploaded, but its version could not be verified: ${result.versionWarning}`);
      } else {
        setNotice(`${file.name} uploaded — build ${result?.artifactVersion || release.version} verified, checksum computed automatically.`);
      }
      await refreshAnd(release.id);
    } catch (err) {
      setError(errorMessage(err, 'Upload failed.'));
    } finally {
      setProgress((p) => ({ ...p, [os]: undefined }));
      if (fileInputs[os].current) fileInputs[os].current.value = '';
    }
  };

  const removeArtifact = async (release, os) => {
    const sure = await confirm({
      title: `Remove the ${os} installer from v${release.version}?`,
      message: 'The file is deleted from the server. Visitors on this OS will see the release as not available until a new installer is uploaded.',
      confirmLabel: 'Remove installer',
      danger: true,
    });
    if (!sure) return;
    setError('');
    try {
      await unwrap(api.delete(`/admin/releases/${release.id}/artifact/${os}`));
      setNotice(`${os} installer removed.`);
      await refreshAnd(release.id);
    } catch (err) {
      setError(errorMessage(err, 'Unable to remove the installer.'));
    }
  };

  const setLatest = async (release) => {
    setError('');
    try {
      await unwrap(api.put(`/admin/releases/${release.id}`, { isLatest: true }));
      await loadReleases();
    } catch (err) {
      setError(errorMessage(err, 'Unable to publish release.'));
    }
  };

  const deleteRelease = async (release) => {
    const sure = await confirm({
      title: `Delete release v${release.version}?`,
      message: 'Its uploaded installers are deleted too and it disappears from the changelog. This cannot be undone.',
      confirmLabel: 'Delete release',
      danger: true,
    });
    if (!sure) return;
    setError('');
    try {
      await unwrap(api.delete(`/admin/releases/${release.id}`));
      await loadReleases();
    } catch (err) {
      setError(errorMessage(err, 'Unable to delete release.'));
    }
  };

  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const platformCell = (release) => (
    <div className="space-y-1 text-xs">
      {OSES.map(({ key, label }) => {
        const a = artifactState(release, key);
        if (a.kind === 'file') {
          return (
            <p key={key} className="text-admin-muted">
              <span className="font-semibold text-admin-success">{label} ✓</span>{' '}
              {formatBytes(a.size)}{a.sha ? ' · sha256' : ''}
            </p>
          );
        }
        if (a.kind === 'url') {
          return <p key={key} className="text-admin-muted"><span className="text-admin-warning">{label} — external URL</span></p>;
        }
        return <p key={key} className="text-admin-faint">{label} — no installer</p>;
      })}
    </div>
  );

  const columns = [
    { key: 'version', header: 'Version', render: (release) => <div><p className="font-semibold text-admin-text">v{release.version}</p>{release.is_latest ? <Badge tone="success">Latest</Badge> : null}</div> },
    { key: 'platforms', header: 'Installers', render: platformCell },
    { key: 'downloads', header: 'Downloads', render: (release) => <span className="font-semibold tabular-nums text-admin-text">{count(release.download_count ?? release.downloadCount)}</span> },
    { key: 'published', header: 'Published', render: (release) => date(release.published_at) },
    { key: 'notes', header: 'Notes', render: (release) => <p className="max-w-xs truncate text-admin-muted">{release.changelog || 'No changelog'}</p> },
    {
      key: 'actions', header: '', className: 'text-right',
      render: (release) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setUploadFor(release)}>Installers</Button>
          {!release.is_latest && <Button size="sm" variant="secondary" onClick={() => setLatest(release)}>Set latest</Button>}
          <Button size="sm" onClick={() => openEdit(release)}>Edit</Button>
          {!release.is_latest && <Button size="sm" variant="danger" onClick={() => deleteRelease(release)}>Delete</Button>}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-admin-cyan">Distribution</p>
          <h2 className="mt-2 text-3xl font-extrabold tracking-tight text-admin-text">Releases</h2>
          <p className="mt-2 max-w-2xl text-sm text-admin-muted">
            Upload the installer for each platform and choose which version the public download page
            promotes. The checksum is computed on upload — you never have to paste one.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={loadReleases} disabled={loading}>Refresh</Button>
          <Button onClick={openCreate}>New release</Button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-admin-danger/30 bg-admin-danger/10 px-4 py-3 text-sm text-admin-danger">{error}</div>}
      {notice && <div className="rounded-xl border border-admin-success/30 bg-admin-success/10 px-4 py-3 text-sm text-admin-success">{notice}</div>}

      <div className="admin-card !p-0">
        <div className="border-b border-admin-border px-5 py-4">
          <p className="text-sm text-admin-muted"><span className="font-bold text-admin-text">{releases.length}</span> releases in the catalog</p>
        </div>
        <DataTable columns={columns} rows={releases} loading={loading} emptyMessage="No releases have been published." />
      </div>

      {/* ---- metadata ---- */}
      <Modal
        open={Boolean(editing)} onClose={() => !saving && setEditing(null)}
        title={editing === 'new' ? 'Create release' : 'Edit release'} size="lg"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>Cancel</Button>
            <Button onClick={saveRelease} disabled={saving || formInvalid}>
              {saving ? 'Saving...' : editing === 'new' ? 'Create & add installers' : 'Save release'}
            </Button>
          </>
        )}
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <Input label="Version" name="version" placeholder="2.2.0" required value={form.version} onChange={update('version')} />
          <label className="flex items-center gap-3 self-end rounded-xl border border-admin-border bg-admin-surface-2/60 px-4 py-3">
            <input type="checkbox" className="h-5 w-5 accent-admin-accent" checked={form.isLatest} onChange={(e) => setForm((c) => ({ ...c, isLatest: e.target.checked }))} />
            <span>
              <span className="block text-sm font-semibold text-admin-text">Set as latest</span>
              <span className="mt-1 block text-xs text-admin-muted">Promote this release immediately.</span>
            </span>
          </label>
          <label className="block sm:col-span-2">
            <span className="admin-label">Changelog</span>
            <textarea className="admin-input min-h-40 resize-y" placeholder="What changed in this release?" value={form.changelog} onChange={update('changelog')} />
          </label>

          <div className="sm:col-span-2">
            <button type="button" className="text-xs font-semibold text-admin-muted underline-offset-2 hover:underline" onClick={() => setShowLegacyUrls((v) => !v)}>
              {showLegacyUrls ? 'Hide' : 'Use an external download URL instead'}
            </button>
            {showLegacyUrls && (
              <div className="mt-3 grid gap-4 rounded-xl border border-admin-border bg-admin-surface-2/40 p-4 sm:grid-cols-2">
                <p className="text-xs text-admin-faint sm:col-span-2">
                  Only for builds hosted elsewhere (a CDN, GitHub Releases). An uploaded installer
                  always takes priority over these.
                </p>
                <Input label="Windows URL" name="windowsUrl" type="url" placeholder="https://..." value={form.windowsUrl} onChange={update('windowsUrl')} />
                <Input label="Linux URL" name="linuxUrl" type="url" placeholder="https://..." value={form.linuxUrl} onChange={update('linuxUrl')} />
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* ---- installers ---- */}
      <Modal
        open={Boolean(uploadFor)} onClose={() => setUploadFor(null)}
        title={uploadFor ? `Installers — v${uploadFor.version}` : 'Installers'} size="lg"
        footer={<Button variant="ghost" onClick={() => setUploadFor(null)}>Done</Button>}
      >
        <div className="space-y-4">
          {OSES.map(({ key, label, hint }) => {
            const a = uploadFor ? artifactState(uploadFor, key) : { kind: 'none' };
            const pct = progress[key];
            const busy = pct !== undefined;
            return (
              <div key={key} className="rounded-xl border border-admin-border bg-admin-surface-2/50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-admin-text">{label}</p>
                    {a.kind === 'file' ? (
                      <>
                        <p className="mt-1 truncate text-sm text-admin-muted">{a.name}</p>
                        <p className="mt-1 text-xs text-admin-faint">
                          {formatBytes(a.size)}
                          {a.sha ? <> · <span className="font-mono">{a.sha.slice(0, 16)}…</span></> : null}
                        </p>
                      </>
                    ) : a.kind === 'url' ? (
                      <p className="mt-1 truncate text-xs text-admin-warning">Served from an external URL — upload a file to replace it.</p>
                    ) : (
                      <p className="mt-1 text-xs text-admin-faint">No installer yet — {hint}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <input
                      ref={fileInputs[key]} type="file" className="hidden"
                      accept=".exe,.msi,.deb,.rpm,.AppImage,.zip,.tar,.gz,.xz,.tgz"
                      onChange={(e) => uploadArtifact(uploadFor, key, e.target.files?.[0])}
                    />
                    <Button size="sm" disabled={busy} onClick={() => fileInputs[key].current?.click()}>
                      {busy ? `Uploading ${pct}%` : a.kind === 'file' ? 'Replace' : 'Upload installer'}
                    </Button>
                    {a.kind === 'file' && !busy && (
                      <Button size="sm" variant="danger" onClick={() => removeArtifact(uploadFor, key)}>Remove</Button>
                    )}
                  </div>
                </div>
                {busy && (
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-admin-border">
                    <div className="h-full rounded-full bg-admin-accent transition-[width]" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
            );
          })}
          <p className="text-xs text-admin-faint">
            Files stream straight to the server and the SHA-256 is computed as they arrive, so the
            desktop updater can verify every download. Large installers are fine — nothing is held
            in memory.
          </p>
        </div>
      </Modal>
    </div>
  );
}
