import { useEffect, useRef, useState } from 'react';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

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
 * "Continue with Google" — Google Identity Services button.
 *
 * Renders nothing when the site was built without VITE_GOOGLE_CLIENT_ID, so the
 * button and the backend's POST /api/auth/google switch on together (the API
 * answers 503 GOOGLE_AUTH_DISABLED without a client ID of its own).
 *
 * `onCredential(idToken)` receives the ID token, which the caller posts to the
 * backend — nothing is trusted client-side; the token is verified server-side
 * against Google's public keys.
 */
export default function GoogleButton({ onCredential, onError, text = 'continue_with', disabled = false }) {
  const container = useRef(null);
  const onCredentialRef = useRef(onCredential);
  const onErrorRef = useRef(onError);
  onCredentialRef.current = onCredential;
  onErrorRef.current = onError;
  const [failed, setFailed] = useState(false);
  // The site stamps data-theme="light" on <html>; dark is the bare default.
  const theme = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light'
    ? 'outline' : 'filled_black';

  useEffect(() => {
    if (!CLIENT_ID || !container.current) return undefined;
    let cancelled = false;
    loadScript()
      .then((google) => {
        if (cancelled || !container.current || !google?.accounts?.id) return;
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
          width: 320,
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [theme, text]);

  if (!CLIENT_ID) return null;
  if (failed) {
    return (
      <p className="text-center text-xs text-slate-500">
        Google sign-in could not load. Use your email and password below.
      </p>
    );
  }

  return (
    <div
      // GIS renders its own iframe button, which cannot be disabled from the
      // outside; blocking pointer events while a request is in flight is what
      // stops a second submit.
      className={`flex justify-center ${disabled ? 'pointer-events-none opacity-60' : ''}`}
      data-testid="google-button"
    >
      <div ref={container} />
    </div>
  );
}
