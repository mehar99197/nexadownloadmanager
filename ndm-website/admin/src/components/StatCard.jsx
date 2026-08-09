/**
 * StatCard — a labeled metric tile for the dashboard.
 * Props: label, value, hint?, icon?, accent? (border/icon color class).
 */
export default function StatCard({ label, value, hint, icon, accent }) {
  return (
    <div className="stat-card">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-admin-muted">{label}</p>
          <p className="mt-2 text-3xl font-semibold text-admin-text">
            {value ?? '—'}
          </p>
        </div>
        {icon && (
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-lg bg-admin-surface-2 text-lg ${accent || 'text-admin-accent'}`}
          >
            {icon}
          </div>
        )}
      </div>
      {hint && <p className="mt-3 text-xs text-admin-faint">{hint}</p>}
    </div>
  );
}
