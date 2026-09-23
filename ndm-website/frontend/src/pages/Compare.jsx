import { useState } from 'react';
import { Link } from 'react-router-dom';
import usePageMeta from '../hooks/usePageMeta';
import useMediaQuery from '../hooks/useMediaQuery';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';

// Cell values: true / false / 'partial' / 'coming' / any string (rendered as text).
const PRODUCTS = [
  { name: 'Nexa', note: 'beta' },
  { name: 'IDM' },
  { name: 'FDM' },
  { name: 'JDownloader' },
  { name: 'EagleGet' },
  { name: 'XDM' },
  { name: 'Motrix' },
  { name: 'uGet' },
];

/* Order of values in every row matches PRODUCTS above.
   Where we are not confident about another product's current behaviour the
   cell says 'partial' with a note rather than guessing a tick — a comparison
   table that overstates a rival is as dishonest as one that understates it. */
const GROUPS = [
  {
    title: 'Platforms & license',
    rows: [
      { label: 'Windows', values: [true, true, true, true, true, true, true, true] },
      { label: 'Linux', values: [true, false, true, true, false, true, true, true] },
      { label: 'macOS', values: ['coming', false, true, true, false, true, true, 'partial'] },
      { label: 'Open source', values: [true, false, false, 'partial', false, true, true, true] },
      {
        label: 'Still actively developed',
        values: [true, true, true, true, false, 'partial', true, 'partial'],
        note: 'EagleGet has had no release since 2019. XDM and uGet update rarely but are not abandoned.',
      },
      {
        label: 'Portable version',
        values: [true, false, false, true, false, 'partial', false, true],
        note: 'Nexa runs portable with a portable.txt beside the executable.',
      },
    ],
  },
  {
    title: 'Price',
    rows: [
      {
        label: 'Price',
        values: [
          'Free · Pro $5/mo',
          'Paid license',
          'Free',
          'Free',
          'Free',
          'Free',
          'Free',
          'Free',
        ],
      },
      {
        label: 'Ads',
        values: ['In-app promo on Free only', false, false, 'Bundled offers in the installer', 'In-app ads', false, false, false],
        note: 'Nexa shows one promo strip inside the app on the Free plan; Pro and Team are ad-free. Nothing is ever bundled into the installer.',
      },
    ],
  },
  {
    title: 'Download engine',
    rows: [
      {
        label: 'Max connections per file',
        values: ['32', '32', '16', '20', '32', '32', '16', '16'],
        note: 'A ceiling, not a recommendation — past about eight, the server is usually the limit. Nexa scales with file size and reaches 32 on Pro; the Free plan stops at 16.',
      },
      { label: 'Multi-connection HTTP', values: [true, true, true, true, true, true, true, true] },
      { label: 'Resume broken downloads', values: [true, true, true, true, true, true, true, true] },
      {
        label: 'Dynamic re-segmentation',
        values: [true, true, false, false, 'partial', false, false, false],
        note: 'Stealing the tail of the slowest segment while the download runs, rather than cutting fixed pieces up front.',
      },
      { label: 'Speed limits (global + per download)', values: [true, true, true, true, 'partial', true, true, true] },
      { label: 'Checksum verification', values: [true, false, 'partial', true, false, false, 'partial', false] },
      { label: 'Proxy support', values: ['HTTP · SOCKS5', 'HTTP · FTP · ISA · NTLM', 'HTTP · SOCKS', 'HTTP · SOCKS', 'HTTP · SOCKS', 'HTTP · SOCKS', 'HTTP · SOCKS', 'HTTP · SOCKS'] },
    ],
  },
  {
    title: 'What it can download',
    rows: [
      { label: 'Video grabber (HLS/DASH)', values: [true, true, 'partial', true, 'partial', true, false, false] },
      {
        label: 'YouTube & 1000+ sites via yt-dlp',
        values: [true, 'partial', 'partial', 'partial', false, 'partial', false, false],
        note: 'Only Nexa runs yt-dlp itself. The others use their own site plugins, which cover fewer sites and break differently.',
      },
      { label: 'Subtitle download', values: [true, 'partial', false, 'partial', false, false, false, false] },
      { label: 'BitTorrent', values: [true, false, true, false, true, false, true, 'partial'] },
      { label: 'Cloud links (Google Drive, Mega)', values: [true, 'partial', false, true, false, false, false, false] },
      { label: 'FTP', values: [false, true, true, true, true, true, true, true], note: 'An honest miss on our side: Nexa is HTTP/HTTPS only.' },
      {
        label: 'Whole-site spider / grabber',
        values: [false, true, false, false, false, false, false, false],
        note: 'IDM alone does this — download every image on a site, or a whole site for offline reading. Nexa has a link grabber for one page, which is not the same thing.',
      },
      { label: 'Batch / pattern downloads', values: [true, true, 'partial', true, true, true, 'partial', true] },
    ],
  },
  {
    title: 'Workflow',
    rows: [
      { label: 'Browser extension', values: ['Chrome · Edge · Brave · Firefox', true, true, true, true, true, 'partial', 'partial'] },
      {
        label: 'Open bridge / native messaging',
        values: [true, false, false, 'partial', false, 'partial', false, false],
        note: 'Nexa’s browser bridge and app are open source, so you can read what happens to your cookies.',
      },
      { label: 'Clipboard monitoring', values: [true, true, true, true, true, true, false, true] },
      { label: 'Automatic categories / folders', values: [true, true, true, true, true, 'partial', false, true] },
      { label: 'Queue management', values: [true, true, true, true, 'partial', true, 'partial', true] },
      { label: 'Scheduler', values: [true, true, true, 'partial', true, true, false, true] },
      { label: 'Auto-shutdown when finished', values: [true, true, true, true, true, 'partial', false, true] },
      { label: 'Remote phone dashboard', values: [true, false, true, true, false, true, false, false] },
      { label: 'AI rename', values: ['Pro, opt-in', false, false, false, false, false, false, false] },
      { label: 'Themes', values: ['64', '2 + toolbar skins', '2', 'partial', '1', '2', '2', 'partial'] },
      { label: 'Update mechanism', values: ['Signed feed, auto', 'Auto', 'Auto', 'Auto', 'Manual', 'Manual', 'Auto', 'Package manager'] },
    ],
  },
];

const PRICING = [
  ['Nexa', 'Yes — 3 concurrent downloads, forever', '$5/mo or $45/yr', '7-day Pro trial, no card'],
  ['IDM', 'No — trial only', 'From ~$12 one-year to ~$25 lifetime, 1 PC', '30-day trial, no card'],
  ['FDM', 'Yes — all features', '—', '—'],
  ['JDownloader', 'Yes — installer carries bundled offers', '—', '—'],
  ['EagleGet', 'Yes — with in-app ads', '—', '—'],
  ['XDM', 'Yes — all features', '—', '—'],
  ['Motrix', 'Yes — all features', '—', '—'],
  ['uGet', 'Yes — all features', '—', '—'],
];

const BEST_FOR = [
  {
    name: 'Nexa',
    mine: true,
    points: [
      'You are on Linux as well as Windows',
      'You want torrents, streams and YouTube in one queue',
      'You download from a thousand-odd sites and want yt-dlp behind it',
      'You want to read the code that handles your cookies',
      'You control the queue from a phone',
    ],
  },
  {
    name: 'IDM',
    points: [
      'You are on Windows only and want 25 years of polish',
      'You need the site spider — whole sites or every image on a page',
      'You would rather pay once than subscribe',
      'Proven stability matters more than breadth',
    ],
  },
  {
    name: 'JDownloader',
    points: [
      'You work with container files (DLC, CCF, RSDF)',
      'You want the deepest link-grabbing and plugin ecosystem there is',
      'You use file-hosting sites heavily and need their account handling',
    ],
  },
  {
    name: 'Free Download Manager',
    points: [
      'You want a free, polished, cross-platform tool with no plan to think about',
      'Your needs are mainstream: HTTP downloads plus the odd torrent',
      'You would rather not run beta software',
    ],
  },
  {
    name: 'Motrix or uGet',
    points: [
      'You want something small, open source and out of the way',
      'aria2 under the hood is a feature to you, not an implementation detail',
      'You do not need video grabbing at all',
    ],
  },
  {
    name: 'A dedicated torrent client',
    points: [
      'You seed a large library and need per-file selection inside a torrent',
      'You want RSS auto-downloading, tags and sequential download',
      'You run a headless seedbox — qBittorrent or Transmission, not a download manager',
    ],
  },
];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function Cell({ value }) {
  if (value === true) {
    return (
      <span className="inline-flex items-center gap-1.5 text-emerald-300">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6L9 17l-5-5" />
        </svg>
        <span className="sr-only">Yes</span>
      </span>
    );
  }
  if (value === false) {
    // aria-label on a role-less <span> is dropped by browsers, so this cell was
    // announced as an em dash or as nothing at all. The visible mark is hidden
    // from the tree and the word carried in sr-only text, matching the Yes cell.
    return (
      <span className="text-slate-500">
        <span aria-hidden="true">—</span>
        <span className="sr-only">No</span>
      </span>
    );
  }
  if (value === 'partial') {
    return <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-amber-300">Partial</span>;
  }
  if (value === 'coming') {
    return <span className="rounded-full border border-brand-400/25 bg-brand-400/10 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-brand-300">Coming</span>;
  }
  return <span className="text-slate-300">{value}</span>;
}

/**
 * The matrix on a phone.
 *
 * The wide table is eight products by thirty-four rows. Squeezed into 390px it
 * was 9.2 screens tall and had to scroll sideways on top of that, which is two
 * gestures to read one cell — the single worst thing on the site to use with a
 * thumb. Nobody compares eight products at once anyway: they compare the one
 * they use with the one they are considering.
 *
 * So the phone gets that question instead. Pick a rival, and every group folds
 * away except the one being read. Same data, same table semantics, same cells
 * — a third of a screen instead of nine, and no sideways scroll at all.
 */
function MobileMatrix({ rival, onRival }) {
  const them = PRODUCTS[rival];

  return (
    <div className="mt-8">
      <label htmlFor="cmp-rival" className="block text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
        Compare Nexa with
      </label>
      <select
        id="cmp-rival"
        value={rival}
        onChange={(e) => onRival(Number(e.target.value))}
        className="input-field mt-2 min-h-11 w-full"
      >
        {PRODUCTS.map((p, i) => (i === 0 ? null : <option key={p.name} value={i}>{p.name}</option>))}
      </select>

      {GROUPS.map((group, gi) => (
        // Open the first one so the page does not read as a list of closed
        // boxes, and cv-row so the four that are shut cost nothing to lay out.
        <Card as="details" key={group.title} open={gi === 0} className="cv-row group mt-3 !p-0">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4 text-left text-sm font-bold text-white marker:hidden [&::-webkit-details-marker]:hidden">
            <span>{group.title}</span>
            <span className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-500">{group.rows.length}</span>
              <svg
                width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                className="shrink-0 text-brand-300 transition-transform group-open:rotate-180"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </span>
          </summary>
          <table className="w-full border-t border-white/5 text-left text-sm">
            <caption className="sr-only">
              {group.title} — Nexa Download Manager compared with {them.name}
            </caption>
            <thead>
              <tr className="border-b border-white/5">
                <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Feature</th>
                <th scope="col" className="px-2 py-2 text-xs font-bold uppercase tracking-[0.12em] text-brand-300">Nexa</th>
                <th scope="col" className="px-2 py-2 text-xs font-bold uppercase tracking-[0.12em] text-slate-400">{them.name}</th>
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row) => (
                <tr key={row.label} className="border-b border-white/5 align-top last:border-0">
                  <th scope="row" className="px-4 py-3 font-normal">
                    <span className="font-semibold text-slate-200">{row.label}</span>
                    {row.note && <p className="mt-1 text-xs leading-5 text-slate-500">{row.note}</p>}
                  </th>
                  <td className="bg-brand-500/[0.04] px-2 py-3"><Cell value={row.values[0]} /></td>
                  <td className="px-2 py-3"><Cell value={row.values[rival]} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}

export default function Compare() {
  usePageMeta({
    title: 'Compare',
    description:
      'Nexa Download Manager against IDM, Free Download Manager, JDownloader, EagleGet, XDM, Motrix and uGet: platforms, price, connections, video grabbing, torrents, scheduling and licensing — including where each one wins.',
  });

  // Eight products is a wide table. Narrowing to the four best-known ones is
  // the default reading; the rest are one click away rather than forcing a long
  // horizontal scroll on everybody.
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? PRODUCTS.map((_, i) => i) : [0, 1, 2, 3];

  // A different tree on a phone, not a restyled one — see MobileMatrix above
  // and hooks/useMediaQuery.js for why this is not a CSS breakpoint. 768px is
  // Tailwind's md, the width at which the wide table first has room.
  const narrow = useMediaQuery('(max-width: 767px)');
  const [rival, setRival] = useState(1); // IDM: the one people arrive comparing

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />Side by side</span>
        <h1 className="mt-5 text-white">Nexa vs <span className="text-gradient">the usual suspects.</span></h1>
        <p>
          An honest feature matrix against seven other download managers. Nexa is in beta — some
          things they do better, and we say so in the table rather than leaving it out.
        </p>
      </div>

      <div className="note-warn mx-auto mt-6 max-w-3xl rounded-xl px-4 py-3 text-center text-sm">
        Nexa is beta software. IDM, FDM and JDownloader have years of polish; expect rough edges
        here and <Link to="/contact?topic=bug" className="font-semibold underline">tell us</Link> when you hit one.
      </div>

      {narrow ? (
        <MobileMatrix rival={rival} onRival={setRival} />
      ) : (
        <>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="btn btn-ghost text-xs"
          aria-pressed={showAll}
        >
          {showAll ? 'Show the four best-known' : 'Add EagleGet, XDM, Motrix and uGet'}
        </button>
        <span className="text-xs text-slate-500">
          Showing {visible.length} of {PRODUCTS.length}
        </span>
      </div>

      <Card className="cv-block mt-6 overflow-hidden !p-0">
        {/* Focusable on purpose. This box scrolls sideways on anything
            narrower than the table, and a scroll box only a pointer can reach
            puts the right-hand columns out of a keyboard's reach entirely
            (axe: scrollable-region-focusable). tabIndex makes the arrow keys
            work; the role and label stop it being an unnamed tab stop. */}
        <div
          className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-300)]"
          tabIndex={0}
          role="region"
          aria-label="Feature comparison table — scrolls sideways"
        >
          <table className={`w-full text-left text-sm ${showAll ? 'min-w-[1180px]' : 'min-w-[720px]'}`}>
            {/* Without a caption and scoped headers a screen reader reads this
                matrix as a run of loose cells: "Yes", "Yes", "—" with nothing
                saying which product or which feature. */}
            <caption className="sr-only">
              Feature comparison of Nexa Download Manager, IDM, Free Download Manager, JDownloader,
              EagleGet, XDM, Motrix and uGet
            </caption>
            <thead>
              <tr className="surface-inset !border-x-0 !border-t-0 border-b border-white/10">
                <th scope="col" className="px-5 py-4 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Feature</th>
                {visible.map((pi) => (
                  <th
                    key={PRODUCTS[pi].name}
                    scope="col"
                    className={`px-5 py-4 text-xs font-bold uppercase tracking-[0.14em] ${pi === 0 ? 'text-brand-300' : 'text-slate-400'}`}
                  >
                    {PRODUCTS[pi].name}
                    {PRODUCTS[pi].note && (
                      <span className="ml-2 rounded-full border border-brand-400/25 bg-brand-400/10 px-1.5 py-0.5 text-xs text-brand-300">
                        {PRODUCTS[pi].note}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            {GROUPS.map((group) => (
              <tbody key={group.title} aria-labelledby={`cmp-${slug(group.title)}`}>
                <tr className="border-b border-white/5">
                  <td
                    colSpan={visible.length + 1}
                    className="surface-inset !border-x-0 px-5 py-2.5"
                  >
                    <span
                      id={`cmp-${slug(group.title)}`}
                      className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400"
                    >
                      {group.title}
                    </span>
                  </td>
                </tr>
                {group.rows.map((row) => (
                  <tr key={row.label} className="border-b border-white/5 align-top last:border-0">
                    <th scope="row" className="px-5 py-3.5 font-normal">
                      <span className="font-semibold text-slate-200">{row.label}</span>
                      {row.note && <p className="mt-1 max-w-xs text-xs leading-5 text-slate-500">{row.note}</p>}
                    </th>
                    {visible.map((pi) => (
                      <td key={pi} className={`px-5 py-3.5 ${pi === 0 ? 'bg-brand-500/[0.04]' : ''}`}>
                        <Cell value={row.values[pi]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      </Card>
        </>
      )}

      <p className="mx-auto mt-5 max-w-3xl text-center text-xs leading-6 text-slate-500">
        Based on publicly documented features as of {new Date().getFullYear()}. &ldquo;Partial&rdquo; means the
        feature exists but with notable limits (fewer sites, a separate app, a plugin, or a paid add-on). If
        we got something wrong about another product, <Link to="/contact" className="text-slate-300 underline underline-offset-2 hover:text-brand-300">let us know</Link> and we will fix it.
      </p>

      <h2 className="mt-16 text-center text-2xl font-extrabold tracking-tight text-white">
        Price, plainly
      </h2>
      <Card className="cv-block mt-6 overflow-hidden !p-0">
        <div
          className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-300)]"
          tabIndex={0}
          role="region"
          aria-label="Pricing comparison table — scrolls sideways"
        >
          {/* Four columns of short text fit a phone; the padding is what did
              not. px-2 below sm: at px-3 the table needed 350px and, with the
              scrollbar gutter now reserved in a narrow desktop window, got 338.
              Phones use overlay scrollbars and have 348 either way. */}
          <table className="w-full text-left text-sm sm:min-w-[720px]">
            <caption className="sr-only">Free tier, paid price and trial for each download manager</caption>
            <thead>
              <tr className="surface-inset !border-x-0 !border-t-0 border-b border-white/10">
                {['Product', 'Free tier', 'Paid', 'Trial'].map((h) => (
                  <th key={h} scope="col" className="px-2 py-4 text-xs font-bold uppercase tracking-[0.14em] text-slate-500 sm:px-5">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PRICING.map((row) => {
                const isUs = row[0] === 'Nexa';
                return (
                  <tr key={row[0]} className={`border-b border-white/5 last:border-0 ${isUs ? 'bg-brand-500/[0.04]' : ''}`}>
                    <th scope="row" className={`px-2 py-3.5 font-semibold sm:px-5 ${isUs ? 'text-brand-300' : 'text-slate-200'}`}>{row[0]}</th>
                    {row.slice(1).map((cell, i) => (
                      <td key={i} className="px-2 py-3.5 text-slate-400 sm:px-5">{cell}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="mx-auto mt-4 max-w-3xl text-center text-xs leading-6 text-slate-500">
        IDM&apos;s price is localised heavily by country, so the figures above are indicative in USD —
        check their site for yours. Nexa&apos;s paid plans are not open yet; the Free plan and the
        trial are what you can use today.
      </p>

      <h2 className="mt-16 text-center text-2xl font-extrabold tracking-tight text-white">
        Which one should you actually use?
      </h2>
      <p className="mx-auto mt-3 max-w-2xl text-center text-sm leading-7 text-slate-400">
        A comparison table where one product wins every row is an advertisement. Here is when we
        think you should pick something else.
      </p>
      <div className="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
        {BEST_FOR.map((b, i) => {
          const points = (
            <ul className="space-y-2">
              {b.points.map((p) => (
                <li key={p} className="flex gap-2 text-sm leading-6 text-slate-400">
                  <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-300" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          );

          // Six recommendations of four or five lines each is another two and
          // a half screens on a phone, and the heading is the whole question:
          // a reader wants the one that matches them, not all six. Folded on a
          // phone, laid out in full wherever there is room for it.
          return narrow ? (
            <Card
              as="details"
              key={b.name}
              open={i === 0}
              className={`cv-row group !p-0 ${b.mine ? 'border-brand-400/30' : ''}`}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 marker:hidden [&::-webkit-details-marker]:hidden">
                <h3 className={`text-base font-bold ${b.mine ? 'text-brand-300' : 'text-white'}`}>
                  Choose {b.name} if&hellip;
                </h3>
                <svg
                  width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                  className="shrink-0 text-brand-300 transition-transform group-open:rotate-180"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </summary>
              <div className="border-t border-white/5 px-5 py-4">{points}</div>
            </Card>
          ) : (
            <Card key={b.name} className={b.mine ? 'border-brand-400/30' : ''}>
              <h3 className={`text-base font-bold ${b.mine ? 'text-brand-300' : 'text-white'}`}>
                Choose {b.name} if&hellip;
              </h3>
              <div className="mt-3">{points}</div>
            </Card>
          );
        })}
      </div>

      <div className="surface-panel mx-auto mt-12 max-w-3xl rounded-[var(--radius-3)] px-6 py-6">
        <p className="text-sm font-bold text-white">Still deciding?</p>
        <p className="mt-1 text-xs leading-6 text-slate-400">
          Nexa is free with no card, so the cheapest way to settle it is to run the same download in
          both and time it. Keep whichever wins — we would rather you did that than take our table
          on trust.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button to="/download">Download free</Button>
          <Button to="/benchmarks" variant="ghost">See the benchmarks</Button>
        </div>
      </div>
    </Section>
  );
}
