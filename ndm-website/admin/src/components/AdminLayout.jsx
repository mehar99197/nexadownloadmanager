import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAdminAuth } from '../context/AdminAuthContext.jsx';
import Button from './Button.jsx';
import { useRailTip } from './RailTip.jsx';
import { IS_ROOT, PANEL_LABEL, PANEL_SUBTITLE, PANEL_HEADING } from '../realm.js';
import { keepRail, readRail } from '../sidebarPreference.js';
import {
  ActivityIcon, AdminsIcon, AdsIcon, AuditIcon, DangerIcon, DashboardIcon, InboxIcon,
  LogoutIcon, ReleasesIcon, ReviewsIcon, SecurityIcon, SubscriptionsIcon, UsersIcon,
} from './NavIcons.jsx';

const STAFF_NAV = [
  { to: '/dashboard', label: 'Dashboard', Icon: DashboardIcon },
  { to: '/users', label: 'Users', Icon: UsersIcon },
  { to: '/subscriptions', label: 'Subscriptions', Icon: SubscriptionsIcon },
  { to: '/reviews', label: 'Reviews', Icon: ReviewsIcon },
  { to: '/contact', label: 'Contact inbox', Icon: InboxIcon },
  { to: '/releases', label: 'Releases', Icon: ReleasesIcon },
  { to: '/ads', label: 'Ads', Icon: AdsIcon },
  { to: '/activity', label: 'Activity log', Icon: ActivityIcon },
  { to: '/security', label: 'Security', Icon: SecurityIcon },
];

// Creator-only screens. They are appended, not substituted: the owner keeps
// every staff screen and gains account management, the full audit trail and
// the irreversible actions.
const ROOT_NAV = [
  { to: '/admins', label: 'Admins', Icon: AdminsIcon },
  { to: '/audit', label: 'Audit trail', Icon: AuditIcon },
  { to: '/danger', label: 'Danger zone', Icon: DangerIcon, danger: true },
];

// The fold's own mark: a panel with its sidebar pane, and a chevron that turns
// to point the way the sidebar will go.
function SidebarGlyph({ folded }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="3.5" />
      <rect x="3" y="4" width="6" height="16" rx="3.5" fill="currentColor" stroke="none" opacity="0.22" />
      <path d="M9 4v16" />
      <path
        d="M16.5 9.25 13.75 12l2.75 2.75"
        className="transition-transform duration-200 motion-reduce:transition-none"
        style={{ transformOrigin: '15.125px 12px', transform: folded ? 'rotate(180deg)' : 'none' }}
      />
    </svg>
  );
}

function MenuGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16M4 12h11M4 17h16" />
    </svg>
  );
}

// Ctrl+B (Cmd+B on a Mac) folds and opens the sidebar, as in most editors —
// except while typing, where the keys may mean something to the field.
function isTyping(target) {
  return target instanceof window.Element && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

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

  useEffect(() => {
    const onKey = (event) => {
      if (event.key?.toLowerCase() !== 'b' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (isTyping(event.target) || !window.matchMedia('(min-width: 48rem)').matches) return;
      event.preventDefault();
      toggleRail();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

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
        {/* The fold lives with the thing it folds. Open, it sits at the end of
            the brand row; folded, the logo turns into it under the pointer or
            keyboard focus, in the logo's own place, so nothing in the rail's
            column moves. A toggle rather than a disclosure: folded, every
            link is still there and still named, so aria-pressed, not
            aria-expanded. Hidden on a phone, whose drawer has no rail. */}
        <div className="group/brand relative flex h-16 items-center gap-2 border-b border-admin-border px-3.5">
          <img src={LOGO} alt="" className={`admin-brand-logo h-9 w-9 shrink-0 rounded-xl transition-opacity duration-150 ${rail ? 'md:group-hover/brand:opacity-0 md:group-has-[:focus-visible]/brand:opacity-0' : ''}`} aria-hidden="true" />
          <div className={`min-w-0 leading-tight ${rail ? 'md:hidden' : ''}`}>
            <p className="text-sm font-bold tracking-tight">Nexa<span className={`bg-clip-text text-transparent ${IS_ROOT ? 'bg-gradient-to-r from-admin-warning to-admin-danger' : 'bg-gradient-to-r from-accent-400 to-admin-cyan'}`}> {PANEL_LABEL}</span></p>
            <p className="text-xs text-admin-faint">{PANEL_SUBTITLE}</p>
          </div>
          <button
            type="button"
            aria-label="Collapse sidebar"
            aria-pressed={rail}
            aria-controls="admin-sidebar"
            aria-keyshortcuts="Control+B Meta+B"
            title={rail ? undefined : 'Collapse sidebar (Ctrl+B)'}
            className={`hidden items-center justify-center text-admin-muted transition duration-150 hover:text-admin-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-admin-accent motion-reduce:transition-none md:flex ${
              rail
                ? 'md:absolute md:left-3.5 md:top-3.5 md:h-9 md:w-9 md:rounded-xl md:border md:border-admin-border md:bg-admin-surface-2 md:opacity-0 md:group-hover/brand:opacity-100 md:focus-visible:opacity-100 md:[@media(hover:none)]:opacity-100'
                : 'ml-auto h-8 w-8 shrink-0 rounded-lg hover:bg-admin-surface-2'
            }`}
            onClick={toggleRail}
            {...tipFor('Expand sidebar · Ctrl+B')}
          >
            <SidebarGlyph folded={rail} />
          </button>
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
                `nav-link group/link ${isActive ? 'nav-link-active' : ''}`
              }
              {...tipFor(item.label)}
            >
              {({ isActive }) => (
                <>
                  {/* 16px wide, the 18px mark centred on it, so the column
                      the rail keeps still is the same as before. */}
                  <span
                    aria-hidden="true"
                    className={`flex w-4 shrink-0 justify-center transition-colors duration-150 ${
                      item.danger ? 'text-admin-danger' : isActive ? 'text-accent-400' : 'text-admin-muted group-hover/link:text-admin-text'
                    }`}
                  >
                    <item.Icon />
                  </span>
                  <span className={label}>{item.label}</span>
                </>
              )}
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
            <span aria-hidden="true" className="flex w-4 shrink-0 justify-center"><LogoutIcon /></span>
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
            <button type="button" aria-label="Open navigation" className="flex h-11 w-11 items-center justify-center rounded-lg border border-admin-border bg-admin-surface-2 text-admin-muted md:hidden" onClick={() => setMobileOpen(true)}><MenuGlyph /></button>
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
