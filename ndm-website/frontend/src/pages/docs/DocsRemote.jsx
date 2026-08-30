import usePageMeta from '../../hooks/usePageMeta';
import DocsShell, { H2, P, Steps, Bullets, Code, Pre, Note } from './DocsShell';

export default function DocsRemote() {
  usePageMeta({
    title: 'Remote dashboard',
    description: 'Control Nexa from your phone: start the web dashboard with --dashboard, the access token, and why LAN access requires TLS.',
  });

  return (
    <DocsShell
      title="Remote dashboard"
      intro="The app can serve a small web dashboard so you can watch the queue, pause, resume and add URLs from a phone on the same network."
    >
      <H2 id="start">Starting it</H2>
      <P>The dashboard is off by default. Launch the app with a flag:</P>
      <Pre>{`nexa --dashboard            # loopback only, default port
nexa --dashboard=8765       # choose a port
nexa --dashboard-lan        # also listen on your LAN address (needs TLS, see below)
nexa --dashboard-token=<at least 16 chars>   # fixed token instead of a random one`}</Pre>
      <P>
        On Windows add the flag to the shortcut target; on Linux run it from a terminal or edit the{' '}
        <Code>.desktop</Code> file. The app prints the URL to open, e.g.{' '}
        <Code>Nexa dashboard: http://127.0.0.1:8765/?token=…</Code>.
      </P>

      <H2 id="token">The access token</H2>
      <P>
        Every request must carry <Code>?token=…</Code>. A random token is generated on each start
        unless you pass <Code>--dashboard-token</Code>; tokens shorter than 16 characters are
        rejected and replaced with a random one. The dashboard page keeps forwarding the token it
        was opened with, so bookmark the full URL on your phone. The token is printed to the
        console only when it is an interactive terminal, never to log files.
      </P>

      <H2 id="lan">Reaching it from your phone (LAN requires TLS)</H2>
      <P>
        By default the server binds to <Code>127.0.0.1</Code> only, which is safe but unreachable from
        other devices. <Code>--dashboard-lan</Code> binds to your LAN address too — and Nexa refuses to
        do that over plain HTTP, because the token would travel in clear text across your Wi-Fi.
        Provide a certificate and key:
      </P>
      <Steps
        items={[
          <>Create a self-signed certificate for your machine&apos;s LAN IP or hostname, e.g. <Code>openssl req -x509 -newkey rsa:2048 -nodes -keyout nexa.key -out nexa.crt -days 365 -subj "/CN=192.168.1.20"</Code>.</>,
          <>Set <Code>NEXA_TLS_CERT=/path/nexa.crt</Code> and <Code>NEXA_TLS_KEY=/path/nexa.key</Code> in the environment the app starts from.</>,
          <>Start with <Code>--dashboard-lan</Code>. The printed URL now starts with <Code>https://</Code> and uses the first non-loopback IPv4 address.</>,
          <>On the phone, open the URL and accept the self-signed certificate once (or install the <Code>.crt</Code> as trusted).</>,
        ]}
      />
      <Note>
        Without <Code>NEXA_TLS_CERT</Code> / <Code>NEXA_TLS_KEY</Code>, <Code>--dashboard-lan</Code> is ignored and the
        app logs why. A reverse proxy such as Caddy or Tailscale Serve can terminate TLS for you
        instead, in which case keep Nexa on loopback and point the proxy at it.
      </Note>

      <H2 id="what">What you can do from the phone</H2>
      <Bullets
        items={[
          <>See every row with progress, speed and ETA, refreshed live.</>,
          <>Pause, resume, cancel and remove downloads.</>,
          <>Paste a URL, magnet link or <Code>.m3u8</Code> to add a download — it starts on the desktop.</>,
          <>Toggle the global speed limit.</>,
        ]}
      />
      <P>
        The dashboard is plain HTML served by the app; nothing goes through our servers and it works
        with the desktop offline from the internet as long as the phone is on the same network.
      </P>
    </DocsShell>
  );
}
