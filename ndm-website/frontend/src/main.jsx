import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import './index.css';

// The app sets the scroll itself on every page change (navigation.jsx). Left
// on "auto", the browser restores a Back's scroll position the instant the
// URL changes — onto the page being LEFT, a frame before the page being
// returned to is swapped in — and the reader watches the wrong page jump.
if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';

// Optional, privacy-friendly analytics. Nothing is loaded unless the site
// operator sets VITE_PLAUSIBLE_DOMAIN at build time (see .env.example).
const plausibleDomain = import.meta.env.VITE_PLAUSIBLE_DOMAIN;
if (plausibleDomain && !document.querySelector('script[data-domain]')) {
  const s = document.createElement('script');
  s.defer = true;
  s.dataset.domain = plausibleDomain;
  s.src = import.meta.env.VITE_PLAUSIBLE_SRC || 'https://plausible.io/js/script.js';
  document.head.appendChild(s);
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);

// The boot screen in index.html is lifted by <BootDone> (navigation.jsx), not
// from here. This used to call it two frames after render() — which is when
// the SHELL has painted, not the page: on every route that loads on demand the
// page arrives a network round trip later, so the screen lifted onto a navbar
// and a spinner and the page then popped in underneath the reader. BootDone
// sits inside the Suspense boundary next to the page and cannot mount before
// it has.
//
// index.html still does not depend on that arriving. It dismisses itself on a
// timer regardless, and ErrorBoundary lifts it too, because a chunk that 404s
// or a module that throws would otherwise leave a reader looking at a spinner.
