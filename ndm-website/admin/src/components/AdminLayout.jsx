import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAdminAuth } from '../context/AdminAuthContext.jsx';
import Button from './Button.jsx';
import { IS_ROOT, PANEL_LABEL, PANEL_SUBTITLE, PANEL_HEADING } from '../realm.js';

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
  const [mobileOpen, setMobileOpen] = useState(false);

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="flex min-h-screen bg-admin-bg text-admin-text">
      {mobileOpen && <button type="button" aria-label="Close navigation" className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden" onClick={() => setMobileOpen(false)} />}
      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-admin-border bg-admin-sidebar transition-transform md:static md:z-auto md:w-60 md:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-16 items-center gap-2 border-b border-admin-border px-5">
          <img src={LOGO} alt="" className="admin-brand-logo h-9 w-9 rounded-xl" aria-hidden="true" />
          <div className="leading-tight">
            <p className="text-sm font-bold tracking-tight">Nexa<span className={`bg-clip-text text-transparent ${IS_ROOT ? 'bg-gradient-to-r from-admin-warning to-admin-danger' : 'bg-gradient-to-r from-accent-400 to-admin-cyan'}`}> {PANEL_LABEL}</span></p>
            <p className="text-[11px] text-admin-faint">{PANEL_SUBTITLE}</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) =>
                `nav-link ${isActive ? 'nav-link-active' : ''}`
              }
            >
              <span className="w-4 text-center text-admin-faint">
                {item.icon}
              </span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-admin-border p-3">
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={handleLogout}
          >
            <span className="w-4 text-center">⎋</span>
            Logout
          </Button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-admin-border bg-admin-surface/80 px-6 backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <button type="button" aria-label="Open navigation" className="rounded-lg border border-admin-border bg-admin-surface-2 px-2.5 py-2 text-admin-muted md:hidden" onClick={() => setMobileOpen(true)}>☰</button>
            <div>
            <p className="text-[0.65rem] font-bold uppercase tracking-[0.16em] text-admin-faint">NexaDownloadManager</p>
            <h1 className="mt-0.5 text-sm font-semibold text-admin-text">{PANEL_HEADING}</h1>
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs text-admin-faint">{IS_ROOT && <span className="rounded-full border border-admin-warning/40 bg-admin-warning/10 px-2.5 py-1 font-bold uppercase tracking-wider text-admin-warning">Creator</span>}<span className="hidden text-admin-muted sm:inline">{admin?.name || 'Administrator'}</span><span className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-admin-success shadow-[0_0_10px_rgba(69,223,193,0.9)]" />Live system</span></div>
        </header>

        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
