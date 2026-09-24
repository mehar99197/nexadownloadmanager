import { Link } from 'react-router-dom';
import usePageMeta from '../../hooks/usePageMeta';
import FeatureShell, {
  H2, P, Steps, Code, Note, Figure, Flow, SpecTable, Tips, Troubles, Related,
} from './FeatureShell';

export default function FeatureVideoGrabber() {
  usePageMeta({
    title: 'Video grabber — HLS & DASH',
    description:
      'How Nexa finds the HLS or DASH stream behind a web player, fetches its segments in parallel and muxes them into a single MP4 you can keep.',
  });

  return (
    <FeatureShell
      title="Video grabber"
      tagline="Streaming video is thousands of small files pretending to be one. Nexa puts them back together."
      hero={
        <Figure kind="Screenshot">
          A web page with the floating Nexa button over the player, its quality dropdown open showing
          1080p / 720p / 480p and the audio-only option.
        </Figure>
      }
    >
      <H2 id="what">What it does</H2>
      <P>
        Almost no site serves video as a single file any more. A player downloads a small text
        manifest listing hundreds or thousands of short chunks, then fetches them a few seconds
        ahead of what you are watching. That is why &ldquo;save video as&rdquo; in a browser gives
        you nothing useful, and why a screen recorder is the usual fallback — a real-time capture of
        something you already had the data for.
      </P>
      <P>
        Nexa reads the manifest instead. It parses the HLS playlist (or the DASH description),
        lists the quality levels the site actually published, and lets you pick one. Then it
        downloads every chunk of that level — many at a time, not in playback order — and hands the
        result to the bundled ffmpeg, which wraps the video and audio streams into a single MP4 or
        MKV without re-encoding anything. The file you get is bit-for-bit the stream the site sent,
        at full speed rather than at 1&times; real time.
      </P>
      <P>
        Because no re-encode happens, a 30-minute lecture takes about as long as its raw size
        divided by your bandwidth. There is no quality loss, and your CPU is essentially idle
        throughout.
      </P>

      <H2 id="how">How it works</H2>
      <P>
        Detection happens in the browser extension, not in the app. The extension&apos;s content
        script watches for the page requesting a <Code>.m3u8</Code> or <Code>.mpd</Code>, and
        for <Code>&lt;video&gt;</Code> elements whose source is a media-source blob — which is the
        giveaway that the real stream is being fed in by JavaScript. When it finds one it draws the
        Nexa button over the player and offers the quality levels the manifest declares.
      </P>
      <P>
        Clicking it sends the app four things over the local native-messaging bridge: the manifest
        URL, the quality you picked, the page&apos;s cookies for that site, and the request headers
        the player itself was using — <Code>Referer</Code>, <Code>Origin</Code> and{' '}
        <Code>User-Agent</Code>. That last part is what makes the difference between a working
        download and a wall of <Code>403</Code> responses: many CDNs sign segment URLs against the
        session that requested the manifest, and a bare <Code>curl</Code> of the same URL is
        rejected.
      </P>
      <Flow
        caption="How a stream on a web page becomes one file."
        steps={[
          { title: 'The page plays a video', detail: 'the player requests its manifest' },
          { title: 'The extension spots it', detail: '.m3u8 or .mpd, and draws the button' },
          { title: 'The local bridge', detail: 'URL, quality, cookies and headers' },
          { title: 'Nexa fetches the segments', detail: '16 at a time by default' },
          { title: 'ffmpeg joins them', detail: 'streams copied, not re-encoded' },
          { title: 'One MP4 on disk' },
        ]}
      />
      <P>
        In the app, segment fetching runs with its own concurrency setting (16 by default, separate
        from the per-file connection count, because a stream is many small requests rather than one
        large one). Failed segments are retried individually against a budget; a stream does not
        fail because chunk 847 of 2,000 timed out once. Progress counts segments, so the percentage
        is real rather than interpolated from bytes.
      </P>
      <P>
        Muxing is the last step and it is fast — ffmpeg is copying streams, not transcoding. If the
        stream carries separate video and audio renditions, both are fetched and combined; if it
        carries subtitle tracks and you asked for them, they are embedded too.
      </P>

      <H2 id="supported">What it supports</H2>
      <SpecTable
        caption="Streaming protocols and options supported by the video grabber"
        head={['', 'Support']}
        rows={[
          ['HLS (.m3u8)', 'Yes — master playlists with multiple renditions, and media playlists'],
          ['MPEG-DASH (.mpd)', 'Yes — including separate video and audio adaptation sets'],
          ['AES-128 encrypted HLS', <>Yes, when the page provides the key the player itself uses. Widevine/FairPlay DRM is <strong className="text-white">not</strong> supported and never will be.</>],
          ['Live streams', 'Partial — a live playlist is downloaded from the current edge until you stop it'],
          ['Quality selection', 'Every rendition the manifest declares, plus audio-only'],
          ['Subtitles', <>WebVTT tracks, embedded on request (Settings → Video)</>],
          ['Output container', 'MP4 by default, MKV when the stream needs it. No re-encoding either way.'],
          ['Parallel segments', '16 by default, configurable in Settings → Video sites'],
          ['Byte-identical output', 'Yes — ffmpeg copies the streams rather than transcoding'],
        ]}
      />
      <Note tone="warn" title="What this will not do">
        Nexa does not break DRM. Netflix, Disney+, Prime Video and anything else using Widevine,
        PlayReady or FairPlay are encrypted with keys the player never exposes, and the grabber will
        tell you so rather than producing a scrambled file. Downloading content you do not have the
        right to keep is also on you — see the <Link to="/terms" className="text-brand-300 hover:underline">terms</Link>.
      </Note>

      <H2 id="use">Using it</H2>
      <Steps
        items={[
          <>Install the <Link to="/features/browser-extension" className="text-brand-300 hover:underline">browser extension</Link> and launch Nexa once so it registers the local bridge.</>,
          <>Open the page and start the video playing. Some players only request the manifest once playback begins — if the button does not appear, press play.</>,
          <>Click the floating <strong className="text-white">Nexa</strong> button over the player.</>,
          <>Pick a quality. The list is what the site published; if only one entry appears, that is all it offers to your session.</>,
          <>The download appears in the app as a normal row. Segment count and throughput are in the details window.</>,
          <>Nothing to do at the end — the muxed file is already in your downloads folder, in the Video category.</>,
        ]}
      />
      <P>
        Without the extension you can still paste an <Code>.m3u8</Code> or <Code>.mpd</Code> URL
        straight into the app. That works for open streams, and fails on anything that checks
        headers or cookies — which is most commercial sites, and exactly what the extension exists
        to solve.
      </P>

      <H2 id="tips">Tips</H2>
      <Tips
        items={[
          'Press play before looking for the button. Lazy players do not fetch their manifest until the first frame is wanted.',
          'Pick the quality you will actually watch. The top rendition is often two to three times the size of the one below it for a difference you cannot see on a laptop.',
          'Audio-only is on the same menu, and is the right answer for a recorded talk or a podcast episode.',
          <>If a site always fails, sign in to it first. The extension exports that session&apos;s cookies with the download; a signed-out session simply gets a shorter manifest or none.</>,
          'Raise the parallel-segment count for slow, far-away CDNs and lower it for sites that start returning errors — it is in Settings → Video sites.',
          'A live stream keeps downloading until you stop it. Stop the row when you have what you want; the part already fetched is muxed and kept.',
          <>For YouTube and the other thousand-odd sites with their own extractors, the <Link to="/features/youtube-sites" className="text-brand-300 hover:underline">yt-dlp path</Link> is better than raw manifest grabbing — it handles their signing and format juggling for you.</>,
        ]}
      />

      <H2 id="trouble">When it goes wrong</H2>
      <Troubles
        items={[
          {
            symptom: 'No Nexa button appears over the video',
            fix: (
              <>
                Three usual causes, in order of likelihood: playback has not started so no manifest
                has been requested; the player is inside a cross-origin iframe the content script
                cannot reach; or the video is a plain progressive MP4, in which case there is nothing
                to grab — right-click it and use <strong className="text-white">Download with Nexa</strong> instead.
                The <Link to="/docs/extension" className="text-brand-300 underline underline-offset-2">extension guide</Link> has the full checklist.
              </>
            ),
          },
          {
            symptom: 'The download starts and immediately fails with 403',
            fix: (
              <>
                The segment URLs are signed against the session that fetched the manifest and it has
                expired, or you started the download from a stale tab. Reload the page, press play,
                and click the button again. This is a fresh-manifest problem, not a login problem.
              </>
            ),
          },
          {
            symptom: 'The file has video but no sound (or the other way round)',
            fix: (
              <>
                A DASH stream with separate adaptation sets where one of them failed to fetch. The
                app logs which one; retry the download. If it repeats, drop the parallel-segment
                count — some CDNs drop the audio requests first under load.
              </>
            ),
          },
          {
            symptom: '“This stream is DRM protected”',
            fix: (
              <>
                The manifest declares a Widevine, PlayReady or FairPlay key system. There is no
                setting to change and no workaround in Nexa; the keys live in the browser&apos;s
                content-decryption module and are never handed to a page. Nothing downloaded would
                be playable.
              </>
            ),
          },
          {
            symptom: 'Only 360p is offered when the site plays 1080p',
            fix: (
              <>
                You are seeing the manifest your session was given. Sign in (many sites gate higher
                renditions behind an account), or switch the player to the quality you want first —
                some sites publish a narrow manifest and widen it after an explicit quality change.
              </>
            ),
          },
        ]}
      />

      <H2 id="related">Related features</H2>
      <Related to={['/features/youtube-sites', '/features/browser-extension', '/features/acceleration']} />
    </FeatureShell>
  );
}
