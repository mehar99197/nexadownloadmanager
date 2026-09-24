import { useEffect, useRef, useState } from 'react';
import useTheme from '../hooks/useTheme';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Brand from './Brand';

const NAV = [
  { to: '/', label: 'Home', end: true },
  { to: '/download', label: 'Download' },
  { to: '/features', label: 'Features' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/docs', label: 'Docs' },
  { to: '/faq', label: 'FAQ' },
  { to: '/reviews', label: 'Reviews' },
];

/** Small sun/moon switch. Labelled for screen readers, since it is icon-only. */
function ThemeToggle({ resolved, onToggle }) {
  const goingToLight = resolved === 'dark';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={goingToLight ? 'Switch to the light theme' : 'Switch to the dark theme'}
      title={goingToLight ? 'Light theme' : 'Dark theme'}
      className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--color-surface-border)] text-slate-400 transition-colors hover:text-white"
    >
      {goingToLight ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" strokeLinecap="round" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

const MENU_ITEM =
  'flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm font-medium text-slate-300 transition hover:bg-[var(--color-surface-2)] hover:text-white';

/**
 * The signed-in account's own pages, and signing out, behind one button.
 *
 * "Logout" used to be a full-size button in the header, beside Dashboard, on
 * every page — the most prominent control a signed-in visitor had, one
 * mis-click from ending the session. A disclosure rather than an ARIA menu:
 * the items are ordinary links reached with Tab, which is what they are.
 */
function AccountMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const trigger = useRef(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e) => {
      if (!wrap.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Tabbing past the last item closes it. A null relatedTarget is a click on
  // something unfocusable, which the pointer handler already judges.
  const onBlur = (e) => {
    if (e.relatedTarget && !wrap.current?.contains(e.relatedTarget)) setOpen(false);
  };

  const initial = (user?.name || user?.email || '?').trim().charAt(0).toUpperCase();

  return (
    <div ref={wrap} className="relative" onBlur={onBlur}>
      <button
        ref={trigger}
        type="button"
        className="btn btn-ghost gap-2 !pl-2.5"
        aria-expanded={open}
        aria-controls="account-menu"
        onClick={() => setOpen((v) => !v)}
      >
        {/* -my-1: the 24px avatar sits in the button's padding rather than
            adding to it, so the trigger is the same 44px as Dashboard beside it. */}
        <span aria-hidden="true" className="-my-1 grid h-6 w-6 place-items-center rounded-full bg-brand-400/15 text-xs font-bold text-brand-300">
          {initial}
        </span>
        Account
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          id="account-menu"
          className="absolute right-0 top-full mt-2 w-60 rounded-xl border border-[var(--color-surface-border)] bg-[var(--color-surface-1)] p-1.5 shadow-[0_24px_48px_-24px_rgba(0,0,0,0.6)]"
        >
          {user?.email && (
            <p className="truncate px-3 pb-1.5 pt-2 text-xs text-slate-500" title={user.email}>{user.email}</p>
          )}
          <ul>
            <li><Link to="/billing" className={MENU_ITEM} onClick={close}>Billing</Link></li>
            <li><Link to="/profile" className={MENU_ITEM} onClick={close}>Profile</Link></li>
            <li className="mt-1 border-t border-[var(--color-surface-border)] pt-1">
              <button type="button" className={MENU_ITEM} onClick={onLogout}>Log out</button>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

export default function Navbar() {
  const { isAuthenticated, user, logout } = useAuth();
  const { resolved, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const linkClass = ({ isActive }) =>
    `relative text-sm font-semibold transition-colors ${
      isActive ? 'text-white after:absolute after:-bottom-[1.3rem] after:left-0 after:right-0 after:h-px after:rounded-full after:bg-gradient-to-r after:from-accent-400 after:to-brand-400 after:shadow-[0_0_6px_rgba(53,201,255,0.35)]' : 'text-slate-400 hover:text-white'
    }`;

  const onLogout = async () => {
    setOpen(false);
    // Leave the protected page FIRST: clearing the user while still on
    // /dashboard let ProtectedRoute bounce to /login?next=/dashboard before
    // the navigation home ran.
    navigate('/');
    await logout();
  };

  return (
    <header className="sticky top-0 z-50 border-b border-[var(--color-surface-border)] bg-[var(--color-nav-bg)] backdrop-blur-xl">
      <nav className="container-x flex h-16 items-center justify-between">
        <Brand compact />

        {/* Desktop nav */}
        <div className="hidden items-center gap-6 md:flex">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={linkClass}>
              {n.label}
            </NavLink>
          ))}
        </div>

        {/* Desktop auth actions */}
        <div className="hidden items-center gap-3 md:flex">
          <ThemeToggle resolved={resolved} onToggle={toggle} />
          {isAuthenticated ? (
            <>
              <Link to="/dashboard" className="btn btn-soft">
                Dashboard
              </Link>
              <AccountMenu user={user} onLogout={onLogout} />
            </>
          ) : (
            <>
              <Link to="/login" className="btn btn-ghost">
                Login
              </Link>
              <Link to="/register" className="btn btn-soft">
                Register
              </Link>
            </>
          )}
        </div>

        {/* Mobile toggle */}
        <button
          type="button"
          /* 44x44, not 40: at phone width this is the only navigation control
             on the page, so it is the one target that must never be missed. */
          className="icon-btn h-11 w-11 rounded-xl md:hidden"
          aria-label="Toggle menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            {open ? (
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            ) : (
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            )}
          </svg>
        </button>
      </nav>

      {/* Mobile menu */}
      {open && (
        <div className="mobile-menu md:hidden">
          <div className="container-x flex flex-col gap-1 py-4">
            <div className="flex items-center justify-between px-3 pb-2">
              <span className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Theme</span>
              <ThemeToggle resolved={resolved} onToggle={toggle} />
            </div>
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-2 text-sm font-medium ${
                    isActive
                      ? 'bg-[var(--color-surface-2)] text-white'
                      : 'text-slate-300 hover:bg-[var(--color-surface-2)]'
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
            <div className="mt-3 flex flex-col gap-2">
              {isAuthenticated ? (
                <>
                  <Link to="/dashboard" className="btn btn-soft" onClick={() => setOpen(false)}>
                    Dashboard
                  </Link>
                  <button type="button" className="btn btn-ghost" onClick={onLogout}>
                    Log out
                  </button>
                </>
              ) : (
                <>
                  <Link to="/login" className="btn btn-ghost" onClick={() => setOpen(false)}>
                    Login
                  </Link>
                  <Link to="/register" className="btn btn-soft" onClick={() => setOpen(false)}>
                    Register
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
