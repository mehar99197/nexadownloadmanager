import { useEffect, useRef, useState } from 'react';

/**
 * Section — vertical page section with the standard container + rhythm.
 * Set `full` to drop the inner container (e.g. full-bleed hero).
 *
 * Warp Intake: each section drifts in toward the centre line the first time
 * it enters the viewport. The reveal classes are only applied by effect —
 * and only when IntersectionObserver exists and reduced motion is not
 * requested — so crawlers, jsdom and old browsers always see the content.
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
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return undefined;
    }
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
