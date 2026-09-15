import { Link, NavLink } from 'react-router-dom';
import Section from '../../components/Section';
import Card from '../../components/Card';

export const DOCS_NAV = [
  { to: '/docs/install', label: 'Install', blurb: 'Windows installer, Ubuntu/Debian .deb and what gets bundled.' },
  { to: '/docs/extension', label: 'Browser extension', blurb: 'Chrome, Edge, Brave and Firefox setup plus the native host bridge.' },
  { to: '/docs/youtube', label: 'YouTube & 1000+ sites', blurb: 'Quality picker, playlists and fixing HTTP 403 errors.' },
  { to: '/docs/courses', label: 'Courses', blurb: 'Udemy and Coursera courses you are enrolled in.' },
  { to: '/docs/torrents', label: 'Torrents', blurb: 'Magnet links, .torrent files, seed ratio and limits.' },
  { to: '/docs/remote', label: 'Remote dashboard', blurb: 'Control the queue from your phone.' },
  { to: '/docs/license', label: 'Signing in & seats', blurb: 'Signing in to the app, seats, manual keys and offline behaviour.' },
];

/** Prose helpers so every guide reads the same. */
export function H2({ id, children }) {
  return (
    <h2 id={id} className="mt-10 scroll-mt-24 text-xl font-bold tracking-tight text-white first:mt-0">
      {children}
    </h2>
  );
}

export function P({ children }) {
  return <p className="mt-3 text-sm leading-7 text-slate-400">{children}</p>;
}

export function Steps({ items }) {
  return (
    <ol className="mt-4 space-y-3">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 text-sm leading-7 text-slate-300">
          <span className="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-brand-400/30 bg-brand-400/10 text-xs font-bold text-brand-300">
            {i + 1}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}

export function Bullets({ items }) {
  return (
    <ul className="mt-3 space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2 text-sm leading-7 text-slate-300">
          <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-300" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function Code({ children }) {
  return (
    <code className="surface-inset rounded-md px-1.5 py-0.5 font-mono text-[0.9em] text-brand-100">
      {children}
    </code>
  );
}

export function Pre({ children }) {
  return (
    <pre className="surface-inset mt-3 overflow-x-auto rounded-xl p-4 font-mono text-xs leading-6 text-brand-100">
      {children}
    </pre>
  );
}

export function Note({ tone = 'info', title, children }) {
  const tones = { info: 'note-info', warn: 'note-warn' };
  return (
    <div className={`mt-4 rounded-xl px-4 py-3 text-sm leading-6 ${tones[tone] || tones.info}`}>
      {title && <p className="font-bold">{title}</p>}
      <div className={title ? 'mt-1' : ''}>{children}</div>
    </div>
  );
}

/**
 * DocsShell — sidebar of guides + a content column. Every /docs/* page wraps
 * itself in this so navigation and rhythm stay identical.
 */
export default function DocsShell({ title, intro, children }) {
  return (
    <Section>
      <div className="grid gap-10 lg:grid-cols-[240px_1fr]">
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <Link to="/docs" className="text-xs font-bold uppercase tracking-[0.18em] text-brand-300 hover:text-white">
            &larr; Docs
          </Link>
          <nav className="mt-4 flex flex-row flex-wrap gap-1 lg:flex-col">
            {DOCS_NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-2 text-sm font-medium transition ${
                    isActive
                      ? 'bg-[var(--color-surface-2)] text-white'
                      : 'text-slate-400 hover:bg-[var(--color-surface-2)] hover:text-white'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </aside>

        <div className="min-w-0">
          <h1 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">{title}</h1>
          {intro && <p className="mt-3 max-w-2xl text-base leading-7 text-slate-400">{intro}</p>}
          <Card className="mt-8 !p-6 sm:!p-8">{children}</Card>
          <p className="mt-6 text-xs text-slate-500">
            Something missing or wrong?{' '}
            <Link to="/contact" className="text-slate-300 hover:text-brand-300">Tell us</Link>{' '}
            and we will fix the page.
          </p>
        </div>
      </div>
    </Section>
  );
}
