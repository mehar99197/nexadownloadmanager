import { Link } from 'react-router-dom';
import usePageMeta from '../../hooks/usePageMeta';
import FeatureShell, {
  H2, P, Steps, Code, Note, Figure, SpecTable, Tips, Troubles, Related,
} from './FeatureShell';

export default function FeatureAcceleration() {
  usePageMeta({
    title: 'Segmented download acceleration',
    description:
      'How Nexa splits a file across up to 32 connections, steals the tail of the slowest segment as others finish, and resumes exactly where it stopped after a crash or a reboot.',
  });

  return (
    <FeatureShell
      title="Segmented acceleration"
      tagline="One file, up to thirty-two connections, and none of them left idle while another finishes."
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
        Nexa asks for the same file in pieces. It sends a <Code>HEAD</Code> request (falling back to
        a ranged <Code>GET</Code> when the server dislikes HEAD), learns the file&apos;s size and
        whether the server honours HTTP range requests, and then opens several connections that each
        fetch a different byte range. Those ranges are written straight into their correct offsets in
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
      <Figure kind="Diagram">
        A timeline showing four segments, one of them slow, with the tail of the slow segment being
        claimed twice by workers that finished early.
      </Figure>
      <P>
        Two details keep this honest. The whole engine runs on a single thread — Qt&apos;s event
        loop — so there are no worker threads and no locks around the segment table; a steal is an
        ordinary function call between two network callbacks, not a race to be reasoned about. And
        the destination file is created sparse on Windows before it is sized, because NTFS otherwise
        zero-fills from its valid-data-length up to the first write past it, inside that write. A
        32-way download writes near the end of the file almost immediately, so without the sparse
        flag a 2&nbsp;GB file froze the window for seconds at the start of every transfer.
      </P>
      <P>
        Progress is persisted to a local SQLite database roughly every two seconds — per segment,
        not per file. A crash or a power cut costs you the last couple of seconds of each
        connection, not the download. On resume Nexa re-validates the file with the{' '}
        <Code>ETag</Code> and <Code>Last-Modified</Code> it recorded; if the server&apos;s copy has
        changed underneath you, it says so and restarts rather than stitching two different files
        together.
      </P>

      <H2 id="supported">What it works with</H2>
      <SpecTable
        caption="Protocol and server support for segmented acceleration"
        head={['', 'Support']}
        rows={[
          ['HTTP / HTTPS', 'Yes — the main path, including HTTP/2 servers'],
          ['Range requests', <>Required for splitting. Nexa detects <Code>Accept-Ranges</Code> and falls back to a single connection when the server refuses.</>],
          ['Unknown file size', <>Handled: a chunked response with no <Code>Content-Length</Code> downloads on one connection and is re-segmented if the size becomes known.</>],
          ['Connections per file', 'Chosen from the file size — 1 below 1 MB, 8 to 10 MB, 16 to 100 MB, 32 above. Capped at 16 on Free, 32 on Pro.'],
          ['Concurrent files', 'Free: 3 at a time. Pro and Team: unlimited.'],
          ['Speed limits', 'Global and per-download caps, applied with a shared token bucket'],
          ['Resume after restart', 'Yes — segment offsets live in the local database'],
          ['Integrity check', <>Optional SHA-256, pasted when the download is added and verified on completion</>],
        ]}
      />
      <Note>
        Some servers cap concurrent connections per client and will refuse or throttle the extra
        ones. Nexa backs off to what the server allows instead of hammering it; raising the
        connection count past that point does nothing.
      </Note>

      <H2 id="use">Using it</H2>
      <Steps
        items={[
          <>Add a download — paste a URL with <Code>Ctrl+V</Code>, use the <strong className="text-white">+</strong> button, or click <strong className="text-white">Download with Nexa</strong> in your browser.</>,
          <>Nexa probes the URL, shows the real filename and size, and tells you whether the server supports resuming.</>,
          <>Open the row to watch the segments. Each bar is one connection; the numbers underneath are that connection&apos;s throughput.</>,
          <>You do not have to tune anything: Nexa picks the count from the file&apos;s size — one connection below 1&nbsp;MB, eight up to 10&nbsp;MB, sixteen up to 100&nbsp;MB, and thirty-two beyond that, up to the ceiling your plan allows (16 on Free, 32 on Pro). Past about eight the server is usually the limit anyway.</>,
          <>Right-click a running download for <strong className="text-white">Limit speed…</strong> if you need to leave bandwidth for something else.</>,
        ]}
      />
      <Figure kind="Screenshot">
        Settings → Downloads with the connections-per-file and speed-limit fields highlighted.
      </Figure>

      <H2 id="tips">Tips</H2>
      <Tips
        items={[
          'More connections is not automatically faster. Past about eight, most servers are the bottleneck and the extra sockets just add overhead.',
          'If a host rate-limits you or starts returning errors, lower the connection count for that download rather than globally — the setting is per-download in the right-click menu.',
          'Set a global speed cap during work hours and remove it at night; the scheduler can do both for you automatically.',
          <>Paste the publisher&apos;s SHA-256 into the new-download dialog. Nexa verifies the finished file and reports a mismatch as an error instead of leaving you a bad copy.</>,
          'On a slow or metered connection, pause rather than cancel. A paused download keeps every byte it has and resumes from there, even after a reboot.',
          'Downloads land in a category folder by default (Video/, Audio/, …). Turn that off, or change where each category points, in Settings → Categories.',
          <>If a download is slower than the same file in a browser, it is almost always a server that dislikes ranges. The details window says <Code>ranges: no</Code> when that is the case.</>,
        ]}
      />

      <H2 id="trouble">When it goes wrong</H2>
      <Troubles
        items={[
          {
            symptom: 'The download runs on one connection instead of sixteen',
            fix: (
              <>
                The server did not advertise <Code>Accept-Ranges: bytes</Code>, or it answered the
                ranged request with a full <Code>200</Code> body. Nexa will not fake a split it
                cannot verify, because writing two overlapping streams into one file corrupts it
                silently. Nothing to fix on your side — the download still resumes if the server
                later allows it.
              </>
            ),
          },
          {
            symptom: 'It stalls at 99% and never finishes',
            fix: (
              <>
                Usually one segment whose connection died without an error — the server stopped
                sending but never closed. Pause and resume the row: Nexa re-opens only the
                outstanding ranges, so you lose nothing. If it repeats on the same host, drop that
                download to 4 connections.
              </>
            ),
          },
          {
            symptom: '“The file on the server changed” on resume',
            fix: (
              <>
                The <Code>ETag</Code> or <Code>Last-Modified</Code> no longer matches what was
                recorded when the download started, so the remaining bytes would belong to a
                different file. Restart the download to get a clean copy. This is most common with
                CDN links that are regenerated per session.
              </>
            ),
          },
          {
            symptom: 'Windows freezes for a few seconds when a big download starts',
            fix: (
              <>
                The destination is on a FAT32 or exFAT volume, where the operating system zero-fills
                the file inside the resize call and sparse files are not available. The row shows
                &ldquo;allocating&hellip; on disk&rdquo; while that happens. Downloading to an NTFS
                volume avoids it.
              </>
            ),
          },
          {
            symptom: 'Only 3 downloads run at once',
            fix: (
              <>
                That is the Free plan&apos;s concurrency cap; the rest are queued, not failing. Pro
                removes it. Note this is files at a time, not connections — each of those three
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
        answer, from two real hosts: sixteen connections beat one by 3.1&times; on a Cloudflare-fronted
        file, and eight beat one by 2.7&times; on an origin server where sixteen was actually slower
        than eight. On a fast server that already saturates your line, expect no gain at all — and
        the page says which figures we could not measure, including IDM.
      </P>

      <H2 id="related">Related features</H2>
      <Related to={['/features/scheduler', '/features/video-grabber', '/features/bittorrent']} />
    </FeatureShell>
  );
}
