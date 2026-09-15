import { Navigate, useLocation } from 'react-router-dom';
import { useAdminAuth } from '../context/AdminAuthContext.jsx';

/**
 * Guards admin routes. If there is no token, redirect to /login (within the
 * /admin basename). Children render only when authenticated.
 */
export default function ProtectedAdminRoute({ children }) {
  const { isAuthenticated, loading, mustEnrol } = useAdminAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-admin-muted">
        Loading…
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  // ADMIN_2FA_REQUIRED and this account has no second factor yet: the API
  // answers 403 to every screen but the setup one, so go straight there.
  if (mustEnrol && location.pathname !== '/security') {
    return <Navigate to="/security" replace state={{ from: location }} />;
  }

  return children;
}
