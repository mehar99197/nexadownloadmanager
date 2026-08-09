import { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Brand from './Brand';

const NAV = [
  { to: '/', label: 'Home', end: true },
  { to: '/download', label: 'Download' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/reviews', label: 'Reviews' },
];

export default function Navbar() {
  const { isAuthenticated, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const linkClass = ({ isActive }) =>
    `relative text-sm font-semibold transition-colors ${
      isActive ? 'text-white after:absolute after:-bottom-[1.3rem] after:left-1/2 after:h-0.5 after:w-5 after:-translate-x-1/2 after:rounded-full after:bg-gradient-to-r after:from-accent-400 after:to-brand-400 after:shadow-[0_0_12px_rgba(53,201,255,0.7)]' : 'text-slate-400 hover:text-white'
    }`;

  const onLogout = async () => {
    setOpen(false);
    await logout();
    navigate('/');
  };

  return (
    <header className="sticky top-0 z-50 border-b border-[rgba(93,117,170,0.28)] bg-[rgba(6,8,14,0.78)] backdrop-blur-xl">
      <nav className="container-x flex h-16 items-center justify-between">
        <Brand compact />

        {/* Desktop nav */}
        <div className="hidden items-center gap-7 md:flex">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={linkClass}>
              {n.label}
            </NavLink>
          ))}
        </div>

        {/* Desktop auth actions */}
        <div className="hidden items-center gap-3 md:flex">
          {isAuthenticated ? (
            <>
              <Link to="/dashboard" className="btn btn-ghost">
                Dashboard
              </Link>
              <button type="button" className="btn btn-primary" onClick={onLogout}>
                Logout
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="btn btn-ghost">
                Login
              </Link>
              <Link to="/register" className="btn btn-primary">
                Register
              </Link>
            </>
          )}
        </div>

        {/* Mobile toggle */}
        <button
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[rgba(93,117,170,0.42)] bg-[rgba(17,24,39,0.7)] text-slate-200 md:hidden"
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
        <div className="border-t border-[rgba(93,117,170,0.28)] bg-[rgba(11,15,24,0.97)] md:hidden">
          <div className="container-x flex flex-col gap-1 py-4">
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
                      : 'text-zinc-300 hover:bg-[var(--color-surface-2)]'
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
            <div className="mt-3 flex flex-col gap-2">
              {isAuthenticated ? (
                <>
                  <Link to="/dashboard" className="btn btn-ghost" onClick={() => setOpen(false)}>
                    Dashboard
                  </Link>
                  <button type="button" className="btn btn-primary" onClick={onLogout}>
                    Logout
                  </button>
                </>
              ) : (
                <>
                  <Link to="/login" className="btn btn-ghost" onClick={() => setOpen(false)}>
                    Login
                  </Link>
                  <Link to="/register" className="btn btn-primary" onClick={() => setOpen(false)}>
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
