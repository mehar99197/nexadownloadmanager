import { Link } from 'react-router-dom';
import usePageMeta from '../../hooks/usePageMeta';
import FeatureShell, {
  H2, P, Steps, Code, Note, Figure, Flow, SpecTable, Tips, Troubles, Related,
} from './FeatureShell';

// The sites whose links the app hands to yt-dlp: the providers in
// resources/cloud_providers.json that CloudProviders::isSiteVideoUrl routes.
// src/test/claims-youtube.test.js checks this list against that file.
const SITE_GROUPS = [
  {
    group: 'Video',
    sites: 'YouTube (including Shorts and YouTube Music), Vimeo, Dailymotion, Bilibili',
  },
  {
    group: 'Social',
    sites: 'X (Twitter), Facebook, Instagram, TikTok, Reddit, LinkedIn. Threads links go to yt-dlp too, but it has no Threads support: use the stream the extension detects instead',
  },
  {
    group: 'Live',
    sites: 'Twitch',
  },
  {
    group: 'Music',
    sites: 'Apple Music: full tracks are DRM-protected and cannot be downloaded',
  },
  {
    group: 'Courses (Pro plan)',
    sites: 'Udemy (one lecture at a time; whole courses are not supported), LinkedIn Learning, Pluralsight. Coursera and Skillshare have no yt-dlp support and work only through the stream the extension detects, one lecture at a time',
  },
];

export default function FeatureYoutubeSites() {
  usePageMeta({
    title: 'YouTube & video sites',
    description:
      'Which sites Nexa hands to its bundled yt-dlp (YouTube, Vimeo, TikTok, X, Instagram, Twitch and more), how the quality menu, playlists and subtitles work, and what to do when a site breaks.',
  });

  return (
    <FeatureShell
      title="YouTube & video sites"
      tagline="For YouTube and the other sites on this page, Nexa does not maintain its own extractors. It drives yt-dlp, and inherits the work of the hundreds of open-source contributors who keep up with these sites."
      hero={
        <Figure kind="Screenshot">
          The extension&apos;s Download with NDM menu on a YouTube video: Best available, every
          height the video offers (such as 2160p60 and 1080p) and Audio only (m4a).
        </Figure>
      }
    >
      <H2 id="what">What it does</H2>
      <P>
        Give Nexa a link from YouTube or another site yt-dlp reads (listed below) and yt-dlp works
        out what is behind the page: the real video, its title and which qualities exist. In your browser, the
        extension&apos;s <strong className="text-white">Download with NDM</strong> button lists those
        qualities and you pick one; a link added in the app downloads at the best quality. Either
        way the finished file is named after the video instead of <Code>videoplayback</Code>.
      </P>
      <P>
        The engine underneath is <strong className="text-white">yt-dlp</strong>, the open-source
        extractor that most of the internet&apos;s downloading quietly runs on. It ships inside
        Nexa&apos;s installer, so there is no command line and nothing separate to install; on Linux
        the .deb pulls in <Code>python3</Code>, which yt-dlp runs on, as an ordinary package
        dependency. yt-dlp also does the downloading, with its own downloader rather than
        Nexa&apos;s segmented engine. What Nexa adds is a row in your download list that you can
        pause and resume while the app is open, <strong className="text-white">Start later</strong>,
        and your browser login on the sites that need one. These downloads start straight away
        rather than waiting in the queue, and they are not restored after you restart Nexa.
      </P>
      <P>
        This is a deliberate architectural choice rather than a shortcut. A download manager that
        writes its own site plugins is always behind: YouTube alone changes its player often enough
        to break naive extractors several times a year. Standing on yt-dlp means a site that broke
        this morning is usually fixed upstream within days, and the fix reaches you when a Nexa
        update brings the newer yt-dlp.
      </P>

      <H2 id="how">How it works</H2>
      <P>
        On YouTube, X, TikTok, Reddit, Dailymotion, Twitch and Bilibili, opening the extension&apos;s
        menu makes Nexa run yt-dlp in probe mode first: no download, just a listing of the formats
        on offer. That is what fills the menu with the heights the video really has. On Vimeo,
        Facebook, Instagram, LinkedIn, Udemy and Pluralsight the probe cannot see formats behind
        your login, so the menu offers Best available and Audio only (M4A). A
        link added in the app skips the probe and gets the best quality.
      </P>
      <P>
        Once you choose, Nexa asks for the best video stream at or below your target plus the best
        audio, and the bundled ffmpeg merges them into one MP4. High resolutions on YouTube are
        usually published as separate video-only and audio-only streams, which is why a
        &ldquo;1080p&rdquo; download is two fetches and a mux rather than one file.
      </P>
      <P>
        A playlist or channel is one row that counts videos as they finish, and its files land in
        one folder named after it, numbered in playlist order.{' '}
        <strong className="text-white">Playlist videos in parallel</strong> in Settings sets how
        many download at once (three unless you change it). The plan does not hold them back: Free runs 3 direct downloads at once (videos and torrents not counted).
        A video that cannot be downloaded, such as a private or deleted one, is skipped and the
        rest carry on, so a 300-video channel does not stop at video 12. The finished row says how
        many videos were saved and counts DRM-protected ones separately; other skipped videos are
        not listed.
      </P>
      <Flow
        caption="What happens on YouTube between clicking the extension's button and the finished file. A link added in the app skips the probe and the pick, and gets the best quality."
        steps={[
          { title: 'You click Download with NDM', detail: 'on the video, in your browser' },
          { title: 'yt-dlp probes it', detail: 'which qualities exist — nothing downloaded yet' },
          { title: 'You pick a quality' },
          { title: 'Video, then audio', detail: 'two streams, one after the other' },
          { title: 'ffmpeg merges them', detail: 'into one MP4' },
          { title: 'A named file', detail: 'in your Video folder' },
        ]}
      />
      <P>
        <strong className="text-white">Updating.</strong> There is no separate yt-dlp updater:
        yt-dlp ships inside Nexa, and your copy changes only when you install a Nexa update. When a
        site that worked last month suddenly fails, look for one first with{' '}
        <strong className="text-white">Help &rarr; Check for updates…</strong>.
      </P>

      <H2 id="supported">Sites and options</H2>
      <P>
        Nexa hands links from the sites below to yt-dlp. On any other site, a video downloads only
        when the browser extension finds a direct, HLS or DASH stream on the page, or when you
        paste the address of the video file itself; the{' '}
        <Link to="/features/video-grabber" className="text-brand-300 underline underline-offset-2">video grabber</Link>{' '}
        covers that path.
      </P>
      <SpecTable
        caption="The sites whose links Nexa hands to yt-dlp"
        head={['Category', 'Sites']}
        rows={SITE_GROUPS.map((g) => [g.group, g.sites])}
      />
      <P>
        Udemy, Coursera, LinkedIn Learning, Skillshare, Pluralsight, Vimeo and Facebook are the
        login sites, where Nexa can use your browser login. YouTube never uses your login in Nexa.
      </P>
      <P>
        Where the table says to use the stream the extension detects, open the extension&apos;s
        toolbar popup and click <strong className="text-white">Grab media on this page</strong>. On
        Coursera the <strong className="text-white">Download with NDM</strong> button offers that
        stream too.
      </P>
      <P className="mt-4">And the options Nexa exposes around them:</P>
      <SpecTable
        caption="Download options available for yt-dlp sites"
        head={['Option', 'Detail']}
        rows={[
          ['Quality', <>In the extension&apos;s menu: Best available, every height the video offers and Audio only (M4A), or just Best available and Audio only on the sites where the probe would need your login (above). A link added in the app gets the best quality.</>],
          ['Audio only', <>M4A, picked in the extension&apos;s menu</>],
          ['Playlists & channels', <>One row for the whole list, its files numbered in a folder named after it. <strong className="text-white">Playlist videos in parallel</strong> in Settings sets how many download at once (default 3).</>],
          ['Subtitles', <>Off by default. Turn on <strong className="text-white">Download and embed subtitles</strong> in Settings &rarr; Video sites and list the languages you want (English unless you change it).</>],
          ['Chapters & metadata', 'Not embedded in the file'],
          ['Login-gated courses', <>Udemy, LinkedIn Learning and Pluralsight go to yt-dlp with your browser login, Udemy one lecture at a time because whole courses are not supported. Coursera and Skillshare have no yt-dlp support and work only through the stream the extension detects, one lecture at a time. <strong className="text-white">Pro plan</strong> — see <Link to="/docs/courses" className="text-brand-300 hover:underline">the courses guide</Link>.</>],
          ['Age-restricted content', 'Not when YouTube asks you to sign in to confirm your age: Nexa never sends your YouTube login. On the login sites it works when you are signed in and start the download from the extension.'],
          ['DRM-protected content', 'Not supported. Netflix, Prime Video and similar are out of scope.'],
        ]}
      />

      <H2 id="use">Using it</H2>
      <Steps
        items={[
          <><strong className="text-white">Add the link in the app:</strong> click <strong className="text-white">+ New download</strong> or press <Code>Ctrl+N</Code> (a copied link is filled in for you), or drop the link on the window. It downloads at the best quality.</>,
          <>Or use the <strong className="text-white">extension</strong>: hover a video on one of the sites yt-dlp reads, click the <strong className="text-white">Download with NDM</strong> button that appears over it, and pick a quality. Prefer this on the login sites, because it sends your login with the link.</>,
          <>There is no default-quality setting: a link added in the app always gets the best quality, and the extension&apos;s menu asks each time.</>,
          <>For a playlist or channel, tick <strong className="text-white">Download whole course / playlist</strong> in the New download dialog, or pick a quality under <strong className="text-white">Entire playlist</strong> in the extension&apos;s menu on a YouTube playlist.</>,
          <>If a site starts failing, look for a Nexa update with <strong className="text-white">Help &rarr; Check for updates…</strong> and retry before doing anything else. A newer yt-dlp only arrives with a Nexa update.</>,
        ]}
      />

      <H2 id="tips">Tips</H2>
      <Tips
        items={[
          'Update Nexa first, ask questions second. A newer yt-dlp only arrives with a Nexa update, and a stale yt-dlp is the most common reason a site stops working.',
          'Adding a link in the app is the quick route: no menu, best quality. Use the extension when you want a smaller file.',
          'For music, pick Audio only (m4a) in the extension: it saves the audio stream the site serves as it is, without re-encoding.',
          'Very high YouTube resolutions are VP9 or AV1. They play everywhere modern; Nexa has no H.264 option, and picking 1080p or below does not guarantee H.264 for an older TV or car stereo.',
          'A playlist is one row: hover its status for a line like "4/37 videos · 1.2 GB · 3 downloading", and pause the whole playlist from that one row.',
          <>On a login site, sign in to it in your browser before starting the download, then start the download from the extension so your session travels with it. YouTube never uses your login in Nexa.</>,
          'Logins expire. If a login site that worked for weeks starts asking for a login, sign in again in your browser and start the download from the extension on a freshly loaded page.',
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
                On a login site, sign in to it in your browser and start the download with the
                extension&apos;s <strong className="text-white">Download with NDM</strong> button so
                your login is attached. Without the extension, open{' '}
                <strong className="text-white">Tools &rarr; Site logins…</strong>, pick the site and your
                browser, and click <strong className="text-white">Use browser login</strong>. YouTube never uses your login in Nexa, so signing in will not fix it
                there. Full walkthrough
                in the <Link to="/docs/youtube" className="text-brand-300 underline underline-offset-2">YouTube guide</Link>.
              </>
            ),
          },
          {
            symptom: '“Media server refused the download (HTTP 403) — the stream URL expired or yt-dlp is out of date”',
            fix: (
              <>
                This is deliberately worded differently from the one above because it is{' '}
                <em>not</em> a login problem. The signed media URL aged out, or the extractor no
                longer matches the site&apos;s player. Retry first: yt-dlp reads the page again and
                gets a fresh address. If it keeps failing, the message&apos;s advice to update
                yt-dlp means updating Nexa, because yt-dlp ships inside it.
              </>
            ),
          },
          {
            symptom: 'Only 360p is available',
            fix: (
              <>
                On a login site, an unauthenticated session is often handed a reduced format list:
                sign in and retry through the extension. On YouTube, where Nexa never sends your
                login, this is the classic symptom of an out-of-date yt-dlp that can no longer
                decipher the higher formats, so look for a Nexa update.
              </>
            ),
          },
          {
            symptom: 'A playlist stops part-way',
            fix: (
              <>
                A playlist is one row, so failed videos cannot be retried one by one. The finished
                row says how many videos were saved and counts DRM-protected ones; private and
                deleted videos are skipped without a note. To fetch what is missing, right-click the
                row and choose Resume: yt-dlp goes through the playlist again and skips the videos
                already on disk.
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
