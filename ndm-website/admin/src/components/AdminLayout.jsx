import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAdminAuth } from '../context/AdminAuthContext.jsx';
import Button from './Button.jsx';
import { useRailTip } from './RailTip.jsx';
import { IS_ROOT, PANEL_LABEL, PANEL_SUBTITLE, PANEL_HEADING } from '../realm.js';
import { keepRail, readRail } from '../sidebarPreference.js';

const STAFF_NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: '▣' },
  { to: '/users', label: 'Users', icon: '◍' },
  { to: '/subscriptions', label: 'Subscriptions', icon: '◆' },
  { to: '/reviews', label: 'Reviews', icon: '★' },
  { to: '/contact', label: 'Contact inbox', icon: '✉' },
  { to: '/releases', label: 'Releases', icon: '⤓' },
  { to: '/ads', label: 'Ads', icon: '◈' },
  { to: '/activity', label: 'Activity log', icon: '◷' },
  { to: '/security', label: 'Security', icon: '⛨' },
];

// Creator-only screens. They are appended, not substituted: the owner keeps
// every staff screen and gains account management, the full audit trail and
// the irreversible actions.
const ROOT_NAV = [
  { to: '/admins', label: 'Admins', icon: '⚿' },
  { to: '/audit', label: 'Audit trail', icon: '❧' },
  { to: '/danger', label: 'Danger zone', icon: '⚠' },
];

const NAV_ITEMS = IS_ROOT ? [...STAFF_NAV, ...ROOT_NAV] : STAFF_NAV;
const LOGO = `${import.meta.env.BASE_URL}nexa-logo-final.svg`;

/**
 * AdminLayout — sidebar (nav + logout) + topbar + routed content via <Outlet/>.
 * Used as the element wrapping all protected routes.
 */
export default function AdminLayout() {
  const { logout, admin } = useAdminAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  // Folded to a rail of icons — on a desktop only; the phone drawer always
  // has its labels. Remembered, so the panel opens the way it was left.
  const [rail, setRail] = useState(readRail);
  const { tipFor, tip, hideTip } = useRailTip(rail);
  // Folded, a label is still its link's name, just not drawn.
  const label = rail ? 'md:sr-only' : undefined;

  function toggleRail() {
    const next = !rail;
    hideTip();
    setRail(next);
    keepRail(next);
  }

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="flex min-h-screen bg-admin-bg text-admin-text">
      {mobileOpen && <button type="button" aria-label="Close navigation" className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden" onClick={() => setMobileOpen(false)} />}
      {/* Sidebar */}
      {/* Sticky on a desktop: moving between screens should never start with
          scrolling back up a long list to find the navigation. It folds to a
          rail of icons from the topbar, and the icons hold still while it
          does: the logo, the icons and the logout mark all sit 32px from the
          edge, and the rail is 64px, so only the width and the labels
          change. */}
      <aside
        id="admin-sidebar"
        className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-admin-border bg-admin-sidebar transition-transform md:sticky md:top-0 md:bottom-auto md:z-auto md:h-screen ${rail ? 'md:w-16' : 'md:w-60'} md:shrink-0 md:self-start md:overflow-x-hidden md:overflow-y-auto md:whitespace-nowrap md:translate-x-0 md:transition-[width] md:duration-200 md:motion-reduce:transition-none ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="flex h-16 items-center gap-2 border-b border-admin-border px-3.5">
          <img src={LOGO} alt="" className="admin-brand-logo h-9 w-9 shrink-0 rounded-xl" aria-hidden="true" />
          <div className={`leading-tight ${rail ? 'md:hidden' : ''}`}>
            <p className="text-sm font-bold tracking-tight">Nexa<span className={`bg-clip-text text-transparent ${IS_ROOT ? 'bg-gradient-to-r from-admin-warning to-admin-danger' : 'bg-gradient-to-r from-accent-400 to-admin-cyan'}`}> {PANEL_LABEL}</span></p>
            <p className="text-xs text-admin-faint">{PANEL_SUBTITLE}</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => {
                setMobileOpen(false);
                hideTip();
              }}
              className={({ isActive }) =>
                `nav-link ${isActive ? 'nav-link-active' : ''}`
              }
              {...tipFor(item.label)}
            >
              <span aria-hidden="true" className="w-4 shrink-0 text-center text-admin-muted">
                {item.icon}
              </span>
              <span className={label}>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-admin-border p-3">
          {/* Spaced like a nav link, so its mark sits in the same column. */}
          <Button
            variant="ghost"
            className="w-full justify-start !gap-3 !px-3"
            onClick={handleLogout}
            {...tipFor('Logout')}
          >
            <span aria-hidden="true" className="w-4 shrink-0 text-center">⎋</span>
            <span className={label}>Logout</span>
          </Button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-admin-border bg-admin-surface/80 px-6 backdrop-blur-xl">
          <div className="flex items-center gap-3">
            {/* 44x44. At 36x42 this was the smallest control in the panel and
                the only way to reach navigation on a phone. */}
            <button type="button" aria-label="Open navigation" className="flex h-11 w-11 items-center justify-center rounded-lg border border-admin-border bg-admin-surface-2 text-admin-muted md:hidden" onClick={() => setMobileOpen(true)}>☰</button>
            {/* The same place on a desktop folds the sidebar to its rail and
                back. A toggle rather than a disclosure: folded, every link is
                still there and still named, so aria-pressed, not
                aria-expanded. */}
            <button
              type="button"
              aria-label="Collapse sidebar"
              aria-pressed={rail}
              aria-controls="admin-sidebar"
              className="hidden h-11 w-11 items-center justify-center rounded-lg border border-admin-border bg-admin-surface-2 text-admin-muted transition-colors hover:text-admin-text md:flex"
              onClick={toggleRail}
            >
              ☰
            </button>
            <div>
            <p className="text-xs font-semibold tracking-wide text-admin-faint">NexaDownloadManager</p>
            <h1 className="mt-0.5 text-sm font-semibold text-admin-text">{PANEL_HEADING}</h1>
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs text-admin-faint">{IS_ROOT && <span className="rounded-full border border-admin-warning/40 bg-admin-warning/10 px-2.5 py-1 font-bold uppercase tracking-wider text-admin-warning">Creator</span>}<span className="hidden text-admin-muted sm:inline">{admin?.name || 'Administrator'}</span><span className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-admin-success shadow-[0_0_10px_rgba(69,223,193,0.9)]" />Live system</span></div>
        </header>

        {/* Keyed, so each screen starts from a fresh tree rather than reusing
            the last one's state — and settles into place as it arrives. The
            transition between screens is the browser's root cross-fade,
            started in navigation.js; nothing in here is named, because a
            named element slides when the scroll position changes under it. */}
        <main className="flex-1 overflow-y-auto p-6">
          <div key={location.pathname} className="screen-enter">
            <Outlet />
          </div>
        </main>
      </div>
      {tip}
    </div>
  );
}
