import { Link } from 'react-router-dom';
import usePageMeta from '../../hooks/usePageMeta';
import DocsShell, { H2, P, Steps, Bullets, Code, Pre, Note } from './DocsShell';

export default function DocsExtension() {
  usePageMeta({
    title: 'Browser extension',
    description: 'Install the Nexa extension in Chrome, Edge, Brave or Firefox, how the native host bridge is registered automatically, and fixing “Nexa: engine unavailable”.',
  });

  return (
    <DocsShell
      title="Browser extension"
      intro="The extension adds a “Download with Nexa” button to pages, sniffs HLS/DASH streams and hands downloads — with the cookies they need — to the app on your computer."
    >
      <Note tone="warn" title="Store listings are not live yet">
        Until the Chrome Web Store, Edge Add-ons and Firefox Add-ons listings are approved, install
        the extension from the packaged zip as described below. The buttons on the download page
        point here on purpose.
      </Note>

      <H2 id="chromium">Chrome, Edge and Brave</H2>
      <Steps
        items={[
          <>Download <Code>nexa-chrome.zip</Code> (or <Code>nexa-edge.zip</Code>) from the <Link to="/download" className="text-brand-300 hover:underline">download page</Link> and unzip it somewhere permanent — the browser loads it from that folder every start.</>,
          <>Open <Code>chrome://extensions</Code> (<Code>edge://extensions</Code> in Edge, <Code>brave://extensions</Code> in Brave) and turn on <strong className="text-white">Developer mode</strong> in the top-right corner.</>,
          <>Click <strong className="text-white">Load unpacked</strong> and choose the unzipped folder. The Nexa icon appears in the toolbar.</>,
          <>Make sure the desktop app is running, then reload any page you already had open so the content script is injected.</>,
        ]}
      />
      <P>When the store listing goes live you will be able to install with one click instead; the unpacked copy can then be removed.</P>

      <H2 id="firefox">Firefox</H2>
      <Steps
        items={[
          <>Download <Code>nexa-firefox.xpi</Code> (or the Firefox zip) from GitHub releases.</>,
          <>Open <Code>about:addons</Code>, click the gear icon and choose <strong className="text-white">Install Add-on From File…</strong>. For an unsigned development build, use <Code>about:debugging#/runtime/this-firefox</Code> &rarr; <strong className="text-white">Load Temporary Add-on</strong> instead (it lasts until Firefox restarts).</>,
          <>Firefox 115 or newer is required.</>,
        ]}
      />

      <H2 id="bridge">How the native host is registered</H2>
      <P>
        Browsers do not let extensions talk to arbitrary programs. They allow a{' '}
        <em>native messaging host</em>: a small executable listed in a JSON manifest that the
        browser looks up by name. Nexa&apos;s host is called <Code>nexa-host</Code>; it reads
        messages from the extension on stdin and relays them to the running app over a local socket.
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
        bridge is about 300 lines of C++ in <Code>native-host/nexa-host.cpp</Code> — open source, so
        you can see that cookies go straight to the local socket and nowhere else.
      </P>

      <H2 id="using">Using it</H2>
      <Bullets
        items={[
          <>Click any download link as usual — the extension intercepts it and the app takes over with multi-connection downloading.</>,
          <>On video pages a floating Nexa button appears when a stream is detected; pick a quality and go.</>,
          <>Right-click &rarr; <strong className="text-white">Download with Nexa</strong> on links, or <strong className="text-white">Download whole course with Nexa</strong> on course pages.</>,
          <>Hold the extension&apos;s toolbar icon menu to pause interception temporarily if you want the browser to handle a download itself.</>,
        ]}
      />

      <H2 id="troubleshooting">Troubleshooting “Nexa: engine unavailable”</H2>
      <P>This message means the extension reached the browser but could not reach the app. Work through these in order:</P>
      <Steps
        items={[
          <><strong className="text-white">Is the app running?</strong> The bridge only relays to a live app. Start Nexa (check the system tray) and try again.</>,
          <><strong className="text-white">Has the app been launched at least once since installing?</strong> The manifests are written on launch. Open the app, close and reopen the browser, and reload the page.</>,
          <><strong className="text-white">Did you load the extension from a folder that still exists?</strong> Chrome shows an error on <Code>chrome://extensions</Code> if the unpacked folder moved.</>,
          <><strong className="text-white">Extension ID mismatch (Chromium):</strong> the host manifest lists the allowed extension ID. The packaged zip includes a fixed <Code>key</Code> so the ID is stable; if you built the extension yourself the ID differs — copy it from <Code>chrome://extensions</Code> into the manifest&apos;s <Code>allowed_origins</Code>, or install the packaged build.</>,
          <><strong className="text-white">Flatpak or snap browsers (Linux):</strong> sandboxed browsers cannot see <Code>~/.config</Code> manifests or run host binaries. Use the <Code>.deb</Code> build of the browser, or grant the sandbox access to the manifest directory.</>,
          <><strong className="text-white">Still stuck?</strong> Run the host by hand to see the error it prints:</>,
        ]}
      />
      <Pre>{`# Linux
~/.local/share/Nexa/nexa-host   # or the path shown in the manifest
# Windows (PowerShell)
& "$env:LOCALAPPDATA\\Programs\\Nexa\\nexa-host.exe"`}</Pre>
      <P>
        Then <Link to="/contact?topic=bug" className="text-brand-300 hover:underline">send us</Link> the output together
        with your browser and OS versions.
      </P>
    </DocsShell>
  );
}
