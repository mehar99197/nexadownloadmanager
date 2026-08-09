import { useState } from 'react';

function Star({ filled, half, size }) {
  const id = `half-${Math.random().toString(36).slice(2)}`;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {half && (
        <defs>
          <linearGradient id={id}>
            <stop offset="50%" stopColor="currentColor" />
            <stop offset="50%" stopColor="transparent" />
          </linearGradient>
        </defs>
      )}
      <path
        d="M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.9l-5.8 3.05 1.1-6.46-4.69-4.58 6.49-.94L12 2.5z"
        fill={half ? `url(#${id})` : filled ? 'currentColor' : 'transparent'}
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * StarRating
 * - Display mode (default): pass `value` (can be fractional, e.g. 4.5).
 * - Interactive mode: pass `onChange` — clicking a star sets the value.
 *
 * Props: value, onChange, max=5, size=20, readOnly, className
 */
export default function StarRating({
  value = 0,
  onChange,
  max = 5,
  size = 20,
  readOnly = false,
  className = '',
}) {
  const interactive = typeof onChange === 'function' && !readOnly;
  const [hover, setHover] = useState(0);
  const shown = interactive && hover ? hover : value;

  return (
    <div
      className={`inline-flex items-center gap-0.5 text-accent-300 ${className}`.trim()}
      role={interactive ? 'radiogroup' : 'img'}
      aria-label={`Rating: ${value} out of ${max}`}
    >
      {Array.from({ length: max }, (_, i) => {
        const idx = i + 1;
        const filled = shown >= idx;
        const half = !filled && shown >= idx - 0.5;

        if (!interactive) {
          return <Star key={idx} filled={filled} half={half} size={size} />;
        }
        return (
          <button
            key={idx}
            type="button"
            role="radio"
            aria-checked={value === idx}
            aria-label={`${idx} star${idx > 1 ? 's' : ''}`}
            className="cursor-pointer p-0.5 leading-none transition-transform hover:scale-110"
            onMouseEnter={() => setHover(idx)}
            onMouseLeave={() => setHover(0)}
            onClick={() => onChange(idx)}
          >
            <Star filled={shown >= idx} half={false} size={size} />
          </button>
        );
      })}
    </div>
  );
}
