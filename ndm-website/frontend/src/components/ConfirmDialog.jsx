import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import Button from './Button';

const ConfirmContext = createContext(null);

/**
 * ConfirmProvider — a promise-based replacement for window.confirm().
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: 'Cancel subscription?', message: '…', confirmLabel: 'Cancel it', danger: true }))) return;
 *
 * One dialog instance lives here; callers just await the answer. Escape and
 * the backdrop both resolve false, so nothing destructive happens by accident.
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
  const confirmRef = useRef(null);

  useEffect(() => {
    if (!request) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onSettle(false); };
    window.addEventListener('keydown', onKey);
    // Focus the affirmative button so Enter confirms and Tab reaches Cancel.
    confirmRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [request, onSettle]);

  if (!request) return null;
  const {
    title = 'Are you sure?', message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false,
  } = request;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" role="presentation">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => onSettle(false)}
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={message ? 'confirm-message' : undefined}
        className="card relative w-full max-w-md !p-6"
      >
        <h2 id="confirm-title" className="text-lg font-bold text-white">{title}</h2>
        {message && (
          <p id="confirm-message" className="mt-2 text-sm leading-6 text-slate-400">{message}</p>
        )}
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button variant="ghost" onClick={() => onSettle(false)}>{cancelLabel}</Button>
          <Button
            ref={confirmRef}
            onClick={() => onSettle(true)}
            className={danger ? '!bg-none !bg-red-500 hover:!bg-red-400 !shadow-none' : ''}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
