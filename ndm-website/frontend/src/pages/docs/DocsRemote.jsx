import usePageMeta from '../../hooks/usePageMeta';
import DocsShell, { H2, P, Steps, Bullets, Code, Pre, Note } from './DocsShell';

export default function DocsRemote() {
  usePageMeta({
    title: 'Remote dashboard',
    description: 'Control Nexa from your phone: turn on the web dashboard in Settings, look after its access token, and why LAN access requires TLS.',
  });

  return (
    <DocsShell
      title="Remote dashboard"
      intro="The app can serve a small web dashboard so you can watch the queue, pause, resume and add URLs from a phone on the same network."
    >
      <H2 id="start">Starting it</H2>
      <P>
        The dashboard is off by default. Turn it on in Settings, under{' '}
        <strong className="text-white">Remote dashboard (control from your phone)</strong>:
      </P>
      <Steps
        items={[
          <>Tick <strong className="text-white">Run the web dashboard while Nexa is open</strong>.</>,
          <>Leave <strong className="text-white">Port</strong> at 8088, or choose another.</>,
          <>Leave <strong className="text-white">Reachable from other devices on my network</strong> unticked until TLS is set up (see below).</>,
          <>Press Save, then open Settings again. The section now shows the link, token included — e.g. <Code>http://127.0.0.1:8088/?token=…</Code> — with a <strong className="text-white">Copy link</strong> button.</>,
        ]}
      />
      <P>
        You can also start it with flags. They apply to that one launch and are never saved, and they
        only take effect when Nexa is not already running: a second <Code>nexa</Code> hands its URLs to
        the running copy, brings its window forward and exits. The Windows installer starts Nexa when
        you sign in, so quit it first (tray icon &rarr; Quit Nexa).
      </P>
      <Pre>{`nexa --dashboard                   # start it, with the port and LAN setting from Settings
nexa --dashboard=9000              # start it on port 9000
nexa --dashboard --dashboard-lan   # start it in LAN mode (needs TLS, see below)
nexa --dashboard --dashboard-token=<16+ characters>   # this token, for this launch only`}</Pre>
      <P>
        <Code>--dashboard-lan</Code> on its own does not start the dashboard; it only switches LAN mode
        on for one that <Code>--dashboard</Code> or Settings starts. On Windows, <Code>nexa.exe</Code> is
        a windowed program and prints nothing in a terminal, so take the link from Settings. On Linux,
        started from a terminal, Nexa also prints it there:{' '}
        <Code>Nexa dashboard: http://127.0.0.1:8088/?token=…</Code>.
      </P>

      <H2 id="token">The access token</H2>
      <P>
        The page and every API call need the token, and it is created once and kept: Nexa makes a
        random 32-character token the first time the dashboard starts, saves it with your settings and
        uses it on every start after that. So the link keeps working after a restart — and so does any
        copy of it that someone else has. Settings has no button to make a new one.
      </P>
      <P>
        The link carries the token as <Code>?token=…</Code>. As soon as the page loads, it removes the
        token from the address bar and sends it in an <Code>Authorization</Code> header from then on.
        So a bookmark or a refresh of the open page has no token and gets &ldquo;unauthorized&rdquo;:
        keep the link itself (Settings &rarr; Copy link), not the page you have open.
      </P>
      <P>
        <Code>--dashboard-token=…</Code> uses a token of your own for that launch only; it is never
        saved, and the next start goes back to the saved one. A token shorter than 16 characters is
        rejected, and Nexa uses its saved one instead.
      </P>
      <Note tone="warn" title="The token can end up in a log file">
        Each time the dashboard starts — at launch, and again whenever you save Settings — Nexa logs
        the full link, token included: always on Windows, and on Linux when Nexa was started from a
        terminal (otherwise the line says the token is hidden). While &ldquo;Save error logs to a file
        (for troubleshooting)&rdquo; is on in Settings, that line is written to <Code>nexa.log</Code>,
        and &ldquo;Export logs…&rdquo; copies the file as it is. Take the line out before you share a
        log.
      </Note>
      <P>
        If the link leaks, turn the dashboard off: untick it and press Save, or quit Nexa if you
        started it with <Code>--dashboard</Code>. To get a new token, quit Nexa, delete the saved one
        and start Nexa again — the dashboard makes a new token the next time it starts. It is the{' '}
        <Code>token</Code> value under <Code>dashboard</Code> in Nexa&apos;s settings: the registry key{' '}
        <Code>HKEY_CURRENT_USER\Software\Nexa\Nexa\dashboard</Code> on Windows,{' '}
        <Code>~/.config/Nexa/Nexa.conf</Code> on Linux, or <Code>NexaData/Nexa/Nexa.ini</Code> beside
        the app in portable mode.
      </P>

      <H2 id="lan">Reaching it from your phone (LAN requires TLS)</H2>
      <P>
        By default the server binds to <Code>127.0.0.1</Code> only, which is safe but unreachable from
        other devices. LAN mode — the <strong className="text-white">Reachable from other devices on my
        network</strong> box, or <Code>--dashboard-lan</Code> — listens on every network interface the
        machine has, and Nexa refuses to do that over plain HTTP, because the token would travel in
        clear text across your Wi-Fi. Provide a certificate and key:
      </P>
      <Steps
        items={[
          <>Create a self-signed certificate for your machine&apos;s LAN IP or hostname, e.g. <Code>openssl req -x509 -newkey rsa:2048 -nodes -keyout nexa.key -out nexa.crt -days 365 -subj "/CN=192.168.1.20"</Code>.</>,
          <>Set <Code>NEXA_TLS_CERT=/path/nexa.crt</Code> and <Code>NEXA_TLS_KEY=/path/nexa.key</Code> in the environment the app starts from, then quit Nexa and start it again so it picks them up.</>,
          <>Tick <strong className="text-white">Reachable from other devices on my network</strong> and press Save, or start with <Code>--dashboard --dashboard-lan</Code>. The link now starts with <Code>https://</Code> and uses the first non-loopback IPv4 address.</>,
          <>On the phone, open the link and accept the self-signed certificate once (or install the <Code>.crt</Code> as trusted).</>,
        ]}
      />
      <Note>
        Without a usable certificate and key in <Code>NEXA_TLS_CERT</Code> / <Code>NEXA_TLS_KEY</Code>,
        LAN mode does not fall back to loopback: the dashboard does not start at all, not even on{' '}
        <Code>127.0.0.1</Code>, and the app logs why (in <Code>nexa.log</Code>, if error logs are saved
        to a file). A reverse proxy such as Caddy or Tailscale Serve can terminate TLS for you
        instead, in which case keep Nexa on loopback and point the proxy at it.
      </Note>

      <H2 id="what">What you can do from the phone</H2>
      <Bullets
        items={[
          <>See every download with its size, progress, speed and status, refreshed every second.</>,
          <>Pause, resume or remove a download, one row at a time.</>,
          <>Paste a URL, magnet link or <Code>.m3u8</Code> to add a download. While &ldquo;Ask before starting a download&rdquo; is on — the default — it opens a New Download window on the desktop and waits until someone confirms it there; magnet and <Code>.torrent</Code> links start straight away.</>,
        ]}
      />
      <P>
        That is the whole list: no time-remaining estimate, no totals, no speed-limit switch and no
        reordering. Downloads are listed in the order they were added, not the order you arranged on
        the desktop.
      </P>
      <P>
        The dashboard is plain HTML served by the app; nothing goes through our servers and it works
        with the desktop offline from the internet as long as the phone is on the same network.
      </P>
    </DocsShell>
  );
}
