import { useCallback, useEffect, useState } from 'react';

const KEY = 'ndm_theme';           // 'light' | 'dark' | 'system'
const MEDIA = '(prefers-color-scheme: light)';

function read() {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';               // storage blocked (private mode, embedded)
  }
}

function resolve(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  return window.matchMedia?.(MEDIA)?.matches ? 'light' : 'dark';
}

/** Stamp the resolved theme on <html> so the CSS variables in index.css apply. */
function paint(mode) {
  const resolved = resolve(mode);
  const root = document.documentElement;
  // The dark palette is the default (bare :root), so it needs no attribute.
  if (resolved === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
  root.style.colorScheme = resolved;
}

/**
 * Site theme: dark by default, light on request, or following the OS.
 * Returns { mode, resolved, setMode, toggle }.
 */
export default function useTheme() {
  const [mode, setMode] = useState(read);

  useEffect(() => {
    paint(mode);
    try { localStorage.setItem(KEY, mode); } catch { /* nothing to persist to */ }
  }, [mode]);

  // While following the OS, react to it changing under us.
  useEffect(() => {
    if (mode !== 'system' || !window.matchMedia) return undefined;
    const mq = window.matchMedia(MEDIA);
    const onChange = () => paint('system');
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [mode]);

  const toggle = useCallback(() => {
    setMode((current) => (resolve(current) === 'light' ? 'dark' : 'light'));
  }, []);

  return { mode, resolved: resolve(mode), setMode, toggle };
}
