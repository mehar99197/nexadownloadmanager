import { Navigate, Route, Routes } from 'react-router-dom';
import AdminLayout from './components/AdminLayout.jsx';
import ProtectedAdminRoute from './components/ProtectedAdminRoute.jsx';
import AdminLogin from './pages/AdminLogin.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';
import Users from './pages/Users.jsx';
import Subscriptions from './pages/Subscriptions.jsx';
import Reviews from './pages/Reviews.jsx';
import Releases from './pages/Releases.jsx';
import NotFound from './pages/NotFound.jsx';
import Activity from './pages/Activity.jsx';

/**
 * App routes. BrowserRouter basename is '/admin' (set in main.jsx), so paths
 * here are relative to /admin.
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
        <Route path="/activity" element={<Activity />} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
