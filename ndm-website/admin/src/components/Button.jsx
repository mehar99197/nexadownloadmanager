/**
 * Button — variants: primary | secondary | danger | ghost. sizes: sm | md.
 */
const VARIANTS = {
  primary:
    'bg-gradient-to-r from-accent-500 to-admin-cyan text-white shadow-[0_12px_26px_-14px_rgba(53,201,255,0.8)] hover:brightness-110 disabled:opacity-50',
  secondary:
    'bg-admin-surface-2 text-admin-text border border-admin-border hover:bg-admin-border disabled:opacity-50',
  danger: 'bg-admin-danger text-white hover:brightness-110 disabled:opacity-50',
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
