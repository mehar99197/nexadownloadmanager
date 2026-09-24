import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useNavigationType } from 'react-router-dom';

/**
 * Moving between screens.
 *
 * The same approach as the public site's src/navigation.jsx, smaller because
 * every screen here is imported eagerly — there is no code to wait for.
 *
 * Recorded frame by frame before the first version of this: going from a
 * scrolled Users list to Subscriptions, the URL changed, the USERS list jumped
 * from 500px to the top, and about 300ms later Subscriptions appeared. Then
 * the owner's second report: a screen still "appears all at once, with only
 * 'Loading' written on it" — a 160ms dissolve that barely registered, none at
 * all under reduced motion, and screens whose numbers popped in afterwards.
 *
 * Now the screen and the scroll position change in one synchronous commit,
 * inside document.startViewTransition, so the whole window dissolves from one
 * screen to the next while the arriving screen settles a few pixels up into
 * place (index.css); its data then arrives into outlines of itself. A plain
 * root cross-fade on purpose: a NAMED element is animated from its old box to
 * its new one, and resetting the scroll moves that box.
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

/**
 * Run `update` inside a view transition where the browser has one, so the
 * window dissolves from what was there to what is there. `update` must make
 * its change synchronously (flushSync), so the "after" snapshot is the new
 * screen and not the old one.
 *
 * Not skipped for prefers-reduced-motion, which it used to be. What a reader
 * who asks for less motion is spared is movement — no settle, a shorter
 * dissolve (index.css) — not the change of screen being visible as one. A
 * cut is not less motion; it is the jolt with the animation taken away.
 */
export function dissolve(update) {
  if (typeof document.startViewTransition !== 'function') {
    update();
    return;
  }
  const vt = document.startViewTransition(update);
  // Cut short by the next one (two quick clicks): expected, and not an error.
  vt.ready.catch(() => {});
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

    dissolve(() => {
      flushSync(() => setShown(target));
      const top = navType === 'POP' ? (recall(target) ?? 0) : 0;
      window.scrollTo({ top, left: 0, behavior: 'instant' });
      // The panel's <main> is a scroll box too on some layouts; a screen should
      // never open part-way down it.
      const main = document.querySelector('main');
      if (main) main.scrollTop = 0;
    });
  }, [live, shown, navType]);

  return shown;
}
