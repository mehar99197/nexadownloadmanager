import { Link } from 'react-router-dom';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';

// Cell values: true / false / 'partial' / 'coming' / any string (rendered as text).
const PRODUCTS = ['Nexa', 'IDM', 'FDM', 'JDownloader'];

const ROWS = [
  { label: 'Windows', values: [true, true, true, true] },
  { label: 'Linux', values: [true, false, true, true] },
  { label: 'macOS', values: ['coming', false, true, true] },
  {
    label: 'Price',
    values: ['Free (ad-supported) · Pro $5/mo', 'Paid license', 'Free', 'Free (ad-supported installer)'],
  },
  {
    label: 'Ads',
    values: ['In-app promo on Free only', false, false, 'Bundled offers in the installer'],
    note: 'Nexa shows one promo strip inside the app on the Free plan; Pro and Team are ad-free. Nothing is ever bundled into the installer.',
  },
  { label: 'Multi-connection HTTP', values: ['Up to 16 per file', true, true, true] },
  { label: 'Browser extension', values: ['Chrome · Edge · Brave · Firefox', true, true, true] },
  { label: 'Video grabber (HLS/DASH)', values: [true, true, 'partial', true] },
  {
    label: 'YouTube & 1000+ sites via yt-dlp',
    values: [true, 'partial', 'partial', 'partial'],
    note: 'Only Nexa runs yt-dlp; the others use their own site plugins, which cover fewer sites and break differently.',
  },
  { label: 'BitTorrent', values: [true, false, true, false] },
  { label: 'Cloud links (Google Drive, Mega)', values: [true, 'partial', false, true] },
  { label: 'Remote phone dashboard', values: [true, false, true, true] },
  { label: 'AI rename', values: ['Optional, your own API key', false, false, false] },
  {
    label: 'Open bridge / native messaging',
    values: [true, false, false, 'partial'],
    note: 'Nexa’s browser bridge and app are open source, so you can read what happens to your cookies.',
  },
  { label: 'Scheduler', values: [true, true, true, 'partial'] },
  { label: 'Open source', values: [true, false, false, 'partial'] },
];

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
    return (
      <span className="text-slate-600" aria-label="No">
        —
      </span>
    );
  }
  if (value === 'partial') {
    return <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-amber-300">Partial</span>;
  }
  if (value === 'coming') {
    return <span className="rounded-full border border-brand-400/25 bg-brand-400/10 px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-brand-300">Coming</span>;
  }
  return <span className="text-slate-300">{value}</span>;
}

export default function Compare() {
  usePageMeta({
    title: 'Compare',
    description:
      'Nexa Download Manager vs IDM vs Free Download Manager vs JDownloader: platforms, price, multi-connection HTTP, HLS/DASH, YouTube via yt-dlp, BitTorrent, cloud links, remote dashboard and more.',
  });

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />Side by side</span>
        <h1 className="mt-5 text-white">Nexa vs <span className="text-gradient">the usual suspects.</span></h1>
        <p>
          An honest feature matrix against Internet Download Manager, Free Download Manager and
          JDownloader. Nexa is in beta — some things they do better, and we say so.
        </p>
      </div>

      <div className="note-warn mx-auto mt-6 max-w-3xl rounded-xl px-4 py-3 text-center text-sm">
        Nexa is beta software. IDM, FDM and JDownloader have years of polish; expect rough edges
        here and <Link to="/contact?topic=bug" className="font-semibold underline">tell us</Link> when you hit one.
      </div>

      <Card className="mt-10 overflow-hidden !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="surface-inset !border-x-0 !border-t-0 border-b border-white/10">
                <th className="px-5 py-4 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Feature</th>
                {PRODUCTS.map((p, i) => (
                  <th
                    key={p}
                    className={`px-5 py-4 text-xs font-bold uppercase tracking-[0.14em] ${i === 0 ? 'text-brand-300' : 'text-slate-400'}`}
                  >
                    {p}
                    {i === 0 && <span className="ml-2 rounded-full border border-brand-400/25 bg-brand-400/10 px-1.5 py-0.5 text-[0.55rem] text-brand-300">beta</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.label} className="border-b border-white/5 align-top last:border-0">
                  <td className="px-5 py-3.5">
                    <span className="font-semibold text-slate-200">{row.label}</span>
                    {row.note && <p className="mt-1 max-w-xs text-xs leading-5 text-slate-500">{row.note}</p>}
                  </td>
                  {row.values.map((v, i) => (
                    <td key={i} className={`px-5 py-3.5 ${i === 0 ? 'bg-brand-500/[0.04]' : ''}`}>
                      <Cell value={v} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="mx-auto mt-5 max-w-3xl text-center text-xs leading-6 text-slate-500">
        Based on publicly documented features as of {new Date().getFullYear()}. &ldquo;Partial&rdquo; means the
        feature exists but with notable limits (fewer sites, a separate app, or a paid add-on). If
        we got something wrong about another product, <Link to="/contact" className="text-slate-300 hover:text-brand-300">let us know</Link> and we will fix it.
      </p>

      <div className="surface-panel mx-auto mt-10 flex max-w-3xl flex-wrap items-center justify-between gap-4 rounded-xl px-6 py-5">
        <div>
          <p className="text-sm font-bold text-white">Try it on your own downloads.</p>
          <p className="mt-1 text-xs text-slate-400">Free plan, no card, Windows and Linux.</p>
        </div>
        <div className="flex gap-3">
          <Button to="/download">Download free</Button>
          <Button to="/pricing" variant="ghost">Pricing</Button>
        </div>
      </div>
    </Section>
  );
}
