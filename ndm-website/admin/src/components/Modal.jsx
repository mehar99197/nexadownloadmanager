import { useId } from 'react';
import useDialogFocus from '../useDialogFocus.js';

/**
 * Modal — centered dialog over a dimmed backdrop.
 *
 * Props:
 *  - open: boolean
 *  - onClose: () => void   (backdrop click + Escape)
 *  - title?: node
 *  - footer?: node         (rendered in a right-aligned action row)
 *  - children: body
 *  - size?: 'sm' | 'md' | 'lg'
 *
 * Keyboard behaviour lives in useDialogFocus, shared with ConfirmDialog.
 */
const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

export default function Modal({
  open,
  onClose,
  title,
  footer,
  children,
  size = 'md',
}) {
  const titleId = useId();
  const panel = useDialogFocus(open, onClose);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={`relative w-full ${SIZES[size] || SIZES.md} rounded-xl border border-admin-border bg-admin-surface shadow-xl outline-none`}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-admin-border px-5 py-4">
            <h3 id={titleId} className="text-base font-semibold text-admin-text">{title}</h3>
            <button
              type="button"
              onClick={onClose}
              className="text-admin-muted transition-colors hover:text-admin-text"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        )}
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-admin-border px-5 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
