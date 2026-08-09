/**
 * Section — vertical page section with the standard container + rhythm.
 * Set `full` to drop the inner container (e.g. full-bleed hero).
 */
export default function Section({
  id,
  className = '',
  innerClassName = '',
  full = false,
  children,
}) {
  return (
    <section id={id} className={`section ${className}`.trim()}>
      {full ? (
        children
      ) : (
        <div className={`container-x ${innerClassName}`.trim()}>{children}</div>
      )}
    </section>
  );
}
