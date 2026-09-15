/**
 * Button — variants: primary | secondary | danger | ghost. sizes: sm | md.
 */
// `from-accent-500 to-admin-cyan` carries white at 4.09:1 falling to 1.92:1,
// and --color-admin-danger at 2.63:1 — every action button in the panel was
// under AA, the destructive one worst of all. Both fills are deepened until
// white clears 4.5:1; `.btn-admin-primary` in index.css uses the same gradient
// so a Button and a bare class cannot drift apart.
const VARIANTS = {
  primary:
    'btn-admin-gradient text-white shadow-[0_12px_26px_-14px_rgba(53,201,255,0.8)] hover:brightness-110 disabled:opacity-50',
  secondary:
    'bg-admin-surface-2 text-admin-text border border-admin-border hover:bg-admin-border disabled:opacity-50',
  danger: 'bg-[#b81f3c] text-white hover:brightness-110 disabled:opacity-50',
  ghost:
    'bg-transparent text-admin-muted hover:bg-admin-surface-2 hover:text-admin-text disabled:opacity-50',
};

const SIZES = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
};

import { forwardRef } from 'react';

const Button = forwardRef(function Button({
  variant = 'primary',
  size = 'md',
  type = 'button',
  className = '',
  children,
  ...props
}, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed ${VARIANTS[variant] || VARIANTS.primary} ${SIZES[size] || SIZES.md} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
});

export default Button;
