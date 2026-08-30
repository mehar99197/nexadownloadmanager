/**
 * Input — labeled text field. Pass `label`, `error`, `hint`, and any native
 * <input> props. `hint` is destructured rather than spread so it renders as
 * help text instead of leaking onto the DOM node as an unknown attribute.
 */
export default function Input({
  label,
  error,
  hint,
  id,
  className = '',
  ...props
}) {
  const inputId = id || props.name;
  return (
    <div className={className}>
      {label && (
        <label htmlFor={inputId} className="admin-label">
          {label}
        </label>
      )}
      <input id={inputId} className="admin-input" {...props} />
      {hint && !error && <p className="mt-1.5 text-xs text-admin-faint">{hint}</p>}
      {error && <p className="mt-1.5 text-xs text-admin-danger">{error}</p>}
    </div>
  );
}
