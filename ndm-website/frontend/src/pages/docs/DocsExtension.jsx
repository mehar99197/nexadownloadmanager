import { Link } from 'react-router-dom';
import usePageMeta from '../../hooks/usePageMeta';
import DocsShell, { H2, P, Steps, Bullets, Code, Note } from './DocsShell';

export default function DocsExtension() {
  usePageMeta({
    title: 'Browser extension',
    description: 'Install the Nexa extension in Chrome, Edge, Brave or Firefox, how the native host bridge is registered automatically, and fixing “Nexa: engine unavailable”.',
  });

  return (
    <DocsShell
      title="Browser extension"
      intro="The extension puts a “Download with NDM” button on video players and “Download with Nexa” in the right-click menu, sniffs HLS/DASH streams and hands downloads — with the cookies they need — to the app on your computer."
    >
      <Note tone="warn" title="Store listings are not live yet">
        Until the Chrome Web Store, Edge Add-ons and Firefox Add-ons listings are approved, install
        the extension from the packaged zip as described below. The buttons on the download page
        point here on purpose.
      </Note>

      <H2 id="chromium">Chrome, Edge and Brave</H2>
      <Steps
        items={[
          <>Download <a href="/downloads/nexa-chrome.zip" download className="text-brand-300 hover:underline"><Code>nexa-chrome.zip</Code></a> (or <a href="/downloads/nexa-edge.zip" download className="text-brand-300 hover:underline"><Code>nexa-edge.zip</Code></a> for Edge) and unzip it somewhere permanent — the browser loads it from that folder every start. Both are also on the <Link to="/download" className="text-brand-300 hover:underline">download page</Link>.</>,
          <>Open <Code>chrome://extensions</Code> (<Code>edge://extensions</Code> in Edge, <Code>brave://extensions</Code> in Brave) and turn on <strong className="text-white">Developer mode</strong>. The switch is in the top-right corner in Chrome and Brave, and in the left pane in Edge.</>,
          <>Click <strong className="text-white">Load unpacked</strong> and choose the unzipped folder. The Nexa icon appears in the toolbar.</>,
          <>Make sure the desktop app is running, then reload any page you already had open so the content script is injected.</>,
        ]}
      />
      <P>When the store listing goes live you will be able to install with one click instead; the unpacked copy can then be removed.</P>

      <H2 id="firefox">Firefox</H2>
      <Steps
        items={[
          <>Download <a href="/downloads/nexa-firefox.zip" download className="text-brand-300 hover:underline"><Code>nexa-firefox.zip</Code></a> (also on the <Link to="/download" className="text-brand-300 hover:underline">download page</Link>).</>,
          <>Open <Code>about:debugging#/runtime/this-firefox</Code>, click <strong className="text-white">Load Temporary Add-on…</strong> and pick the zip. Until the Add-ons listing is approved the build is unsigned, so release Firefox only accepts it this way — and a temporary add-on lasts until Firefox restarts. Once the listing is live it installs permanently with one click.</>,
          <>Firefox 115 or newer is required.</>,
        ]}
      />

      <H2 id="bridge">How the native host is registered</H2>
      <P>
        Browsers do not let extensions talk to arbitrary programs. They allow a{' '}
        <em>native messaging host</em>: a small executable listed in a JSON manifest that the
        browser looks up by name. Nexa&apos;s host is registered as <Code>com.nexa.host</Code> and
        runs the program <Code>nexa-host</Code>, which reads messages from the extension on stdin and
        relays them to the app over a local socket, starting the app first if it is not running.
      </P>
      <P>
        You never install that manifest by hand. <strong className="text-white">Every time the app
        launches</strong> it rewrites the manifests for Chrome, Edge, Brave and Firefox to point at
        the current <Code>nexa-host</Code> path:
      </P>
      <Bullets
        items={[
          <>Windows: registry keys under <Code>HKCU\Software\Google\Chrome\NativeMessagingHosts</Code> (and the Edge, Brave and Mozilla equivalents) pointing at a manifest next to the app. The installer also writes machine-wide HKLM keys so it works for every user account.</>,
          <>Linux: <Code>~/.config/google-chrome/NativeMessagingHosts/</Code>, <Code>~/.config/microsoft-edge/…</Code>, <Code>~/.config/BraveSoftware/Brave-Browser/…</Code> and <Code>~/.mozilla/native-messaging-hosts/</Code>.</>,
        ]}
      />
      <P>
        Moving or reinstalling the app therefore fixes itself the next time you open it. The whole
        bridge is about 240 lines of C++ in <Code>native-host/nexa-host.cpp</Code> — open source, so
        you can see that cookies go straight to the local socket and nowhere else.
      </P>

      <H2 id="using">Using it</H2>
      <Bullets
        items={[
          <>Click a download link as usual. The extension takes over the file types on its list — archives, disk images, installers, video, audio, documents and torrents by default, plus any file whose type it cannot tell — and the app downloads them with multiple connections. Change the list under <strong className="text-white">File types</strong> in the extension&apos;s Options.</>,
          <>On video pages a floating <strong className="text-white">Download with NDM</strong> button appears when a stream is detected; pick a quality and go.</>,
          <>Right-click &rarr; <strong className="text-white">Download with Nexa</strong> on links, or <strong className="text-white">Download whole course with Nexa</strong> on course pages.</>,
          <>To let the browser handle downloads itself, click the Nexa toolbar icon and turn off <strong className="text-white">Take over downloads</strong>, or turn on <strong className="text-white">Pause on this site</strong> to keep Nexa out of the site you are on.</>,
        ]}
      />

      <H2 id="troubleshooting">Troubleshooting “Nexa: engine unavailable”</H2>
      <P>This message means the extension reached the browser but could not reach the app. Work through these in order:</P>
      <Steps
        items={[
          <><strong className="text-white">Is the app running?</strong> If it is not, the bridge starts it in the background and waits about six seconds for it to answer before giving up with this message. Start Nexa yourself (check the system tray) and try again.</>,
          <><strong className="text-white">Has the app been launched at least once since installing?</strong> The manifests are written on launch. Open the app, close and reopen the browser, and reload the page.</>,
          <><strong className="text-white">Did you load the extension from a folder that still exists?</strong> Chrome shows an error on <Code>chrome://extensions</Code> if the unpacked folder moved.</>,
          <><strong className="text-white">Extension ID mismatch (Chromium):</strong> the host manifest lists the extension IDs allowed to connect. The extension&apos;s <Code>manifest.json</Code> carries a fixed <Code>key</Code>, so the packaged zip and a copy loaded from the repository get the same ID. If <Code>chrome://extensions</Code> shows a different ID for yours, do not edit the host manifest: the app rewrites it on every launch. Put the ID in the <Code>NEXA_EXTRA_EXTENSION_IDS</Code> environment variable (comma-separated for several) or the app&apos;s <Code>nativeHost/extraChromeIds</Code> setting, then restart Nexa.</>,
          <><strong className="text-white">Flatpak or snap browsers (Linux):</strong> sandboxed browsers cannot see <Code>~/.config</Code> manifests or run host binaries. Use the <Code>.deb</Code> build of the browser, or grant the sandbox access to the manifest directory.</>,
          <><strong className="text-white">Still stuck?</strong> Collect what the extension and the app recorded. In the extension&apos;s Options, click <strong className="text-white">Export diagnostics</strong>: it copies a report of the extension&apos;s version, your browser, its settings and its recent errors and handoffs to the clipboard. In the app, turn on <strong className="text-white">Save error logs to a file</strong> in Settings, reproduce the problem, then choose <strong className="text-white">File &rarr; Export logs…</strong>.</>,
        ]}
      />
      <P>
        Then <Link to="/contact?topic=bug" className="text-brand-300 hover:underline">send us</Link> both, together
        with your browser and OS versions.
      </P>
    </DocsShell>
  );
}
