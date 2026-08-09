import { forwardRef } from 'react';

/**
 * Input — labelled text input with optional error + hint.
 */
const Input = forwardRef(function Input(
  { label, error, hint, id, as = 'input', className = '', ...rest },
  ref
) {
  const inputId = id || rest.name;
  const Field = as;
  return (
    <label className="block" htmlFor={inputId}>
      {label && (
        <span className="mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-slate-300">
          {label}
        </span>
      )}
      <Field
        ref={ref}
        id={inputId}
        className={`input-field ${
          error
            ? 'border-red-400/70 focus:border-red-400 focus:ring-red-400/20'
            : ''
        } ${className}`}
        {...rest}
      />
      {error ? (
        <span className="mt-1 block text-xs text-red-400">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-xs text-slate-500">{hint}</span>
      ) : null}
    </label>
  );
});

export default Input;
