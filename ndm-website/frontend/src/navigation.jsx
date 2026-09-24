import { createContext, createElement, lazy, useContext, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useNavigationType } from 'react-router-dom';

/* ------------------------------------------------------------------ *
 *  Moving between pages.
 *
 *  Two rounds of this, both reported by the owner and both recorded frame
 *  by frame before anything was changed.
 *
 *  The first was jolts. A click from a scrolled page to one not visited yet
 *  went: old page → a BLANK frame with the Suspense spinner → the scroll
 *  clamped from 700 to 0 → the scrollbar vanished and everything shifted 5px
 *  sideways → the new page → the scrollbar back. The cause was structural:
 *  the page wrapper was keyed OUTSIDE the Suspense boundary, so every
 *  navigation mounted a new boundary, and a new boundary always shows its
 *  fallback. That fix held the old page until the new one was ready and
 *  swapped them in one frame under a 200ms cross-fade.
 *
 *  The second was that the fix had overcorrected: "it shifts all at once,
 *  and no skeleton shows." Holding the old page meant a click on a link
 *  whose code had not arrived did nothing visible but a 2px hairline, and
 *  then the page changed in a single cut that the short dissolve barely
 *  softened. Under prefers-reduced-motion it was a literal cut.
 *
 *  What happens now, in order:
 *
 *    1. the next page's code is usually here before the click: pages are
 *       fetched when a link is pointed at or focused, and the header's own
 *       pages once the first one has settled (usePrefetch);
 *    2. if it is not, the hairline acknowledges the tap at once, and if the
 *       code still has not landed after SKELETON_AFTER_MS the page's
 *       SKELETON is swapped in — the reader sees the page they asked for
 *       taking shape instead of the old one sitting there — and the real
 *       page replaces it the moment its code lands;
 *    3. every swap is ONE synchronous commit — page, title, active link and
 *       scroll together — run inside document.startViewTransition: the
 *       window dissolves from one to the next while the arriving page
 *       settles up into place (index.css, "Moving between pages").
 *
 *  The dissolve is a plain ROOT cross-fade on purpose. A named element is
 *  animated from its old box to its new one, and resetting the scroll moves
 *  a page's box by however far down the reader was — the old page slid
 *  700px as it faded. The root snapshot is the viewport itself, which does
 *  not move; the settle is a transform on the arriving page inside it.
 * ------------------------------------------------------------------ */

/**
 * How long the next page's code may take before its skeleton is shown in
 * the meantime. Under this, the page goes straight in: a skeleton that is on
 * screen for two frames reads as a flicker, not as progress.
 */
export const SKELETON_AFTER_MS = 150;

/**
 * React.lazy, plus a way to fetch the code before it is rendered.
 *
 * lazy() on its own cannot be warmed up: even when the module is already in
 * the browser's cache, the first render of a lazy component suspends, so a
 * synchronous swap would still flash the fallback. Once `preload()` has
 * resolved, this renders the module's component directly and never suspends.
 * Until then — the very first page of a visit — it behaves exactly as lazy()
 * does, under the boot screen.
 *
 * A download that FAILS is not remembered. Prefetching means a page's code
 * can now be requested long before anyone asks for the page, and a blip on
 * the network at that moment must not become a page that can never load.
 */
export function lazyPage(factory) {
  let Loaded = null;
  let loading = null;

  const load = () => {
    if (!loading) {
      loading = factory().then(
        (mod) => {
          Loaded = mod.default;
          return mod;
        },
        (err) => {
          loading = null;
          throw err;
        },
      );
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

/**
 * Put the reader where they belong on the page just shown: its anchor, the
 * place they left it (Back/Forward), or its top.
 *
 * `again` is the second landing, once a page has replaced its skeleton. The
 * skeleton is shorter than most pages and has none of their anchors, so a
 * remembered position or an anchor could not be reached the first time. A
 * plain new page is already at its top, and is left alone — the reader may
 * have scrolled the skeleton, and that scroll is theirs.
 */
function land(target, { samePage = false, pop = false, again = false } = {}) {
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
  if (again && !pop) return;
  jumpTo(pop ? (recallScroll(target) ?? 0) : 0);
}

/* ---------------- the dissolve ---------------- */

let current = null;

/**
 * Run `update` inside a view transition where the browser has one.
 *
 * NOT skipped for prefers-reduced-motion, which it used to be. What a reader
 * who asks for less motion is spared is movement — for them the arriving page
 * does not rise into place (index.css) and the dissolve is shorter — not the
 * change of screen being visible as a change. A dissolve is the standard
 * stand-in for a slide; an instant cut is the "all at once" this replaced.
 */
function dissolve(update) {
  if (typeof document.startViewTransition !== 'function') {
    update();
    return;
  }
  const vt = document.startViewTransition(update);
  current = vt;
  // A transition cut short by the next one (two quick clicks) rejects
  // `ready`; that is expected, and must not surface as an unhandled error.
  vt.ready.catch(() => {});
  vt.finished
    .catch(() => {})
    .then(() => {
      if (current === vt) current = null;
    });
}

/** Resolves once the dissolve in progress, if any, has finished — so two never overlap. */
const afterDissolve = () => (current ? current.finished.catch(() => {}) : Promise.resolve());

/* ---------------- the swap ---------------- */

const Waiting = createContext(false);

/** Provided by App: true while the page being shown is its skeleton. */
export const WaitingProvider = Waiting.Provider;
export const useRouteWaiting = () => useContext(Waiting);

/**
 * The location the page is actually showing, and whether it is showing that
 * page's skeleton rather than the page.
 *
 * `preloadFor(pathname)` returns a promise for that page's code, or null when
 * there is nothing to wait for.
 *
 * Returns [shown, waiting, pending]: `pending` is true for as long as a page's
 * code is being fetched, and drives the hairline at the top of the window.
 */
export function useSwappedLocation(preloadFor) {
  const live = useLocation();
  const navType = useNavigationType();
  const [shown, setShown] = useState(live);
  const [waiting, setWaiting] = useState(false);
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

  // How the page under a skeleton is to be landed on once it arrives.
  const landing = useRef(null);

  useEffect(() => {
    if (shown.key === live.key) return undefined;

    let cancelled = false;
    let timer = 0;
    const target = live;
    const pop = navType === 'POP';

    // Where the page being left was, for when Back returns to it. Taken now,
    // before anything moves: with scrollRestoration set to manual (main.jsx)
    // the browser does not touch the scroll on a Back, so this is still the
    // old page's position.
    rememberScroll(shown);

    if (target.pathname === shown.pathname) {
      setShown(target);
      land(target, { samePage: true, pop });
      return () => {
        cancelled = true;
      };
    }

    // `skeleton`: the code is not here yet, so show the page's outline now
    // and let the effect below swap the page in when it lands.
    const swap = (skeleton) => {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(timer);
      landing.current = { target, pop };
      dissolve(() => {
        // Synchronous on purpose: the page, its title, the active nav link
        // and the scroll position all change in the same frame, inside the
        // view transition's update, so the "after" snapshot is already right.
        flushSync(() => {
          setShown(target);
          setWaiting(skeleton);
          if (!skeleton) setPending(false);
        });
        land(target, { pop });
      });
    };

    const loading = preloadFor(target.pathname);
    if (!loading) {
      swap(false);
      return undefined;
    }

    setPending(true);
    timer = setTimeout(() => swap(true), SKELETON_AFTER_MS);
    // A failed download still has to leave the old page: the route then
    // renders through lazy(), whose own error reaches the ErrorBoundary.
    loading.then(() => swap(false), () => swap(false));

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [live, shown, navType, preloadFor]);

  // A skeleton is on screen: swap the page in the moment its code lands —
  // after the dissolve that brought the skeleton in has finished, so the two
  // never overlap and the second does not start from a half-faded frame.
  useEffect(() => {
    if (!waiting) return undefined;
    let cancelled = false;
    const loading = preloadFor(shown.pathname) || Promise.resolve();
    const reveal = () =>
      afterDissolve().then(() => {
        if (cancelled) return;
        dissolve(() => {
          flushSync(() => {
            setWaiting(false);
            setPending(false);
          });
          const how = landing.current;
          if (how && how.target.key === shown.key) land(how.target, { pop: how.pop, again: true });
        });
      });
    loading.then(reveal, reveal);
    return () => {
      cancelled = true;
    };
  }, [waiting, shown, preloadFor]);

  return [shown, waiting, pending];
}

/* ---------------- fetching the next page before it is asked for ---------------- */

/**
 * Starts fetching a page's code on the first sign someone is going there:
 * a pointer over a link, a finger on one, or keyboard focus. A hover is
 * typically 100-300ms ahead of the click it becomes, which on most
 * connections is the whole download — so the click finds the code waiting.
 *
 * `idlePaths` — the header's own pages — are fetched once the first page has
 * finished loading and the main thread is idle. Not on a connection that has
 * asked to save data, or one too slow for it to be a kindness.
 */
export function usePrefetch(preloadFor, idlePaths = []) {
  useEffect(() => {
    const tried = new WeakSet();
    const warm = (event) => {
      const link = event.target instanceof window.Element ? event.target.closest('a[href]') : null;
      if (!link || tried.has(link)) return;
      tried.add(link);
      let url;
      try {
        url = new URL(link.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      preloadFor(url.pathname)?.catch(() => {});
    };
    document.addEventListener('pointerover', warm, { passive: true });
    document.addEventListener('touchstart', warm, { passive: true });
    document.addEventListener('focusin', warm);

    const connection = navigator.connection;
    const frugal = Boolean(connection && (connection.saveData || /(^|-)2g$/.test(connection.effectiveType || '')));
    let idle = 0;
    let delay = 0;
    const warmAll = () => idlePaths.forEach((path) => preloadFor(path)?.catch(() => {}));
    const schedule = () => {
      delay = window.setTimeout(() => {
        idle = window.requestIdleCallback
          ? window.requestIdleCallback(warmAll, { timeout: 4000 })
          : window.setTimeout(warmAll, 0);
      }, 1200);
    };
    if (!frugal && idlePaths.length) {
      if (document.readyState === 'complete') schedule();
      else window.addEventListener('load', schedule, { once: true });
    }

    return () => {
      document.removeEventListener('pointerover', warm);
      document.removeEventListener('touchstart', warm);
      document.removeEventListener('focusin', warm);
      window.removeEventListener('load', schedule);
      window.clearTimeout(delay);
      if (idle && window.cancelIdleCallback) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    };
  }, [preloadFor, idlePaths]);
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
