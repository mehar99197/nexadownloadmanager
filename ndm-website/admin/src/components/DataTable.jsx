import { useEffect, useRef } from 'react';

/**
 * What each table has learned about its own rows, kept at module level so it
 * outlives the table. Leaving a screen unmounts its table; without this,
 * coming back to it — Back, or the nav — drew eight one-line stand-ins
 * instead of the twelve two-line rows it had just shown, the page came back
 * several hundred pixels shorter than it left, and Back could not return to
 * where the reader had been (recorded: 500px left, 24px restored, because 24
 * was as far as the short page could scroll). Keyed by caption, which every
 * table in the panel carries and which names what it lists.
 */
const learned = new Map();

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
 *  - loadingRows: number       stand-ins to draw while loading (see below)
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
  loadingRows,
}) {
  const keyFor = (row, i) =>
    rowKey ? rowKey(row, i) : (row?.id ?? row?._id ?? i);

  // How many stand-in rows to draw while the next set is on its way.
  //
  // A page size is a caller's business and every screen here picks its own
  // (Users is 12, others 20), so guessing one number for all of them would
  // trade one layout shift for a different one. A table that has already
  // shown rows does not have to guess: it knows exactly how many are coming
  // back, so a refetch — a filter, a page change, Refresh — holds its height
  // to the pixel. Only the very first load has a number to pick, and eight is
  // a screenful.
  const memo = learned.get(caption || '') || {};
  const lastCount = useRef(0);
  if (!loading && rows.length) lastCount.current = rows.length;
  const standIns = loadingRows || lastCount.current || memo.count || 8;

  // And how TALL those rows are. Matching the count alone was not enough:
  // twelve stand-ins of one line each against twelve real rows of a name over
  // an email is still 336px of movement, which is most of the shift the
  // stand-ins were added to remove. Every table here has a different row —
  // one line, two lines, a badge, a thumbnail — so this is measured off the
  // real thing rather than guessed per screen.
  const bodyRef = useRef(null);
  const lastRowHeight = useRef(0);
  useEffect(() => {
    if (loading || !rows.length) return;
    const tr = bodyRef.current && bodyRef.current.querySelector('tr');
    if (tr) lastRowHeight.current = Math.round(tr.getBoundingClientRect().height);
    learned.set(caption || '', { count: rows.length, height: lastRowHeight.current });
  }, [loading, rows.length, caption]);
  const standInHeight = lastRowHeight.current || memo.height || 0;

  return (
    // Focusable, because it scrolls. Every table in the panel is wider than a
    // phone, and a scroll box only a pointer can reach puts the right-hand
    // columns — which is where the row actions live — out of a keyboard's
    // reach entirely (axe: scrollable-region-focusable).
    <div
      className="overflow-x-auto rounded-xl border border-admin-border bg-admin-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-admin-accent)]"
      tabIndex={0}
      role="region"
      aria-busy={loading || undefined}
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
        <tbody ref={bodyRef}>
          {loading ? (
            /* Rows the shape of the rows that are coming, rather than one
               centred word. The word collapsed the table to a single line, so
               the moment the data landed the page grew by twenty rows and
               every control under it jumped. The region above carries
               aria-busy; these are decoration and stay out of the tree. */
            Array.from({ length: standIns }, (_, r) => (
              <tr
                key={`loading-${r}`}
                aria-hidden="true"
                style={standInHeight ? { height: standInHeight } : undefined}
              >
                {columns.map((col, c) => (
                  <td key={col.key} className={col.className}>
                    <span
                      className={`skeleton block h-4 rounded ${c === 0 ? 'w-40' : 'w-20'}`}
                    />
                  </td>
                ))}
              </tr>
            ))
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
                // row-in: each row fades up out of the stand-in it replaces.
                className={onRowClick ? 'row-in cursor-pointer' : 'row-in'}
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
