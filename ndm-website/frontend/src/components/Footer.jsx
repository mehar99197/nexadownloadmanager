import { Link } from 'react-router-dom';
import Brand from './Brand';

export const SUPPORT_EMAIL = 'support@nexadownloadmanager.com';

/**
 * The public repository. The site tells readers they can check its claims by
 * reading the code (About, Security, the extension pages) and used to give
 * them no way to find it.
 */
export const SOURCE_URL = 'https://github.com/mehar99197/nexadownloadmanager';

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
    // /tutorials is left out until it has videos to show: every card on it
    // still reads "video to be created". The route stays for old links.
    links: [
      { to: '/docs', label: 'Docs' },
      { to: '/faq', label: 'FAQ' },
      { to: '/security', label: 'Security' },
      { href: SOURCE_URL, label: 'Source code' },
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
      {/* Two columns from the narrowest screen up, not one.
          This footer is identical on every page and measured 1084px at 390px —
          1.28 screens of it, sitting under a /pricing page that is only 1581px
          in total. Four link lists stacked in a single column is what did it.
          Two-up roughly halves the block and costs nothing: these are short
          labels that fit a ~170px column comfortably. */}
      <div className="container-x grid grid-cols-2 gap-x-6 gap-y-8 py-10 sm:grid-cols-2 sm:gap-10 md:grid-cols-[1.4fr_repeat(4,1fr)] md:py-12">
        <div className="col-span-2 md:col-span-1">
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
            <ul className="-my-2" aria-labelledby={`footer-${col.title.toLowerCase()}`}>
              {col.links.map((l) => {
                /* 18px tall was under even WCAG 2.2 AA's 24px minimum
                   (2.5.8). `block py-2` makes each row ~34px and widens the
                   hit area to the whole column, which is what actually makes a
                   dense link list tappable. Not 44px: that is the AAA/HIG bar,
                   and paying 26px twelve times over would put back most of the
                   footer height just saved. */
                const cls = 'block py-2 text-sm text-slate-400 transition hover:text-brand-300';
                return (
                  <li key={l.label}>
                    {l.href ? (
                      <a href={l.href} className={cls}>{l.label}</a>
                    ) : (
                      <Link to={l.to} className={cls}>{l.label}</Link>
                    )}
                  </li>
                );
              })}
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
