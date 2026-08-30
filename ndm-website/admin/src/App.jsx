import { Navigate, Route, Routes } from 'react-router-dom';
import AdminLayout from './components/AdminLayout.jsx';
import ProtectedAdminRoute from './components/ProtectedAdminRoute.jsx';
import AdminLogin from './pages/AdminLogin.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';
import Users from './pages/Users.jsx';
import Subscriptions from './pages/Subscriptions.jsx';
import Reviews from './pages/Reviews.jsx';
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
export default function App() {
  return (
    <Routes>
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
