/**
 * Skeleton — a stand-in the shape of the content that is on its way.
 *
 * The shimmer is not the point; the size is. A centred spinner occupies one
 * line, so when the data lands the page grows by several hundred pixels at
 * once and everything the reader was looking at jumps down. A stand-in built
 * to the real layout means nothing moves when the content replaces it.
 *
 * Each block is aria-hidden and the wrapper carries the announcement: one
 * "Loading plans" is information, forty separate "loading" nodes are noise.
 */
export default function Skeleton({ className = '' }) {
  return <span className={`skeleton block ${className}`.trim()} aria-hidden="true" />;
}
