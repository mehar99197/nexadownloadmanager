import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * WP-18 — consent for non-essential third-party embeds.
 *
 * Google Identity Services drops a `g_state` cookie the moment its script
 * runs, and /login and /register loaded that script on mount. That is a
 * non-essential cookie set before the visitor has agreed to anything, which
 * ePrivacy does not allow.
 *
 * The gate is global rather than EU-only on purpose: one code path to reason
 * about, no dependency on a country header being present and correct at the
 * CDN, and nothing that misfires for someone on a VPN. The cost is that
 * everyone sees the banner once.
 *
 * `null` means undecided, and undecided behaves exactly like denied — silence
 * is not consent.
 */

const STORAGE_KEY = 'ndm-consent-v1';
const GRANTED = 'granted';
const DENIED = 'denied';

const ConsentContext = createContext(null);

function readStored() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === GRANTED || value === DENIED ? value : null;
  } catch {
    // Private mode, blocked storage, no origin. Undecided is the safe answer.
    return null;
  }
}

function writeStored(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // The choice still applies to this page view; it just will not persist.
  }
}

/**
 * `initial` seeds the decision explicitly. Tests use it so they do not depend
 * on localStorage surviving a teardown that clears it; the app never passes it
 * and reads the stored value instead.
 */
export function ConsentProvider({ children, initial }) {
  // Read lazily rather than in an effect: an effect would render one frame of
  // "undecided", and a returning visitor would see the banner flash on every
  // page load.
  const [consent, setConsent] = useState(() => {
    if (initial === GRANTED || initial === DENIED) return initial;
    return typeof window === 'undefined' ? null : readStored();
  });

  const grant = useCallback(() => { setConsent(GRANTED); writeStored(GRANTED); }, []);
  const deny = useCallback(() => { setConsent(DENIED); writeStored(DENIED); }, []);
  const reset = useCallback(() => {
    setConsent(null);
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* nothing to clear */ }
  }, []);

  // Another tab deciding should not leave this one showing the banner.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === STORAGE_KEY) setConsent(readStored());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value = useMemo(() => ({
    consent,
    decided: consent !== null,
    // The only question callers should ask before loading anything.
    thirdPartyAllowed: consent === GRANTED,
    grant,
    deny,
    reset,
  }), [consent, grant, deny, reset]);

  return <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>;
}

export function useConsent() {
  const ctx = useContext(ConsentContext);
  if (!ctx) {
    // A component rendered outside the provider must fail closed, never open.
    return { consent: null, decided: false, thirdPartyAllowed: false, grant: () => {}, deny: () => {}, reset: () => {} };
  }
  return ctx;
}

export { STORAGE_KEY, GRANTED, DENIED };
