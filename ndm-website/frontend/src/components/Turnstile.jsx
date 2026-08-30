import { useEffect, useRef } from 'react';

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let scriptPromise = null;

function loadScript() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ||= new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${SCRIPT_SRC}"]`);
    const script = existing || document.createElement('script');
    if (!existing) {
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    script.addEventListener('load', () => resolve(window.turnstile));
    script.addEventListener('error', () => reject(new Error('Turnstile failed to load')));
  });
  return scriptPromise;
}

/** True when the site is built with a Turnstile site key. */
export const turnstileEnabled = () => Boolean(SITE_KEY);

/**
 * Cloudflare Turnstile widget.
 *
 * Renders nothing — and reports no token — when the site was built without
 * VITE_TURNSTILE_SITE_KEY, so local builds and the backend's gate switch on
 * together. `onToken(token|null)` fires when a challenge passes, expires, or
 * errors; the form sends the token as `turnstileToken`. Bump `resetKey` after
 * a submit to get a fresh token (each one is single-use).
 */
export default function Turnstile({ onToken, resetKey = 0, className = '' }) {
  const container = useRef(null);
  const widgetId = useRef(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  // The site stamps data-theme="light" on <html>; dark is the bare default.
  const theme = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

  useEffect(() => {
    if (!SITE_KEY || !container.current) return undefined;
    let cancelled = false;
    loadScript().then((turnstile) => {
      if (cancelled || !container.current || !turnstile) return;
      widgetId.current = turnstile.render(container.current, {
        sitekey: SITE_KEY,
        theme,
        callback: (token) => onTokenRef.current?.(token),
        'expired-callback': () => onTokenRef.current?.(null),
        'error-callback': () => onTokenRef.current?.(null),
      });
    }).catch(() => onTokenRef.current?.(null));
    return () => {
      cancelled = true;
      try { if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current); }
      catch { /* widget already gone */ }
      widgetId.current = null;
    };
  }, [theme]);

  // A submitted token cannot be reused; the form bumps resetKey after sending.
  useEffect(() => {
    if (!resetKey || !widgetId.current || !window.turnstile) return;
    try { window.turnstile.reset(widgetId.current); } catch { /* ignore */ }
  }, [resetKey]);

  if (!SITE_KEY) return null;
  return <div ref={container} className={className} data-testid="turnstile" />;
}
