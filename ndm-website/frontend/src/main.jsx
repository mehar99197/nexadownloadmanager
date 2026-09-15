import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import './index.css';

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

// Tell the first-run boot screen in index.html that the app is up. Two frames,
// not zero: render() only schedules the work, so calling straight after it
// would dismiss the screen while the page behind is still blank — the one
// moment the screen exists to cover. The second frame is the first one after
// React has actually painted.
//
// index.html does not depend on this arriving. It dismisses itself on a timer
// regardless, because a chunk that 404s or a module that throws would otherwise
// leave a reader looking at a spinner for ever.
requestAnimationFrame(() => {
  requestAnimationFrame(() => window.__ndmBootDone?.());
});
