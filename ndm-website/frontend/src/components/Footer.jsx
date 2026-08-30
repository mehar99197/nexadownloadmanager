import { Link } from 'react-router-dom';
import Brand from './Brand';

export const GITHUB_URL = 'https://github.com/mehar99197/nexadownloadmanager';
export const SUPPORT_EMAIL = 'support@nexadownloadmanager.com';

const COLS = [
  {
    title: 'Product',
    links: [
      { to: '/download', label: 'Download' },
      { to: '/pricing', label: 'Pricing' },
      { to: '/compare', label: 'Compare' },
      { to: '/changelog', label: 'Changelog' },
      { to: '/reviews', label: 'Reviews' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { to: '/docs', label: 'Docs' },
      { to: '/faq', label: 'FAQ' },
      { to: '/about', label: 'About' },
      { to: '/contact', label: 'Contact' },
      { href: GITHUB_URL, label: 'GitHub' },
    ],
  },
  {
    title: 'Account',
    links: [
      { to: '/login', label: 'Login' },
      { to: '/register', label: 'Register' },
      { to: '/dashboard', label: 'Dashboard' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { to: '/terms', label: 'Terms' },
      { to: '/privacy', label: 'Privacy' },
    ],
  },
];

function Social({ label, href, children }) {
  return (
    <a
      href={href}
      aria-label={label}
      target="_blank"
      rel="noreferrer"
      className="icon-btn h-9 w-9 rounded-xl"
    >
      {children}
    </a>
  );
}

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="site-footer mt-auto">
      <div className="container-x grid gap-10 py-12 sm:grid-cols-2 md:grid-cols-[1.4fr_repeat(4,1fr)]">
        <div className="sm:col-span-2 md:col-span-1">
          <Brand compact />
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-slate-400">
            Download videos, streams, torrents and files from anywhere — faster,
            with segmented acceleration.
          </p>
          <div className="mt-4 flex gap-2">
            <Social label="GitHub" href={GITHUB_URL}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.1-1.47-1.1-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z" />
              </svg>
            </Social>
          </div>
        </div>

        {COLS.map((col) => (
          <div key={col.title}>
            <h4 className="mb-3 text-xs font-bold uppercase tracking-[0.16em] text-slate-200">{col.title}</h4>
            <ul className="space-y-2">
              {col.links.map((l) => (
                <li key={l.label}>
                  {l.href ? (
                    <a
                      href={l.href}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-slate-400 transition hover:text-brand-300"
                    >
                      {l.label}
                    </a>
                  ) : (
                    <Link
                      to={l.to}
                      className="text-sm text-slate-400 transition hover:text-brand-300"
                    >
                      {l.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-[var(--color-surface-border)]">
        <div className="container-x flex flex-col items-center justify-between gap-2 py-5 text-xs text-slate-500 sm:flex-row">
          <p>© {year} NexaDownloadManager. All rights reserved.</p>
          <p>
            <Link to="/contact" className="text-slate-300 hover:text-brand-300">Contact</Link>
            {' · '}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-slate-300 hover:text-brand-300">
              {SUPPORT_EMAIL}
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
