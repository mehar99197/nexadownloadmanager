import { useState } from 'react';

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

/**
 * A stand-in for a run of text about `chars` characters long, laid out in the
 * font and line box the real text will have and painted as a bar (index.css,
 * .skeleton-text). Use it where the text sits inside something whose height
 * it decides — an eyebrow pill, a heading, a stat — and a block of a guessed
 * height would be off by the line box.
 *
 * The placeholder is FIGURE SPACES, not words. Transparent words are still
 * words: find-in-page stops on them, and a test looking for "downloads
 * served" found the outline of the tile before the tile. U+2007 is as wide
 * as a digit, never collapses and never breaks, so the bar holds its width.
 */
export function SkeletonText({ chars = 12, className = '' }) {
  return (
    <span className={`skeleton skeleton-text ${className}`.trim()} aria-hidden="true">
      {'\u2007'.repeat(chars)}
    </span>
  );
}

/**
 * The class for content arriving in place of its skeleton: 'fade-in' if this
 * component has shown a skeleton since it mounted, '' if the content was
 * there from its first frame (a revisit served from memory) — which the page
 * transition is already bringing in, and fading it a second time would only
 * make it late.
 */
export function useArrival(loading) {
  const [waited, setWaited] = useState(loading);
  // State adjusted during render, React's own pattern for "remember
  // something about an earlier render": it re-renders at once, before paint.
  if (loading && !waited) setWaited(true);
  return waited ? 'fade-in' : '';
}
