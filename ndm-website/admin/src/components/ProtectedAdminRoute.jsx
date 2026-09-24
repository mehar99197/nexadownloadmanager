import { Navigate, useLocation } from 'react-router-dom';
import { useAdminAuth } from '../context/AdminAuthContext.jsx';
import PanelSkeleton from './PanelSkeleton.jsx';

/**
 * Guards admin routes. If there is no token, redirect to /login (within the
 * /admin basename). Children render only when authenticated.
 */
export default function ProtectedAdminRoute({ children }) {
  const { isAuthenticated, loading, mustEnrol } = useAdminAuth();
  const location = useLocation();

  // The panel in outline while the session is checked — it used to be the
  // single word "Loading…", and then the whole panel at once.
  if (loading) {
    return <PanelSkeleton />;
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
