import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';

/* ------------------------------------------------------------------ *
 *  Everything on this page was measured. Nothing here is illustrative.
 *
 *  Run on 2026-09-16 with the harness described in METHOD: 24 MiB of the same
 *  file fetched at 1, 4, 8 and 16 concurrent HTTP range requests, three
 *  repetitions interleaved so that a slow minute hit every configuration
 *  equally. The tables report the median of the three, and the per-run spread
 *  is printed beside it rather than hidden, because on this connection the
 *  spread is large enough to matter.
 *
 *  Two things are deliberately absent:
 *    - IDM. It is not installed on the test machine and we will not publish a
 *      number for software we did not run.
 *    - A third host (GitHub's release CDN). Two of its three repetitions failed
 *      with DNS errors and timeouts, so its median rests on a single sample.
 *      A 13x speedup from one run is not a result.
 * ------------------------------------------------------------------ */
const MEASURED_ON = '16 September 2026';

const METHOD = [
  ['Machine', 'Windows 10 (19045), 8-core CPU, NVMe SSD'],
  ['Connection', 'Home fibre in Pakistan. Highly variable — see the caveat below'],
  ['Payload', '24 MiB of the same file per run, requested as HTTP byte ranges'],
  ['Repetitions', 'Three per configuration, interleaved rather than run back to back'],
  ['Reported', 'Median of the three; the full spread is shown beside it'],
  ['Discarded', 'Any run that did not transfer all 24 MiB'],
  ['Harness', 'Node 22, plain https.get, no download manager — isolates the network effect'],
  ['App under test', 'Nexa 0.3.0, measured separately end to end through its own dashboard API'],
];

/* Median MiB/s by concurrent connections. Both hosts completed 3/3 runs at
   every setting. */
const HOSTS = [
  {
    id: 'nodejs',
    label: 'nodejs.org',
    sub: 'Cloudflare CDN',
    byConn: { 1: 2.644, 4: 4.841, 8: 5.688, 16: 8.092 },
    secs: { 1: 9.08, 4: 4.96, 8: 4.22, 16: 2.97 },
    best: 16,
  },
  {
    id: 'blender',
    label: 'download.blender.org',
    sub: 'origin server, no CDN',
    byConn: { 1: 2.831, 4: 4.698, 8: 7.657, 16: 6.976 },
    secs: { 1: 8.48, 4: 5.11, 8: 3.13, 16: 3.44 },
    best: 8,
  },
];

const COUNTS = [1, 4, 8, 16];

/* The app itself, on a 34 MB file from nodejs.org, which Nexa splits into 16
   segments. Includes everything the range harness leaves out: probing, writing
   to disk, the queue, the UI. The three runs are printed because the spread is
   the honest headline. */
const NEXA_RUNS = [
  { rep: 1, secs: 17.72, mibs: 1.840 },
  { rep: 2, secs: 9.70, mibs: 3.361 },
  { rep: 3, secs: 7.69, mibs: 4.242 },
];
const NEXA_MEDIAN = 3.361;

const PALETTE = {
  dark: ['#3196cc', '#bd8622'],
  light: ['#1d7fb5', '#a06d14'],
};

/** Follows the site's `:root[data-theme='light']` switch without touching CSS. */
function useThemeMode() {
  const [mode, setMode] = useState(
    () => (typeof document !== 'undefined'
      && document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'),
  );
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setMode(root.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
    read();
    const obs = new MutationObserver(read);
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return mode;
}

const W = 720;
const H = 300;
const PAD = { top: 18, right: 16, bottom: 46, left: 48 };

/**
 * Throughput by connection count, two hosts side by side.
 *
 * Bars rather than a line: the x axis is four discrete configurations someone
 * chooses between, not a continuum being sampled. Grouped rather than stacked,
 * because these are alternatives and never sum to anything.
 */
function ThroughputChart({ colors }) {
  const [hover, setHover] = useState(null);   // { host, n }
  const maxY = 9;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const groupW = plotW / COUNTS.length;
  const barW = (groupW - 20) / HOSTS.length - 2;   // 2px surface gap between bars

  const py = (v) => PAD.top + plotH - (v / maxY) * plotH;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`Median download throughput by number of concurrent connections. On nodejs.org: ${COUNTS.map((n) => `${n} connections ${HOSTS[0].byConn[n]} MiB per second`).join(', ')}. On download.blender.org: ${COUNTS.map((n) => `${n} connections ${HOSTS[1].byConn[n]} MiB per second`).join(', ')}.`}
        onMouseLeave={() => setHover(null)}
      >
        {[0, 2, 4, 6, 8].map((v) => (
          <g key={v}>
            <line
              x1={PAD.left} x2={W - PAD.right} y1={py(v)} y2={py(v)}
              stroke="currentColor" strokeWidth="1" className="text-slate-500/20"
            />
            <text x={PAD.left - 8} y={py(v) + 4} textAnchor="end" className="fill-slate-500 text-[11px]">
              {v}
            </text>
          </g>
        ))}
        <text x={PAD.left - 8} y={PAD.top - 4} textAnchor="end" className="fill-slate-500 text-[11px]">
          MiB/s
        </text>

        {COUNTS.map((n, gi) => {
          const gx = PAD.left + gi * groupW + 10;
          return (
            <g key={n}>
              {HOSTS.map((h, hi) => {
                const v = h.byConn[n];
                const x = gx + hi * (barW + 2);
                const y = py(v);
                const isHot = hover && hover.host === h.id && hover.n === n;
                return (
                  <g key={h.id}>
                    <rect
                      x={x} y={y} width={barW} height={PAD.top + plotH - y}
                      rx="4" ry="4"
                      fill={colors[hi]}
                      opacity={hover && !isHot ? 0.55 : 1}
                      onMouseEnter={() => setHover({ host: h.id, n })}
                    />
                    {/* Direct labels: with four groups there is room, and a
                        number on the bar beats a trip to the axis. */}
                    <text
                      x={x + barW / 2} y={y - 6} textAnchor="middle"
                      className="fill-slate-400 text-[10px] font-semibold"
                    >
                      {v.toFixed(1)}
                    </text>
                  </g>
                );
              })}
              <text
                x={gx + (barW * HOSTS.length) / 2 + 1} y={H - PAD.bottom + 18}
                textAnchor="middle" className="fill-slate-400 text-[11px] font-semibold"
              >
                {n}
              </text>
            </g>
          );
        })}
        <text
          x={PAD.left + plotW / 2} y={H - 10} textAnchor="middle"
          className="fill-slate-500 text-[11px]"
        >
          concurrent connections
        </text>
      </svg>

      {hover && (
        <div className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 rounded-lg border border-[var(--color-surface-border)] bg-[var(--color-surface-2)] px-3 py-2 text-xs shadow-lg">
          {(() => {
            const h = HOSTS.find((x) => x.id === hover.host);
            return (
              <>
                <p className="font-bold text-white">{h.label}</p>
                <p className="mt-1 text-slate-300">
                  {hover.n} connection{hover.n !== 1 ? 's' : ''} ·{' '}
                  <span className="font-mono font-semibold text-white">{h.byConn[hover.n].toFixed(3)} MiB/s</span>
                </p>
                <p className="mt-0.5 text-slate-500">{h.secs[hover.n]}s for 24 MiB</p>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

export default function Benchmarks() {
  usePageMeta({
    title: 'Benchmarks',
    description:
      'Measured download throughput at 1, 4, 8 and 16 concurrent connections against two real hosts, plus Nexa end to end — with the method, the raw spread and everything we could not measure stated plainly.',
  });

  const mode = useThemeMode();
  const colors = PALETTE[mode];
  const [showTable, setShowTable] = useState(false);

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />Benchmarks</span>
        <h1 className="mt-5 text-white">Speed you can <span className="text-gradient">measure.</span></h1>
        <p>
          Measured on {MEASURED_ON}, with the method written down so you can run it yourself and
          disagree with us. Including the parts that did not flatter us.
        </p>
      </div>

      <div className="note-info mx-auto mt-6 max-w-3xl rounded-xl px-5 py-4 text-sm leading-6">
        <p className="font-bold">Read the caveat before the numbers.</p>
        <p className="mt-1">
          These were measured on a single home connection in Pakistan, and that connection is
          noisy: three consecutive runs of the identical download varied by more than a factor of
          two. The <strong>ratios</strong> between configurations are the usable result. The
          absolute MiB/s figures describe this line on this day and will not match yours.
        </p>
      </div>

      <Card className="mt-10">
        <h2 className="text-lg font-bold text-white">How the tests were run</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          A benchmark without its conditions is an advertisement. These are ours.
        </p>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-sm">
            <caption className="sr-only">Test methodology, hardware and network conditions</caption>
            <thead>
              <tr className="surface-inset !border-x-0 !border-t-0 border-b border-white/10">
                <th scope="col" className="px-4 py-3 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Variable</th>
                <th scope="col" className="px-4 py-3 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Held at</th>
              </tr>
            </thead>
            <tbody>
              {METHOD.map(([k, v]) => (
                <tr key={k} className="border-b border-white/5 last:border-0">
                  <th scope="row" className="px-4 py-3 font-semibold text-slate-200">{k}</th>
                  <td className="px-4 py-3 text-slate-400">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mt-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-white">Does splitting a file actually help?</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-slate-400">
              This is the question the whole feature rests on, so it is the one we measured first.
              Same file, same minute, same machine — only the number of concurrent connections
              changed. It helped on both hosts, and on one of them sixteen was worse than eight.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowTable((v) => !v)}
            className="btn btn-ghost shrink-0 text-xs"
          >
            {showTable ? 'Show chart' : 'Show data table'}
          </button>
        </div>

        <ul className="mt-5 flex flex-wrap gap-x-5 gap-y-2">
          {HOSTS.map((h, i) => (
            <li key={h.id} className="flex items-center gap-2 text-xs text-slate-400">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ background: colors[i] }}
                aria-hidden="true"
              />
              <span className="font-semibold text-slate-300">{h.label}</span>
              <span className="text-slate-500">{h.sub}</span>
            </li>
          ))}
        </ul>

        <div className="mt-4">
          {showTable ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <caption className="sr-only">
                  Median throughput and elapsed time for 24 MiB at each connection count, per host
                </caption>
                <thead>
                  <tr className="surface-inset !border-x-0 !border-t-0 border-b border-white/10">
                    <th scope="col" className="px-4 py-3 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Connections</th>
                    {HOSTS.map((h) => (
                      <th key={h.id} scope="col" className="px-4 py-3 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                        {h.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {COUNTS.map((n) => (
                    <tr key={n} className="border-b border-white/5 last:border-0">
                      <th scope="row" className="px-4 py-3 font-semibold text-slate-200">{n}</th>
                      {HOSTS.map((h) => (
                        <td key={h.id} className="px-4 py-3 font-mono text-xs text-slate-400">
                          {h.byConn[n].toFixed(3)} MiB/s
                          <span className="ml-2 text-slate-500">({h.secs[n]}s)</span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <ThroughputChart colors={colors} />
          )}
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {HOSTS.map((h) => {
            const one = h.byConn[1];
            const best = h.byConn[h.best];
            return (
              <div key={h.id} className="surface-panel rounded-xl px-4 py-4">
                <p className="text-sm font-bold text-white">{h.label}</p>
                <p className="mt-1 text-2xl font-extrabold text-brand-300">
                  {(best / one).toFixed(1)}&times; faster
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  at {h.best} connections ({best.toFixed(2)} MiB/s) than on a single one
                  ({one.toFixed(2)} MiB/s).
                  {h.best === 8 && ' Sixteen was slower than eight here — the server, not the client, was the limit.'}
                </p>
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="mt-8">
        <h2 className="text-lg font-bold text-white">And Nexa itself?</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
          The sweep above is a bare HTTP client, which isolates the network but is not the product.
          So the shipped 0.3.0 binary was driven through its own dashboard API over a 34&nbsp;MB file
          from the same host — a size Nexa splits into 16 segments — with everything real included:
          probing, writing to disk, the queue, the interface.
        </p>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-sm">
            <caption className="sr-only">Nexa end-to-end download runs</caption>
            <thead>
              <tr className="surface-inset !border-x-0 !border-t-0 border-b border-white/10">
                <th scope="col" className="px-4 py-3 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Run</th>
                <th scope="col" className="px-4 py-3 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Time</th>
                <th scope="col" className="px-4 py-3 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Throughput</th>
              </tr>
            </thead>
            <tbody>
              {NEXA_RUNS.map((r) => (
                <tr key={r.rep} className="border-b border-white/5 last:border-0">
                  <th scope="row" className="px-4 py-3 font-semibold text-slate-200">Run {r.rep}</th>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">{r.secs.toFixed(2)}s</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">{r.mibs.toFixed(3)} MiB/s</td>
                </tr>
              ))}
              <tr className="bg-brand-500/[0.05]">
                <th scope="row" className="px-4 py-3 font-semibold text-brand-300">Median</th>
                <td className="px-4 py-3 font-mono text-xs text-slate-400">9.70s</td>
                <td className="px-4 py-3 font-mono text-xs font-bold text-brand-300">{NEXA_MEDIAN.toFixed(3)} MiB/s</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="note-warn mt-5 rounded-xl px-4 py-3 text-sm leading-6">
          <p className="font-bold">This came out lower than the bare range client, and we are not hiding it.</p>
          <p className="mt-1">
            The sweep reached 8.09 MiB/s at sixteen connections; Nexa&apos;s median over the same host
            was {NEXA_MEDIAN} MiB/s. Two things are mixed in there and we have not separated them
            yet. One is real overhead — Nexa probes the URL first, allocates the file, writes every
            byte to disk and persists progress, none of which the harness does. The other is simply
            the line: those three runs alone spanned 1.84 to 4.24 MiB/s, and the first was the
            slowest, which is what a cold DNS and TLS path looks like. Until we can measure on a
            stable connection, treat this as a floor rather than a verdict.
          </p>
        </div>
      </Card>

      <Card className="mt-8">
        <h2 className="text-lg font-bold text-white">What we could not measure</h2>
        <ul className="mt-4 space-y-2.5 text-sm leading-6 text-slate-400">
          <li className="flex gap-2.5">
            <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300" />
            <span>
              <strong className="text-slate-200">IDM.</strong> It is not installed on the test
              machine and we hold no licence for it. Every IDM figure you have seen on a page like
              this one, including the ones we nearly published, was copied from somewhere else.
              If you own IDM and run this method, <Link to="/contact" className="text-brand-300 hover:underline">send us the numbers</Link> and
              they go on this page with your name on them.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300" />
            <span>
              <strong className="text-slate-200">Chrome and Firefox.</strong> A browser downloads on
              one connection, so the 1-connection column is the honest stand-in. We have not timed
              the browsers themselves, so we do not name them in the table.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300" />
            <span>
              <strong className="text-slate-200">A third host.</strong> GitHub&apos;s release CDN was
              in the plan and was dropped: two of its three repetitions failed with DNS errors and
              timeouts, leaving a single sample that suggested a 14&times; speedup. One run is not a
              result, so it is not on the page.
            </span>
          </li>
        </ul>
      </Card>

      <Card className="mt-8">
        <h2 className="text-lg font-bold text-white">Features, not just speed</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          Throughput is one axis and usually not the deciding one. The{' '}
          <Link to="/compare" className="text-brand-300 hover:underline">comparison page</Link>{' '}
          puts Nexa beside IDM, Free Download Manager, JDownloader and four others across platforms,
          protocols, price and licensing — including the places where they are ahead.
        </p>
      </Card>

      <div className="mx-auto mt-8 max-w-3xl text-xs leading-6 text-slate-500">
        <p className="font-semibold text-slate-400">Things that move these numbers more than we do</p>
        <ul className="mt-2 space-y-1.5">
          <li>
            The server. A host that already saturates your line cannot be improved on, and one that
            throttles each connection is where splitting pays most. That is the whole spread between
            our two hosts.
          </li>
          <li>
            Concurrency caps. Two of the speed-test hosts we tried answered <code className="font-mono">429 Too Many Requests</code>{' '}
            to eight parallel range requests and had to be abandoned. More connections is not free.
          </li>
          <li>
            Your own line, Wi-Fi, disk and antivirus — all of which moved our results more than the
            connection count did on some runs.
          </li>
          <li>
            We benchmark our own software. Treat anyone&apos;s self-reported numbers, ours included,
            as a reason to run your own test rather than as a fact.
          </li>
        </ul>
      </div>

      <div className="surface-panel mx-auto mt-10 max-w-3xl rounded-[var(--radius-3)] px-6 py-6">
        <p className="text-sm font-bold text-white">See for yourself.</p>
        <p className="mt-1 text-xs text-slate-400">
          Free plan, no card. Download the same file twice and time it.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button to="/download">Download free</Button>
          <Button to="/features/acceleration" variant="ghost">How acceleration works</Button>
        </div>
      </div>
    </Section>
  );
}
