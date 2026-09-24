import { Link } from 'react-router-dom';
import usePageMeta from '../../hooks/usePageMeta';
import FeatureShell, {
  H2, P, Steps, Code, Figure, Flow, SpecTable, Tips, Troubles, Related,
} from './FeatureShell';

export default function FeatureBittorrent() {
  usePageMeta({
    title: 'Built-in BitTorrent',
    description:
      'Magnet links and .torrent files download in the same Nexa queue as everything else, on a real libtorrent engine with DHT, peer exchange, speed limits and seed-ratio control.',
  });

  return (
    <FeatureShell
      title="BitTorrent"
      tagline="A real torrent engine inside the download manager, so a magnet link is just another row in the same queue."
      hero={
        <Figure kind="Screenshot">
          The main window with an HTTP download, a YouTube video and a torrent running side by side —
          the torrent row showing its progress and download speed.
        </Figure>
      }
    >
      <H2 id="what">What it does</H2>
      <P>
        Most download managers stop at HTTP. If a file is distributed as a torrent you are expected
        to keep a second application around, learn its own queue and its own settings, and watch
        your bandwidth get divided between two programs that know nothing about each other.
      </P>
      <P>
        Nexa treats a magnet link or a <Code>.torrent</Code> file as a download like any other. It
        goes in the same list, shows the same progress bar, uses the same scheduler and saves into
        your download folder; its speed limits are its own, under Settings &rarr; BitTorrent. The
        engine underneath is{' '}
        <strong className="text-white">libtorrent-rasterbar</strong> — the same library
        qBittorrent and Deluge are built on — so this is a genuine BitTorrent client, not a
        simplified imitation.
      </P>
      <P>
        Practically this means one window instead of two, and one place to look when you want to
        know what your machine is downloading tonight.
      </P>

      <H2 id="how">How it works</H2>
      <P>
        A magnet link contains an info-hash but not the file list. Nexa joins the distributed hash
        table (DHT), finds peers holding the metadata, downloads it, and only then can show you what
        the torrent actually contains. That is why a magnet sits at &ldquo;fetching
        metadata&hellip;&rdquo; for a moment before any progress appears — it is a normal part of
        the protocol, not a stall.
      </P>
      <P>
        From there libtorrent does the work: connecting to peers from the tracker, the DHT and peer
        exchange, requesting pieces in a rarest-first order, verifying every completed piece against
        its SHA-1 hash from the torrent, and writing it to disk. A piece that fails verification is
        discarded and re-requested from someone else, which is why a completed torrent is
        trustworthy in a way an HTTP download is not — the integrity check is built into the
        protocol rather than optional.
      </P>
      <Flow
        caption="From a magnet link to a finished torrent."
        steps={[
          { title: 'Magnet link', detail: 'an info-hash, no file list' },
          { title: 'Peers found', detail: 'through the DHT and trackers' },
          { title: 'Metadata arrives', detail: 'real names and sizes' },
          { title: 'Pieces from many peers', detail: 'rarest first' },
          { title: 'Every piece checked', detail: 'against its hash in the torrent' },
          { title: 'Files on disk' },
          { title: 'Seeding, if you ask', detail: 'until your ratio target' },
        ]}
      />
      <P>
        Seeding is where a torrent client differs most from a download manager, and where Nexa is
        explicit rather than clever. Out of the box a torrent stops the moment it completes:
        Settings &rarr; BitTorrent &rarr; <strong className="text-white">Seed to ratio</strong> starts
        at <Code>0</Code>, shown as &ldquo;Don&apos;t seed&rdquo;. Set a ratio and a finished torrent
        keeps uploading until it reaches it, then stops on its own &mdash; <Code>1.0</Code> means
        you have given back as much as you took. It is one field in Settings rather than a buried
        policy.
      </P>
      <P>
        Upload and download limits for torrents are separate from the HTTP ones, because the right
        numbers are different: torrent upload in particular needs headroom left over or your own
        downloads slow down, since BitTorrent rewards peers who give back.
      </P>

      <H2 id="supported">What it supports</H2>
      <SpecTable
        caption="BitTorrent capabilities in Nexa"
        head={['', 'Support']}
        rows={[
          ['Magnet links', <>Yes — paste one into New download (<Code>Ctrl+N</Code>), drag it onto the window, or right-click it in the browser and choose <strong className="text-white">Download with Nexa</strong> (needs the extension). Clicking a <Code>magnet:</Code> link does not open Nexa.</>],
          ['.torrent files', <>Yes — drag one onto the window, or click a link whose address ends in <Code>.torrent</Code> in the browser (needs the extension)</>],
          ['DHT (trackerless)', 'Yes'],
          ['Peer exchange (PEX)', 'Yes'],
          ['Local peer discovery', 'Yes'],
          ['Piece verification', 'Always — SHA-1 per piece, part of the protocol'],
          ['Seed ratio target', 'Yes, configurable; 0 stops seeding at completion'],
          ['Separate up/down limits', 'Yes, independent of the global HTTP cap'],
          ['Resume after restart', 'No — torrents are not restored when Nexa restarts; add them again'],
          ['Selective file download', <>Not yet — a torrent downloads in full. <span className="text-amber-300">Planned.</span></>],
          ['Creating torrents', <>Not supported. Nexa downloads torrents; it is not a tracker or a creation tool.</>],
          ['Anonymity / VPN binding', <>Not built in. Torrent traffic (peers, trackers and DHT) never goes through a proxy: not the one in Settings &rarr; Network, and not your system proxy. If you need it on a VPN, set the VPN up at the OS level.</>],
        ]}
      />

      <H2 id="use">Using it</H2>
      <Steps
        items={[
          <>Press <Code>Ctrl+N</Code> for a new download and paste the magnet link, or drop a <Code>.torrent</Code> file onto the list.</>,
          <>For a magnet, wait a moment while the metadata arrives. The row will show the real name and size once it does.</>,
          <>Watch progress as usual. The row shows progress and download speed; hover over its status badge to see how many peers it is connected to.</>,
          <>To control bandwidth, open <strong className="text-white">Settings &rarr; BitTorrent</strong> and set the download and upload caps and the seed ratio.</>,
          <>With a seed ratio set, a completed torrent keeps seeding until it hits that ratio. Stop the row by hand at any time if you need the bandwidth back.</>,
        ]}
      />
      <Figure kind="Screenshot">
        Settings → BitTorrent showing the download limit, upload limit and seed-ratio fields.
      </Figure>

      <H2 id="vs">Compared with a dedicated client</H2>
      <P>
        Being honest about this matters more than winning the comparison. qBittorrent, Deluge and
        Transmission are mature, focused torrent clients with years of tuning and features Nexa does
        not have: per-file selection inside a torrent, RSS auto-downloading, categories and tags,
        sequential download, bandwidth scheduling per protocol, tracker editing, a web UI for a
        seedbox.
      </P>
      <P>
        Nexa is the right choice when torrents are a small part of what you download and you would
        rather not run a second application for them — one queue and one download folder. It is
        the wrong choice if you seed a large library, need selective downloading, or
        run a headless box. Those are real gaps, not marketing softeners, and they are on the{' '}
        <Link to="/compare" className="text-brand-300 hover:underline">compare page</Link> too.
      </P>

      <H2 id="tips">Tips</H2>
      <Tips
        items={[
          'Leave upload headroom. Choking your own upload to zero makes peers deprioritise you and your download gets slower, not faster.',
          <>A magnet stuck at &ldquo;fetching metadata&rdquo; for minutes usually has no reachable peers — the torrent is dead rather than broken.</>,
          'Set a seed ratio you are comfortable with once, rather than stopping torrents by hand. 1.0 is the usual courtesy floor on public swarms.',
          'Use the scheduler for large torrents: start at 2am, cap upload during the day, and let it seed overnight.',
          'Category rules do not apply to torrents. With category folders on (the default), every torrent lands in the Torrents folder inside your download folder, whatever it contains.',
          'If your ISP or network blocks BitTorrent, no client setting fixes it — that is a network-level block and needs a VPN configured at the OS level.',
          'Only download what you have the right to. A torrent client is a transfer tool; what you move with it is your responsibility.',
        ]}
      />

      <H2 id="trouble">When it goes wrong</H2>
      <Troubles
        items={[
          {
            symptom: 'The torrent sits at 0% with 0 peers',
            fix: (
              <>
                Either the swarm is empty, or DHT traffic is blocked on your network. Try a torrent
                with a known-healthy swarm to tell the two apart. Corporate and university networks
                commonly block BitTorrent outright.
              </>
            ),
          },
          {
            symptom: 'Download speed is far below my connection',
            fix: (
              <>
                Torrent speed is the swarm&apos;s, not your line&apos;s: few seeds means slow,
                regardless of bandwidth. Check the peer count first. If it is healthy and you are
                still slow, raise your upload limit — heavily choked peers get served last.
              </>
            ),
          },
          {
            symptom: 'It keeps uploading after the download finished',
            fix: (
              <>
                That is seeding, and it only happens once a seed ratio is set. It stops on its own
                at that ratio; set it back to <Code>0</Code> (&ldquo;Don&apos;t seed&rdquo;) in
                Settings &rarr; BitTorrent to stop at completion, or stop the row by hand.
              </>
            ),
          },
          {
            symptom: 'A magnet link in the browser does nothing',
            fix: (
              <>
                Nexa does not register itself as the handler for <Code>magnet:</Code> links, so
                clicking one does not reach it. Right-click the link and choose{' '}
                <strong className="text-white">Download with Nexa</strong> instead (needs the
                extension), or copy it and paste it into New download (<Code>Ctrl+N</Code>).
              </>
            ),
          },
          {
            symptom: 'A torrent is gone after restarting the app',
            fix: (
              <>
                Nexa does not restore torrents when it restarts; only regular file downloads and
                scheduled jobs come back. Add the magnet link or <Code>.torrent</Code> file again.
              </>
            ),
          },
        ]}
      />

      <H2 id="related">Related features</H2>
      <Related to={['/features/acceleration', '/features/scheduler', '/features/remote-dashboard']} />
    </FeatureShell>
  );
}
