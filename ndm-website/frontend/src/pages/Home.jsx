import Section from '../components/Section';
import Button from '../components/Button';
import Card from '../components/Card';
import { BrandMark } from '../components/Brand';

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
    desc: 'Watch speed, progress, and ETA at a glance. Pause, resume, reorder, or inspect any transfer instantly.',
  },
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        <path d="M21 3v5h-5" />
      </svg>
    ),
    title: 'Resume anywhere',
    desc: 'Progress is persisted locally, so a reboot or a bad connection never means starting over again.',
  },
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22c-4 0-8-3.5-8-10S8 2 12 2s8 3.5 8 10-4 10-8 10z" />
        <path d="M12 6v4l3 2" />
      </svg>
    ),
    title: 'Smart scheduling',
    desc: 'Set speed limits, schedule quiet hours, and configure concurrency around the way you actually work.',
  },
];

const STATS = [
  { value: '1,000+', label: 'supported sites' },
  { value: '10x', label: 'faster transfers' },
  { value: '50K+', label: 'active users' },
  { value: '99.9%', label: 'reliability' },
];

export default function Home() {
  return (
    <>
      <Section full className="hero-shell !pb-12 !pt-20 md:!pb-20 md:!pt-28">
        <div className="container-x relative z-10">
          <div className="grid items-center gap-14 lg:grid-cols-[1.04fr_0.96fr] lg:gap-16">
            <div>
              <span className="eyebrow">
                <span className="eyebrow-dot" />
                Nexa engine online / v2.1
              </span>
              <h1 className="mt-7 max-w-3xl text-5xl font-extrabold leading-[0.98] tracking-[-0.065em] text-white sm:text-6xl lg:text-[5.2rem]">
                Download without the{' '}
                <span className="text-gradient">waiting.</span>
              </h1>
              <p className="mt-7 max-w-xl text-base leading-8 text-slate-400 sm:text-lg">
                NexaDownloadManager turns every transfer into a fast, focused
                workflow. Videos, streams, torrents, and files, accelerated by
                one intelligent queue.
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                <Button to="/download" className="px-7 py-3.5 text-base">
                  Download free
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </Button>
                <Button to="/pricing" variant="ghost" className="px-7 py-3.5 text-base">
                  Explore plans
                </Button>
              </div>
              <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs font-medium text-slate-500">
                <span className="inline-flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.9)]" />
                  Free forever plan
                </span>
                <span>Windows / Linux</span>
                <span>No credit card</span>
              </div>
            </div>

            <div className="relative mx-auto w-full max-w-xl lg:ml-auto">
              <div className="absolute -inset-7 rounded-[2rem] bg-[radial-gradient(circle,rgba(153,92,244,0.24),transparent_65%)] blur-2xl" />
              <div className="hero-console">
                <div className="console-bar">
                  <div className="console-dots"><span /><span /><span /></div>
                  <span className="console-status">All systems ready</span>
                </div>
                <div className="console-heading">
                  <BrandMark size={42} />
                  <div>
                    <p>NexaDownloadManager</p>
                    <p>Unified download queue</p>
                  </div>
                  <span className="ml-auto rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-1 text-[0.6rem] font-bold uppercase tracking-[0.12em] text-emerald-300">Live</span>
                </div>
                <div className="download-row">
                  <div className="download-row-top"><span>nexa-launcher-0.1.0.exe</span><span>82%</span></div>
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
                <div className="mt-4 flex items-center justify-between px-1 text-[0.65rem] font-semibold text-slate-500">
                  <span>3 active downloads</span>
                  <span className="text-brand-300">34.3 MB/s total</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Section>

      <Section className="!py-0">
        <div className="stat-strip grid grid-cols-2 md:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.label} className="stat-item px-5 py-6 text-center first:border-0 md:px-8 md:py-7">
              <div className="text-2xl font-extrabold tracking-tight text-white md:text-3xl">{s.value}</div>
              <div className="mt-1 text-[0.68rem] font-bold uppercase tracking-[0.13em] text-slate-500">{s.label}</div>
            </div>
          ))}
        </div>
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
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <Card key={feature.title} className="card-hover !p-6">
              <div className="icon-tile">{feature.icon}</div>
              <h3 className="mt-5 text-base font-bold text-white">{feature.title}</h3>
              <p className="mt-2 text-sm leading-7 text-slate-400">{feature.desc}</p>
            </Card>
          ))}
        </div>
      </Section>

      <Section full className="!pt-0">
        <div className="container-x">
          <Card className="relative overflow-hidden !p-8 md:!p-12">
            <div className="absolute -right-24 -top-32 h-80 w-80 rounded-full bg-accent-500/15 blur-3xl" />
            <div className="relative z-10 grid items-center gap-8 md:grid-cols-[1fr_auto]">
              <div>
                <span className="text-xs font-bold uppercase tracking-[0.18em] text-brand-300">Your bandwidth, your rules</span>
                <h2 className="mt-3 text-2xl font-extrabold tracking-tight text-white sm:text-3xl">Make every download feel instant.</h2>
                <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-400">
                  Join thousands of people using NexaDownloadManager to move
                  their files faster, with less friction and more control.
                </p>
              </div>
              <div className="flex flex-wrap gap-3 md:justify-end">
                <Button to="/download">Get started</Button>
                <Button to="/reviews" variant="ghost">See user stories</Button>
              </div>
            </div>
          </Card>
        </div>
      </Section>
    </>
  );
}
