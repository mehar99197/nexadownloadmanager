import { createElement, lazy, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useNavigationType } from 'react-router-dom';

/* ------------------------------------------------------------------ *
 *  Moving between pages without the page moving.
 *
 *  Measured frame by frame on the live site before this existed, a
 *  navigation from a scrolled page to one not visited yet went:
 *
 *    old page → a BLANK frame with the Suspense spinner → the scroll
 *    clamped from 700 to 0 because the page was suddenly short → the
 *    scrollbar vanished, shifting everything 5px sideways → the new page
 *    → the scrollbar back, shifting everything again.
 *
 *  Four jolts for one click. The cause of the first three was structural:
 *  the page wrapper was keyed by pathname OUTSIDE the Suspense boundary,
 *  so every navigation mounted a brand-new boundary — and a boundary that
 *  is new always shows its fallback, transition or no transition. The
 *  "keep the old page until the new one is ready" that the previous
 *  version described was never actually happening.
 *
 *  What happens now, in order:
 *
 *    1. the old page stays exactly as it is while the next page's code
 *       downloads (a hairline at the top of the window says so);
 *    2. once it has arrived, ONE synchronous commit swaps the page and
 *       sets the scroll — to the top for a new page, back to where the
 *       reader was for Back/Forward;
 *    3. where the browser has view transitions, that commit runs inside
 *       document.startViewTransition, and the screen dissolves from what
 *       was there to what is there.
 *
 *  Step 3 is a plain root cross-fade on purpose. A NAMED element (which
 *  React's <ViewTransition> always creates) is animated from its old box
 *  to its new box, and resetting the scroll moves a page's box by however
 *  far down the reader was — so the old page visibly slid 700px as it
 *  faded. The root snapshot is the viewport itself, which does not move.
 * ------------------------------------------------------------------ */

/**
 * React.lazy, plus a way to fetch the code before it is rendered.
 *
 * lazy() on its own cannot be warmed up: even when the module is already in
 * the browser's cache, the first render of a lazy component suspends, so a
 * synchronous swap would still flash the fallback. Once `preload()` has
 * resolved, this renders the module's component directly and never suspends.
 * Until then — the very first page of a visit — it behaves exactly as lazy()
 * does, under the boot screen.
 */
export function lazyPage(factory) {
  let Loaded = null;
  let loading = null;

  const load = () => {
    if (!loading) {
      loading = factory().then((mod) => {
        Loaded = mod.default;
        return mod;
      });
    }
    return loading;
  };

  const Lazy = lazy(load);

  function Page(props) {
    return Loaded ? createElement(Loaded, props) : createElement(Lazy, props);
  }
  Page.preload = load;
  Page.isLoaded = () => Loaded !== null;
  return Page;
}

/* ---------------- where each page was left ---------------- */

const SCROLL_KEY = 'ndm_scroll';

/**
 * One history entry. React Router's `key` lives in history.state, so it
 * survives a reload — but the landing entry of every fresh document is keyed
 * "default", so the path is part of the id or a new tab's /faq would inherit
 * the scroll position of an old tab's /pricing.
 */
export const entryId = (location) => `${location.key}|${location.pathname}`;

function readScroll() {
  try {
    return JSON.parse(sessionStorage.getItem(SCROLL_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

export function rememberScroll(location) {
  try {
    const map = readScroll();
    map[entryId(location)] = Math.round(window.scrollY);
    // A long session should not grow this without bound.
    const ids = Object.keys(map);
    if (ids.length > 80) delete map[ids[0]];
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify(map));
  } catch {
    /* storage blocked: Back lands at the top, which is merely ordinary */
  }
}

export function recallScroll(location) {
  const y = readScroll()[entryId(location)];
  return typeof y === 'number' ? y : null;
}

/** Scroll without the smooth behaviour html carries for in-page anchors. */
const jumpTo = (top) => window.scrollTo({ top, left: 0, behavior: 'instant' });

/* ---------------- the swap ---------------- */

/**
 * The location the page is actually showing, which trails the URL by exactly
 * as long as the next page's code takes to arrive — and not a frame longer.
 *
 * `preloadFor(pathname)` returns a promise for that page's code, or null when
 * there is nothing to wait for.
 */
export function useSwappedLocation(preloadFor) {
  const live = useLocation();
  const navType = useNavigationType();
  const [shown, setShown] = useState(live);
  const [pending, setPending] = useState(false);

  // Leaving the site, closing the tab or reloading: record where this page
  // was, so a reload or a Back from elsewhere returns to the same spot.
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    const onHide = () => rememberScroll(shownRef.current);
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  useEffect(() => {
    if (shown.key === live.key) return undefined;

    let cancelled = false;
    const target = live;
    const samePage = target.pathname === shown.pathname;

    // Where the page being left was, for when Back returns to it. Taken now,
    // before anything moves: with scrollRestoration set to manual (main.jsx)
    // the browser does not touch the scroll on a Back, so this is still the
    // old page's position.
    rememberScroll(shown);

    const land = () => {
      if (target.hash) {
        const anchor = document.getElementById(decodeURIComponent(target.hash.slice(1)));
        if (anchor) {
          anchor.scrollIntoView({ block: 'start', behavior: samePage ? 'smooth' : 'instant' });
          return;
        }
      }
      // A query string changing on the same page (a filter, a tab) keeps the
      // reader where they are.
      if (samePage) return;
      jumpTo(navType === 'POP' ? (recallScroll(target) ?? 0) : 0);
    };

    if (samePage) {
      setShown(target);
      land();
      return () => {
        cancelled = true;
      };
    }

    const swap = () => {
      if (cancelled) return;
      // Synchronous on purpose: the page, its title, the active nav link and
      // the scroll position all change in the same frame, inside the view
      // transition's update, so the "after" snapshot is already right.
      flushSync(() => setShown(target));
      land();
    };

    const run = () => {
      if (cancelled) return;
      setPending(false);
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!reduce && typeof document.startViewTransition === 'function') {
        document.startViewTransition(swap);
      } else {
        swap();
      }
    };

    const loading = preloadFor(target.pathname);
    if (loading) {
      setPending(true);
      // A failed download still has to leave the old page: the route then
      // renders through lazy(), whose own error reaches the ErrorBoundary.
      loading.then(run, run);
    } else {
      run();
    }

    return () => {
      cancelled = true;
    };
  }, [live, shown, navType, preloadFor]);

  return [shown, pending];
}

/* ---------------- the end of the boot screen ---------------- */

let booted = false;

/**
 * Lifts the boot screen once the first page's CONTENT is on screen.
 *
 * It used to be lifted from main.jsx two frames after render() — which is the
 * shell, not the page. On any route that is loaded on demand the page itself
 * arrives a network round trip later, so the screen lifted onto a navbar, a
 * spinner and a footer, and the page then popped in under the reader. This
 * sits inside the Suspense boundary beside the page, so it cannot mount until
 * the page has.
 *
 * It is also where a reload gets its scroll position back, while the boot
 * screen still covers the page: restored before anyone can see it happen.
 */
export function BootDone() {
  const location = useLocation();

  useEffect(() => {
    if (booted) return;
    booted = true;
    const y = recallScroll(location);
    if (y) jumpTo(y);
    // Two frames: effects run after the commit but before the paint.
    requestAnimationFrame(() => requestAnimationFrame(() => window.__ndmBootDone?.()));
  }, [location]);

  return null;
}
