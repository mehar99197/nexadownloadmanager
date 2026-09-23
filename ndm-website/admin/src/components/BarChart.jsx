import Skeleton, { BAR_OUTLINE } from './Skeleton.jsx';

/**
 * BarChart — lightweight pure-CSS/SVG bars. NO chart library.
 *
 * Props:
 *  - data: [{ label, value }]
 *  - height?: number (px, default 200) — chart plotting area height
 *  - valueFormatter?: (value) => string
 *  - barClassName?: string (color of the bars)
 *  - loading?: boolean — draw `skeletonBars` outline bars instead. It used to
 *    say "No data" while the data was still coming, which is a claim.
 *
 * Renders vertical bars sized relative to the max value, with labels beneath.
 */
export default function BarChart({
  data = [],
  height = 200,
  valueFormatter = (v) => String(v),
  barClassName = 'bg-admin-accent',
  loading = false,
  skeletonBars = 14,
}) {
  const max = data.reduce((m, d) => Math.max(m, Number(d.value) || 0), 0) || 1;

  if (loading) {
    const bars = BAR_OUTLINE.slice(0, skeletonBars);
    return (
      <div className="w-full">
        <div className="flex items-end gap-2" style={{ height }}>
          {bars.map((h, i) => (
            <div key={i} className="flex h-full min-w-0 flex-1 items-end justify-center">
              <Skeleton className="w-full max-w-16 rounded-t-md" style={{ height: `${h}%` }} />
            </div>
          ))}
        </div>
        {/* h-4: the real label row is one 16px line of text-xs. */}
        <div className="mt-2 flex h-4 items-center gap-2">
          {bars.map((_, i) => (
            <div key={i} className="flex min-w-0 flex-1 justify-center">
              <Skeleton className="h-3 w-7 max-w-full rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    // As tall as a chart with its label row (8px gap + one 16px line), so an
    // empty series takes the place its outline held instead of shrinking it.
    return (
      <div
        className="flex items-center justify-center text-sm text-admin-muted fade-in"
        style={{ height: height + 24 }}
      >
        No data
      </div>
    );
  }

  return (
    <div className="w-full fade-in">
      <div className="flex items-end gap-2" style={{ height }}>
        {data.map((d, i) => {
          const value = Number(d.value) || 0;
          const pct = Math.max(2, (value / max) * 100);
          return (
            <div
              key={d.label ?? i}
              className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end"
              title={`${d.label}: ${valueFormatter(value)}`}
            >
              <span className="mb-1 text-xs font-medium text-admin-muted opacity-0 transition-opacity group-hover:opacity-100">
                {valueFormatter(value)}
              </span>
              {/* max-w keeps a bar looking like a bar: with one or two days of
                  data a plain w-full column stretched into a full-width slab. */}
              <div
                className={`w-full max-w-16 rounded-t-md transition-all ${barClassName}`}
                style={{ height: `${pct}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2">
        {data.map((d, i) => (
          <div
            key={d.label ?? i}
            className="min-w-0 flex-1 truncate text-center text-xs text-admin-faint"
          >
            {d.label}
          </div>
        ))}
      </div>
    </div>
  );
}
