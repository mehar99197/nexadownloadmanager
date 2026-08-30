import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { AdminAuthProvider } from './context/AdminAuthContext.jsx';
import { ConfirmProvider } from './components/ConfirmDialog.jsx';
import { BASENAME } from './realm.js';
import './index.css';

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
