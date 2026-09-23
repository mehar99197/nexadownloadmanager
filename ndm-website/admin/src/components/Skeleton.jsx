import { useState } from 'react';

/**
 * Skeleton — a stand-in the shape of the content that is on its way.
 *
 * The size is the point, not the shimmer: a stand-in built to the real
 * layout means nothing moves when the content replaces it. Each block is
 * aria-hidden; whatever wraps a group of them carries the one "loading"
 * announcement (a busy region, or a status).
 */
export default function Skeleton({ className = '', style }) {
  return <span className={`skeleton block ${className}`.trim()} style={style} aria-hidden="true" />;
}

/** Outline bar heights (%) for a chart: the same every time, because an outline that changes shape between visits reads as noise. */
export const BAR_OUTLINE = [38, 52, 44, 66, 58, 72, 48, 80, 62, 70, 54, 86, 68, 76];

/**
 * A stand-in for a run of text about `chars` characters long, laid out in the
 * font and line box the real text will have — a stat's number, a count in a
 * sentence — and painted as a bar (index.css, .skeleton-text).
 *
 * Figure spaces, not placeholder words: transparent words are still words,
 * and find-in-page (or a test) would stop on them. U+2007 is as wide as a
 * digit, never collapses and never breaks.
 */
export function SkeletonText({ chars = 6, className = '' }) {
  return (
    <span className={`skeleton skeleton-text ${className}`.trim()} aria-hidden="true">
      {'\u2007'.repeat(chars)}
    </span>
  );
}

/**
 * The class for content arriving where its outline was: 'fade-in' once this
 * component has shown an outline, '' if the content was there from its first
 * frame and has nothing to arrive from.
 */
export function useArrival(loading) {
  const [waited, setWaited] = useState(loading);
  // State adjusted during render — React's own pattern for remembering
  // something about an earlier render; it re-renders at once, before paint.
  if (loading && !waited) setWaited(true);
  return waited ? 'fade-in' : '';
}
