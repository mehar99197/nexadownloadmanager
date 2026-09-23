import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Decided once, at load. The scroll-driven reveal is pure CSS and is already
 * gated in the stylesheet on both support and prefers-reduced-motion, so the
 * class can be on the section from its very first render — nothing about the
 * section changes after the browser has painted it.
 */
const NATIVE_REVEAL =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('animation-timeline: view()');

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
 * scroll rather than starting a frame after it.
 *
 * Both paths now leave a section that is ALREADY on screen alone. The class
 * used to arrive in an effect, after the first paint, so a section straddling
 * the fold was drawn in place and then jumped: straight down by up to 22px on
 * the native path, and on the observer path it vanished and faded back in.
 * Frame-by-frame recording showed it on every load and every navigation.
 * The native class is now in the first render; the observer path only ever
 * hides a section that starts below the fold, where nobody can see it go.
 */
export default function Section({
  id,
  className = '',
  innerClassName = '',
  full = false,
  children,
}) {
  const ref = useRef(null);
  const [reveal, setReveal] = useState(NATIVE_REVEAL ? 'reveal-native' : '');

  // Layout effect, so a below-the-fold section is hidden before the first
  // paint rather than one frame after it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || NATIVE_REVEAL || typeof IntersectionObserver === 'undefined') return undefined;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return undefined;
    }
    // On screen already: leave it exactly as painted. Hiding it now to fade
    // it back in is the blink this path used to produce on every load.
    if (el.getBoundingClientRect().top < window.innerHeight) return undefined;
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
