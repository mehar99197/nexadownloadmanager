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
          <><strong className="text-white">Video detection.</strong> It notices when a page loads an HLS or DASH stream and draws a download button over the player, with the quality levels the site actually published.</>,
          <><strong className="text-white">Your session.</strong> It passes the cookies and request headers for that page along with the URL, so a download from a site you are signed in to works instead of returning 403.</>,
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
        The extension never downloads anything and never talks to our servers. It talks to the Nexa
        app running on your own computer, through the browser&apos;s{' '}
        <strong className="text-white">native messaging</strong> channel: a local pipe the browser
        opens to a small helper program, <Code>nexa-host</Code>, installed alongside the app. The
        helper forwards the message to the running app over a local socket. Nothing leaves your
        machine at any point in that chain.
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
        carrying the URL, the suggested filename, the headers to replay, and flags like
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
            'Read and change data on all sites',
            <>To notice a streaming manifest on the page you are watching and draw the download button, and to read the cookies for <em>that</em> site when you click it. It cannot be scoped to a list, because you can download from any site. It is used on the page you act on, not harvested in the background.</>,
          ],
          [
            'Communicate with cooperating native applications',
            <>The native-messaging bridge to <Code>nexa-host</Code>. This is the entire mechanism — without it the extension can do nothing at all.</>,
          ],
          [
            'Access browser activity during navigation (webRequest)',
            <>To see the media requests a player makes. A stream manifest is fetched by JavaScript and never appears in the DOM, so there is no other way to find it.</>,
          ],
          [
            'Downloads',
            <>To intercept a download the browser was about to start and hand it to Nexa instead — the &ldquo;take over downloads&rdquo; option, which you can turn off.</>,
          ],
          [
            'Cookies',
            <>Read-only, and only for the site of the download you just triggered. They travel over the local bridge to the app on your machine and are never transmitted anywhere else.</>,
          ],
          [
            'Context menus, storage',
            'The right-click entries, and your own extension settings.',
          ],
        ]}
      />
      <Note>
        The <Link to="/security" className="text-brand-300 hover:underline">security page</Link>{' '}
        documents where every piece of data goes, and the{' '}
        <Link to="/privacy" className="text-brand-300 hover:underline">privacy policy</Link> is the
        binding version. Short form: your cookies go from your browser to your own computer, and
        nowhere else.
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
          'Incognito/private windows need the extension explicitly allowed in incognito, and the app still needs to be running.',
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
                The extension reached the bridge but nothing answered — the app is not running, or
                has never been launched since the extension was installed. Start Nexa, wait for the
                window, then reload the page. If it persists, launching the app once more rewrites
                the native-host manifest, which repairs a broken registration.
              </>
            ),
          },
          {
            symptom: 'No download button on any video',
            fix: (
              <>
                Check the extension is enabled for that site in the toolbar popup, that playback has
                started, and that the player is not inside a cross-origin iframe. Progressive MP4
                videos have no manifest and get a right-click entry instead of a floating button.
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
