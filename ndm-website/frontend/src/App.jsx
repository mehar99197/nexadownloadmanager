import { lazy, Suspense } from 'react';
import { Routes, Route, Outlet, useLocation } from 'react-router-dom';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import WarpField from './components/WarpField';
import ProtectedRoute from './components/ProtectedRoute';
import Spinner from './components/Spinner';
import { ToastProvider } from './components/Toast';
import { ConfirmProvider } from './components/ConfirmDialog';

import Home from './pages/Home';
import NotFound from './pages/NotFound';

/**
 * Every page except the two above is loaded on demand.
 *
 * All 43 of them used to be imported eagerly, so a visitor landing on the
 * homepage downloaded the changelog, the seven feature deep-dives, the billing
 * portal and the QR-code library for two-factor setup before anything rendered
 * — one 728 kB chunk, of which the entry page needs a small fraction.
 *
 * Home stays eager because it is the most common entry and a round trip before
 * the first paint is exactly what this is meant to remove. NotFound stays
 * eager because it is tiny and it is the one route that renders when something
 * has already gone wrong.
 *
 * Safe for the prerendered shells: scripts/prerender.mjs writes per-route HTML
 * by string substitution and never imports the app, so the meta tags are
 * unaffected by how the JS is chunked.
 */
const Download = lazy(() => import('./pages/Download'));
const Pricing = lazy(() => import('./pages/Pricing'));
const Reviews = lazy(() => import('./pages/Reviews'));
const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
const VerifyEmail = lazy(() => import('./pages/VerifyEmail'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Billing = lazy(() => import('./pages/Billing'));
const Profile = lazy(() => import('./pages/Profile'));
const Activate = lazy(() => import('./pages/Activate'));
const Terms = lazy(() => import('./pages/Terms'));
const Privacy = lazy(() => import('./pages/Privacy'));
const Faq = lazy(() => import('./pages/Faq'));
const About = lazy(() => import('./pages/About'));
const Changelog = lazy(() => import('./pages/Changelog'));
const Contact = lazy(() => import('./pages/Contact'));
const TeamJoin = lazy(() => import('./pages/TeamJoin'));
const Compare = lazy(() => import('./pages/Compare'));
const Benchmarks = lazy(() => import('./pages/Benchmarks'));
const Tutorials = lazy(() => import('./pages/Tutorials'));
const Security = lazy(() => import('./pages/Security'));
const Features = lazy(() => import('./pages/Features'));
const FeatureAcceleration = lazy(() => import('./pages/features/FeatureAcceleration'));
const FeatureVideoGrabber = lazy(() => import('./pages/features/FeatureVideoGrabber'));
const FeatureYoutubeSites = lazy(() => import('./pages/features/FeatureYoutubeSites'));
const FeatureBittorrent = lazy(() => import('./pages/features/FeatureBittorrent'));
const FeatureBrowserExtension = lazy(() => import('./pages/features/FeatureBrowserExtension'));
const FeatureScheduler = lazy(() => import('./pages/features/FeatureScheduler'));
const FeatureRemoteDashboard = lazy(() => import('./pages/features/FeatureRemoteDashboard'));
const Docs = lazy(() => import('./pages/Docs'));
const DocsInstall = lazy(() => import('./pages/docs/DocsInstall'));
const DocsExtension = lazy(() => import('./pages/docs/DocsExtension'));
const DocsYoutube = lazy(() => import('./pages/docs/DocsYoutube'));
const DocsCourses = lazy(() => import('./pages/docs/DocsCourses'));
const DocsTorrents = lazy(() => import('./pages/docs/DocsTorrents'));
const DocsRemote = lazy(() => import('./pages/docs/DocsRemote'));
const DocsLicense = lazy(() => import('./pages/docs/DocsLicense'));

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
          {/* Inside the shell, not around the whole router: the navbar and
              footer must stay on screen while a route's chunk arrives, or every
              navigation would blank the page. */}
          <Suspense fallback={<Spinner center />}>
            <Outlet />
          </Suspense>
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
          {/* Inside the shell, not around the whole router: the navbar and
              footer must stay on screen while a route's chunk arrives, or every
              navigation would blank the page. */}
          <Suspense fallback={<Spinner center />}>
            <Outlet />
          </Suspense>
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
