import { Link } from 'react-router-dom';
import Brand from './Brand';

const COLS = [
  {
    title: 'Product',
    links: [
      { to: '/download', label: 'Download' },
      { to: '/pricing', label: 'Pricing' },
      { to: '/reviews', label: 'Reviews' },
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
      { to: '/pricing', label: 'Terms' },
      { to: '/pricing', label: 'Privacy' },
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
      className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[rgba(93,117,170,0.4)] bg-[rgba(17,24,39,0.5)] text-slate-400 transition hover:border-accent-400 hover:text-white"
    >
      {children}
    </a>
  );
}

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="mt-auto border-t border-[rgba(93,117,170,0.28)] bg-[rgba(8,11,18,0.9)]">
      <div className="container-x grid gap-10 py-12 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div>
          <Brand compact />
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-slate-400">
            Download videos, streams, torrents and files from anywhere — faster,
            with segmented acceleration.
          </p>
          <div className="mt-4 flex gap-2">
            {/* Socials — placeholders */}
            <Social label="GitHub" href="#">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.1-1.47-1.1-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z" />
              </svg>
            </Social>
            <Social label="X" href="#">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M18.9 2H22l-7.5 8.6L23 22h-6.8l-5.3-6.9L4.8 22H1.7l8-9.2L1 2h6.9l4.8 6.4L18.9 2zm-2.4 18h1.9L7.6 4H5.6l10.9 16z" />
              </svg>
            </Social>
            <Social label="Discord" href="#">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M20 4.4A19 19 0 0 0 15.3 3l-.2.4a14 14 0 0 0-6.2 0L8.7 3A19 19 0 0 0 4 4.4C1.6 8 1 11.5 1.3 15a19 19 0 0 0 5.7 2.9l.5-.8c-.5-.2-1-.4-1.4-.7l.3-.2a13.6 13.6 0 0 0 11.2 0l.3.2c-.4.3-.9.5-1.4.7l.5.8A19 19 0 0 0 22.7 15c.4-4.1-.6-7.6-2.7-10.6zM8.7 13c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.6.8 1.6 1.8S9.6 13 8.7 13zm6.6 0c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.6.8 1.6 1.8-.7 1.8-1.6 1.8z" />
              </svg>
            </Social>
          </div>
        </div>

        {COLS.map((col) => (
          <div key={col.title}>
            <h4 className="mb-3 text-xs font-bold uppercase tracking-[0.16em] text-slate-200">{col.title}</h4>
            <ul className="space-y-2">
              {col.links.map((l, i) => (
                <li key={`${l.label}-${i}`}>
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

      <div className="border-t border-[rgba(93,117,170,0.22)]">
        <div className="container-x flex flex-col items-center justify-between gap-2 py-5 text-xs text-slate-500 sm:flex-row">
          <p>© {year} NexaDownloadManager. All rights reserved.</p>
          <p>
            Contact:{' '}
            <a
              href="mailto:support@nexadownloadmanager.com"
              className="text-slate-300 hover:text-brand-300"
            >
              support@nexadownloadmanager.com
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
