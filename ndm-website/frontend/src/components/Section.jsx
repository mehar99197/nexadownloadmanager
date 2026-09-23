import { useEffect, useRef, useState } from 'react';

/**
 * Section — vertical page section with the standard container + rhythm.
 * Set `full` to drop the inner container (e.g. full-bleed hero).
 *
 * Warp Intake: each section drifts in toward the centre line the first time
 * it enters the viewport. The reveal classes are only applied by effect —
 * and only when IntersectionObserver exists and reduced motion is not
 * requested — so crawlers, jsdom and old browsers always see the content.
 *
 * Where the browser has scroll-driven animations the reveal is handed to CSS
 * instead (.reveal-native, index.css): the scroll position drives the
 * animation directly, so there is no observer to construct per section, no
 * callback on the main thread, and the drift stays in step with a fling
 * scroll rather than starting a frame after it. The observer below is still
 * the path Firefox takes, and is unchanged.
 */
export default function Section({
  id,
  className = '',
  innerClassName = '',
  full = false,
  children,
}) {
  const ref = useRef(null);
  const [reveal, setReveal] = useState('');

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return undefined;
    }
    // Set once and never changed again: the animation is entirely CSS from
    // here, and the class carries no visible state of its own.
    if (typeof CSS !== 'undefined' && CSS.supports && CSS.supports('animation-timeline: view()')) {
      setReveal('reveal-native');
      return undefined;
    }
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setReveal('reveal reveal-in');
          io.disconnect();
        }
      },
      { threshold: 0.08, rootMargin: '0px 0px -4% 0px' }
    );
    setReveal('reveal');
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <section id={id} ref={ref} className={`section ${reveal} ${className}`.replace(/\s+/g, ' ').trim()}>
      {full ? (
        children
      ) : (
        <div className={`container-x ${innerClassName}`.trim()}>{children}</div>
      )}
    </section>
  );
}
