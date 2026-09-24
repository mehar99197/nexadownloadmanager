import { Link } from 'react-router-dom';
import usePageMeta from '../../hooks/usePageMeta';
import FeatureShell, {
  H2, P, Steps, Code, Note, Figure, Flow, SpecTable, Tips, Troubles, Related,
} from './FeatureShell';

export default function FeatureVideoGrabber() {
  usePageMeta({
    title: 'Video grabber — HLS & DASH',
    description:
      'How Nexa finds the HLS or DASH stream behind a web player and turns it into a single MP4 you can keep, without re-encoding.',
  });

  return (
    <FeatureShell
      title="Video grabber"
      tagline="Streaming video is thousands of small files pretending to be one. Nexa puts them back together."
      hero={
        <Figure kind="Screenshot">
          A web page with the floating Nexa button over the player, its quality dropdown open showing
          the 1080p / 720p / 480p variants of an HLS stream.
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
        Nexa reads the manifest instead. For HLS, the extension lists the quality levels the site
        published in its master playlist and lets you pick one; a DASH stream is offered as a single
        best-available entry. Every chunk is then downloaded — by the bundled ffmpeg, or by Nexa
        itself when an HLS stream comes with cookies — and ffmpeg copies the video and audio into a
        single MP4 without re-encoding anything, at full speed rather than at 1&times; real time.
      </P>
      <P>
        Because no re-encode happens, a 30-minute lecture takes about as long as its raw size
        divided by your bandwidth. There is no quality loss, and your CPU is essentially idle
        throughout.
      </P>

      <H2 id="how">How it works</H2>
      <P>
        Detection happens in the browser extension, not in the app. The extension&apos;s background
        worker watches the tab&apos;s network requests for a <Code>.m3u8</Code> or <Code>.mpd</Code>{' '}
        playlist (and for plain video and audio files). When it sees one, the content script draws
        the Nexa button over the player, with a dropdown listing what you can download.
      </P>
      <P>
        Picking a quality sends the app the playlist URL for that quality over the local
        native-messaging bridge, together with your browser&apos;s cookies for the stream&apos;s
        host, the page&apos;s address as the <Code>Referer</Code> and your browser&apos;s{' '}
        <Code>User-Agent</Code>. Those are what make the difference between a working download and a
        wall of <Code>403</Code> responses: many CDNs sign segment URLs against the session that
        requested the manifest, and a bare <Code>curl</Code> of the same URL is rejected.
      </P>
      <Flow
        caption="How a stream on a web page becomes one file."
        steps={[
          { title: 'The page plays a video', detail: 'the player requests its manifest' },
          { title: 'The extension spots it', detail: '.m3u8 or .mpd, and draws the button' },
          { title: 'The local bridge', detail: 'playlist URL, cookies, Referer, User-Agent' },
          { title: 'The segments are fetched', detail: 'by ffmpeg, or by Nexa for an HLS stream with cookies' },
          { title: 'ffmpeg joins them', detail: 'streams copied, not re-encoded' },
          { title: 'One MP4 on disk' },
        ]}
      />
      <P>
        In the app, a stream without cookies goes straight to ffmpeg, which downloads the segments
        and writes the MP4 itself. An HLS stream that comes with cookies takes a different route:
        ffmpeg only accepts headers on its command line, where other programs on your computer can
        read them, so Nexa fetches every segment itself — 16 at a time by default, set by{' '}
        <strong className="text-white">Settings &rarr; Downloads &rarr; HLS stream connections</strong>{' '}
        — and hands ffmpeg the downloaded files to join. On that route one failed segment fails the
        whole download, and resuming starts it again from the beginning. That route reads HLS only,
        so a DASH stream that comes with cookies fails. Whichever route it takes, a stream has no
        known size until it is finished, so its row shows the amount downloaded and the speed rather
        than a percentage.
      </P>
      <P>
        Muxing is fast — ffmpeg is copying streams, not transcoding. For a DASH stream without
        cookies, ffmpeg combines the separate video and audio. Separate HLS audio tracks are not
        merged yet: picking a quality hands Nexa only that variant&apos;s playlist, so a site that
        keeps its audio in its own rendition gives you a silent video. Nexa has no subtitle option
        for streams.
      </P>

      <H2 id="supported">What it supports</H2>
      <SpecTable
        caption="Streaming protocols and options supported by the video grabber"
        head={['', 'Support']}
        rows={[
          ['HLS (.m3u8)', 'Yes — master playlists (you pick one variant) and media playlists. A separate audio rendition is not merged yet.'],
          ['MPEG-DASH (.mpd)', <>Yes for a stream without cookies, including separate video and audio adaptation sets. One that comes with cookies fails with &ldquo;not a valid m3u8 playlist&rdquo;.</>],
          ['AES-128 encrypted HLS', <>Yes, when the page provides the key the player itself uses. Widevine/FairPlay DRM is <strong className="text-white">not</strong> supported and never will be.</>],
          ['Live streams', 'No — stopping a live stream ends ffmpeg before it finishes the file, so nothing usable is kept'],
          ['Quality selection', <>HLS: each variant in the master playlist. DASH: one &ldquo;Best available (DASH)&rdquo; entry. No separate audio-only option.</>],
          ['Subtitles', <>Not for streams. The subtitle option in Settings &rarr; Video sites applies to yt-dlp downloads only.</>],
          ['Output container', 'Always MP4, with no re-encoding'],
          ['Parallel segments', <>Only for an HLS stream that comes with cookies: 16 by default, set in Settings &rarr; Downloads &rarr; HLS stream connections. Other streams are downloaded by ffmpeg.</>],
          ['Re-encoding', 'None — ffmpeg copies the video and audio into a new MP4 rather than transcoding them'],
        ]}
      />
      <Note tone="warn" title="What this will not do">
        Nexa does not break DRM. Netflix, Disney+, Prime Video and anything else using Widevine,
        PlayReady or FairPlay are encrypted with keys the player never exposes. Nexa cannot decrypt
        them and does not check for DRM first, so a protected stream either fails or finishes as a
        file that will not play. Downloading content you do not have the
        right to keep is also on you — see the <Link to="/terms" className="text-brand-300 hover:underline">terms</Link>.
      </Note>

      <H2 id="use">Using it</H2>
      <Steps
        items={[
          <>Install the <Link to="/features/browser-extension" className="text-brand-300 hover:underline">browser extension</Link> and launch Nexa once so it registers the local bridge.</>,
          <>Open the page and start the video playing. Some players only request the manifest once playback begins — if the button does not appear, press play.</>,
          <>Click the floating <strong className="text-white">Nexa</strong> button over the player.</>,
          <>Pick a quality. For HLS the list is what the site published; if only one entry appears, that is all it offers to your session. A DASH stream always shows a single entry, &ldquo;Best available (DASH)&rdquo;.</>,
          <>The download appears in the app as a normal row, showing the amount downloaded and the speed. For an HLS stream that came with cookies, the details window also counts segments.</>,
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
          <>If a site always fails, sign in to it first. The extension exports that session&apos;s cookies with the download; a signed-out session simply gets a shorter manifest or none.</>,
          'For an HLS stream that comes with cookies, raise Settings → Downloads → HLS stream connections for slow, far-away CDNs and lower it for sites that start returning errors. Other streams are fetched by ffmpeg, which ignores that setting.',
          'Do not use the grabber to record a live stream. Stopping the row ends ffmpeg before it finishes the file, so the recording is lost.',
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
                Usual causes: playback has not started, so no playlist has been requested yet; the
                player sits inside an embedded frame, in which case the button is parked in the
                page&apos;s top-right corner instead of over the video; or the button is turned off in
                the extension&apos;s options, or paused for this site from its toolbar popup.
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
            symptom: 'The file has video but no sound',
            fix: (
              <>
                Most likely the site keeps its audio in a separate HLS rendition. Picking a quality
                hands Nexa only that variant&apos;s playlist, and Nexa does not merge a separate audio
                track yet, so the video comes out silent. No setting changes this.
              </>
            ),
          },
          {
            symptom: 'The download finishes but the file will not play',
            fix: (
              <>
                The stream is most likely protected with Widevine, PlayReady or FairPlay DRM. Nexa
                does not check for DRM and cannot decrypt it: the keys live in the browser&apos;s
                content-decryption module and are never handed to a page. There is no setting to
                change and no workaround in Nexa.
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
