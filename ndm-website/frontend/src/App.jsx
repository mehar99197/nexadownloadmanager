import { Routes, Route, Outlet, useLocation } from 'react-router-dom';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import WarpField from './components/WarpField';
import ProtectedRoute from './components/ProtectedRoute';
import { ToastProvider } from './components/Toast';
import { ConfirmProvider } from './components/ConfirmDialog';

import Home from './pages/Home';
import Download from './pages/Download';
import Pricing from './pages/Pricing';
import Reviews from './pages/Reviews';
import Login from './pages/Login';
import Register from './pages/Register';
import VerifyEmail from './pages/VerifyEmail';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Dashboard from './pages/Dashboard';
import Billing from './pages/Billing';
import Profile from './pages/Profile';
import Activate from './pages/Activate';
import Terms from './pages/Terms';
import Privacy from './pages/Privacy';
import Faq from './pages/Faq';
import About from './pages/About';
import Changelog from './pages/Changelog';
import Contact from './pages/Contact';
import TeamJoin from './pages/TeamJoin';
import Compare from './pages/Compare';
import Benchmarks from './pages/Benchmarks';
import Tutorials from './pages/Tutorials';
import Security from './pages/Security';
import Features from './pages/Features';
import FeatureAcceleration from './pages/features/FeatureAcceleration';
import FeatureVideoGrabber from './pages/features/FeatureVideoGrabber';
import FeatureYoutubeSites from './pages/features/FeatureYoutubeSites';
import FeatureBittorrent from './pages/features/FeatureBittorrent';
import FeatureBrowserExtension from './pages/features/FeatureBrowserExtension';
import FeatureScheduler from './pages/features/FeatureScheduler';
import FeatureRemoteDashboard from './pages/features/FeatureRemoteDashboard';
import Docs from './pages/Docs';
import DocsInstall from './pages/docs/DocsInstall';
import DocsExtension from './pages/docs/DocsExtension';
import DocsYoutube from './pages/docs/DocsYoutube';
import DocsCourses from './pages/docs/DocsCourses';
import DocsTorrents from './pages/docs/DocsTorrents';
import DocsRemote from './pages/docs/DocsRemote';
import DocsLicense from './pages/docs/DocsLicense';
import NotFound from './pages/NotFound';

/** Remounts on every route change so each page plays its drift-in. */
function PageFade({ children }) {
  const location = useLocation();
  return (
    <div key={location.pathname} className="page-enter">
      {children}
    </div>
  );
}

/** The ordinary page shell: navbar, page, footer. */
function Layout() {
  return (
    <>
      <WarpField mode="ambient" />
      <Navbar />
      <main className="flex-1">
        <PageFade>
          <Outlet />
        </PageFade>
      </main>
      <Footer />
    </>
  );
}

/**
 * Sign-in / sign-up shell — the same navbar (logo, nav, theme toggle) but no
 * footer: on a page whose only job is one short form, a full sitemap below it
 * is noise. `auth-main` lets the form section take the height the footer used
 * to occupy, so the card stays optically centred instead of sitting high with
 * dead space under it (see index.css).
 */
function AuthLayout() {
  return (
    <>
      <WarpField mode="ambient" />
      <Navbar />
      <main className="auth-main">
        <PageFade>
          <Outlet />
        </PageFade>
      </main>
    </>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
      <Routes>
        <Route element={<Layout />}>
          {/* Public */}
          <Route path="/" element={<Home />} />
          <Route path="/download" element={<Download />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/reviews" element={<Reviews />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/benchmarks" element={<Benchmarks />} />
          <Route path="/tutorials" element={<Tutorials />} />
          <Route path="/security" element={<Security />} />

          {/* Feature deep-dives: one hub plus a page per feature. */}
          <Route path="/features" element={<Features />} />
          <Route path="/features/acceleration" element={<FeatureAcceleration />} />
          <Route path="/features/video-grabber" element={<FeatureVideoGrabber />} />
          <Route path="/features/youtube-sites" element={<FeatureYoutubeSites />} />
          <Route path="/features/bittorrent" element={<FeatureBittorrent />} />
          <Route path="/features/browser-extension" element={<FeatureBrowserExtension />} />
          <Route path="/features/scheduler" element={<FeatureScheduler />} />
          <Route path="/features/remote-dashboard" element={<FeatureRemoteDashboard />} />
          <Route path="/faq" element={<Faq />} />
          <Route path="/about" element={<About />} />
          <Route path="/changelog" element={<Changelog />} />
          <Route path="/contact" element={<Contact />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/team/join" element={<TeamJoin />} />

          {/* Docs */}
          <Route path="/docs" element={<Docs />} />
          <Route path="/docs/install" element={<DocsInstall />} />
          <Route path="/docs/extension" element={<DocsExtension />} />
          <Route path="/docs/youtube" element={<DocsYoutube />} />
          <Route path="/docs/courses" element={<DocsCourses />} />
          <Route path="/docs/torrents" element={<DocsTorrents />} />
          <Route path="/docs/remote" element={<DocsRemote />} />
          <Route path="/docs/license" element={<DocsLicense />} />

          {/* Protected (user portal) */}
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/billing"
            element={
              <ProtectedRoute>
                <Billing />
              </ProtectedRoute>
            }
          />
          <Route
            path="/profile"
            element={
              <ProtectedRoute>
                <Profile />
              </ProtectedRoute>
            }
          />
          <Route
            path="/activate"
            element={
              <ProtectedRoute>
                <Activate />
              </ProtectedRoute>
            }
          />

          {/* Fallback */}
          <Route path="*" element={<NotFound />} />
        </Route>

        {/* Sign in / sign up — same shell minus the footer. */}
        <Route element={<AuthLayout />}>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
        </Route>
      </Routes>
      </ConfirmProvider>
    </ToastProvider>
  );
}
