/**
 * Spinner — accessible loading indicator. `size` in px. `center` wraps it
 * in a centered flex box for full-page loading states.
 */
export default function Spinner({ size = 22, center = false, className = '' }) {
  const svg = (
    <svg
      className={`animate-spin text-[var(--color-brand-400)] ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label="Loading"
    >
      <circle
        className="opacity-20"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"
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
