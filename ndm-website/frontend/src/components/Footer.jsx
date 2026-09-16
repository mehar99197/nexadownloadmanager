import { Link } from 'react-router-dom';
import Brand from './Brand';

export const SUPPORT_EMAIL = 'support@nexadownloadmanager.com';

const COLS = [
  {
    title: 'Product',
    links: [
      { to: '/download', label: 'Download' },
      { to: '/features', label: 'Features' },
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
      { to: '/tutorials', label: 'Tutorials' },
      { to: '/faq', label: 'FAQ' },
      { to: '/security', label: 'Security' },
      { to: '/about', label: 'About' },
      { to: '/contact', label: 'Contact' },
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
        </div>

        {COLS.map((col) => (
          <div key={col.title}>
            <h2 id={`footer-${col.title.toLowerCase()}`} className="mb-3 text-xs font-bold uppercase tracking-[0.16em] text-slate-300">
              {col.title}
            </h2>
            <ul className="space-y-2" aria-labelledby={`footer-${col.title.toLowerCase()}`}>
              {col.links.map((l) => (
                <li key={l.label}>
                  <Link
                    to={l.to}
                    className="text-sm text-slate-400 transition hover:text-brand-300"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-[var(--color-surface-border)]">
        <div className="container-x flex flex-col items-center justify-between gap-3 py-7 text-xs text-slate-500 sm:flex-row sm:py-6">
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
