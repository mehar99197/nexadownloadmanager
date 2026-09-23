import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useNavigationType } from 'react-router-dom';

/**
 * Moving between screens without the screen moving.
 *
 * The same approach as the public site's src/navigation.jsx, smaller because
 * every screen here is imported eagerly — there is no code to wait for.
 *
 * Recorded frame by frame before this, going from a scrolled Users list to
 * Subscriptions: the URL changed, the USERS list jumped from 500px to the top,
 * and about 300ms later Subscriptions appeared. The old screen visibly leapt
 * before it was replaced, and Back never returned to where the list had been.
 *
 * Now the screen and the scroll position change in one synchronous commit,
 * inside document.startViewTransition where the browser has it, so the whole
 * window dissolves from one screen to the next. The browser's own root
 * cross-fade on purpose: a NAMED element (what React's <ViewTransition> makes)
 * is animated from its old box to its new one, and resetting the scroll moves
 * that box.
 */

const KEY = 'ndm_admin_scroll';
const entryId = (location) => `${location.key}|${location.pathname}`;

function read() {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function remember(location) {
  try {
    const map = read();
    map[entryId(location)] = Math.round(window.scrollY);
    const ids = Object.keys(map);
    if (ids.length > 80) delete map[ids[0]];
    sessionStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* storage blocked: Back lands at the top */
  }
}

function recall(location) {
  const y = read()[entryId(location)];
  return typeof y === 'number' ? y : null;
}

export function useSwappedLocation() {
  const live = useLocation();
  const navType = useNavigationType();
  const [shown, setShown] = useState(live);

  useEffect(() => {
    if (shown.key === live.key) return;
    const target = live;

    // A filter or tab in the query string keeps the reader where they are.
    if (target.pathname === shown.pathname) {
      setShown(target);
      return;
    }

    remember(shown);

    const swap = () => {
      flushSync(() => setShown(target));
      const top = navType === 'POP' ? (recall(target) ?? 0) : 0;
      window.scrollTo({ top, left: 0, behavior: 'instant' });
      // The panel's <main> is a scroll box too on some layouts; a screen should
      // never open part-way down it.
      const main = document.querySelector('main');
      if (main) main.scrollTop = 0;
    };

    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce && typeof document.startViewTransition === 'function') {
      document.startViewTransition(swap);
    } else {
      swap();
    }
  }, [live, shown, navType]);

  return shown;
}
