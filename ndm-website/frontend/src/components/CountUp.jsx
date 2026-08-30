import { useEffect, useRef, useState } from 'react';

/**
 * CountUp — animated count-up for stat tiles (Warp Intake motion pass).
 *
 * Renders the final value immediately when the value is not a finite number,
 * IntersectionObserver is missing (jsdom, crawlers) or the visitor prefers
 * reduced motion — the animation is a flourish, never a gate on the data.
 */
export default function CountUp({ value, duration = 900, className = '' }) {
  const target = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  const animatable = Number.isFinite(target);
  const ref = useRef(null);
  const [shown, setShown] = useState(0);
  const [done, setDone] = useState(!animatable);

  useEffect(() => {
    if (!animatable) return undefined;
    const el = ref.current;
    const reduced = !!(
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
    if (!el || typeof IntersectionObserver === 'undefined' || reduced) {
      setDone(true);
      return undefined;
    }
    let raf = 0;
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      io.disconnect();
      clearTimeout(fallback);
      const t0 = performance.now();
      const tick = (now) => {
        const k = Math.min(1, (now - t0) / duration);
        const eased = 1 - Math.pow(1 - k, 3);
        setShown(Math.round(target * eased));
        if (k < 1) raf = requestAnimationFrame(tick);
        else setDone(true);
      };
      raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) start();
      },
      { threshold: 0.4 }
    );
    // Below-the-fold tiles still count up (and settle on the real number)
    // even when the visitor never scrolls.
    const fallback = setTimeout(start, 1200);
    io.observe(el);
    return () => {
      io.disconnect();
      clearTimeout(fallback);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [animatable, target, duration]);

  const text = animatable
    ? (done ? target : shown).toLocaleString('en-US')
    : value;
  return (
    <span ref={ref} className={className}>
      {text}
    </span>
  );
}
