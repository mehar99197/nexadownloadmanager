/**
 * DataTable — generic table.
 *
 * Props:
 *  - columns: [{ key, header, render?(row, rowIndex), className? }]
 *      `render` is optional; defaults to row[key].
 *  - rows: array of records
 *  - rowKey: (row, i) => key   (defaults to row.id ?? row._id ?? index)
 *  - loading: boolean          (shows a loading row)
 *  - emptyMessage: string      (shown when no rows)
 *  - onRowClick?: (row) => void
 *  - caption: string           what this table lists, for screen readers
 *  - rowHeader: boolean        first column is the row's label (default true)
 *
 * The caption and the scopes are not decoration. Without them every table in
 * the panel is read as a flat run of cells with nothing naming the row or the
 * column it belongs to — "active", "pro", "5" and no idea whose.
 */
export default function DataTable({
  columns = [],
  rows = [],
  rowKey,
  loading = false,
  emptyMessage = 'No records found.',
  onRowClick,
  caption,
  rowHeader = true,
}) {
  const keyFor = (row, i) =>
    rowKey ? rowKey(row, i) : (row?.id ?? row?._id ?? i);

  return (
    // Focusable, because it scrolls. Every table in the panel is wider than a
    // phone, and a scroll box only a pointer can reach puts the right-hand
    // columns — which is where the row actions live — out of a keyboard's
    // reach entirely (axe: scrollable-region-focusable).
    <div
      className="overflow-x-auto rounded-xl border border-admin-border bg-admin-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-admin-accent)]"
      tabIndex={0}
      role="region"
      aria-label={caption ? `${caption} — scrolls sideways` : 'Table — scrolls sideways'}
    >
      <table className="admin-table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} scope="col" className={col.className}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-4 py-8 text-center text-admin-muted"
              >
                Loading…
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-4 py-8 text-center text-admin-muted"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr
                key={keyFor(row, i)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={onRowClick ? 'cursor-pointer' : undefined}
              >
                {columns.map((col, c) => {
                  const content = col.render ? col.render(row, i) : row[col.key];
                  return rowHeader && c === 0 ? (
                    <th key={col.key} scope="row" className={col.className}>
                      {content}
                    </th>
                  ) : (
                    <td key={col.key} className={col.className}>
                      {content}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
