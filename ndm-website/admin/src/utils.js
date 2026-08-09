export function formatDate(value, options = {}) {
  if (!value) return '-';
  return new Date(value).toLocaleDateString(undefined, options);
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
