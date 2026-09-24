import { Link } from 'react-router-dom';
import usePageMeta from '../../hooks/usePageMeta';
import DocsShell, { H2, P, Bullets, Code, Note } from './DocsShell';

export default function DocsTorrents() {
  usePageMeta({
    title: 'Torrents',
    description: 'BitTorrent in Nexa Download Manager: magnet links and .torrent files, seed ratio, speed limits, DHT and PEX.',
  });

  return (
    <DocsShell
      title="Torrents"
      intro="BitTorrent is built into the app (libtorrent), so a magnet link sits in the same queue as an HTTP file, with the same pause and resume controls. Torrents have their own speed limits."
    >
      <H2 id="adding">Adding a torrent</H2>
      <Bullets
        items={[
          <><strong className="text-white">Magnet link:</strong> paste it into New download (<Code>Ctrl+N</Code>), drag it onto the window, or right-click it in the browser and choose <strong className="text-white">Download with Nexa</strong> (needs the extension). Clicking a <Code>magnet:</Code> link does not open Nexa. Metadata is fetched from the swarm before the row shows a size.</>,
          <><strong className="text-white">.torrent file:</strong> drag it onto the window. In the browser, clicking a link whose address ends in <Code>.torrent</Code> hands it to Nexa through the extension, and the torrent starts; other <Code>.torrent</Code> links download as an ordinary file, which you can then drag onto the window.</>,
          <>A torrent downloads in full: choosing individual files from a multi-file torrent is not supported yet.</>,
        ]}
      />

      <H2 id="seeding">Seed ratio</H2>
      <P>
        By default a torrent stops the moment it completes: Settings &rarr; BitTorrent &rarr;{' '}
        <strong className="text-white">Seed to ratio</strong> starts at <Code>0</Code>, shown as
        &ldquo;Don&apos;t seed&rdquo;. Set it above zero and Nexa keeps uploading after the download
        finishes until the upload/download ratio reaches that value, then stops on its own —{' '}
        <Code>1.0</Code> means you have given back as much as you took. Changing the value applies
        live to torrents already seeding.
      </P>

      <H2 id="limits">Speed limits</H2>
      <P>
        Separate download and upload caps for the whole torrent session live under Settings &rarr;
        BitTorrent, where <Code>0</Code> shows as Unlimited. These are independent of the HTTP
        speed limit. On a shared connection an upload cap around 80% of your uplink keeps the rest
        of the house happy.
      </P>

      <H2 id="network">Peers, DHT and ports</H2>
      <Bullets
        items={[
          <>DHT and peer exchange (PEX) are on by default so magnet links resolve without a tracker.</>,
          <>Nexa listens on libtorrent&apos;s standard port, 6881, and asks your router to open it (UPnP and NAT-PMP). The app has no setting to change the port; most swarms work fine even when the router declines.</>,
          <>Private torrents (with the <Code>private</Code> flag) never use DHT or peer exchange, as the spec requires.</>,
        ]}
      />

      <Note tone="warn" title="Only download what you may download">
        BitTorrent is a transport, not a license. Use it for Linux ISOs, open data, your own files,
        and content whose owner distributes it this way. The <Link to="/terms" className="underline">terms</Link> spell this out.
      </Note>
    </DocsShell>
  );
}
