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
 */
export default function DataTable({
  columns = [],
  rows = [],
  rowKey,
  loading = false,
  emptyMessage = 'No records found.',
  onRowClick,
}) {
  const keyFor = (row, i) =>
    rowKey ? rowKey(row, i) : (row?.id ?? row?._id ?? i);

  return (
    <div className="overflow-x-auto rounded-xl border border-admin-border bg-admin-surface">
      <table className="admin-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} className={col.className}>
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
                {columns.map((col) => (
                  <td key={col.key} className={col.className}>
                    {col.render ? col.render(row, i) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
