import { Link, NavLink } from 'react-router-dom';
import Section from '../../components/Section';
import Card from '../../components/Card';
import Button from '../../components/Button';

/**
 * The feature deep-dives share one skeleton so a reader who lands on any of
 * them from search finds the same shape: what it does, how it works, what it
 * supports, how to use it, tips, what goes wrong, where to go next.
 *
 * Prose helpers are imported from the docs shell rather than re-declared — the
 * two sets of pages should read as one voice, and a second copy of <P> would
 * drift from the first within a month.
 */
export { H2, P, Steps, Bullets, Code, Pre, Note } from '../docs/DocsShell';

export const FEATURE_NAV = [
  {
    to: '/features/acceleration',
    label: 'Segmented acceleration',
    blurb: 'Up to 16 connections per file, with the tail of the slowest one stolen by whoever finishes first.',
  },
  {
    to: '/features/video-grabber',
    label: 'Video grabber',
    blurb: 'HLS and DASH streams detected on the page, fetched in parallel and muxed into one file.',
  },
  {
    to: '/features/youtube-sites',
    label: 'YouTube & 1000+ sites',
    blurb: 'yt-dlp under the hood: quality picker, playlists, subtitles, and updates between releases.',
  },
  {
    to: '/features/bittorrent',
    label: 'BitTorrent',
    blurb: 'Magnets and .torrent files in the same queue as everything else, with seeding you control.',
  },
  {
    to: '/features/browser-extension',
    label: 'Browser extension',
    blurb: 'One click from Chrome, Edge, Brave or Firefox — with the cookies that page needs.',
  },
  {
    to: '/features/scheduler',
    label: 'Scheduler & limits',
    blurb: 'Start at 2am, cap the bandwidth while you work, shut the machine down when it is done.',
  },
  {
    to: '/features/remote-dashboard',
    label: 'Remote dashboard',
    blurb: 'Watch and steer the queue from your phone on the same network.',
  },
];

/**
 * A placeholder for artwork that has not been produced yet.
 *
 * Deliberately loud rather than an empty grey box: a silent placeholder is one
 * that ships. This one names what still has to be drawn, and `npm run build`
 * leaves it alone, so the only way it disappears is somebody replacing it.
 */
export function Figure({ kind = 'Screenshot', children, caption }) {
  return (
    <figure className="mt-5">
      <div className="flex min-h-[132px] flex-col items-center justify-center rounded-[var(--radius-3)] border border-dashed border-amber-400/30 bg-amber-400/[0.06] px-6 py-8 text-center">
        <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-amber-300">
          {kind} needed
        </span>
        <p className="mt-3 max-w-md text-sm leading-6 text-slate-400">{children}</p>
      </div>
      {caption && <figcaption className="mt-2 text-xs text-slate-500">{caption}</figcaption>}
    </figure>
  );
}

/**
 * The "what does this actually support" table every feature page carries.
 * `rows` is [[label, value], …]; a value may be a string or a node.
 */
export function SpecTable({ caption, head = ['', ''], rows }) {
  return (
    <div className="mt-5 overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="surface-inset !border-x-0 !border-t-0 border-b border-white/10">
            {head.map((h, i) => (
              <th
                key={i}
                scope="col"
                className="px-4 py-3 text-xs font-bold uppercase tracking-[0.14em] text-slate-500"
              >
                {h || <span className="sr-only">Item</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label} className="border-b border-white/5 align-top last:border-0">
              <th scope="row" className="px-4 py-3 font-semibold text-slate-200">{label}</th>
              <td className="px-4 py-3 text-slate-400">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Tips & best practices — a checklist, visually distinct from plain bullets. */
export function Tips({ items }) {
  return (
    <ul className="mt-4 space-y-2.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 text-sm leading-7 text-slate-300">
          <svg
            width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true" className="mt-2 shrink-0 text-emerald-300"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Troubleshooting: symptom → cause → fix. Kept as <details> so the page stays
 * skimmable, and open-by-default on the first entry so it is obvious they open.
 */
export function Troubles({ items }) {
  return (
    <div className="mt-4 space-y-2.5">
      {items.map((item, i) => (
        <details key={item.symptom} className="surface-panel group rounded-xl px-4 py-3" open={i === 0}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-bold text-white marker:hidden [&::-webkit-details-marker]:hidden">
            <span>{item.symptom}</span>
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true" className="shrink-0 text-brand-300 transition-transform group-open:rotate-180"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </summary>
          <div className="mt-2.5 border-t border-white/5 pt-2.5 text-sm leading-7 text-slate-400">
            {item.fix}
          </div>
        </details>
      ))}
    </div>
  );
}

/** Related features — two or three cards at the foot of every page. */
export function Related({ to }) {
  const picks = FEATURE_NAV.filter((f) => to.includes(f.to));
  return (
    <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {picks.map((f) => (
        <Link
          key={f.to}
          to={f.to}
          className="surface-panel rounded-xl px-4 py-4 transition hover:border-brand-400/30"
        >
          <p className="text-sm font-bold text-white">{f.label}</p>
          <p className="mt-1 text-xs leading-6 text-slate-400">{f.blurb}</p>
        </Link>
      ))}
    </div>
  );
}

export default function FeatureShell({ title, tagline, hero, children }) {
  return (
    <Section>
      <div className="grid gap-10 lg:grid-cols-[240px_1fr]">
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <Link
            to="/features"
            className="text-xs font-bold uppercase tracking-[0.18em] text-brand-300 hover:text-white"
          >
            &larr; Features
          </Link>
          <nav className="mt-4 flex flex-row flex-wrap gap-1 lg:flex-col">
            {FEATURE_NAV.map((item) => (
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
          <p className="mt-3 max-w-2xl text-base leading-7 text-slate-400">{tagline}</p>
          {hero}

          <Card className="mt-8 !p-6 sm:!p-8">{children}</Card>

          <div className="surface-panel mt-8 rounded-[var(--radius-3)] px-6 py-6">
            <p className="text-sm font-bold text-white">Try it free.</p>
            <p className="mt-1 text-xs text-slate-400">
              Free plan, no card, Windows and Linux. Every account also gets a 7-day Pro trial.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button to="/download">Download free</Button>
              <Button to="/pricing" variant="ghost">See plans</Button>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}
