import { createContext, useCallback, useContext, useState } from 'react';

const ToastContext = createContext(null);

let _id = 0;

/**
 * ToastProvider — wraps the app and renders a fixed toast stack.
 * Use the `useToast()` hook to push toasts:
 *   const toast = useToast();
 *   toast.success('Saved!');  toast.error('Something broke');  toast.show(msg, type)
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const remove = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const show = useCallback(
    (message, type = 'info', duration = 4000) => {
      const id = ++_id;
      setToasts((t) => [...t, { id, message, type }]);
      if (duration > 0) setTimeout(() => remove(id), duration);
      return id;
    },
    [remove]
  );

  const api = {
    show,
    remove,
    success: (m, d) => show(m, 'success', d),
    error: (m, d) => show(m, 'error', d),
    info: (m, d) => show(m, 'info', d),
  };

  const tone = {
    success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
    error: 'border-red-500/40 bg-red-500/10 text-red-200',
    info: 'border-brand-400/35 bg-brand-400/10 text-brand-100',
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto w-full max-w-sm rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur ${
              tone[t.type] || tone.info
            }`}
            onClick={() => remove(t.id)}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

export default ToastContext;
