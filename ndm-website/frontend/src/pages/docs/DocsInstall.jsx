import { Link } from 'react-router-dom';
import usePageMeta from '../../hooks/usePageMeta';
import DocsShell, { H2, P, Steps, Bullets, Code, Pre, Note } from './DocsShell';

export default function DocsInstall() {
  usePageMeta({
    title: 'Install',
    description: 'Install Nexa Download Manager on Windows (installer) or Ubuntu 24.04+ (.deb). yt-dlp and ffmpeg are bundled.',
  });

  return (
    <DocsShell
      title="Install Nexa"
      intro="Two builds: a Windows installer and a Debian package. Both bundle yt-dlp and ffmpeg. The one thing to add yourself is a JavaScript runtime (Deno, Node.js or Bun) if you download from YouTube."
    >
      <H2 id="windows">Windows</H2>
      <Steps
        items={[
          <>Grab the installer from the <Link to="/download" className="text-brand-300 hover:underline">download page</Link>. It is a standard NSIS <Code>.exe</Code> for Windows 10 and newer (64-bit).</>,
          <>Run it. SmartScreen may warn about an unrecognised publisher while the project is young — click &ldquo;More info&rdquo; &rarr; &ldquo;Run anyway&rdquo; if you downloaded it from this site. Compare the SHA-256 shown next to the download button if you want to be sure.</>,
          <>Launch Nexa from the Start menu. On first run it registers the browser bridge (see the <Link to="/docs/extension" className="text-brand-300 hover:underline">extension guide</Link>) and creates its data folder under <Code>%APPDATA%\Nexa\Nexa</Code>.</>,
        ]}
      />
      <P>
        Upgrading is the same as installing: run the newer installer over the old one. Your queue,
        history and settings are kept.
      </P>

      <H2 id="linux">Ubuntu (.deb)</H2>
      <P>
        The package is for Ubuntu 24.04 or newer on x86-64; it is built and tested on 24.04. It is
        self-contained: Qt, libtorrent and the app&apos;s other libraries are bundled in{' '}
        <Code>/usr/lib/nexa</Code>, so all it takes from your system is the C and C++ runtime, the
        OpenGL and EGL libraries, and Python 3, which runs yt-dlp.
      </P>
      <Pre>{`# download nexa_<version>_amd64.deb from /download, then:
sudo apt install ./nexa_*_amd64.deb

# launch from your app menu, or:
nexa`}</Pre>
      <P>
        <Code>apt install ./file.deb</Code> installs any of those that are missing; plain{' '}
        <Code>dpkg -i</Code> works too but you may need <Code>sudo apt -f install</Code> afterwards.
        To upgrade, install the newer <Code>.deb</Code> the same way. To remove:{' '}
        <Code>sudo apt remove nexa</Code>.
      </P>
      <Note>
        Other distributions: the app is a normal CMake + Qt 6 project. The repository README covers
        building from source with <Code>cmake -B build -G Ninja &amp;&amp; cmake --build build</Code>.
      </Note>

      <H2 id="bundled">What gets bundled</H2>
      <P>Both installers ship the external tools Nexa drives as subprocesses:</P>
      <Bullets
        items={[
          <><strong className="text-white">yt-dlp</strong> — YouTube and the other <Link to="/docs/youtube" className="text-brand-300 underline underline-offset-2">video sites Nexa supports</Link>. The app has no separate yt-dlp updater: the bundled copy is replaced when you install a newer Nexa, so if a site stops working, run <strong className="text-white">Help &rarr; Check for updates…</strong> in the app.</>,
          <><strong className="text-white">ffmpeg</strong> — muxes HLS/DASH segments and merges separate video + audio streams into one file.</>,
          <><strong className="text-white">nexa-host</strong> — the tiny native messaging bridge the browser extension talks to.</>,
        ]}
      />
      <P>
        If you already have these tools on your <Code>PATH</Code>, the app still prefers the bundled
        copies for predictability. BitTorrent support comes from libtorrent, a library that ships
        with the app rather than a separate program.
      </P>
      <Note title="Not bundled: a JavaScript runtime">
        yt-dlp needs one to solve YouTube&apos;s player challenges, and Nexa lets it use Deno,
        Node.js or Bun, whichever you have installed. Without one, many YouTube formats come back
        empty, especially 1080p and above and age-restricted videos. If you download from YouTube,
        install one of the three.
      </Note>

      <H2 id="where">Where things live</H2>
      <Bullets
        items={[
          <>Downloads: your system Downloads folder by default, changeable in Settings.</>,
          <>Queue and history: a SQLite database, <Code>nexa.db</Code>, in the app data folder (<Code>%APPDATA%\Nexa\Nexa</Code> on Windows, <Code>~/.local/share/Nexa/Nexa</Code> on Linux).</>,
          <>Settings: the registry under <Code>HKCU\Software\Nexa\Nexa</Code> on Windows, <Code>~/.config/Nexa/Nexa.conf</Code> on Linux.</>,
          <>Site logins: cookies the extension hands over for a signed-in site go into a temporary <Code>cookies-….txt</Code> file in a private <Code>nexa-auth</Code> folder (<Code>%USERPROFILE%\nexa-auth</Code> on Windows, under <Code>$XDG_RUNTIME_DIR</Code> on Linux). Both ordinary downloads and yt-dlp use it, and Nexa deletes it when it exits, clearing any a crash left behind at the next start. A browser login set up under <strong className="text-white">Site logins</strong> writes no file: yt-dlp reads the cookies from your browser each time.</>,
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
