import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import RouteSkeleton from './PageSkeleton';

/**
 * ProtectedRoute — gate for authenticated pages.
 * Shows the account page's outline while the session is loading, then either
 * renders the children or redirects to /login?next=<current path>.
 */
export default function ProtectedRoute({ children }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <RouteSkeleton />;
  }

  if (!isAuthenticated) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  return children;
}
