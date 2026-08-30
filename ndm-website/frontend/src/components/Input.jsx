import { forwardRef, useState } from 'react';

function EyeIcon(props) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon(props) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a20.3 20.3 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a20.3 20.3 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <path d="M1 1l22 22" />
    </svg>
  );
}

/**
 * Input — labelled text input with optional error + hint.
 * A `type="password"` field automatically gets a show/hide toggle.
 */
const Input = forwardRef(function Input(
  { label, error, hint, id, as = 'input', className = '', type = 'text', ...rest },
  ref
) {
  const inputId = id || rest.name;
  const Field = as;
  const isPassword = as === 'input' && type === 'password';
  const [visible, setVisible] = useState(false);

  const field = (
    <Field
      ref={ref}
      id={inputId}
      type={isPassword ? (visible ? 'text' : 'password') : type}
      className={`input-field ${isPassword ? 'pr-11' : ''} ${
        error
          ? 'border-red-400/70 focus:border-red-400 focus:ring-red-400/20'
          : ''
      } ${className}`}
      {...rest}
    />
  );

  return (
    <div className="block">
      {label && (
        // A real <label>, not a wrapper: when a <label> wraps an interactive
        // descendant (the show/hide button), some browsers fold the button's
        // own aria-label into the input's accessible name ("Password Show
        // password"). Associating by htmlFor instead keeps the input's name
        // just "Password".
        <label htmlFor={inputId} className="mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-slate-300">
          {label}
        </label>
      )}
      {isPassword ? (
        <div className="relative">
          {field}
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? 'Hide password' : 'Show password'}
            aria-pressed={visible}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 transition-colors hover:text-slate-300"
          >
            {visible ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
      ) : (
        field
      )}
      {error ? (
        <span className="mt-1 block text-xs text-red-400">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-xs text-slate-500">{hint}</span>
      ) : null}
    </div>
  );
});

export default Input;
