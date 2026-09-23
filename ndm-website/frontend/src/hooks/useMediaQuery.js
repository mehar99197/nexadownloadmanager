import { useEffect, useState } from 'react';

/**
 * useMediaQuery — true while the given media query matches.
 *
 * For the cases a CSS breakpoint cannot express: rendering a *different tree*
 * on a phone rather than restyling the same one. Hiding the wide version with
 * `hidden md:block` would leave both in the document — twice the nodes, the
 * same content twice for a crawler, and every control in the hidden copy still
 * there to be found by a tab key in some browsers.
 *
 * Starts from the real value rather than `false`, so the first paint is
 * already right and nothing flips on hydration.
 */
export default function useMediaQuery(query) {
  const read = () =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(query).matches
      : false;

  const [matches, setMatches] = useState(read);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    // The query can change between renders, and the width can change between
    // the first read and this effect running.
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
