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
      intro="BitTorrent is built into the app (libtorrent), so a magnet link sits in the same queue as an HTTP file, with the same pause, resume and speed controls."
    >
      <H2 id="adding">Adding a torrent</H2>
      <Bullets
        items={[
          <><strong className="text-white">Magnet link:</strong> paste it into the app, or click it in the browser — with the extension installed, <Code>magnet:</Code> links are handed to Nexa. Metadata is fetched from the swarm before the row shows a size.</>,
          <><strong className="text-white">.torrent file:</strong> open it with Nexa, drag it onto the window, or download it normally — the extension recognises the file type and passes it to the app.</>,
          <>Multi-file torrents show a file list; untick what you do not want before it starts.</>,
        ]}
      />

      <H2 id="seeding">Seed ratio</H2>
      <P>
        After a torrent completes, Nexa keeps seeding until the upload/download ratio reaches the
        value in Settings &rarr; Torrents &rarr; <strong className="text-white">Seed ratio</strong>. The default is{' '}
        <Code>0</Code>, which means seed indefinitely until you pause or remove the torrent; set{' '}
        <Code>1.0</Code> to stop once you have uploaded as much as you downloaded. Changing the
        value applies live to torrents already seeding.
      </P>

      <H2 id="limits">Speed limits</H2>
      <P>
        Separate download and upload caps for the whole torrent session live under Settings &rarr;
        Torrents. <Code>0</Code> is unlimited. These are independent of the HTTP speed limit and of the
        global &ldquo;quiet hours&rdquo; scheduler, which pauses everything. On a shared connection an
        upload cap around 80% of your uplink keeps the rest of the house happy.
      </P>

      <H2 id="network">Peers, DHT and ports</H2>
      <Bullets
        items={[
          <>DHT and peer exchange (PEX) are on by default so magnet links resolve without a tracker.</>,
          <>Nexa listens on a random high port unless you set one; forward it on your router for better connectivity, or leave it — most swarms work fine without.</>,
          <>Trackerless private torrents (with the <Code>private</Code> flag) automatically disable DHT/PEX as the spec requires.</>,
        ]}
      />

      <Note tone="warn" title="Only download what you may download">
        BitTorrent is a transport, not a license. Use it for Linux ISOs, open data, your own files,
        and content whose owner distributes it this way. The <Link to="/terms" className="underline">terms</Link> spell this out.
      </Note>
    </DocsShell>
  );
}
