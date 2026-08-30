import { Link } from 'react-router-dom';
import usePageMeta from '../../hooks/usePageMeta';
import DocsShell, { H2, P, Steps, Bullets, Code, Pre, Note } from './DocsShell';

export default function DocsInstall() {
  usePageMeta({
    title: 'Install',
    description: 'Install Nexa Download Manager on Windows (installer) or Ubuntu/Debian (.deb). yt-dlp, ffmpeg and aria2 are bundled.',
  });

  return (
    <DocsShell
      title="Install Nexa"
      intro="Two builds: a Windows installer and a Debian package. Both bundle everything the app needs, so there is nothing else to install."
    >
      <H2 id="windows">Windows</H2>
      <Steps
        items={[
          <>Grab the installer from the <Link to="/download" className="text-brand-300 hover:underline">download page</Link>. It is a standard NSIS <Code>.exe</Code> for Windows 10 and newer (64-bit).</>,
          <>Run it. SmartScreen may warn about an unrecognised publisher while the project is young — click &ldquo;More info&rdquo; &rarr; &ldquo;Run anyway&rdquo; if you downloaded it from this site. Compare the SHA-256 shown next to the download button if you want to be sure.</>,
          <>Launch Nexa from the Start menu. On first run it registers the browser bridge (see the <Link to="/docs/extension" className="text-brand-300 hover:underline">extension guide</Link>) and creates its data folder under <Code>%APPDATA%\Nexa</Code>.</>,
        ]}
      />
      <P>
        Upgrading is the same as installing: run the newer installer over the old one. Your queue,
        history and settings are kept.
      </P>

      <H2 id="linux">Ubuntu / Debian (.deb)</H2>
      <P>The package targets Ubuntu 22.04+ and Debian 12+ on x86-64 and depends on the Qt 6 runtime from your distribution.</P>
      <Pre>{`# download nexa_<version>_amd64.deb from /download, then:
sudo apt install ./nexa_*_amd64.deb

# launch from your app menu, or:
nexa`}</Pre>
      <P>
        <Code>apt install ./file.deb</Code> resolves the Qt dependencies for you; plain{' '}
        <Code>dpkg -i</Code> works too but you may need <Code>sudo apt -f install</Code> afterwards.
        To upgrade, install the newer <Code>.deb</Code> the same way. To remove:{' '}
        <Code>sudo apt remove nexa</Code>.
      </P>
      <Note>
        Other distributions: the app is a normal CMake + Qt 6 project. The repository README covers
        building from source with <Code>cmake -B build -G Ninja &amp;&amp; cmake --build build</Code>.
      </Note>

      <H2 id="bundled">What gets bundled</H2>
      <P>Both installers ship the external tools Nexa drives as subprocesses, so a fresh machine works out of the box:</P>
      <Bullets
        items={[
          <><strong className="text-white">yt-dlp</strong> — YouTube and 1000+ other sites. Because sites change often, the app can update its copy of yt-dlp from Settings without waiting for a new Nexa release.</>,
          <><strong className="text-white">ffmpeg</strong> — muxes HLS/DASH segments and merges separate video + audio streams into one file.</>,
          <><strong className="text-white">aria2</strong> — optional accelerated HTTP fallback used for some site downloads.</>,
          <><strong className="text-white">nexa-host</strong> — the tiny native messaging bridge the browser extension talks to.</>,
        ]}
      />
      <P>
        If you already have these tools on your <Code>PATH</Code>, the app still prefers the bundled
        copies for predictability. BitTorrent support (libtorrent) is compiled into the app itself.
      </P>

      <H2 id="where">Where things live</H2>
      <Bullets
        items={[
          <>Downloads: your system Downloads folder by default, changeable in Settings.</>,
          <>Queue and history: a SQLite database in the app data folder (<Code>%APPDATA%\Nexa</Code> on Windows, <Code>~/.local/share/Nexa</Code> on Linux).</>,
          <>Site logins: per-domain <Code>cookies.txt</Code> files in the same folder, used only by yt-dlp on your machine.</>,
        ]}
      />

      <H2 id="macos">macOS</H2>
      <P>
        Not yet. The code builds on macOS but we have not published a signed, notarised build.{' '}
        <Link to="/contact?topic=macos" className="text-brand-300 hover:underline">Tell us you want one</Link> and we
        will email you when it ships.
      </P>
    </DocsShell>
  );
}
