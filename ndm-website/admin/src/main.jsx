import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { AdminAuthProvider } from './context/AdminAuthContext.jsx';
import { ConfirmProvider } from './components/ConfirmDialog.jsx';
import { BASENAME } from './realm.js';
import './index.css';

// navigation.js sets the scroll on every screen change. Left on "auto", the
// browser restores a Back's position the instant the URL changes — onto the
// screen being LEFT, a frame before the one being returned to is swapped in.
if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      {/* One bundle, two mounts: /admin for staff, /root for the creator. */}
      <BrowserRouter basename={BASENAME}>
        <AdminAuthProvider>
          <ConfirmProvider>
            <App />
          </ConfirmProvider>
        </AdminAuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
