/**
 * A date an operator can act on. Bare toLocaleDateString() renders "7/5/2027",
 * which is 5 July or 7 May depending on who is reading — not a distinction to
 * leave open on a licence expiry or a deletion date. The month is always a
 * word; the order still follows the reader's locale.
 */
export function formatDate(value, options = {}) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', ...options });
}

export function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function formatMoney(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

export function downloadCsv(filename, rows, columns) {
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const csv = [
    columns.map((column) => escape(column.label)).join(','),
    ...rows.map((row) => columns.map((column) => escape(column.value(row))).join(',')),
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

// Human file size for release installers. Binary units (MiB steps) shown with
// the familiar MB/GB labels, matching what Windows and most browsers report.
export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * The exports stop at a server-side cap (5000 rows) and report it in response
 * headers — the body stays the bare array of rows. When the file was cut
 * short, say so, and by how much; an export that quietly loses rows is worse
 * than one that refuses. Returns '' when the file is complete.
 */
export function exportTruncationNotice(response, rowsInFile, what) {
  const headers = response?.headers || {};
  const read = (name) => (typeof headers.get === 'function' ? headers.get(name) : headers[name]);
  if (String(read('x-export-truncated')) !== 'true') return '';
  const total = Number(read('x-export-total')) || 0;
  const fmt = (n) => Number(n).toLocaleString('en-US');
  return `This file holds the newest ${fmt(rowsInFile)} of ${fmt(total)} matching ${what} — an export stops at ${fmt(read('x-export-limit') || rowsInFile)} rows. Narrow the filters to export the rest.`;
}

/**
 * Daily signups for exactly the last `days` days (UTC, today included), oldest
 * first, with a zero for every day nobody signed up.
 *
 * The API returns only the days that HAD signups, and the dashboard used to
 * draw the last fourteen of those under a caption promising thirty days — so
 * a quiet week vanished from the chart instead of showing as a gap, and
 * anything older than the fourteenth busy day was cut. Days are keyed in UTC
 * because the server groups them in UTC (the database session is pinned to it).
 *
 * Every bar keeps a full label for its tooltip; only every seventh day, counted
 * back from today, prints one underneath (BarChart's `tick`).
 */
export function dailySignupSeries(signups, days = 30, now = new Date()) {
  const counts = new Map();
  for (const item of signups || []) {
    const key = String(item?.date ?? '').slice(0, 10);
    if (key) counts.set(key, (counts.get(key) || 0) + (Number(item.count) || 0));
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(today - i * 86400000);
    const key = day.toISOString().slice(0, 10);
    series.push({
      date: key,
      label: day.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
      tick: i % 7 === 0 ? day.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '',
      value: counts.get(key) || 0,
    });
  }
  return series;
}
