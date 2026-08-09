/**
 * Input — labeled text field. Pass `label`, `error`, and any native <input> props.
 */
export default function Input({
  label,
  error,
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
      {error && <p className="mt-1.5 text-xs text-admin-danger">{error}</p>}
    </div>
  );
}
