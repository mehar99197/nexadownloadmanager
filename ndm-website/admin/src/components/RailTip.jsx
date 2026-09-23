import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Tailwind's md breakpoint. Below it the sidebar is the phone drawer, which
// always carries its labels.
const DESKTOP = '(min-width: 48rem)';

/**
 * The name of a sidebar link, beside it, while the sidebar is folded to a rail
 * of icons — for a pointer resting on the icon, or keyboard focus reaching it.
 *
 * It is drawn in a portal on <body>. Inside the sidebar it would be clipped:
 * the sidebar scrolls on its own, and it is translated, which makes it the
 * containing block even for position: fixed.
 *
 * It is only a picture of the name. Every link keeps its label as text
 * (visually hidden in the rail), so a screen reader hears the same name
 * folded or not, and the tip itself is aria-hidden. As WCAG 1.4.13 asks of
 * anything that appears on hover or focus, Escape dismisses it, and the
 * pointer can move onto it without it vanishing.
 */
export function useRailTip(active) {
  const [tip, setTip] = useState(null);
  const timer = useRef(0);

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setTip(null);
  }, []);

  const show = useCallback(
    (target, label) => {
      window.clearTimeout(timer.current);
      if (!active || !window.matchMedia(DESKTOP).matches) return;
      const box = target.getBoundingClientRect();
      const edge = target.closest('aside')?.getBoundingClientRect().right ?? box.right;
      setTip({ label, top: box.top + box.height / 2, left: edge + 8 });
    },
    [active]
  );

  // A short grace on the way out, so the pointer can cross onto the tip.
  const leave = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setTip(null), 150);
  }, []);

  useEffect(() => {
    if (!tip) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey);
    // It is placed once, so anything that could move its link takes it away.
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [tip, hide]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  /** The handlers that give one link (or the logout button) its tip. */
  const tipFor = (label) => ({
    onPointerEnter: (event) => {
      if (event.pointerType !== 'touch') show(event.currentTarget, label);
    },
    onPointerLeave: leave,
    onFocus: (event) => {
      if (focusVisible(event.currentTarget)) show(event.currentTarget, label);
    },
    onBlur: hide,
  });

  const element =
    tip &&
    createPortal(
      <div
        className="rail-tip"
        aria-hidden="true"
        style={{ top: tip.top, left: tip.left }}
        onPointerEnter={() => window.clearTimeout(timer.current)}
        onPointerLeave={hide}
      >
        {tip.label}
      </div>,
      document.body
    );

  return { tipFor, tip: element, hideTip: hide };
}

// Focus from a click is not a reason to show a name the pointer already
// shows; focus from the keyboard is the only way a keyboard learns it.
function focusVisible(element) {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}
