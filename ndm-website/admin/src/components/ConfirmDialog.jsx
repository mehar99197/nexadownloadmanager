import { createContext, useCallback, useContext, useRef, useState } from 'react';
import Button from './Button.jsx';
import useDialogFocus from '../useDialogFocus.js';

const ConfirmContext = createContext(null);

/**
 * ConfirmProvider — promise-based replacement for window.confirm().
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: 'Delete release?', message: '…', confirmLabel: 'Delete', danger: true }))) return;
 *
 * Escape and the backdrop resolve false, so nothing destructive happens by
 * accident; Enter on the focused primary button confirms.
 */
export function ConfirmProvider({ children }) {
  const [request, setRequest] = useState(null);
  const resolver = useRef(null);

  const confirm = useCallback((options) => new Promise((resolve) => {
    resolver.current = resolve;
    setRequest({ ...options });
  }), []);

  const settle = useCallback((answer) => {
    setRequest(null);
    const resolve = resolver.current;
    resolver.current = null;
    if (resolve) resolve(answer);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog request={request} onSettle={settle} />
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within a ConfirmProvider');
  return ctx;
}

function ConfirmDialog({ request, onSettle }) {
  const primary = useRef(null);
  // Focus was moved in already; what was missing is containment. One Tab from
  // "Delete permanently?" used to land in the sidebar, leaving Cancel
  // unreachable on the one prompt where reaching it matters most.
  const panel = useDialogFocus(Boolean(request), () => onSettle(false), { initialFocus: primary });

  if (!request) return null;
  const {
    title = 'Are you sure?', message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false,
  } = request;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => onSettle(false)}
      />
      <div
        ref={panel}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="admin-confirm-title"
        tabIndex={-1}
        className="relative w-full max-w-md rounded-xl border border-admin-border bg-admin-surface p-5 shadow-xl outline-none"
      >
        <h3 id="admin-confirm-title" className="text-base font-semibold text-admin-text">{title}</h3>
        {message && <p className="mt-2 text-sm leading-6 text-admin-muted">{message}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onSettle(false)}>{cancelLabel}</Button>
          <Button ref={primary} variant={danger ? 'danger' : 'primary'} onClick={() => onSettle(true)}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
