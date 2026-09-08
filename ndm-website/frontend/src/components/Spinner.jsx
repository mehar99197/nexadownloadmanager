import { useId } from 'react';

/**
 * Spinner — accessible loading indicator. `size` in px. `center` wraps it
 * in a centered flex box for full-page loading states.
 *
 * Two arcs turning against each other, the outer one growing and shrinking on
 * its dash offset. Motion and colour live in index.css (`.ndm-spinner__*`), so
 * one definition serves both themes and the reduced-motion variant sits beside
 * the thing it overrides rather than in here.
 */
export default function Spinner({ size = 22, center = false, className = '' }) {
  // The gradient needs a document-unique id. More than one spinner can be on
  // screen at once — a card refreshing while a route loads — and duplicate ids
  // make every url(#…) in the document resolve to whichever one rendered
  // first, so the others would silently lose their gradient. useId's colons
  // are legal in an id but awkward inside url(#…), so they come out.
  const gradientId = `ndm-spinner-${useId().replace(/:/g, '')}`;

  const svg = (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 50 50"
      fill="none"
      role="status"
      aria-label="Loading"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop className="ndm-spinner__from" offset="0%" />
          <stop className="ndm-spinner__to" offset="100%" />
        </linearGradient>
      </defs>

      {/* The full circle the arc travels, faint enough to read as a groove. */}
      <circle className="ndm-spinner__track" cx="25" cy="25" r="21" strokeWidth="4" />

      <circle
        className="ndm-spinner__arc"
        cx="25"
        cy="25"
        r="21"
        stroke={`url(#${gradientId})`}
        strokeWidth="4"
        strokeLinecap="round"
      />

      {/* A short counter-turning arc inside. It is what stops the mark reading
          as one more rotating ring — and it is cheap, since it never changes
          shape. */}
      <circle
        className="ndm-spinner__inner"
        cx="25"
        cy="25"
        r="13"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="14 68"
      />
    </svg>
  );

  if (center) {
    return (
      <div className="flex min-h-[40vh] w-full items-center justify-center">
        {svg}
      </div>
    );
  }
  return svg;
}
