import { Suspense } from 'react';
import {
  Routes,
  Route,
  Outlet,
  useLocation,
  matchRoutes,
  createRoutesFromElements,
} from 'react-router-dom';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import WarpField from './components/WarpField';
import ProtectedRoute from './components/ProtectedRoute';
import Spinner from './components/Spinner';
import { ToastProvider } from './components/Toast';
import { ConfirmProvider } from './components/ConfirmDialog';
import { lazyPage, useSwappedLocation, BootDone } from './navigation';

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
 *
 * lazyPage rather than lazy: the same on-demand loading, plus a preload() that
 * navigation uses to fetch a page's code BEFORE swapping to it — see
 * navigation.jsx for why a plain lazy() cannot be warmed up.
 */
const Download = lazyPage(() => import('./pages/Download'));
const Pricing = lazyPage(() => import('./pages/Pricing'));
const Reviews = lazyPage(() => import('./pages/Reviews'));
const Login = lazyPage(() => import('./pages/Login'));
const Register = lazyPage(() => import('./pages/Register'));
const VerifyEmail = lazyPage(() => import('./pages/VerifyEmail'));
const ForgotPassword = lazyPage(() => import('./pages/ForgotPassword'));
const ResetPassword = lazyPage(() => import('./pages/ResetPassword'));
const Dashboard = lazyPage(() => import('./pages/Dashboard'));
const Billing = lazyPage(() => import('./pages/Billing'));
const Profile = lazyPage(() => import('./pages/Profile'));
const Activate = lazyPage(() => import('./pages/Activate'));
const Terms = lazyPage(() => import('./pages/Terms'));
const Privacy = lazyPage(() => import('./pages/Privacy'));
const Faq = lazyPage(() => import('./pages/Faq'));
const About = lazyPage(() => import('./pages/About'));
const Changelog = lazyPage(() => import('./pages/Changelog'));
const Contact = lazyPage(() => import('./pages/Contact'));
const TeamJoin = lazyPage(() => import('./pages/TeamJoin'));
const Compare = lazyPage(() => import('./pages/Compare'));
const Benchmarks = lazyPage(() => import('./pages/Benchmarks'));
const Tutorials = lazyPage(() => import('./pages/Tutorials'));
const Security = lazyPage(() => import('./pages/Security'));
const Features = lazyPage(() => import('./pages/Features'));
const FeatureAcceleration = lazyPage(() => import('./pages/features/FeatureAcceleration'));
const FeatureVideoGrabber = lazyPage(() => import('./pages/features/FeatureVideoGrabber'));
const FeatureYoutubeSites = lazyPage(() => import('./pages/features/FeatureYoutubeSites'));
const FeatureBittorrent = lazyPage(() => import('./pages/features/FeatureBittorrent'));
const FeatureBrowserExtension = lazyPage(() => import('./pages/features/FeatureBrowserExtension'));
const FeatureScheduler = lazyPage(() => import('./pages/features/FeatureScheduler'));
const FeatureRemoteDashboard = lazyPage(() => import('./pages/features/FeatureRemoteDashboard'));
const Docs = lazyPage(() => import('./pages/Docs'));
const DocsInstall = lazyPage(() => import('./pages/docs/DocsInstall'));
const DocsExtension = lazyPage(() => import('./pages/docs/DocsExtension'));
const DocsYoutube = lazyPage(() => import('./pages/docs/DocsYoutube'));
const DocsCourses = lazyPage(() => import('./pages/docs/DocsCourses'));
const DocsTorrents = lazyPage(() => import('./pages/docs/DocsTorrents'));
const DocsRemote = lazyPage(() => import('./pages/docs/DocsRemote'));
const DocsLicense = lazyPage(() => import('./pages/docs/DocsLicense'));

/**
 * The routed page.
 *
 * The key is INSIDE the Suspense boundary, and that placement is the fix.
 * Keyed outside it, every navigation mounted a brand-new boundary — and a new
 * boundary always shows its fallback — so the old page was torn down for a
 * spinner on every first visit to a route, the scroll clamped to the top of a
 * suddenly short page, and the scrollbar vanished and came back. Keyed in
 * here, the boundary persists; the key still remounts the page itself, so
 * each one starts from fresh state and the .page-enter keyframes replay on a
 * browser without view transitions.
 */
function RoutedPage() {
  const location = useLocation();
  return (
    <div key={location.pathname} className="page-enter">
      <Outlet />
      <BootDone />
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
        {/* Inside the shell, not around the whole router: the navbar and
            footer stay on screen whatever the page is doing. The fallback is
            only ever seen on the first page of a visit, under the boot
            screen — every later page is fetched before it is swapped in. */}
        <Suspense fallback={<Spinner center />}>
          <RoutedPage />
        </Suspense>
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
        <Suspense fallback={<Spinner center />}>
          <RoutedPage />
        </Suspense>
      </main>
    </>
  );
}

/**
 * The route table, as a value rather than inline in <Routes>, so the same
 * definition can be both rendered and looked up: preloadFor() below matches a
 * pathname against it to find the page whose code has to arrive first.
 * Declaring the routes twice would let the two lists drift.
 */
const ROUTES = (
  <>
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
  </>
);

const ROUTE_OBJECTS = createRoutesFromElements(ROUTES);

/**
 * The code a pathname needs before it can be shown, or null if it is already
 * here. Looks through wrappers such as <ProtectedRoute> to the page inside.
 * Module-level, so it is one stable function for useSwappedLocation's effect.
 */
function preloadFor(pathname) {
  const pending = [];
  for (const match of matchRoutes(ROUTE_OBJECTS, pathname) || []) {
    let el = match.route.element;
    while (el && el.type && !el.type.preload && el.props && el.props.children && !Array.isArray(el.props.children)) {
      el = el.props.children;
    }
    const Page = el && el.type;
    if (Page && Page.preload && !Page.isLoaded()) pending.push(Page.preload());
  }
  return pending.length ? Promise.all(pending) : null;
}

export default function App() {
  const [shown, routePending] = useSwappedLocation(preloadFor);

  return (
    <ToastProvider>
      <ConfirmProvider>
        {/* While the next page's code downloads, the page being left stays
            exactly where it is — correct, and otherwise completely silent. A
            hairline at the top of the window is the acknowledgement; it is
            decoration over a state the content already conveys, so it stays
            out of the accessibility tree. */}
        {routePending && <div className="route-progress" aria-hidden="true" />}
        <Routes location={shown}>{ROUTES}</Routes>
      </ConfirmProvider>
    </ToastProvider>
  );
}
