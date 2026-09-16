import { useState } from 'react';
import { Link } from 'react-router-dom';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';

/* ------------------------------------------------------------------ *
 *  Video tutorials.
 *
 *  None of these are recorded yet, and the page says so on every card rather
 *  than showing a play button that does nothing. Each entry links to the
 *  written guide covering the same ground, so the page is useful today instead
 *  of being a promise.
 *
 *  PRODUCTION NOTES (for whoever records these — deliberately not rendered):
 *    - Under 5 minutes each; most of these should be under 3.
 *    - Record the real UI at 1920×1080, zoom into the control being discussed.
 *      Never slides.
 *    - Voice narration, and always burn in captions — a large share of viewers
 *      watch muted.
 *    - Publish unlisted on YouTube and embed, or self-host MP4 + WebVTT. Either
 *      way a transcript goes under the player: it is what makes the page rank
 *      and what makes it usable without sound.
 *    - Show the finished result at the end. "It worked" is the payoff.
 *
 *  TO PUBLISH ONE: set `videoId` (or `src`) and `transcript` on its entry and
 *  drop the `ready: false`. The card switches to a player by itself.
 * ------------------------------------------------------------------ */

const CATEGORIES = [
  {
    id: 'start',
    label: 'Getting started',
    blurb: 'From download to your first finished file.',
    videos: [
      { title: 'Installing Nexa on Windows', mins: 2, level: 'Beginner', guide: '/docs/install' },
      { title: 'Installing Nexa on Linux', mins: 3, level: 'Beginner', guide: '/docs/install' },
      { title: 'Your first download, start to finish', mins: 2, level: 'Beginner', guide: '/docs' },
    ],
  },
  {
    id: 'extension',
    label: 'Browser extension',
    blurb: 'The bridge between your browser and the app.',
    videos: [
      { title: 'Installing the Chrome extension', mins: 1, level: 'Beginner', guide: '/docs/extension' },
      { title: 'Installing the Firefox extension', mins: 1, level: 'Beginner', guide: '/docs/extension' },
      { title: 'How video detection works', mins: 2, level: 'Beginner', guide: '/features/video-grabber' },
      { title: 'Downloading from sites you are signed in to', mins: 3, level: 'Intermediate', guide: '/docs/courses' },
    ],
  },
  {
    id: 'types',
    label: 'Download types',
    blurb: 'Videos, playlists, streams, torrents and cloud links.',
    videos: [
      { title: 'Downloading a YouTube video', mins: 3, level: 'Beginner', guide: '/features/youtube-sites' },
      { title: 'Downloading a whole YouTube playlist', mins: 4, level: 'Intermediate', guide: '/docs/youtube' },
      { title: 'Downloading HLS and DASH streams', mins: 3, level: 'Intermediate', guide: '/features/video-grabber' },
      { title: 'Torrents and magnet links', mins: 4, level: 'Intermediate', guide: '/features/bittorrent' },
      { title: 'Downloading from Google Drive', mins: 2, level: 'Beginner', guide: '/docs' },
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    blurb: 'The parts people discover six months in.',
    videos: [
      { title: 'Setting up the remote dashboard', mins: 4, level: 'Advanced', guide: '/features/remote-dashboard' },
      { title: 'Scheduling downloads for overnight', mins: 3, level: 'Intermediate', guide: '/features/scheduler' },
      { title: 'Speed limits that keep your calls smooth', mins: 2, level: 'Beginner', guide: '/features/scheduler' },
      { title: 'Categories: sorting downloads automatically', mins: 3, level: 'Intermediate', guide: '/features' },
      { title: 'AI rename', mins: 3, level: 'Intermediate', guide: '/pricing' },
    ],
  },
  {
    id: 'fixing',
    label: 'Troubleshooting',
    blurb: 'The three things that actually go wrong.',
    videos: [
      { title: 'Fixing YouTube 403 errors', mins: 2, level: 'Intermediate', guide: '/docs/youtube' },
      { title: 'The extension is not detecting videos', mins: 2, level: 'Beginner', guide: '/docs/extension' },
      { title: '“Engine unavailable” and downloads that never start', mins: 3, level: 'Beginner', guide: '/docs/extension' },
    ],
  },
];

const LEVEL_STYLE = {
  Beginner: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  Intermediate: 'border-brand-400/25 bg-brand-400/10 text-brand-300',
  Advanced: 'border-accent-400/25 bg-accent-400/10 text-accent-300',
};

function VideoCard({ video }) {
  return (
    <Card className="!p-0 overflow-hidden">
      {/* The thumbnail slot. A dashed placeholder rather than a grey box with a
          play triangle: a play button that does nothing is worse than an honest
          gap, and this one cannot be mistaken for a working video. */}
      <div className="flex aspect-video flex-col items-center justify-center border-b border-dashed border-amber-400/25 bg-amber-400/[0.05] px-4 text-center">
        <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-amber-300">
          Video to be created
        </span>
        <p className="mt-2 text-xs text-slate-500">≈ {video.mins} min when recorded</p>
      </div>
      <div className="p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full border px-2 py-0.5 text-xs font-bold ${LEVEL_STYLE[video.level]}`}>
            {video.level}
          </span>
          <span className="text-xs text-slate-500">{video.mins} min</span>
        </div>
        <h3 className="mt-3 text-sm font-bold leading-6 text-white">{video.title}</h3>
        <Link
          to={video.guide}
          className="mt-3 inline-block text-xs font-semibold text-brand-300 hover:underline"
        >
          Read the written guide instead &rarr;
        </Link>
      </div>
    </Card>
  );
}

export default function Tutorials() {
  usePageMeta({
    title: 'Tutorials',
    description:
      'Short video guides for Nexa Download Manager — installing, the browser extension, YouTube and playlists, torrents, scheduling and the remote dashboard. Written guides are available for every topic today.',
  });

  const [active, setActive] = useState(CATEGORIES[0].id);
  const current = CATEGORIES.find((c) => c.id === active) || CATEGORIES[0];
  const total = CATEGORIES.reduce((n, c) => n + c.videos.length, 0);

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />Tutorials</span>
        <h1 className="mt-5 text-white">Learn Nexa in <span className="text-gradient">minutes.</span></h1>
        <p>Short, focused guides for every feature — one task per video, none of them longer than five minutes.</p>
      </div>

      <div className="note-warn mx-auto mt-6 max-w-3xl rounded-xl px-5 py-4 text-sm leading-6">
        <p className="font-bold">The videos are not recorded yet.</p>
        <p className="mt-1">
          All {total} are planned and listed below so you can see what is coming — and every one of
          them already has a written guide that covers the same ground, linked on its card. We would
          rather show you the plan than an empty page.{' '}
          <Link to="/contact" className="font-semibold underline">Tell us which to record first</Link>{' '}
          and it moves up the list.
        </p>
      </div>

      {/* Tabs rather than an accordion: five categories fit on one row and a
          reader can see the whole shape of the library at once. */}
      <div className="mt-10 flex flex-wrap gap-2" role="tablist" aria-label="Tutorial categories">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            id={`tab-${c.id}`}
            aria-selected={active === c.id}
            aria-controls={`panel-${c.id}`}
            onClick={() => setActive(c.id)}
            className={`rounded-[var(--radius-pill)] px-4 py-2 text-sm font-semibold transition ${
              active === c.id
                ? 'on-brand'
                : 'surface-panel text-slate-400 hover:text-white'
            }`}
          >
            {c.label}
            <span className="ml-2 text-xs opacity-70">{c.videos.length}</span>
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`panel-${current.id}`}
        aria-labelledby={`tab-${current.id}`}
        className="mt-8"
      >
        <p className="text-sm text-slate-400">{current.blurb}</p>
        <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {current.videos.map((v) => (
            <VideoCard key={v.title} video={v} />
          ))}
        </div>
      </div>

      <div className="surface-panel mx-auto mt-12 max-w-3xl rounded-[var(--radius-3)] px-6 py-6">
        <p className="text-sm font-bold text-white">Prefer to read?</p>
        <p className="mt-1 text-xs text-slate-400">
          Every topic above exists as a written guide today, with screenshots and copy-paste commands.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button to="/docs">Read the docs</Button>
          <Button to="/features" variant="ghost">Feature guides</Button>
        </div>
      </div>
    </Section>
  );
}
