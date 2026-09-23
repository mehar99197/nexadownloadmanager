import { useEffect, useState, useTransition } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import AdminLayout from './components/AdminLayout.jsx';
import ProtectedAdminRoute from './components/ProtectedAdminRoute.jsx';
import AdminLogin from './pages/AdminLogin.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';
import Users from './pages/Users.jsx';
import Subscriptions from './pages/Subscriptions.jsx';
import Reviews from './pages/Reviews.jsx';
import Contact from './pages/Contact.jsx';
import Releases from './pages/Releases.jsx';
import Ads from './pages/Ads.jsx';
import NotFound from './pages/NotFound.jsx';
import Activity from './pages/Activity.jsx';
import Security from './pages/Security.jsx';
import Admins from './pages/root/Admins.jsx';
import RootAudit from './pages/root/RootAudit.jsx';
import DangerZone from './pages/root/DangerZone.jsx';
import { IS_ROOT } from './realm.js';

/**
 * App routes for the mounted realm.
 *
 * BrowserRouter's basename is /admin or /root (see main.jsx), so paths here are
 * relative to whichever panel is being served. The creator panel is a superset:
 * every staff screen plus the account/audit/danger screens. Those extra routes
 * simply do not exist in the staff bundle's route table, and their APIs reject
 * a staff token regardless — this is convenience, not the security boundary.
 */
/**
 * The routed screen, held one React transition behind the URL.
 *
 * Every screen here is imported eagerly, so this is not about waiting for a
 * chunk — it is the signal <ViewTransition> (AdminLayout) needs in order to
 * run the swap inside document.startViewTransition. Without a transition
 * React commits the change synchronously and the browser has nothing to
 * animate between.
 *
 * Everything inside <Routes location={shown}> is handed the deferred location
 * by React Router's own context, so the highlighted nav link and the screen
 * change together.
 */
function useDeferredRoute() {
  const live = useLocation();
  const [shown, setShown] = useState(live);
  const [, startRouteTransition] = useTransition();

  useEffect(() => {
    if (shown.key === live.key) return;
    startRouteTransition(() => setShown(live));
  }, [live, shown]);

  return shown;
}

export default function App() {
  const shown = useDeferredRoute();

  return (
    <Routes location={shown}>
      <Route path="/login" element={<AdminLogin />} />

      {/* Protected area — wrapped in the sidebar layout. */}
      <Route
        element={
          <ProtectedAdminRoute>
            <AdminLayout />
          </ProtectedAdminRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<AdminDashboard />} />
        <Route path="/users" element={<Users />} />
        <Route path="/subscriptions" element={<Subscriptions />} />
        <Route path="/reviews" element={<Reviews />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/releases" element={<Releases />} />
        <Route path="/ads" element={<Ads />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/security" element={<Security />} />

        {IS_ROOT && [
          <Route key="admins" path="/admins" element={<Admins />} />,
          <Route key="audit" path="/audit" element={<RootAudit />} />,
          <Route key="danger" path="/danger" element={<DangerZone />} />,
        ]}
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
