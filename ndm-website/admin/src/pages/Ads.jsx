import { useCallback, useEffect, useMemo, useState } from 'react';
import api, { unwrap } from '../api/client.js';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import DataTable from '../components/DataTable.jsx';
import Badge from '../components/Badge.jsx';
import Button from '../components/Button.jsx';
import Input from '../components/Input.jsx';
import Modal from '../components/Modal.jsx';
import StatCard from '../components/StatCard.jsx';

const PLACEMENTS = [
  { value: 'app_banner', label: 'App banner', hint: 'Strip above the download list — the main surface.' },
  { value: 'app_sidebar', label: 'App sidebar', hint: 'Reserved for the side panel.' },
  { value: 'app_complete', label: 'Download complete', hint: 'Shown on the completion dialog.' },
];

const EMPTY_FORM = {
  title: '', body: '', imageUrl: '', targetUrl: '', ctaLabel: 'Learn more',
  placement: 'app_banner', active: true, weight: 1, startsAt: '', endsAt: '',
};

const HTTPS_RE = /^https:\/\/\S+$/i;

function count(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function date(value) {
  return value ? new Date(value).toLocaleDateString() : '—';
}

// <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" in LOCAL time; the API
// speaks UTC ISO. Convert both ways so a saved schedule reads back unchanged.
function toLocalInput(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toIso(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function adForm(ad) {
  return {
    title: ad?.title || '',
    body: ad?.body || '',
    imageUrl: ad?.image_url || '',
    targetUrl: ad?.target_url || '',
    ctaLabel: ad?.cta_label || 'Learn more',
    placement: ad?.placement || 'app_banner',
    active: ad ? Boolean(ad.active) : true,
    weight: Number(ad?.weight || 1),
    startsAt: toLocalInput(ad?.starts_at),
    endsAt: toLocalInput(ad?.ends_at),
  };
}

// Always send both schedule bounds: "" is how the API is told to clear one.
function payloadFrom(form) {
  return {
    title: form.title.trim(),
    body: form.body.trim(),
    imageUrl: form.imageUrl.trim() || null,
    targetUrl: form.targetUrl.trim(),
    ctaLabel: form.ctaLabel.trim() || 'Learn more',
    placement: form.placement,
    active: Boolean(form.active),
    weight: Number(form.weight) || 1,
    startsAt: toIso(form.startsAt),
    endsAt: toIso(form.endsAt),
  };
}

// Only complain about what the user actually typed. An empty target link is
// already handled by the disabled Save button; shouting "Required" at a form
// nobody has touched yet is just noise.
function urlError(value) {
  const v = value.trim();
  if (!v) return '';
  return HTTPS_RE.test(v) ? '' : 'Must be an https:// link.';
}

// Mirrors utils/ads.js on the server: what a free user would see right now.
function liveNow(ad) {
  if (!ad.active) return false;
  const now = Date.now();
  if (ad.starts_at && new Date(ad.starts_at).getTime() > now) return false;
  if (ad.ends_at && new Date(ad.ends_at).getTime() <= now) return false;
  return true;
}

function statusOf(ad) {
  if (!ad.active) return { tone: 'default', label: 'Paused' };
  if (ad.starts_at && new Date(ad.starts_at).getTime() > Date.now()) return { tone: 'info', label: 'Scheduled' };
  if (ad.ends_at && new Date(ad.ends_at).getTime() <= Date.now()) return { tone: 'warning', label: 'Ended' };
  return { tone: 'success', label: 'Live' };
}

export default function Ads() {
  const confirm = useConfirm();
  const [ads, setAds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const targetError = urlError(form.targetUrl);
  const imageError = urlError(form.imageUrl);
  const rangeError =
    form.startsAt && form.endsAt && new Date(form.endsAt) <= new Date(form.startsAt)
      ? 'End must be after start.'
      : '';
  const formInvalid = !form.title.trim() || !form.targetUrl.trim()
    || Boolean(targetError) || Boolean(imageError) || Boolean(rangeError);

  const loadAds = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setAds((await unwrap(api.get('/admin/ads'))) || []);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Unable to load ads.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAds();
  }, [loadAds]);

  const totals = useMemo(() => {
    const impressions = ads.reduce((sum, ad) => sum + Number(ad.impressions || 0), 0);
    const clicks = ads.reduce((sum, ad) => sum + Number(ad.clicks || 0), 0);
    return {
      live: ads.filter(liveNow).length,
      impressions,
      clicks,
      ctr: impressions > 0 ? `${((clicks / impressions) * 100).toFixed(2)}%` : '—',
    };
  }, [ads]);

  const openCreate = () => {
    setEditing('new');
    setForm(EMPTY_FORM);
  };

  const openEdit = (ad) => {
    setEditing(ad);
    setForm(adForm(ad));
  };

  const saveAd = async () => {
    if (formInvalid) return;
    setSaving(true);
    setError('');
    try {
      const payload = payloadFrom(form);
      if (editing === 'new') await unwrap(api.post('/admin/ads', payload));
      else await unwrap(api.put(`/admin/ads/${editing.id}`, payload));
      setEditing(null);
      await loadAds();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Unable to save ad.');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (ad) => {
    setError('');
    try {
      await unwrap(api.put(`/admin/ads/${ad.id}`, { active: !ad.active }));
      await loadAds();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Unable to update ad.');
    }
  };

  const deleteAd = async (ad) => {
    const sure = await confirm({
      title: `Delete "${ad.title}"?`,
      message: 'Its impression and click history goes with it. Prefer switching it off if you might bring it back.',
      confirmLabel: 'Delete ad',
      danger: true,
    });
    if (!sure) return;
    setError('');
    try {
      await unwrap(api.delete(`/admin/ads/${ad.id}`));
      await loadAds();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err?.message || 'Unable to delete ad.');
    }
  };

  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const placementLabel = (value) => PLACEMENTS.find((p) => p.value === value)?.label || value;

  const columns = [
    {
      key: 'ad',
      header: 'Ad',
      render: (ad) => (
        <div className="flex items-start gap-3">
          {ad.image_url ? (
            <img src={ad.image_url} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-admin-border bg-admin-surface-2 text-xs text-admin-faint">Ad</div>
          )}
          <div className="min-w-0">
            <p className="truncate font-semibold text-admin-text">{ad.title}</p>
            <p className="max-w-xs truncate text-xs text-admin-muted">{ad.body || 'No body copy'}</p>
            <a href={ad.target_url} target="_blank" rel="noreferrer noopener" className="block max-w-xs truncate text-xs text-admin-cyan hover:underline">{ad.target_url}</a>
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (ad) => {
        const status = statusOf(ad);
        return (
          <div className="space-y-1">
            <Badge tone={status.tone}>{status.label}</Badge>
            <p className="text-xs text-admin-muted">{placementLabel(ad.placement)}</p>
          </div>
        );
      },
    },
    { key: 'weight', header: 'Weight', render: (ad) => <span className="tabular-nums text-admin-text">{ad.weight}</span> },
    {
      key: 'schedule',
      header: 'Schedule',
      render: (ad) => (
        <div className="text-xs text-admin-muted">
          <p>{ad.starts_at ? `From ${date(ad.starts_at)}` : 'From now'}</p>
          <p>{ad.ends_at ? `Until ${date(ad.ends_at)}` : 'No end date'}</p>
        </div>
      ),
    },
    {
      key: 'performance',
      header: 'Performance',
      render: (ad) => (
        <div className="text-xs text-admin-muted">
          <p><span className="font-semibold tabular-nums text-admin-text">{count(ad.impressions)}</span> impressions</p>
          <p><span className="font-semibold tabular-nums text-admin-text">{count(ad.clicks)}</span> clicks · {Number(ad.ctr || 0).toFixed(2)}% CTR</p>
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (ad) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => toggleActive(ad)}>{ad.active ? 'Pause' : 'Resume'}</Button>
          <Button size="sm" onClick={() => openEdit(ad)}>Edit</Button>
          <Button size="sm" variant="danger" onClick={() => deleteAd(ad)}>Delete</Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-admin-cyan">Monetisation</p>
          <h2 className="mt-2 text-3xl font-extrabold tracking-tight text-admin-text">Ads</h2>
          <p className="mt-2 text-sm text-admin-muted">
            Promotions shown inside the desktop app to <span className="font-semibold text-admin-text">Free installs only</span>.
            Pro and Team are ad-free — the server refuses to return an ad for a paid licence, so nothing here can reach a paying user.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={loadAds} disabled={loading}>Refresh</Button>
          <Button onClick={openCreate}>New ad</Button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-admin-danger/30 bg-admin-danger/10 px-4 py-3 text-sm text-admin-danger">{error}</div>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Live right now" value={count(totals.live)} hint={`${ads.length} total`} />
        <StatCard label="Impressions" value={count(totals.impressions)} hint="All time" />
        <StatCard label="Clicks" value={count(totals.clicks)} hint="All time" />
        <StatCard label="Click-through rate" value={totals.ctr} hint="Clicks ÷ impressions" />
      </div>

      <div className="admin-card !p-0">
        <div className="border-b border-admin-border px-5 py-4">
          <p className="text-sm text-admin-muted"><span className="font-bold text-admin-text">{ads.length}</span> ads in the rotation</p>
        </div>
        <DataTable columns={columns} rows={ads} loading={loading} emptyMessage="No ads yet. Free users currently see nothing." />
      </div>

      <Modal
        open={Boolean(editing)}
        onClose={() => !saving && setEditing(null)}
        title={editing === 'new' ? 'Create ad' : 'Edit ad'}
        size="lg"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>Cancel</Button>
            <Button onClick={saveAd} disabled={saving || formInvalid}>{saving ? 'Saving...' : editing === 'new' ? 'Create ad' : 'Save ad'}</Button>
          </>
        )}
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <Input label="Title" name="title" placeholder="Go Pro — unlimited downloads" required maxLength={120} value={form.title} onChange={update('title')} />
          <Input label="Call to action" name="ctaLabel" placeholder="Learn more" maxLength={40} value={form.ctaLabel} onChange={update('ctaLabel')} />
          <label className="block sm:col-span-2">
            <span className="admin-label">Body</span>
            <textarea className="admin-input min-h-20 resize-y" maxLength={300} placeholder="One short line. The app shows this under the title." value={form.body} onChange={update('body')} />
          </label>
          <Input label="Target link" name="targetUrl" type="url" placeholder="https://nexadownloadmanager.com/pricing" required value={form.targetUrl} onChange={update('targetUrl')} error={targetError} />
          <Input label="Image URL (optional)" name="imageUrl" type="url" placeholder="https://cdn.example.com/promo.png" value={form.imageUrl} onChange={update('imageUrl')} error={imageError} />
          <label className="block">
            <span className="admin-label">Placement</span>
            <select className="admin-input" value={form.placement} onChange={update('placement')}>
              {PLACEMENTS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
            <span className="mt-1.5 block text-xs text-admin-faint">{PLACEMENTS.find((p) => p.value === form.placement)?.hint}</span>
          </label>
          <Input label="Weight (1–100)" name="weight" type="number" min={1} max={100} value={form.weight} onChange={update('weight')} />
          <Input label="Starts (optional)" name="startsAt" type="datetime-local" value={form.startsAt} onChange={update('startsAt')} />
          <Input label="Ends (optional)" name="endsAt" type="datetime-local" value={form.endsAt} onChange={update('endsAt')} error={rangeError} />
          <label className="flex items-center gap-3 self-end rounded-xl border border-admin-border bg-admin-surface-2/60 px-4 py-3 sm:col-span-2">
            <input type="checkbox" className="h-5 w-5 accent-admin-accent" checked={form.active} onChange={(event) => setForm((current) => ({ ...current, active: event.target.checked }))} />
            <span>
              <span className="block text-sm font-semibold text-admin-text">Active</span>
              <span className="mt-1 block text-xs text-admin-muted">Uncheck to keep the ad on file without serving it.</span>
            </span>
          </label>
        </div>
        <p className="mt-4 text-xs text-admin-faint">
          Links must be <code className="font-mono">https://</code> — they open in the user&apos;s own browser. Higher weight means the app
          shows this ad more often in its rotation. Leave the dates empty to run the ad indefinitely.
        </p>
      </Modal>
    </div>
  );
}
