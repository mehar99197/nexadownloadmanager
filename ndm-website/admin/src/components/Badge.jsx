/**
 * Badge — small status pill. tone: default | success | warning | danger | info.
 * Convenience: status strings map to a sensible tone via STATUS_TONE.
 */
const TONES = {
  default: 'bg-admin-surface-2 text-admin-muted border-admin-border',
  success: 'bg-admin-success/15 text-admin-success border-admin-success/30',
  warning: 'bg-admin-warning/15 text-admin-warning border-admin-warning/30',
  danger: 'bg-admin-danger/15 text-admin-danger border-admin-danger/30',
  info: 'bg-admin-info/15 text-admin-info border-admin-info/30',
};

export const STATUS_TONE = {
  active: 'success',
  approved: 'success',
  paid: 'success',
  pending: 'warning',
  expired: 'warning',
  rejected: 'danger',
  cancelled: 'danger',
  failed: 'danger',
  banned: 'danger',
  refunded: 'info',
};

export default function Badge({ tone, status, children, className = '' }) {
  const resolved = tone || (status && STATUS_TONE[status]) || 'default';
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${TONES[resolved] || TONES.default} ${className}`}
    >
      {children ?? status}
    </span>
  );
}
