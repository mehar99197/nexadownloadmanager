import { Link } from 'react-router-dom';
import usePageMeta from '../../hooks/usePageMeta';
import FeatureShell, {
  H2, P, Steps, Bullets, Code, Note, Figure, Flow, SpecTable, Tips, Troubles, Related,
} from './FeatureShell';

export default function FeatureBrowserExtension() {
  usePageMeta({
    title: 'Browser extension',
    description:
      'The Nexa extension for Chrome, Edge, Brave and Firefox: one-click handoff, video detection, and the cookies an authenticated download needs — over a local bridge, never through our servers.',
  });

  return (
    <FeatureShell
      title="Browser extension"
      tagline="A bridge, not a downloader. It hands the app the URL, the headers and the cookies — then gets out of the way."
      hero={
        <Figure kind="Screenshot">
          A browser window with the Nexa toolbar icon open, showing the recent-handoffs list and the
          per-site toggle.
        </Figure>
      }
    >
      <H2 id="what">What it does</H2>
      <P>
        Three things, all of which are awkward without it.
      </P>
      <Bullets
        items={[
          <><strong className="text-white">One-click handoff.</strong> Right-click any link and send it to Nexa, or let the extension take over downloads automatically so clicking a file in the browser starts it in the app instead.</>,
          <><strong className="text-white">Video detection.</strong> It notices when a page loads a stream (HLS or DASH) or a video or audio file, and draws a download button over the player — or in the page&apos;s top-right corner when the page has no player of its own, as when it sits in a cross-origin iframe. For HLS it lists each quality in the stream&apos;s master playlist; DASH gets a single &ldquo;Best available (DASH)&rdquo; entry, and neither offers audio only. On YouTube and the other public video sites it supports, the app looks the qualities up with yt-dlp.</>,
          <><strong className="text-white">Your session.</strong> It passes the cookies the download needs, the referrer and your browser&apos;s user agent along with the URL — for some services the cookies of their sign-in domain too, and on AI-assistant sites the file request&apos;s own headers — so a download from a site you are signed in to works instead of returning 403.</>,
        ]}
      />
      <P>
        That third point is the whole reason the extension exists. A URL copied out of a browser and
        pasted into any download manager is a URL without a session. For public files that is fine.
        For anything behind a login — a purchased course, a members-only video, a file on a site
        that checks <Code>Referer</Code> — it fails, and the failure looks like a broken download
        manager rather than a missing cookie.
      </P>

      <H2 id="how">How it works</H2>
      <P>
        The extension never talks to our servers, and it does not download files itself. The one
        request it makes to a website is for a stream&apos;s HLS master playlist, fetched from the
        site you are watching, with that site&apos;s cookies, when you open the quality list.
        Everything else goes to the Nexa app running on your own computer, through the
        browser&apos;s <strong className="text-white">native messaging</strong> channel: a local
        pipe the browser opens to a small helper program, <Code>nexa-host</Code>, installed
        alongside the app. The helper forwards the message to the app over a local socket,
        starting the app first if it is not running. Nothing leaves your machine at any point in
        that chain.
      </P>
      <Flow
        caption="The path a download takes from the browser to the app."
        steps={[
          { title: 'The web page' },
          { title: 'Extension service worker', detail: 'URL, cookies and headers' },
          { title: 'Native messaging', detail: 'the browser starts nexa-host' },
          { title: 'nexa-host', detail: 'a small helper beside the app' },
          { title: 'Local socket' },
          { title: 'Nexa app', detail: 'the download starts' },
        ]}
        note="Every step happens on your own computer. Nexa's servers are not in this path."
      />
      <P>
        Registration is automatic. Every time Nexa launches it rewrites the native-host manifests
        for the browsers it finds installed, so the bridge repairs itself after a browser update, a
        profile reset or an app reinstall. You should never have to edit a JSON file by hand.
      </P>
      <P>
        The messages themselves are small and boring on purpose — a length-prefixed JSON object
        carrying the URL, the suggested filename, the cookies and headers to replay, and flags like
        &ldquo;this is a playlist&rdquo; or &ldquo;ask me before starting&rdquo;. Because both the
        extension and the app are open source, you can read exactly what is sent rather than taking
        our word for it.
      </P>

      <H2 id="permissions">The permissions, and why each one exists</H2>
      <P>
        Extension permission prompts are alarming by design and most extensions do not explain
        them. Here is every permission Nexa asks for and what it is actually used for.
      </P>
      <SpecTable
        caption="Browser permissions requested by the Nexa extension and their purpose"
        head={['Permission', 'Why it is needed']}
        rows={[
          [
            'Host access to all sites (<all_urls>)',
            <>The download button has to work on any site, so the page script runs on every page and looks for video players, requests are watched on every site, and cookies can be read for any site you download from. To list a stream&apos;s qualities the extension also fetches its HLS master playlist from the site you are watching, with that site&apos;s cookies. It cannot be scoped to a list, because you can download from any site.</>,
          ],
          [
            'nativeMessaging',
            <>The native-messaging bridge to <Code>nexa-host</Code>, which starts the app if it is not running. Every hand-off goes this way, and so does the quality lookup the extension starts by itself about a second after a YouTube video page, or a page on the other public video sites it supports, loads.</>,
          ],
          [
            'webRequest',
            <>Watches the requests every tab makes, in the background, for streams and media files, and keeps a list per tab until the tab navigates or closes. A stream manifest is fetched by JavaScript and never appears in the DOM, so there is no other way to find it. On about two dozen AI-assistant sites it also keeps each request&apos;s headers, Cookie and Authorization included, for two minutes, so an attachment download can reuse them.</>,
          ],
          [
            'downloads',
            <>To intercept a download the browser was about to start and hand it to Nexa instead — the &ldquo;take over downloads&rdquo; option, which you can turn off.</>,
          ],
          [
            'cookies',
            <>Read-only. It reads the cookies for a download you hand over and, for some services, their sign-in domain too: an Instagram download also carries your facebook.com cookies, a OneDrive or microsoft.com download your live.com cookies, and a Google Drive download every google.com cookie. They travel over the local bridge to the app, which uses them for your downloads from that site; they never reach our servers.</>,
          ],
          [
            'tabs',
            <>Reads the address and title of the tab you are using, to name files and send the page to Nexa. On install and each time the browser starts, it reads every open tab&apos;s address to add the download button there.</>,
          ],
          [
            'scripting',
            <>Adds the download button to tabs that were already open when the extension was installed or the browser started. Chrome and Firefox both use it.</>,
          ],
          [
            'storage',
            <>Your extension settings, your last 8 hand-offs and your last 20 errors, kept in the browser on this computer. The per-tab media lists and captured headers sit in session storage, which the browser clears when it closes.</>,
          ],
          [
            'contextMenus',
            <>Four right-click entries: <strong className="text-white">Download with Nexa</strong>, <strong className="text-white">Download video/audio with Nexa</strong>, <strong className="text-white">Download all links on page</strong> and <strong className="text-white">Download whole course with Nexa</strong>.</>,
          ],
          [
            'notifications',
            <>&ldquo;Sent to Nexa&rdquo; after each hand-off (you can turn it off), the result of sending a page&apos;s links, and errors.</>,
          ],
        ]}
      />
      <Note>
        The <Link to="/security" className="text-brand-300 hover:underline">security page</Link>{' '}
        documents where every piece of data goes, and the{' '}
        <Link to="/privacy" className="text-brand-300 hover:underline">privacy policy</Link> is the
        binding version. Short form: your cookies go from your browser to the Nexa app on your own
        computer, which uses them for your downloads from that site. They never reach our servers.
      </Note>

      <H2 id="install">Installing it</H2>
      <Note tone="warn" title="Store listings are not live yet">
        Nexa is new, and the Chrome Web Store and Firefox Add-ons listings are still in review. For
        now the extension is installed from the packaged zip on the{' '}
        <Link to="/download" className="text-brand-300 hover:underline">download page</Link>. That is
        a few more clicks and we would rather say so plainly than pretend otherwise — the store
        links will replace this note the moment they are live.
      </Note>
      <P><strong className="text-white">Chrome, Edge and Brave</strong></P>
      <Steps
        items={[
          <>Download <Code>nexa-chrome.zip</Code> (or <Code>nexa-edge.zip</Code>) and unzip it to a folder you will keep — deleting it later removes the extension.</>,
          <>Open <Code>chrome://extensions</Code> (<Code>edge://extensions</Code>, <Code>brave://extensions</Code>).</>,
          <>Turn on <strong className="text-white">Developer mode</strong>, top right.</>,
          <>Click <strong className="text-white">Load unpacked</strong> and choose the unzipped folder.</>,
          <>Launch Nexa once so it registers the bridge, then reload any tab you want to download from.</>,
        ]}
      />
      <Figure kind="Screenshot">
        The Chrome extensions page with Developer mode on and the Load unpacked button highlighted.
      </Figure>
      <P className="mt-4"><strong className="text-white">Firefox</strong></P>
      <Steps
        items={[
          <>Download <Code>nexa-firefox.zip</Code>.</>,
          <>Open <Code>about:debugging#/runtime/this-firefox</Code>.</>,
          <>Click <strong className="text-white">Load Temporary Add-on</strong> and pick the zip.</>,
          <>Launch Nexa once, then reload your tabs.</>,
        ]}
      />
      <Note tone="warn">
        A temporary add-on in Firefox is removed when the browser restarts. The signed
        permanent version arrives with the Add-ons listing; until then Firefox users should expect
        to reload it after a restart. Chromium browsers keep an unpacked extension across restarts.
      </Note>

      <H2 id="tips">Tips</H2>
      <Tips
        items={[
          'Launch Nexa at least once after installing the extension. The bridge is registered by the app, not by the browser.',
          <>Turn off &ldquo;take over downloads&rdquo; for sites where you want the browser to handle things — the toolbar popup has a per-site toggle.</>,
          'Press play before expecting a video button. Players fetch their manifest lazily.',
          <>Enable &ldquo;ask before handing off&rdquo; if you want a confirmation dialog in the app rather than downloads simply starting.</>,
          'Sign in to a site first, then click the Nexa button — the cookies are read at the moment you click.',
          'Incognito/private windows need the extension explicitly allowed in incognito.',
          'If you use several browsers, install it in each; the app registers the bridge for all of them, but each browser needs its own copy of the extension.',
        ]}
      />

      <H2 id="trouble">When it goes wrong</H2>
      <Troubles
        items={[
          {
            symptom: '“Nexa: engine unavailable”',
            fix: (
              <>
                The bridge ran but could not reach the app. <Code>nexa-host</Code> starts Nexa
                itself when it is not running and waits about six seconds for it, so this means the
                app did not answer in that time: it was still starting, or it could not be started
                from the folder the bridge is in. Start Nexa yourself, wait for the window, then try
                again. If it persists, launching the app once more rewrites the native-host
                manifest, which repairs a broken registration.
              </>
            ),
          },
          {
            symptom: 'No download button on any video',
            fix: (
              <>
                Check that the floating button is switched on in the extension&apos;s options and
                that the site is not paused in the toolbar popup, then start playback: on most sites
                the button appears once the player requests its stream or video file, progressive
                MP4s included. A player inside a cross-origin iframe gets the button parked in the
                page&apos;s top-right corner rather than over the video.
              </>
            ),
          },
          {
            symptom: 'The extension disappears after restarting Firefox',
            fix: (
              <>
                Expected: <Code>about:debugging</Code> installs it temporarily. Firefox only keeps
                signed add-ons permanently, which needs the Add-ons store listing. Reload it after
                each restart in the meantime.
              </>
            ),
          },
          {
            symptom: 'Downloads start in the browser instead of Nexa',
            fix: (
              <>
                &ldquo;Take over downloads&rdquo; is off, either globally or for that site. Check the
                toolbar popup. Some browsers also bypass extensions for downloads started by a
                page&apos;s own JavaScript — right-click and use <strong className="text-white">Download with Nexa</strong> there.
              </>
            ),
          },
          {
            symptom: 'A course site downloads the preview instead of the lecture',
            fix: (
              <>
                The page was opened without a signed-in session, so the player was given the free
                preview. Sign in, reload, and start again. Login-gated course sites also need the Pro
                entitlement — see the <Link to="/docs/courses" className="text-brand-300 hover:underline">courses guide</Link>.
              </>
            ),
          },
        ]}
      />

      <H2 id="related">Related features</H2>
      <Related to={['/features/video-grabber', '/features/youtube-sites', '/features/acceleration']} />
    </FeatureShell>
  );
}
