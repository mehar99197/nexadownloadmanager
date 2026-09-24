import { Link } from 'react-router-dom';
import usePageMeta from '../../hooks/usePageMeta';
import FeatureShell, {
  H2, P, Steps, Code, Pre, Note, Figure, Flow, SpecTable, Tips, Troubles, Related,
} from './FeatureShell';

export default function FeatureRemoteDashboard() {
  usePageMeta({
    title: 'Remote dashboard',
    description:
      'Watch and control the Nexa queue from your phone on the same network: live progress, pause and resume, add URLs — behind an access token, and over TLS when it leaves loopback.',
  });

  return (
    <FeatureShell
      title="Remote dashboard"
      tagline="Your queue on your phone, served by the app itself — not by us, and not through the internet."
      hero={
        <Figure kind="Screenshot">
          A phone screen showing the dashboard: three rows with progress bars, the aggregate speed at
          the top, and the add-URL field.
        </Figure>
      }
    >
      <H2 id="what">What it does</H2>
      <P>
        Nexa can serve a small web dashboard from the machine it is running on. Open it on your
        phone, on a laptop in another room, or in a second browser tab, and you get the queue: every
        download with live progress, speed and ETA, plus the controls that matter when you are not
        at the keyboard — pause, resume, cancel, and add a URL.
      </P>
      <P>
        The use case is the ordinary one. A long download is running on the desktop upstairs; you
        want to know whether it finished, pause it because someone is on a call, or queue something
        you found on your phone so it is waiting when you get back. None of that is worth walking
        upstairs for, and none of it should require an account, a cloud relay or a mobile app.
      </P>
      <P>
        There is no Nexa server in this picture. The dashboard is served by the copy of Nexa on your
        own machine, over your own network. If your internet connection is down, the dashboard still
        works.
      </P>

      <H2 id="how">How it works</H2>
      <P>
        The app embeds a small HTTP server. When enabled it binds to{' '}
        <Code>127.0.0.1</Code> and serves a single-page dashboard plus a REST API that the page
        polls for the queue state. Every request must carry an access token; a random one is
        generated each time the app starts unless you pin your own, and tokens shorter than 16
        characters are rejected outright rather than silently accepted.
      </P>
      <P>
        Loopback-only is the default because it is the safe one — it is reachable from the machine
        itself and nothing else. To reach it from a phone you have to opt in to listening on your
        LAN address, and that is where the one firm rule lives:
      </P>
      <Note tone="warn" title="LAN access requires TLS, and this is not optional">
        Over plain HTTP the access token travels across your Wi-Fi in clear text, and anyone on that
        network — a guest, a compromised smart device — can read it and then drive your download
        queue. So Nexa refuses to bind to a LAN address without a certificate and key, and logs why
        rather than quietly falling back to HTTP. It is the single most opinionated default in the
        app, and it exists because &ldquo;it is only my home network&rdquo; is exactly the reasoning
        that makes these things exploitable.
      </Note>
      <P>
        Set <Code>NEXA_TLS_CERT</Code> and <Code>NEXA_TLS_KEY</Code> and the printed URL switches to{' '}
        <Code>https://</Code>. A self-signed certificate is fine for a home network — you accept it
        once on the phone. If you already run a reverse proxy such as Caddy or Tailscale Serve, the
        better arrangement is to leave Nexa on loopback and let the proxy terminate TLS and handle
        access.
      </P>
      <Flow
        caption="Phone to desktop, on your own network."
        steps={[
          { title: 'Your phone', detail: 'any browser' },
          { title: 'Your home Wi-Fi', detail: 'HTTPS, with the access token' },
          { title: 'Nexa’s built-in server', detail: 'running on your desktop' },
          { title: 'The same download engine', detail: 'the desktop window drives' },
        ]}
        note="No Nexa server, relay or account is involved: the phone talks to your own computer."
      />

      <H2 id="supported">What you can do from it</H2>
      <SpecTable
        caption="Remote dashboard capabilities and limits"
        head={['', 'Detail']}
        rows={[
          ['Live queue', 'Every row with progress, speed and ETA, refreshed automatically'],
          ['Pause / resume / cancel', 'Per download, and for everything at once'],
          ['Add a URL', 'Queue a new download from the phone; it starts on the desktop'],
          ['Aggregate throughput', 'Total speed and active count at the top'],
          ['Authentication', <>A token on every request (<Code>?token=…</Code>), random per start unless pinned</>],
          ['Binding', <>Loopback by default; LAN on request and only with TLS configured</>],
          ['Transport', <>HTTP on loopback, HTTPS required off it (<Code>NEXA_TLS_CERT</Code> / <Code>NEXA_TLS_KEY</Code>)</>],
          ['Internet access', <>Not provided. There is no relay, no port forwarding helper and no account. Use a VPN or Tailscale if you need it away from home.</>],
          ['Settings editing', <>Not exposed — the dashboard drives the queue, not the app&apos;s configuration.</>],
          ['File browsing', <>Not exposed. It never serves your downloaded files, only their metadata.</>],
        ]}
      />

      <H2 id="use">Turning it on</H2>
      <P>
        From the app: <strong className="text-white">Settings &rarr; Remote dashboard</strong>, tick
        it on, choose a port, and optionally allow LAN access. The panel shows the current URL,
        token included, so you can send it to your phone.
      </P>
      <P>Or from the command line, which is what the flags map to:</P>
      <Pre>{`nexa --dashboard            # loopback only, default port
nexa --dashboard=8765       # choose a port
nexa --dashboard-lan        # also listen on the LAN address (requires TLS)
nexa --dashboard-token=<at least 16 chars>   # pin a token instead of a random one`}</Pre>
      <Steps
        items={[
          <>Enable it and note the printed URL — it looks like <Code>http://127.0.0.1:8765/?token=…</Code>.</>,
          <>To reach it from a phone, create a certificate for your machine&apos;s LAN IP and set <Code>NEXA_TLS_CERT</Code> and <Code>NEXA_TLS_KEY</Code>. The <Link to="/docs/remote" className="text-brand-300 hover:underline">remote dashboard guide</Link> has the exact <Code>openssl</Code> command.</>,
          <>Start with LAN access on. The URL now begins with <Code>https://</Code> and uses your LAN address.</>,
          <>Open it on the phone, accept the self-signed certificate once, and bookmark the full URL — the token is part of it.</>,
          <>Pin a token with <Code>--dashboard-token</Code> if you want that bookmark to keep working after the app restarts.</>,
        ]}
      />

      <H2 id="tips">Tips</H2>
      <Tips
        items={[
          'Bookmark the whole URL including the token. Without it every request is refused, which is the point.',
          <>Pin a token if you use the dashboard regularly — otherwise a restart invalidates yesterday&apos;s bookmark.</>,
          'Add the certificate to your phone as trusted once, and the browser stops warning on every visit.',
          'Away from home, use a VPN or Tailscale rather than forwarding a port. Exposing this to the internet is exactly what the TLS rule is trying to prevent, one step further.',
          'The dashboard reflects the same queue as the desktop window — reordering or pausing from either is immediately visible in the other.',
          'On a phone, add it to the home screen; it behaves like a small app and opens straight to the queue.',
          'It serves metadata only. Even with the token, nobody can read your downloaded files through it.',
        ]}
      />

      <H2 id="trouble">When it goes wrong</H2>
      <Troubles
        items={[
          {
            symptom: 'The phone cannot reach the dashboard at all',
            fix: (
              <>
                Almost always still on loopback. Loopback means &ldquo;this machine only&rdquo;;
                LAN access has to be turned on <em>and</em> TLS configured, or the app ignores the
                request and logs why. Check the app&apos;s log for that line — it names the missing
                variable.
              </>
            ),
          },
          {
            symptom: '“Connection refused”',
            fix: (
              <>
                The server is not listening: the dashboard is off, the app is not running, or
                another program already holds that port. Change the port and try again. A desktop
                firewall blocking inbound connections on the LAN is the other common cause.
              </>
            ),
          },
          {
            symptom: 'The browser warns about the certificate',
            fix: (
              <>
                Expected with a self-signed certificate — nothing vouches for it. Accept it once, or
                install the <Code>.crt</Code> on the phone as trusted to stop the prompt. This is
                still strictly better than plain HTTP, where the token is readable by anyone on the
                network.
              </>
            ),
          },
          {
            symptom: 'Every request returns unauthorised',
            fix: (
              <>
                The token in the URL is not the current one — the app restarted and generated a new
                random token. Re-open the URL from Settings, or pin a token so it stops changing.
              </>
            ),
          },
          {
            symptom: 'It worked yesterday and the address changed',
            fix: (
              <>
                Your router handed the machine a different DHCP address. Reserve a static lease for
                it, or use its hostname instead of the IP — and remember the certificate is issued
                for whichever of the two you chose.
              </>
            ),
          },
        ]}
      />

      <H2 id="related">Related features</H2>
      <Related to={['/features/scheduler', '/features/bittorrent', '/features/acceleration']} />
    </FeatureShell>
  );
}
