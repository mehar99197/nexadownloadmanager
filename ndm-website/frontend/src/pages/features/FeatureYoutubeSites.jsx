import { Link } from 'react-router-dom';
import usePageMeta from '../../hooks/usePageMeta';
import FeatureShell, {
  H2, P, Steps, Code, Note, Figure, Flow, SpecTable, Tips, Troubles, Related,
} from './FeatureShell';

const SITE_GROUPS = [
  {
    group: 'Video',
    sites: 'YouTube, Vimeo, Dailymotion, Rumble, Odysee, Bitchute, TED, Internet Archive',
  },
  {
    group: 'Social',
    sites: 'X (Twitter), Instagram, Facebook, TikTok, Reddit, Tumblr, Bluesky',
  },
  {
    group: 'Live & gaming',
    sites: 'Twitch VODs and clips, Kick, YouTube Live archives',
  },
  {
    group: 'Audio',
    sites: 'SoundCloud, Bandcamp, Mixcloud, podcast RSS enclosures',
  },
  {
    group: 'News & public media',
    sites: 'BBC iPlayer (region-limited), ARD, ZDF, NPR, Al Jazeera, France.tv',
  },
  {
    group: 'Learning',
    sites: 'Udemy, Coursera, LinkedIn Learning, Skillshare, Pluralsight (enrolled content, Pro plan)',
  },
];

export default function FeatureYoutubeSites() {
  usePageMeta({
    title: 'YouTube & 1000+ sites',
    description:
      'Nexa drives yt-dlp, so YouTube, Vimeo, Twitch, SoundCloud, X and a thousand more sites land in the same queue — with a quality picker, playlists, subtitles and an updater for when sites change.',
  });

  return (
    <FeatureShell
      title="YouTube & 1000+ sites"
      tagline="Nexa does not maintain its own site extractors. It drives yt-dlp, and inherits the work of hundreds of people who fix these sites for a living."
      hero={
        <Figure kind="Screenshot">
          The new-download dialog after probing a YouTube URL: title, duration, thumbnail and the
          quality dropdown from 2160p down to audio-only.
        </Figure>
      }
    >
      <H2 id="what">What it does</H2>
      <P>
        Paste a link from almost any video or audio site and Nexa works out what is behind it: the
        real title, how long it is, which qualities exist, whether it is one item or a playlist of
        four hundred. You pick a quality, it downloads, and the finished file has a sensible name
        instead of <Code>videoplayback</Code>.
      </P>
      <P>
        The engine underneath is <strong className="text-white">yt-dlp</strong>, the open-source
        extractor that most of the internet&apos;s downloading quietly runs on. It ships inside
        Nexa&apos;s installer — there is nothing separate to install, no Python on your machine, and
        no command line. What Nexa adds is everything around it: a queue, the segmented HTTP engine,
        resume, scheduling, cookies from your browser, and a way to update the extractor when a site
        changes without waiting for us to ship a release.
      </P>
      <P>
        This is a deliberate architectural choice rather than a shortcut. A download manager that
        writes its own site plugins is always behind: YouTube alone changes its player often enough
        to break naive extractors several times a year, and every competitor maintaining its own
        parsers covers fewer sites and fixes them more slowly. Standing on yt-dlp means a site that
        broke this morning is usually working again the same week, for everyone.
      </P>

      <H2 id="how">How it works</H2>
      <P>
        When you add a URL, Nexa runs yt-dlp in probe mode first — no download, just a listing of
        available formats. That is what fills the quality dropdown, and it is why the dialog can
        show you a real title and thumbnail before committing to anything.
      </P>
      <P>
        Once you choose, Nexa asks for the best video stream at or below your target plus the best
        audio, and the bundled ffmpeg merges them. High resolutions on YouTube are usually published
        as separate video-only and audio-only streams, which is why a &ldquo;1080p&rdquo; download
        is two fetches and a mux rather than one file.
      </P>
      <P>
        Playlists become one row per entry, with the playlist name as a subfolder, and several
        entries download in parallel up to your concurrency limit. Entries that are private,
        deleted or members-only are skipped with a note rather than failing the whole playlist —
        a 300-video channel should not stop at video 12.
      </P>
      <Flow
        caption="What happens between pasting a link and the finished file."
        steps={[
          { title: 'You paste a URL' },
          { title: 'yt-dlp probes it', detail: 'title, length and formats — nothing downloaded yet' },
          { title: 'You pick a quality' },
          { title: 'Video and audio fetched', detail: 'two streams, in parallel' },
          { title: 'ffmpeg merges them' },
          { title: 'A named file', detail: 'in your Video or Audio folder' },
        ]}
      />
      <P>
        <strong className="text-white">Updating.</strong> Settings &rarr; Video sites &rarr;{' '}
        <strong className="text-white">Update yt-dlp</strong> pulls the latest release into the
        app&apos;s data folder. It does not touch the installed application, needs no admin rights,
        and takes a few seconds. When a site that worked last month suddenly fails, this is the
        first thing to try and it fixes it most of the time.
      </P>

      <H2 id="supported">Sites and options</H2>
      <P>
        yt-dlp supports well over a thousand sites and the list changes weekly, so the honest
        statement is &ldquo;try it&rdquo; rather than an exhaustive table. A representative sample:
      </P>
      <SpecTable
        caption="A sample of the site families supported through yt-dlp"
        head={['Category', 'Examples']}
        rows={SITE_GROUPS.map((g) => [g.group, g.sites])}
      />
      <P className="mt-4">And the options Nexa exposes around them:</P>
      <SpecTable
        caption="Download options available for yt-dlp sites"
        head={['Option', 'Detail']}
        rows={[
          ['Quality', '2160p, 1440p, 1080p, 720p, 480p, or best available'],
          ['Audio only', 'M4A (lossless copy where possible), AAC, FLAC or MP3'],
          ['Playlists & channels', 'One row per entry, playlist name as a subfolder, parallel up to your limit'],
          ['Subtitles', <>Selected languages, embedded or as a sidecar file (Settings &rarr; Video sites)</>],
          ['Chapters & metadata', 'Embedded when the site provides them'],
          ['Login-gated courses', <>Udemy, Coursera, LinkedIn Learning and similar. <strong className="text-white">Pro plan</strong> — see <Link to="/docs/courses" className="text-brand-300 hover:underline">the courses guide</Link>.</>],
          ['Age-restricted content', 'Works when you are signed in and the extension supplies your cookies'],
          ['DRM-protected content', 'Not supported. Netflix, Prime Video and similar are out of scope.'],
        ]}
      />

      <H2 id="use">Using it</H2>
      <Steps
        items={[
          <><strong className="text-white">Paste the URL</strong> into the app with <Code>Ctrl+V</Code>, or click the <strong className="text-white">+</strong> button. Nexa probes it and shows what it found.</>,
          <>Or use the <strong className="text-white">extension</strong>: on a supported page the Nexa button appears; clicking it sends the URL together with your session cookies. Prefer this on anything that needs a login.</>,
          <>Pick a quality, or set a default in <strong className="text-white">Settings &rarr; Video sites</strong> so you are never asked again.</>,
          <>For a playlist, tick <strong className="text-white">Download whole course / playlist</strong> in the dialog before confirming.</>,
          <>If a site starts failing, run <strong className="text-white">Settings &rarr; Video sites &rarr; Update yt-dlp</strong> and retry before doing anything else.</>,
        ]}
      />

      <H2 id="tips">Tips</H2>
      <Tips
        items={[
          'Update yt-dlp first, ask questions second. It resolves the large majority of "this site broke" reports.',
          <>Set a default quality. The picker is useful once; after that it is a dialog between you and the download.</>,
          'For music, M4A copies the source AAC without re-encoding. MP3 re-encodes and is strictly worse unless something you own needs it.',
          'Very high YouTube resolutions are VP9 or AV1. They play everywhere modern; pick 1080p or below if the file is destined for an older TV or car stereo.',
          'A playlist row shows "video 4 of 37" — you can pause the whole playlist from that one row rather than each entry.',
          <>Sign in to the site in your browser before starting a gated download, then use the extension button so your session travels with it.</>,
          'Cookies expire. If a site that worked for weeks starts asking for a login, re-export or just re-trigger from the extension on a freshly loaded page.',
        ]}
      />

      <H2 id="trouble">When it goes wrong</H2>
      <Troubles
        items={[
          {
            symptom: '“Authentication required (HTTP 403)”',
            fix: (
              <>
                The site wants a signed-in session: age-gated, members-only, purchased or private.
                Sign in to it in your browser and start the download with the extension&apos;s Nexa
                button so your cookies are attached. Without the extension, export a Netscape
                <Code>cookies.txt</Code> and add it under Settings &rarr; Site logins. Full walkthrough
                in the <Link to="/docs/youtube" className="text-brand-300 underline underline-offset-2">YouTube guide</Link>.
              </>
            ),
          },
          {
            symptom: '“Media server refused the download (HTTP 403) — stream URL expired or yt-dlp is out of date”',
            fix: (
              <>
                This is deliberately worded differently from the one above because it is{' '}
                <em>not</em> a login problem. The signed media URL aged out, or the extractor no
                longer matches the site&apos;s player. Update yt-dlp and retry.
              </>
            ),
          },
          {
            symptom: 'Only 360p is available',
            fix: (
              <>
                An unauthenticated session is often handed a reduced format list. Sign in and retry
                through the extension. On YouTube this is also the classic symptom of an out-of-date
                yt-dlp that can no longer decipher the higher formats.
              </>
            ),
          },
          {
            symptom: 'A playlist stops part-way',
            fix: (
              <>
                Check the rows that failed — private and deleted entries are skipped with a note and
                are not errors. If genuine entries failed, they can be retried individually from the
                right-click menu without re-downloading the ones that succeeded.
              </>
            ),
          },
          {
            symptom: 'Course downloads are refused',
            fix: (
              <>
                Login-gated course sites are a Pro entitlement, and the app says so rather than
                failing silently. Every account gets a 7-day Pro trial with no card — see{' '}
                <Link to="/pricing" className="text-brand-300 hover:underline">pricing</Link>. DRM-protected
                lectures cannot be downloaded on any plan.
              </>
            ),
          },
        ]}
      />
      <Note tone="warn" title="Windows and browser cookies">
        Chrome, Edge and Brave 127+ encrypt their cookie store so that no external tool can read it
        (App-Bound Encryption). yt-dlp&apos;s own <Code>--cookies-from-browser</Code> therefore does
        not work there. The extension route is unaffected, because it reads cookies through the
        browser&apos;s own API rather than off disk — on Windows, use the extension.
      </Note>

      <H2 id="related">Related features</H2>
      <Related to={['/features/video-grabber', '/features/browser-extension', '/features/scheduler']} />
    </FeatureShell>
  );
}
