import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

// Google treats `width` as a MINIMUM (and caps it at 400), so the button has to
// be told the space it actually has or it keeps its full width inside a narrower
// card — on a 320-414px phone the auth card's content box is only 214-308px and
// `.card { overflow: hidden }` clips the pill's rounded ends.
const MAX_WIDTH = 320;

let scriptPromise = null;

function loadScript() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.google?.accounts?.id) return Promise.resolve(window.google);
  scriptPromise ||= new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${SCRIPT_SRC}"]`);
    const script = existing || document.createElement('script');
    if (!existing) {
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    script.addEventListener('load', () => resolve(window.google));
    script.addEventListener('error', () => reject(new Error('Google sign-in failed to load')));
  });
  return scriptPromise;
}

/** True when the site is built with a Google client ID. */
export const googleAuthEnabled = () => Boolean(CLIENT_ID);

/**
 * "Continue with Google" — Google Identity Services button, plus the "or"
 * divider that separates it from the form below.
 *
 * The divider lives here rather than in the page so it appears only when the
 * button actually rendered: when GIS fails to load the card would otherwise
 * read "could not load… — or — [form]", with nothing on the first side.
 *
 * Renders nothing when the site was built without VITE_GOOGLE_CLIENT_ID, so the
 * button and the backend's POST /api/auth/google switch on together (the API
 * answers 503 GOOGLE_AUTH_DISABLED without a client ID of its own).
 *
 * `onCredential(idToken)` receives the ID token, which the caller posts to the
 * backend — nothing is trusted client-side; the token is verified server-side
 * against Google's public keys.
 */
export default function GoogleButton({
  onCredential,
  onError,
  text = 'continue_with',
  disabled = false,
  fallback = 'Google sign-in could not load. Use your email and password below.',
}) {
  const container = useRef(null);
  const onCredentialRef = useRef(onCredential);
  const onErrorRef = useRef(onError);
  onCredentialRef.current = onCredential;
  onErrorRef.current = onError;
  const [failed, setFailed] = useState(false);
  const [boxWidth, setBoxWidth] = useState(0);

  // The site stamps data-theme="light" on <html>; dark is the bare default.
  // Watched rather than read once, so toggling the theme on this page restyles
  // the pill instead of leaving a black button on the white card.
  const [themeAttr, setThemeAttr] = useState(() =>
    (typeof document === 'undefined' ? null : document.documentElement.getAttribute('data-theme')));
  const theme = themeAttr === 'light' ? 'outline' : 'filled_black';

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setThemeAttr(root.getAttribute('data-theme'));
    // useTheme() lives in the Navbar, which sits above this page in the tree, so
    // it stamps data-theme in an effect that has ALREADY run by the time this one
    // does — later than the render that seeded themeAttr. Without this first sync
    // the light theme's very first paint gets the dark pill.
    sync();
    if (typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  // Measure before the render effect runs (and keep measuring across rotation)
  // so renderButton is called once, with the width the card can actually give
  // it. Desktop is always the 320px cap, so only phones ever re-render.
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return undefined;
    const measure = () => setBoxWidth(el.clientWidth || MAX_WIDTH);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!CLIENT_ID || !container.current || !boxWidth) return undefined;
    let cancelled = false;
    loadScript()
      .then((google) => {
        if (cancelled || !container.current) return;
        // A privacy extension can let the script "load" while stubbing the API
        // away. Without this the button silently never appears.
        if (!google?.accounts?.id) throw new Error('Google Identity Services unavailable');
        google.accounts.id.initialize({
          client_id: CLIENT_ID,
          callback: (response) => {
            if (response?.credential) onCredentialRef.current?.(response.credential);
            else onErrorRef.current?.('Google did not return a credential. Please try again.');
          },
        });
        google.accounts.id.renderButton(container.current, {
          type: 'standard',
          theme,
          size: 'large',
          shape: 'pill',
          text,
          logo_alignment: 'center',
          width: Math.min(MAX_WIDTH, boxWidth),
        });
      })
      // Covers a failed script fetch, a stubbed-out API, and anything
      // initialize/renderButton itself throws.
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [theme, text, boxWidth]);

  if (!CLIENT_ID) return null;
  if (failed) {
    // Same reserved height as the button, so the card does not shift when the
    // notice replaces it.
    return (
      <p className="flex min-h-10 items-center justify-center text-center text-xs text-slate-500">
        {fallback}
      </p>
    );
  }

  return (
    <>
      <div
        // GIS renders its own iframe button, which cannot be disabled from the
        // outside. `inert` is what actually stops a second submit: pointer-events
        // alone leaves Google's role="button" reachable by Tab, so Enter could
        // start a second flow mid-request. pointer-events-none stays as a
        // fallback for browsers without inert.
        //
        // scheme-light: the button is a cross-origin iframe whose document uses
        // the light colour scheme. useTheme stamps `color-scheme: dark` on <html>,
        // and browsers paint an opaque canvas (white, here) behind any iframe
        // whose colour scheme differs from the iframe element's — the pill ended
        // up sitting on a white slab. Pinning the wrapper to light matches
        // Google's document, so the iframe stays transparent on the dark card
        // (a no-op on light). CSS Color Adjust 1 §2.4; Chrome 83+, Firefox 102+.
        //
        // min-h-10 reserves the 40px the size:'large' pill will take, so the
        // form below does not jump when the async script lands.
        className={`flex min-h-10 justify-center scheme-light ${disabled ? 'pointer-events-none opacity-60' : ''}`}
        data-testid="google-button"
        inert={disabled ? '' : undefined}
        aria-busy={disabled || undefined}
      >
        <div ref={container} className="w-full max-w-[320px]" />
      </div>
      <div className="mt-6 flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-white/10" />
        <span className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">or</span>
        <span className="h-px flex-1 bg-white/10" />
      </div>
    </>
  );
}
