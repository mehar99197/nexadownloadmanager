import { Link } from 'react-router-dom';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import { FEATURE_NAV } from './features/FeatureShell';

// One line per page saying what the reader gets, so the hub is a map rather
// than a list of nouns.
const DETAIL = {
  '/features/acceleration': 'How a file is split, why segments are stolen mid-transfer, and what happens to a download when the power goes out.',
  '/features/video-grabber': 'Why "save video as" gives you nothing, what a manifest is, and how the page you are watching becomes one MP4.',
  '/features/youtube-sites': 'Why Nexa drives yt-dlp instead of writing its own extractors, and how site fixes reach you: yt-dlp ships inside Nexa and is updated with each Nexa release.',
  '/features/bittorrent': 'A real libtorrent engine in the same queue — and an honest account of where a dedicated client still wins.',
  '/features/browser-extension': 'The local bridge, every permission explained, and installing it while the store listings are still in review.',
  '/features/scheduler': 'Start at 2am, cap the speed of direct downloads, shut the machine down afterwards — and the one thing you should not schedule.',
  '/features/remote-dashboard': 'Your queue on your phone, served by your own machine, behind a token and TLS.',
};

export default function Features() {
  usePageMeta({
    title: 'Features',
    description:
      'In-depth guides to what Nexa Download Manager actually does: segmented acceleration, the HLS/DASH video grabber, YouTube & video sites via yt-dlp, BitTorrent, the browser extension, scheduling and the phone dashboard.',
  });

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />Features</span>
        <h1 className="mt-5 text-white">What it actually <span className="text-gradient">does.</span></h1>
        <p>
          Not a list of adjectives. Each page explains how one feature works, what it supports,
          where it fails, and what to do about it.
        </p>
      </div>

      {/* Wrapped and centred rather than a two-column grid, as the docs hub
          does it: with an odd number of pages the grid left the last card
          stranded in the left column beside an empty cell. */}
      <div className="mt-12 flex flex-wrap justify-center gap-4">
        {FEATURE_NAV.map((f, i) => (
          <Card key={f.to} as={Link} to={f.to} className="group block w-full transition hover:border-brand-400/30 md:w-[calc(50%-0.5rem)]">
            <span className="text-xs font-bold uppercase tracking-[0.18em] text-brand-300">
              {String(i + 1).padStart(2, '0')}
            </span>
            <h2 className="mt-3 text-lg font-bold text-white group-hover:text-brand-100">{f.label}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">{DETAIL[f.to] || f.blurb}</p>
            <span className="mt-4 inline-block text-sm font-semibold text-brand-300">
              Read more &rarr;
            </span>
          </Card>
        ))}
      </div>

      <div className="mt-12 grid gap-4 md:grid-cols-3">
        <Card>
          <h2 className="text-base font-bold text-white">Prefer step-by-step?</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            The docs are task-shaped: install it, wire up the browser, download a course lecture, fix a 403.
          </p>
          <Link to="/docs" className="mt-4 inline-flex items-center py-3 -my-3 text-sm font-semibold text-brand-300">
            Read the docs &rarr;
          </Link>
        </Card>
        <Card>
          <h2 className="text-base font-bold text-white">Want the numbers?</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Measured throughput at 1, 4, 8 and 16 connections against two real hosts, with the
            method, the raw spread, and what we could not measure.
          </p>
          <Link to="/benchmarks" className="mt-4 inline-flex items-center py-3 -my-3 text-sm font-semibold text-brand-300">
            See benchmarks &rarr;
          </Link>
        </Card>
        <Card>
          <h2 className="text-base font-bold text-white">Comparing tools?</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            A side-by-side against IDM, FDM, JDownloader and four more — including where they win.
          </p>
          <Link to="/compare" className="mt-4 inline-flex items-center py-3 -my-3 text-sm font-semibold text-brand-300">
            Compare &rarr;
          </Link>
        </Card>
      </div>

      <div className="surface-panel mx-auto mt-12 max-w-3xl rounded-[var(--radius-3)] px-6 py-6">
        <p className="text-sm font-bold text-white">Try the whole thing free.</p>
        <p className="mt-1 text-xs text-slate-400">
          Free plan, no card, Windows and Linux. Every account gets a 7-day Pro trial.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button to="/download">Download free</Button>
          <Button to="/pricing" variant="ghost">Pricing</Button>
        </div>
      </div>
    </Section>
  );
}
