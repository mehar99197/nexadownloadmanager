import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { forgetRead, lastRead, readPublic } from '../api/reads';
import usePageMeta from '../hooks/usePageMeta';
import { formatDate } from '../utils/formatDate';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Skeleton, { SkeletonText, useArrival } from '../components/Skeleton';

const API_BASE = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');

const OS_OPTIONS = [
  {
    key: 'windows',
    label: 'Windows',
    format: 'Installer (.exe) · Windows 10 or newer',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
        <path d="M3 12V6.5l8-1.1v6.6H3zm0 1.5h8v6.7l-8-1.1V13.5zm9-8.4L21 3v9h-9V5.1zm0 15.3V12h9v9l-9-1.2z" />
      </svg>
    ),
  },
  {
    key: 'linux',
    label: 'Linux',
    format: 'Debian package (.deb) · Ubuntu 24.04 or newer (x86-64)',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1.41 15.5c-.22.44-.45.87-.47 1.35-.02.47.34 1.09.73 1.5-.3.06-.61.13-.91.15-.56.04-.89-.29-1.06-.74-.17-.45-.13-.96.08-1.38.21-.42.53-.76.86-1.08.29-.29.65-.57.77-.92.06-.18.05-.42-.05-.62s-.33-.28-.57-.33c-.24-.05-.5-.04-.73.02-.23.06-.42.2-.59.35-.33.3-.57.68-.84 1.02-.27.34-.56.66-.69 1.09-.13.42-.1.91.15 1.28.25.37.67.58 1.11.52.24-.03.48-.09.7-.16.22-.07.43-.16.56-.31.14-.15.22-.36.21-.58-.01-.21-.14-.42-.26-.59-.12-.17-.25-.34-.29-.52-.03-.18.02-.4.18-.48.15-.08.32.01.43.13.11.12.18.26.24.41zm3.28-1.51c-.17-.45-.64-.67-1.09-.64-.27.02-.54.07-.81.1-.45.06-.97.09-1.29-.27-.23-.26-.24-.63-.14-.96.1-.32.27-.61.41-.91.14-.3.25-.63.23-1.05-.02-.42-.22-.78-.51-1.05-.49-.46-1.08-.85-1.74-1.13-.27-.12-.55-.23-.79-.04-.22.17-.26.46-.22.71.04.25.13.48.23.71.17.39.44.76.62 1.16.19.4.3.85.21 1.27-.08.36-.3.63-.55.85-.25.22-.52.41-.78.63-.27.22-.55.47-.73.79-.18.32-.23.7-.14 1.04.09.34.3.61.56.81.27.2.6.3.93.3.67.01 1.35-.16 2-.35.41-.12.82-.26 1.18-.08.29.14.47.4.59.7.12.29.19.6.29.89.05.14.13.28.26.36.13.08.33.06.46-.02.13-.08.21-.21.27-.35.16-.37.31-.74.25-1.14-.04-.28-.18-.55-.35-.78-.17-.23-.38-.44-.62-.62.08-.05.16-.1.22-.16.32-.31.53-.75.6-1.22.06-.47-.05-.97-.25-1.38zM12 3.84c.65 0 1.25.14 1.8.38-.21.19-.39.44-.47.73-.08.29-.03.63.14.92.17.29.43.52.73.69.3.17.63.27.97.32.14.02.29.03.43.02.55.04 1.12-.01 1.69.07.28.04.57.1.83.22.25.11.47.28.63.49.05.06.09.13.12.21.05.1.72.17 1.05.25.19.1.36.25.48.43.13.17.21.38.24.6.03.22.01.46-.05.67-.06.21-.17.41-.32.57-.14.16-.32.28-.52.34s-.42.06-.64.02l-.2-.03c-.22-.05-.41-.17-.54-.34-.13-.17-.19-.39-.17-.6.02-.22.1-.42.23-.59.03-.04.06-.07.11-.11l.06-.06c.14-.27.15-.58.02-.85-.13-.27-.39-.47-.69-.53-.3-.06-.65-.02-.97.11-.32.13-.61.33-.85.58-.24.25-.42.56-.53.89l-.02.01c-.43.4-.78.88-1.03 1.42-.25.54-.39 1.13-.4 1.73-.01.6.1 1.21.32 1.76.22.55.55 1.06.96 1.47.42.42.92.74 1.47.95.55.21 1.15.31 1.73.3h.03c.58-.01 1.14-.12 1.64-.35.5-.22.94-.55 1.28-.96.34-.42.57-.92.67-1.45.1-.53.07-1.09-.1-1.61-.07-.22-.2-.42-.37-.59-.17-.16-.38-.28-.6-.35s-.47-.07-.7-.02c-.23.05-.44.15-.61.3s-.29.34-.35.53c-.1.34-.22.68-.36 1.01-.14.33-.3.66-.52.95-.21.29-.47.55-.77.76z" />
      </svg>
    ),
  },
];

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

// The packaged extension, served as static files under /downloads/ (the deploy
// script builds them from extension-chromium/ and extension-firefox/). Until the
// store listings are approved this is the only way to get it, so every card
// offers the file itself first and the install guide second.
const BROWSERS = [
  { key: 'chrome', label: 'Chrome', note: 'Also works in Brave and Chromium', file: 'nexa-chrome.zip', guide: '/docs/extension#chromium' },
  { key: 'edge', label: 'Edge', note: 'Microsoft Edge (Chromium)', file: 'nexa-edge.zip', guide: '/docs/extension#chromium' },
  { key: 'firefox', label: 'Firefox', note: 'Firefox 115 or newer. Until the Add-ons listing is live it loads as a temporary add-on, which Firefox removes when it restarts.', file: 'nexa-firefox.zip', guide: '/docs/extension#firefox' },
];

function Sha256({ value }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard blocked — the full hash is still selectable below
    }
  };

  return (
    <div className="mt-4 text-left">
      <p className="text-xs font-bold uppercase tracking-[0.13em] text-slate-500">SHA-256</p>
      {/* items-stretch: the code box grows to the button's 44px rather than
          the button shrinking to the code's line. */}
      <div className="mt-1.5 flex items-stretch gap-2">
        <code
          className="surface-inset flex min-w-0 flex-1 items-center truncate rounded-lg px-2.5 py-1.5 font-mono text-[0.7rem] text-brand-100"
          title={value}
        >
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          className="min-h-11 shrink-0 rounded-lg border border-[rgba(99,126,187,0.42)] px-3.5 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-accent-400 hover:text-white"
          aria-label="Copy SHA-256 checksum"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export default function Download() {
  usePageMeta({
    title: 'Download',
    description:
      'Download Nexa Download Manager for Windows (installer) or Ubuntu 24.04+ (.deb), plus the browser extension for Chrome, Edge, Brave and Firefox. Free to start, SHA-256 checksums included.',
  });

  // A revisit starts from the last answer (api/reads.js) and asks again
  // underneath, so it draws the real cards in its first frame.
  const [release, setRelease] = useState(() => lastRead('/releases/latest') ?? null);
  const [loading, setLoading] = useState(() => lastRead('/releases/latest') === undefined);
  const [error, setError] = useState('');
  const [os, setOs] = useState('');
  const arrive = useArrival(loading);

  useEffect(() => {
    let cancelled = false;
    readPublic('/releases/latest')
      .then((data) => {
        if (!cancelled) setRelease(data || null);
      })
      .catch((err) => {
        if (cancelled) return;
        // 404 = nothing published yet, which is a valid (empty) state, not an
        // error — and it overrides whatever an earlier visit was told.
        if (err?.response?.status === 404) {
          forgetRead('/releases/latest');
          setRelease(null);
        } else if (lastRead('/releases/latest') === undefined) {
          // With an earlier answer on screen, a failed refresh changes nothing.
          setError('Failed to load download links.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!os) {
      const ua = navigator.userAgent;
      // Android's user agent starts "Mozilla/5.0 (Linux; Android ...)", so a
      // plain includes('Linux') matched every phone and pre-selected the .deb
      // as their primary CTA — "Download for Linux", on a handset. Rule the
      // handhelds out first and let them land where macOS and iOS already do:
      // nothing pre-selected, both cards offered plainly.
      if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return;
      if (ua.includes('Win')) setOs('windows');
      else if (ua.includes('Linux')) setOs('linux');
    }
  }, [os]);

  const hasRelease = Boolean(release?.version);
  const publishedAt = release?.publishedAt ? new Date(release.publishedAt) : null;

  return (
    <Section className="relative overflow-hidden">
      <div className="page-intro">
        <span className="eyebrow">
          <span className="eyebrow-dot" />
          {/* "Version not published yet" used to be what this said while the
              release was still loading — a wrong answer for a quarter of a
              second on every visit. */}
          {loading ? (
            <SkeletonText chars={22} />
          ) : (
            <span className={arrive}>
              {hasRelease ? `Latest release / v${release.version}` : 'Version not published yet'}
            </span>
          )}
        </span>
        <h1 className="mt-5 text-white">Get the <span className="text-gradient">full-speed</span> experience.</h1>
        <p>
          Choose your platform and bring NexaDownloadManager to the desktop.
          Fast by default, free to start, and ready for every kind of transfer.
        </p>
      </div>

      {/* Only what the release decides waits for it — the version line, the
          buttons and the checksums. The cards, the extension section and the
          notes around them are the same whatever it says, so they are drawn
          at once instead of a spinner standing in for the whole page. */}
      {loading && <p role="status" className="sr-only">Loading the latest release…</p>}
      {error ? (
        <div className="mt-10 text-center">
          <p className="text-red-300">{error}</p>
        </div>
      ) : (
        <>
          {!loading && !hasRelease && (
            <div className="mx-auto mt-10 max-w-xl rounded-xl border border-brand-400/25 bg-brand-400/10 px-4 py-3 text-center text-sm text-brand-100">
              No build has been published yet. Watch the{' '}
              <Link to="/changelog" className="font-semibold underline">changelog</Link>, or{' '}
              <Link to="/contact" className="font-semibold underline">ask us to tell you</Link> when it lands.
            </div>
          )}

          <div data-stagger className="mx-auto mt-12 grid max-w-5xl gap-5 md:grid-cols-3">
            {OS_OPTIONS.map(({ key, label, format, icon }) => {
              // An installer is downloadable when the admin UPLOADED it (hasWindowsFile)
              // or, for releases published before uploads existed, linked it.
              const available = hasRelease && Boolean(
                key === 'windows'
                  ? release?.hasWindowsFile || release?.windowsUrl
                  : release?.hasLinuxFile || release?.linuxUrl,
              );
              const sha = key === 'windows' ? release?.windowsSha256 : release?.linuxSha256;
              const size = formatBytes(key === 'windows' ? release?.windowsSize : release?.linuxSize);
              const href = `${API_BASE}/releases/download/${key}`;

              return (
                <Card key={key} className="card-hover flex flex-col text-center !p-7">
                  <div className="icon-tile mx-auto">{icon}</div>
                  <h3 className="mt-5 text-lg font-bold text-white">{label}</h3>
                  <p className="mt-2 text-xs font-medium tracking-wide text-slate-500">
                    {loading ? (
                      <SkeletonText chars={13} />
                    ) : (
                      <span className={arrive}>
                        {hasRelease ? `Version ${release.version}` : 'Version not published yet'}
                      </span>
                    )}
                  </p>
                  <p className="mt-2 text-xs text-slate-400">{format}</p>
                  <div className={loading ? 'mt-5' : `mt-5 ${arrive}`.trim()} key={loading ? 'waiting' : 'ready'}>
                    {loading ? (
                      <Skeleton className="h-11 w-full rounded-[var(--radius-2)]" />
                    ) : available ? (
                      <Button
                        href={href}
                        className="w-full"
                        variant={key === os ? 'primary' : 'ghost'}
                        rel="nofollow"
                      >
                        {key === os ? `Download for ${label}` : 'Download'}
                        {size && <span className="opacity-75">· {size}</span>}
                      </Button>
                    ) : (
                      <Button className="w-full" variant="ghost" disabled>
                        Not available yet
                      </Button>
                    )}
                  </div>
                  {loading ? (
                    // The checksum block's own shape: label, then a 44px row.
                    <div className="mt-4">
                      <Skeleton className="h-4 w-16 rounded" />
                      <Skeleton className="mt-1.5 h-11 w-full rounded-lg" />
                    </div>
                  ) : (
                    available && sha && (
                      <div className={arrive}>
                        <Sha256 value={sha} />
                      </div>
                    )
                  )}
                </Card>
              );
            })}

            <Card className="card-hover flex flex-col text-center !p-7">
              <div className="icon-tile mx-auto">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M16.37 12.6c-.02-2.1 1.72-3.11 1.8-3.16-.98-1.43-2.5-1.63-3.05-1.65-1.3-.13-2.53.76-3.19.76-.66 0-1.67-.74-2.75-.72-1.41.02-2.72.82-3.45 2.09-1.47 2.55-.38 6.33 1.06 8.4.7 1.01 1.53 2.15 2.62 2.11 1.05-.04 1.45-.68 2.72-.68s1.63.68 2.75.66c1.13-.02 1.85-1.03 2.54-2.05.8-1.17 1.13-2.31 1.15-2.37-.03-.01-2.2-.85-2.2-3.39zM14.28 6.4c.58-.7.97-1.68.86-2.65-.83.03-1.85.56-2.44 1.26-.54.62-1.01 1.62-.88 2.57.93.07 1.88-.47 2.46-1.18z" />
                </svg>
              </div>
              <h3 className="mt-5 text-lg font-bold text-white">macOS</h3>
              <p className="mt-2 text-xs font-medium tracking-wide text-slate-500">Coming later</p>
              <p className="mt-2 text-xs text-slate-400">
                The Qt codebase builds on macOS, but we haven&apos;t shipped a signed build yet.
              </p>
              <div className="mt-5">
                <Button to="/contact?topic=macos" className="w-full" variant="ghost">
                  Get notified
                </Button>
              </div>
            </Card>
          </div>

          <div className="mx-auto mt-14 max-w-5xl">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <span className="text-xs font-bold tracking-wide text-brand-300">Browser extension</span>
                <h2 className="mt-2 text-2xl font-extrabold tracking-tight text-white">Send downloads from your browser.</h2>
                <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-400">
                  The extension puts a &ldquo;Download with NDM&rdquo; button on video
                  players and &ldquo;Download with Nexa&rdquo; in the right-click menu,
                  sniffs HLS/DASH streams, and hands cookies to the app running on your
                  machine. Store listings aren&apos;t live yet, so download the packaged
                  zip and load it unpacked &mdash; the guide takes two minutes. Firefox
                  loads it as a temporary add-on, which it removes when it restarts.
                </p>
              </div>
              <Link to="/docs/extension" className="text-sm font-semibold text-brand-300 hover:text-brand-200">
                Full extension guide &rarr;
              </Link>
            </div>
            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              {BROWSERS.map((b) => (
                <Card key={b.key} className="card-hover !p-5">
                  <h3 className="text-base font-bold text-white">{b.label}</h3>
                  <p className="mt-1 text-xs text-slate-400">{b.note}</p>
                  <div className="mt-4 flex flex-col gap-2">
                    <Button href={`/downloads/${b.file}`} download={b.file} className="w-full">
                      Download {b.file}
                    </Button>
                    <Button to={b.guide} variant="ghost" className="w-full">
                      Install guide
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          </div>

          {hasRelease && release?.changelog && (
            <Card className="mx-auto mt-14 max-w-5xl !p-7">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h3 className="text-lg font-bold text-white">
                    What&apos;s new in v{release.version}
                  </h3>
                  {publishedAt && !Number.isNaN(publishedAt.getTime()) && (
                    <p className="mt-1 text-xs text-slate-500">
                      Published {formatDate(publishedAt)}
                    </p>
                  )}
                </div>
                <Link to="/changelog" className="rounded-full border border-brand-400/25 bg-brand-400/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.12em] text-brand-300 hover:text-white">
                  Release notes
                </Link>
              </div>
              <p className="mt-4 whitespace-pre-wrap border-t border-white/10 pt-4 text-sm leading-relaxed text-slate-400">
                {release.changelog}
              </p>
            </Card>
          )}

          <p className="mx-auto mt-10 max-w-2xl text-center text-xs leading-6 text-slate-500">
            Installers bundle yt-dlp and ffmpeg. For YouTube, also install a JavaScript
            runtime (Deno, Node.js or Bun): without one, yt-dlp misses many formats,
            especially 1080p and above.
            See the <Link to="/docs/install" className="text-slate-300 hover:text-brand-300">install guide</Link> for
            details, or verify a download by comparing its SHA-256 with the value shown above.
          </p>
        </>
      )}
    </Section>
  );
}
