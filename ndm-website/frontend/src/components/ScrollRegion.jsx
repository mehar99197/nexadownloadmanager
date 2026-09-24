/**
 * A box that scrolls sideways when what it holds (a table, usually) is wider
 * than the screen.
 *
 * Focusable on purpose. A scroll box only a pointer can reach puts the
 * right-hand columns out of a keyboard's reach entirely (axe:
 * scrollable-region-focusable): tabIndex lets the arrow keys scroll it, and
 * the role and label stop it being an unnamed tab stop. The comparison table
 * on /compare does the same inline; every other table on the site now goes
 * through here.
 */
export default function ScrollRegion({ label, className = '', children }) {
  return (
    <div
      className={`overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-300)] ${className}`.trim()}
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      {children}
    </div>
  );
}
