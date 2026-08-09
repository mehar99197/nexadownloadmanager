/**
 * BarChart — lightweight pure-CSS/SVG bars. NO chart library.
 *
 * Props:
 *  - data: [{ label, value }]
 *  - height?: number (px, default 200) — chart plotting area height
 *  - valueFormatter?: (value) => string
 *  - barClassName?: string (color of the bars)
 *
 * Renders vertical bars sized relative to the max value, with labels beneath.
 */
export default function BarChart({
  data = [],
  height = 200,
  valueFormatter = (v) => String(v),
  barClassName = 'bg-admin-accent',
}) {
  const max = data.reduce((m, d) => Math.max(m, Number(d.value) || 0), 0) || 1;

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-admin-muted"
        style={{ height }}
      >
        No data
      </div>
    );
  }

  return (
    <div className="w-full">
      <div className="flex items-end gap-2" style={{ height }}>
        {data.map((d, i) => {
          const value = Number(d.value) || 0;
          const pct = Math.max(2, (value / max) * 100);
          return (
            <div
              key={d.label ?? i}
              className="group flex min-w-0 flex-1 flex-col items-center justify-end"
              title={`${d.label}: ${valueFormatter(value)}`}
            >
              <span className="mb-1 text-[10px] font-medium text-admin-muted opacity-0 transition-opacity group-hover:opacity-100">
                {valueFormatter(value)}
              </span>
              <div
                className={`w-full rounded-t-md transition-all ${barClassName}`}
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
            className="min-w-0 flex-1 truncate text-center text-[11px] text-admin-faint"
          >
            {d.label}
          </div>
        ))}
      </div>
    </div>
  );
}
