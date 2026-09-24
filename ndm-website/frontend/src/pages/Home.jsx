import { useEffect, useState } from 'react';
import { lastRead, readPublic } from '../api/reads';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Button from '../components/Button';
import Card from '../components/Card';
import { BrandMark } from '../components/Brand';
import WarpField from '../components/WarpField';
import CountUp from '../components/CountUp';
import StarRating from '../components/StarRating';
import Skeleton, { SkeletonText, useArrival } from '../components/Skeleton';

/** The arrow both primary CTAs carry. Decorative — the label says where it goes. */
function CtaArrow() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

const FEATURES = [
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    ),
    title: 'Segmented acceleration',
    desc: 'Dynamic re-segmentation keeps every connection busy and pulls the maximum speed from your bandwidth.',
  },
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
      </svg>
    ),
    title: 'Universal support',
    desc: 'HTTP, HLS/DASH, YouTube, BitTorrent, and more in one calm queue with one consistent experience.',
  },
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    ),
    title: 'Browser integration',
    desc: 'Send downloads from Chrome, Firefox, Edge, and Brave straight into the fastest queue on your desktop.',
  },
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a10 10 0 1 0 10 10H12V2z" />
        <path d="M12 2a10 10 0 0 1 10 10h-10V2z" />
      </svg>
    ),
    title: 'Real-time control',
    desc: 'Watch speed and progress in the list, with time left in each download’s details window. Pause, resume, reorder, or inspect any transfer instantly.',
  },
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        <path d="M21 3v5h-5" />
      </svg>
    ),
    title: 'Resume where it stopped',
    desc: 'Direct downloads save their progress as they go, so after a reboot or a dropped connection they carry on from there, on any server that supports resuming.',
  },
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22c-4 0-8-3.5-8-10S8 2 12 2s8 3.5 8 10-4 10-8 10z" />
        <path d="M12 6v4l3 2" />
      </svg>
    ),
    title: 'Smart scheduling',
    desc: 'Cap the speed of direct downloads, globally or per download, schedule a start time, and pick how many of them run at once.',
  },
];

const COLS_CLASS = { 1: 'md:grid-cols-1', 2: 'md:grid-cols-2', 3: 'md:grid-cols-3', 4: 'md:grid-cols-4' };

const HOME_REVIEWS = { page: 1, limit: 3 };

// What each answer has to hold to be shown at all. Real numbers only: an
// answer without them hides its tile or section rather than inventing one.
const usableStats = (data) => (data && typeof data === 'object' ? data : null);
const usableRelease = (data) => (data?.version ? data : null);
/**
 * How many approved reviews the homepage waits for before it shows any.
 *
 * Same rule as the tiles — real reviews or no section at all — plus a floor.
 * One review is an anecdote, and as the first social proof a visitor sees it
 * decides the product's score on its own: a single three-star entry put
 * "3.0 out of 5" under the hero. Below the floor every review still appears on
 * /reviews, where it is read as one of a list rather than as the verdict.
 */
const MIN_REVIEWS_ON_HOME = 5;

const usableReviews = (data) =>
  (data?.reviews?.length && Number(data.totalCount) >= MIN_REVIEWS_ON_HOME ? data : null);

const firstVisit = () =>
  lastRead('/stats') === undefined ||
  lastRead('/releases/latest') === undefined ||
  lastRead('/reviews', HOME_REVIEWS) === undefined;

/** The reviews section as it will land: heading block, then three cards. */
function ReviewsOutline() {
  return (
    <Section>
      <div className="mx-auto flex max-w-2xl flex-col items-center text-center" role="status" aria-label="Loading reviews">
        <Skeleton className="h-[1.95rem] w-36 rounded-full" />
        <Skeleton className="mt-5 h-8 w-4/5 max-w-md rounded-lg" />
        <Skeleton className="mt-4 h-4 w-3/5 rounded" />
      </div>
      <div className="mt-10 grid gap-5 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Card key={i} className="!p-6">
            <Skeleton className="h-3.5 w-20 rounded" />
            {['w-full', 'w-full', 'w-3/4'].map((w, j) => (
              <Skeleton key={j} className={`h-3.5 rounded ${w} ${j ? 'mt-3' : 'mt-4'}`} />
            ))}
            <Skeleton className="mt-5 h-3 w-24 rounded" />
          </Card>
        ))}
      </div>
    </Section>
  );
}


export default function Home() {
  usePageMeta({
    title: 'Fast downloads for Windows and Linux',
    description:
      'Nexa Download Manager accelerates HTTP downloads with up to 32 connections per file on Pro (16 on Free) and handles HLS/DASH streams, YouTube via yt-dlp, BitTorrent and cloud links in one queue. Free to start.',
  });

  // A revisit starts from the last answers (api/reads.js), so the numbers and
  // the reviews are there in its first frame; they are asked for again anyway.
  const [stats, setStats] = useState(() => usableStats(lastRead('/stats')));
  const [release, setRelease] = useState(() => usableRelease(lastRead('/releases/latest')));
  const [reviews, setReviews] = useState(() => usableReviews(lastRead('/reviews', HOME_REVIEWS)));
  // Until the first answers are in, what they decide is drawn as its own
  // outline, not left out and slotted in a moment later — the release pill
  // arriving above the headline used to push the whole hero down.
  const [loading, setLoading] = useState(firstVisit);
  const arrive = useArrival(loading);

  // Real numbers only. If a call fails we simply hide what it would have shown.
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      readPublic('/stats'),
      readPublic('/releases/latest'),
      readPublic('/reviews', HOME_REVIEWS),
    ]).then(([s, r, v]) => {
      if (cancelled) return;
      if (s.status === 'fulfilled') setStats(usableStats(s.value));
      if (r.status === 'fulfilled') setRelease(usableRelease(r.value));
      if (v.status === 'fulfilled') setReviews(usableReviews(v.value));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const tiles = [];
  if (stats && Number.isFinite(Number(stats.downloads))) {
    tiles.push({ value: Number(stats.downloads), label: 'downloads served' });
  }
  if (stats && Number.isFinite(Number(stats.users))) {
    tiles.push({ value: Number(stats.users), label: 'registered users' });
  }
  if (release?.version) {
    tiles.push({ value: `v${release.version}`, label: 'latest version' });
  }
  // The Pro ceiling, and labeled as one: Free stops at 16 connections a file.
  tiles.push({ value: '32 on Pro', label: 'connections per file' });
  if (tiles.length < 3) tiles.push({ value: 'Win + Linux', label: 'native desktop app' });

  return (
    <>
      <Section full className="hero-shell !pb-12 !pt-20 md:!pb-20 md:!pt-28">
        <WarpField mode="hero" />
        <div className="container-x relative z-10">
          <div className="grid items-center gap-14 lg:grid-cols-[1.04fr_0.96fr] lg:gap-16">
            <div>
              {/* Always a pill in this slot, so the headline under it never
                  moves: the release once it is known, its outline until then,
                  and a plain fact if there is no release to name. */}
              {loading ? (
                <span className="eyebrow rise rise-1" aria-hidden="true">
                  <span className="eyebrow-dot" />
                  <SkeletonText chars={22} />
                </span>
              ) : release?.version ? (
                <span key="release" className="eyebrow rise rise-1">
                  <span className="eyebrow-dot" />
                  Latest release / v{release.version}
                </span>
              ) : (
                <span key="plain" className="eyebrow rise rise-1">
                  <span className="eyebrow-dot" />
                  Free for Windows and Linux
                </span>
              )}
              <h1 className="rise rise-2 mt-7 max-w-3xl text-5xl font-extrabold leading-[1.02] tracking-[-0.045em] text-white sm:text-6xl lg:text-[4.6rem]">
                The internet, pulled into{' '}
                <span className="text-gradient">one place.</span>
              </h1>
              <p className="rise rise-3 mt-7 max-w-xl text-base leading-8 text-slate-400 sm:text-lg">
                NexaDownloadManager turns every transfer into a fast, focused
                workflow. Videos, streams, torrents, and files, accelerated by
                one intelligent queue.
              </p>
              <div className="rise rise-4 mt-9 flex flex-wrap items-center gap-3">
                <Button to="/download" className="btn-breathe px-7 py-3.5 text-base">
                  Download free
                  <CtaArrow />
                </Button>
                <Button to="/pricing" variant="ghost" className="px-7 py-3.5 text-base">
                  Explore plans
                </Button>
              </div>
              <div className="rise rise-5 mt-7 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs font-medium text-slate-500">
                <span className="inline-flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.9)]" />
                  Free forever plan
                </span>
                <span>Windows / Linux</span>
                <span>No credit card</span>
                <span>Open source</span>
              </div>
            </div>

            <div className="rise rise-3 relative mx-auto w-full max-w-xl lg:ml-auto">
              <div className="absolute -inset-7 rounded-[var(--radius-5)] bg-[radial-gradient(circle,rgba(153,92,244,0.24),transparent_65%)] blur-2xl" />
              {/* An illustration of the app, and labelled as one: a green "Live"
                  chip and "All systems ready" over made-up transfers claimed a
                  state nothing on this page is measuring. */}
              <div className="hero-console">
                <div className="console-bar">
                  <div className="console-dots"><span /><span /><span /></div>
                </div>
                <div className="console-heading">
                  <BrandMark size={48} className="brand-mark-hero" />
                  <div>
                    <p>NexaDownloadManager</p>
                    <p>Unified download queue</p>
                  </div>
                  <span className="ml-auto rounded-full border border-brand-400/25 bg-brand-400/10 px-2.5 py-1 text-xs font-bold uppercase tracking-[0.12em] text-brand-300">Preview</span>
                </div>
                <div className="download-row">
                  <div className="download-row-top"><span>project-setup-x64.exe</span><span>82%</span></div>
                  <div className="progress-track"><span style={{ width: '82%' }} /></div>
                  <div className="download-row-bottom"><span>Windows installer</span><span>18.4 MB/s</span></div>
                </div>
                <div className="download-row">
                  <div className="download-row-top"><span>creative-course.m3u8</span><span>46%</span></div>
                  <div className="progress-track"><span style={{ width: '46%' }} /></div>
                  <div className="download-row-bottom"><span>HLS stream / 1080p</span><span>9.7 MB/s</span></div>
                </div>
                <div className="download-row">
                  <div className="download-row-top"><span>open-source-archive.torrent</span><span>23%</span></div>
                  <div className="progress-track"><span style={{ width: '23%' }} /></div>
                  <div className="download-row-bottom"><span>BitTorrent / 12 peers</span><span>6.2 MB/s</span></div>
                </div>
                <div className="mt-4 flex items-center justify-between px-1 text-xs font-semibold text-slate-500">
                  <span>3 active downloads</span>
                  <span className="text-brand-300">34.3 MB/s total</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Section>

      <Section className="!py-0">
        {loading ? (
          // The strip usually lands with four tiles; its outline has four.
          <div key="waiting" data-stagger className={`stat-strip grid grid-cols-2 ${COLS_CLASS[4]}`} role="status" aria-label="Loading the numbers">
            {[5, 5, 6, 8].map((chars, i) => (
              <div key={i} className="stat-item px-5 py-6 text-center first:border-0 md:px-8 md:py-7">
                <div className="text-2xl font-extrabold tracking-tight md:text-3xl">
                  <SkeletonText chars={chars} />
                </div>
                <div className="mt-1 text-xs font-semibold tracking-wide">
                  <SkeletonText chars={16} />
                </div>
              </div>
            ))}
          </div>
        ) : (
        <div key="ready" data-stagger className={`stat-strip grid grid-cols-2 ${COLS_CLASS[tiles.length] || 'md:grid-cols-4'} ${arrive}`.trim()}>
          {tiles.map((s) => (
            <div key={s.label} className="stat-item px-5 py-6 text-center first:border-0 md:px-8 md:py-7">
              <div className="text-2xl font-extrabold tracking-tight text-white md:text-3xl">
                {typeof s.value === 'number' ? <CountUp value={s.value} /> : s.value}
              </div>
              <div className="mt-1 text-xs font-semibold tracking-wide text-slate-500">{s.label}</div>
            </div>
          ))}
        </div>
        )}
      </Section>

      <Section>
        <div className="page-intro">
          <span className="eyebrow"><span className="eyebrow-dot" />Built for momentum</span>
          <h2 className="mt-5 text-white">One queue. <span className="text-gradient">Everything.</span></h2>
          <p>
            The power of a serious download engine, wrapped in a focused interface
            that stays out of your way.
          </p>
        </div>
        <div data-stagger className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <Card key={feature.title} className="card-hover !p-6">
              <div className="icon-tile">{feature.icon}</div>
              <h3 className="mt-5 text-base font-bold text-white">{feature.title}</h3>
              <p className="mt-2 text-sm leading-7 text-slate-400">{feature.desc}</p>
            </Card>
          ))}
        </div>
      </Section>

      {loading ? (
        <ReviewsOutline />
      ) : reviews && (
        <Section>
          <div className={`mx-auto max-w-2xl text-center ${arrive}`.trim()}>
            <span className="eyebrow"><span className="eyebrow-dot" />What users say</span>
            <h2 className="mt-5 text-2xl font-extrabold tracking-tight text-white sm:text-3xl">
              From people who actually use it.
            </h2>
            {Number(reviews.averageRating) > 0 && (
              <p className="mt-3 text-sm text-slate-400">
                {Number(reviews.averageRating).toFixed(1)} out of 5 from{' '}
                {reviews.totalCount} review{reviews.totalCount !== 1 ? 's' : ''} — every one moderated,
                none of them written by us.
              </p>
            )}
          </div>
          <div className={`mt-10 grid gap-5 md:grid-cols-3 ${arrive}`.trim()}>
            {reviews.reviews.map((r) => (
              <Card key={r.id} className="!p-6">
                <StarRating value={r.rating} readOnly size={14} />
                <p className="mt-3 text-sm leading-7 text-slate-300">“{r.comment}”</p>
                <p className="mt-4 text-xs font-semibold text-slate-400">{r.userName || 'Anonymous'}</p>
              </Card>
            ))}
          </div>
          <div className="mt-8 text-center">
            <Button to="/reviews" variant="ghost">Read all reviews</Button>
          </div>
        </Section>
      )}

      <Section full className="!pt-0">
        <div className="container-x">
          <Card className="relative mx-auto max-w-4xl overflow-hidden !p-8 md:!p-12">
            <div className="absolute -right-24 -top-32 h-80 w-80 rounded-full bg-accent-500/15 blur-3xl" />
            <div className="relative z-10 max-w-2xl">
              <span className="text-xs font-bold tracking-wide text-brand-300">Your bandwidth, your rules</span>
              <h2 className="mt-3 text-2xl font-extrabold tracking-tight text-white sm:text-3xl">Make every download feel instant.</h2>
              <p className="mt-3 text-sm leading-7 text-slate-400">
                Nexa is in beta and free to start. Grab the app, send us what
                breaks, and help shape what ships next.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Button to="/download" className="btn-breathe">
                  Get started
                  <CtaArrow />
                </Button>
                <Button to="/compare" variant="ghost">Compare with IDM</Button>
              </div>
            </div>
          </Card>
        </div>
      </Section>
    </>
  );
}
