import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

export const SITE_NAME = 'Nexa Download Manager';
export const SITE_URL = (import.meta.env.VITE_SITE_URL || 'https://nexadownloadmanager.com').replace(/\/$/, '');

const DEFAULT_DESCRIPTION =
  'Nexa Download Manager — a free, open desktop download manager for Windows and Linux. Multi-connection HTTP, HLS/DASH streams, YouTube via yt-dlp, BitTorrent and cloud links in one queue.';

function setMeta(selector, attr, value) {
  const el = document.head.querySelector(selector);
  if (el) el.setAttribute(attr, value);
}

/**
 * Keep a page out of search results for as long as it is mounted. The
 * prerendered shell carries the same tag for a crawler that does not run JS
 * (scripts/prerender.mjs); this covers arriving by client-side navigation.
 */
function useNoindex(noindex) {
  useEffect(() => {
    if (!noindex) return undefined;
    let tag = document.head.querySelector('meta[name="robots"]');
    const added = !tag;
    if (added) {
      tag = document.createElement('meta');
      tag.setAttribute('name', 'robots');
      document.head.appendChild(tag);
    }
    const previous = tag.getAttribute('content');
    tag.setAttribute('content', 'noindex, follow');
    return () => {
      if (added) tag.remove();
      else if (previous === null) tag.removeAttribute('content');
      else tag.setAttribute('content', previous);
    };
  }, [noindex]);
}

/**
 * usePageMeta — sets document.title ("<Page> · Nexa Download Manager"), the
 * meta description, Open Graph / Twitter title + description, and the
 * canonical link for the current route. Call it once at the top of every page.
 * `noindex` keeps an unfinished page out of search results.
 */
export default function usePageMeta({ title, description, noindex = false } = {}) {
  const { pathname } = useLocation();
  useNoindex(noindex);

  useEffect(() => {
    const fullTitle = title ? `${title} · ${SITE_NAME}` : SITE_NAME;
    const desc = description || DEFAULT_DESCRIPTION;
    const canonical = `${SITE_URL}${pathname === '/' ? '/' : pathname.replace(/\/$/, '')}`;

    document.title = fullTitle;
    setMeta('meta[name="description"]', 'content', desc);
    setMeta('meta[property="og:title"]', 'content', fullTitle);
    setMeta('meta[property="og:description"]', 'content', desc);
    setMeta('meta[property="og:url"]', 'content', canonical);
    setMeta('meta[name="twitter:title"]', 'content', fullTitle);
    setMeta('meta[name="twitter:description"]', 'content', desc);
    setMeta('link[rel="canonical"]', 'href', canonical);
  }, [title, description, pathname]);
}
