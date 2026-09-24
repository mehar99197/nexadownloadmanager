import { Link } from 'react-router-dom';
import usePageMeta from '../../hooks/usePageMeta';
import FeatureShell, {
  H2, P, Steps, Code, Note, Figure, SpecTable, Tips, Troubles, Related,
} from './FeatureShell';

/*
 * The picture "How it works" describes. Positions are illustrative, not
 * measured: four connections start together, connection 4 is on a slow path,
 * and 1, 2 and 3 each finish their own range and take the back half of the
 * biggest range still in flight — by then, always what 4 has left. All four
 * end together, where 4 alone would have run on. Numbers are percentages of
 * the time axis.
 */
const LANES = [
  { label: 'Connection 1', bars: [{ from: 0, to: 40, kind: 'own' }, { from: 40, to: 61, kind: 'taken' }] },
  { label: 'Connection 2', bars: [{ from: 0, to: 47, kind: 'own' }, { from: 47, to: 61, kind: 'taken' }] },
  { label: 'Connection 3', bars: [{ from: 0, to: 55, kind: 'own' }, { from: 55, to: 61, kind: 'taken' }] },
  { label: 'Connection 4', bars: [{ from: 0, to: 61, kind: 'own' }, { from: 61, to: 100, kind: 'avoided' }] },
];

const BAR = {
  own: 'bg-brand-500/75',
  taken: 'bg-accent-500/80',
  avoided: 'border border-dashed border-slate-500',
};

const LEGEND = [
  ['own', 'Its own range'],
  ['taken', 'The tail of connection 4, taken over'],
  ['avoided', 'How long connection 4 would have run alone'],
];

function SegmentTimeline() {
  return (
    <figure className="mt-5">
      <div
        role="img"
        aria-label="Illustration: connections 1, 2 and 3 finish their own ranges early while connection 4, on a slow path, is still going. As each one finishes it takes the back half of what connection 4 has left, so all four finish together, well before connection 4 would have finished on its own."
        className="surface-inset rounded-xl p-4"
      >
        <div className="space-y-2.5">
          {LANES.map((lane) => (
            <div key={lane.label} className="grid grid-cols-[6.5rem_1fr] items-center gap-3">
              <span className="text-xs text-slate-400">{lane.label}</span>
              <div className="relative h-5">
                {lane.bars.map((b) => (
                  <span
                    key={b.from}
                    className={`absolute inset-y-0 rounded ${BAR[b.kind]}`}
                    style={{ left: `${b.from}%`, width: `${b.to - b.from}%` }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-[6.5rem_1fr] gap-3">
          <span />
          <div className="relative h-5 border-t border-[var(--color-surface-border)] text-xs text-slate-500">
            <span className="absolute left-0 top-1">start</span>
            <span className="absolute top-1 -translate-x-1/2" style={{ left: '61%' }}>all done</span>
            {/* On a phone the bars are ~140px wide and this ran into "all done";
                start → all done already says which way time goes. */}
            <span className="absolute right-0 top-1 hidden sm:inline">time &rarr;</span>
          </div>
        </div>
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-400">
        {LEGEND.map(([kind, label]) => (
          <li key={kind} className="flex items-center gap-2">
            <span aria-hidden="true" className={`inline-block h-3 w-5 rounded-sm ${BAR[kind]}`} />
            {label}
          </li>
        ))}
      </ul>
      <figcaption className="mt-2 text-xs text-slate-500">
        Illustrative timings: a steal lets every connection finish together instead of three
        sitting idle while one crawls.
      </figcaption>
    </figure>
  );
}

export default function FeatureAcceleration() {
  usePageMeta({
    title: 'Segmented download acceleration',
    description:
      'How Nexa splits a file across up to 32 connections on Pro (16 on Free), hands half of the biggest range left to each connection that finishes early, and resumes where it stopped after a crash or a reboot.',
  });

  return (
    <FeatureShell
      title="Segmented acceleration"
      tagline="One file, up to thirty-two connections on Pro (sixteen on Free), and a connection that finishes early takes over half of the biggest range left."
      hero={
        <Figure kind="Screenshot">
          The download details window mid-transfer, showing the per-connection segment bars and the
          live throughput sparkline.
        </Figure>
      }
    >
      <H2 id="what">What it does</H2>
      <P>
        A browser asks a server for a file once and reads it through a single connection. That is
        fine when the server is fast and close, and wasteful when it is neither: most of the delay
        on a large download is not your bandwidth, it is per-connection throughput being throttled,
        shaped, or simply limited by round-trip latency.
      </P>
      <P>
        Nexa asks for the same file in pieces. It first asks for a single byte with a ranged{' '}
        <Code>GET</Code> (Google Drive links get a <Code>HEAD</Code> instead). The answer carries the
        file&apos;s size, and only a <Code>206 Partial Content</Code> answer counts as proof that the
        server honors HTTP range requests. Then Nexa opens several connections that each fetch a
        different byte range. Those ranges are written straight into their correct offsets in
        one destination file, so there is no merge step at the end and no temporary copy that doubles
        your disk use.
      </P>
      <P>
        The result is the same bytes in less time on nearly every real-world server, and — more
        usefully day to day — a download that survives things a browser does not: a dropped Wi-Fi
        connection, a laptop lid, a server that hangs up after 200&nbsp;MB.
      </P>

      <H2 id="how">How it works</H2>
      <P>
        The part that matters is what happens when the connections finish at different speeds, which
        they always do. Most accelerators cut the file into N equal pieces before the transfer
        starts. One piece lands on a slow mirror or a congested path, the other fifteen finish, and
        the whole download then waits on a single connection crawling through the last 6% — with
        fifteen idle sockets watching.
      </P>
      <P>
        Nexa re-segments while the download is running. When a worker finishes its range, it does
        not exit: it looks at every segment still in flight, finds the one with the most bytes
        outstanding, and takes the back half of it for itself. The slow segment&apos;s owner keeps
        going, unaware, and simply stops earlier than it planned. This repeats until the remaining
        work is too small to be worth splitting.
      </P>
      <SegmentTimeline />
      <P>
        Two details keep this honest. The segment table lives on a single thread — Qt&apos;s event
        loop — so there are no locks around it; a steal is an ordinary function call between two
        network callbacks, not a race to be reasoned about. And the destination file is sized before
        the transfer starts, on a worker thread, because on some disks that one call blocks for
        seconds; the download&apos;s status reads &ldquo;allocating &hellip; on disk&rdquo; until it
        is done. On Windows the file is marked sparse before it is sized, because NTFS otherwise
        zero-fills from its valid-data-length up to the first write past it, inside that write — and
        a 32-way download writes near the end of the file almost immediately.
      </P>
      <P>
        Progress is persisted to a local SQLite database roughly every two seconds — per segment,
        not per file. A crash or a power cut costs you the last couple of seconds of each
        connection, not the download. On resume Nexa re-validates the file with the{' '}
        <Code>ETag</Code> and <Code>Last-Modified</Code> it recorded; if the server&apos;s copy has
        changed underneath you, it quietly throws the partial file away and starts again from the
        first byte rather than stitching two different files together.
      </P>

      <H2 id="supported">What it works with</H2>
      <SpecTable
        caption="Protocol and server support for segmented acceleration"
        head={['', 'Support']}
        rows={[
          ['HTTP / HTTPS', 'Yes — the main path, including HTTP/2 servers'],
          ['Range requests', <>Required for splitting. Nexa splits only when its one-byte ranged request comes back <Code>206 Partial Content</Code>; any other answer gets a single connection.</>],
          ['Unknown file size', <>Handled: a chunked response with no <Code>Content-Length</Code> downloads on one connection, and stays on one even if the size turns up mid-transfer.</>],
          ['Connections per file', 'Chosen from the file size — 1 below 1 MB, 8 to 10 MB, 16 to 100 MB, 32 above. Capped at 16 on Free, 32 on Pro.'],
          ['Concurrent files', 'Free: 3 direct downloads at once. Pro and Team: up to 32, set in Settings → Downloads (4 by default). Video-site, stream, MEGA and torrent jobs are not counted and start right away.'],
          ['Speed limits', 'Global and per-download caps, applied with a shared token bucket'],
          ['Resume after restart', 'Yes — segment offsets live in the local database'],
          ['Integrity check', <>Optional SHA-256, pasted when the download is added and verified on completion</>],
        ]}
      />
      <Note>
        Some servers cap concurrent connections per client and will refuse or throttle the extra
        ones. Nexa does not scale back to what such a server allows, and the connection count is not
        a setting: a connection that keeps failing is retried five times, then the download stops
        with an error. Resuming keeps every byte already saved, though it opens as many connections
        as before.
      </Note>

      <H2 id="use">Using it</H2>
      <Steps
        items={[
          <>Add a download: press <Code>Ctrl+N</Code> or click <strong className="text-white">+ New download</strong> (a link you have copied is filled in for you), drop a link on the window, or click <strong className="text-white">Download with Nexa</strong> in your browser.</>,
          <>Nexa probes the URL, shows the real filename and size, and tells you whether the server supports resuming.</>,
          <>Double-click the row to open its details window, then expand <strong className="text-white">Connection details</strong>. The strip shows each connection&apos;s slice of the file, and the table under it shows how much each one has downloaded.</>,
          <>You do not have to tune anything: Nexa picks the count from the file&apos;s size — one connection below 1&nbsp;MB, eight up to 10&nbsp;MB, sixteen up to 100&nbsp;MB, and thirty-two beyond that, up to the ceiling your plan allows (16 on Free, 32 on Pro). Past about eight the server is usually the limit anyway.</>,
          <>Right-click a running download for <strong className="text-white">Limit speed…</strong> if you need to leave bandwidth for something else.</>,
        ]}
      />
      <Figure kind="Screenshot">
        Settings → Downloads with the Max simultaneous downloads and Global speed limit fields
        highlighted.
      </Figure>

      <H2 id="tips">Tips</H2>
      <Tips
        items={[
          'More connections is not automatically faster. Past about eight, most servers are the bottleneck and the extra sockets just add overhead.',
          'The connection count is automatic, and there is no setting to lower it for one host. If a host refuses the extra connections, the download can stop with an error; resuming it keeps every byte already saved.',
          'Set a global speed cap during work hours and remove it at night. That part is manual: the scheduler only starts downloads.',
          <>Paste the publisher&apos;s SHA-256 into the new-download dialog. Nexa verifies the finished file and reports a mismatch as an error instead of leaving you a bad copy.</>,
          'On a slow or metered connection, pause rather than cancel. A paused download keeps every byte it has and resumes from there, even after a reboot.',
          'Downloads land in a category folder by default (Video/, Audio/, …). Turn that off, or change where each category points, in Settings → Categories.',
          <>If a download is slower than the same file in a browser, it is almost always a server that dislikes ranges. The details window says <Code>Resume capability: No</Code> when that is the case.</>,
        ]}
      />

      <H2 id="trouble">When it goes wrong</H2>
      <Troubles
        items={[
          {
            symptom: 'The download runs on one connection instead of sixteen',
            fix: (
              <>
                The server answered Nexa&apos;s one-byte ranged request with a full <Code>200</Code>{' '}
                instead of <Code>206 Partial Content</Code>, so it never proved it can serve ranges.
                Nexa will not fake a split it cannot verify, because writing two overlapping streams
                into one file corrupts it silently. Nothing to fix on your side — the download still
                resumes if the server later allows it.
              </>
            ),
          },
          {
            symptom: 'It stalls at 99% and never finishes',
            fix: (
              <>
                Usually one segment whose connection died without an error — the server stopped
                sending but never closed. Pause and resume the row: Nexa re-opens only the
                outstanding ranges, so you lose nothing. If it keeps happening on the same host,
                pausing and resuming is the remedy: the connection count is automatic, and there is
                no setting to lower it.
              </>
            ),
          },
          {
            symptom: 'A resumed download starts again from 0%',
            fix: (
              <>
                The <Code>ETag</Code> or <Code>Last-Modified</Code> no longer matches what was
                recorded when the download started, so the remaining bytes would belong to a
                different file. Nexa throws the partial file away and downloads the new one from
                the start, without a message. This is most common with CDN links that are
                regenerated per session.
              </>
            ),
          },
          {
            symptom: 'A big download waits on “allocating … on disk” before it starts',
            fix: (
              <>
                The destination is on a FAT32 or exFAT volume, where the operating system writes
                zeros across the whole file when it is sized, and sparse files are not available.
                Nexa does that on a worker thread, so the window stays responsive, but the transfer
                waits until it is done. Downloading to an NTFS volume avoids the wait.
              </>
            ),
          },
          {
            symptom: 'Only 3 downloads run at once',
            fix: (
              <>
                That is the Free plan&apos;s limit on direct downloads; the rest are queued, not
                failing. Video-site, stream, MEGA and torrent jobs do not count toward it. Pro lets
                you raise it as high as 32 in Settings → Downloads → Max simultaneous downloads (the
                default is 4). Note this is files at a time, not connections — each of those three
                still uses up to 16 connections on Free, or 32 on Pro. See <Link to="/pricing" className="text-brand-300 hover:underline">pricing</Link>.
              </>
            ),
          },
        ]}
      />

      <H2 id="measured">Is it actually faster?</H2>
      <P>
        We would rather show numbers than adjectives. The{' '}
        <Link to="/benchmarks" className="text-brand-300 hover:underline">benchmarks page</Link>{' '}
        documents the method, the hardware and the conditions so you can reproduce it. Measured
        answer, from two real hosts, using a plain range-request client rather than Nexa itself:
        sixteen connections beat one by 3.1&times; on a Cloudflare-fronted file, and eight beat one
        by 2.7&times; on an origin server where sixteen was actually slower than eight. Nexa end to
        end came in below that client on the same host, and the page shows by how much. On a fast
        server that already saturates your line, expect no gain at all — and the page says which
        figures we could not measure, including IDM.
      </P>

      <H2 id="related">Related features</H2>
      <Related to={['/features/scheduler', '/features/video-grabber', '/features/bittorrent']} />
    </FeatureShell>
  );
}
