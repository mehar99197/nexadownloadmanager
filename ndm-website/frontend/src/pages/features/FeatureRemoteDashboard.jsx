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
          A phone screen showing the dashboard: the add-URL field, then three rows, each with its file
          name, size, progress bar, speed, status and Pause, Resume or Remove buttons.
        </Figure>
      }
    >
      <H2 id="what">What it does</H2>
      <P>
        Nexa can serve a small web dashboard from the machine it is running on. Open it on your
        phone, on a laptop in another room, or in a second browser tab, and you get the queue: every
        download with live progress and speed, plus the controls that matter when you are not at the
        keyboard — pause, resume, remove, and add a URL.
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
        polls for the queue state. The page and every API call need an access token, and it is
        created once and kept: Nexa makes a random one the first time the dashboard starts and reuses
        it on every start after that, so the link keeps working after a restart — for anyone who has
        it. A token you pass with <Code>--dashboard-token</Code> lasts for that launch only, and one
        shorter than 16 characters is rejected outright rather than silently accepted.
      </P>
      <P>
        Loopback-only is the default because it is the safe one — it is reachable from the machine
        itself and nothing else. To reach it from a phone you have to opt in to LAN mode, which
        listens on every network interface the machine has, and that is where the one firm rule
        lives:
      </P>
      <Note tone="warn" title="LAN access requires TLS, and this is not optional">
        Over plain HTTP the access token travels across your Wi-Fi in clear text, and anyone on that
        network — a guest, a compromised smart device — can read it and then drive your download
        queue. So in LAN mode, without a certificate and key, Nexa does not start the dashboard at
        all — not even on loopback — and logs why, rather than quietly falling back to HTTP. It is
        the single most opinionated default in the app, and it exists because &ldquo;it is only my
        home network&rdquo; is exactly the reasoning that makes these things exploitable.
      </Note>
      <P>
        Set <Code>NEXA_TLS_CERT</Code> and <Code>NEXA_TLS_KEY</Code> and the link switches to{' '}
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
          ['Live queue', 'Every download with its size, progress, speed and status, refreshed every second, in the order they were added'],
          ['Pause / resume / remove', 'One download at a time; there is no pause-all or resume-all. Remove stops a download and takes it off the list.'],
          ['Add a URL', <>Paste a URL, magnet link or <Code>.m3u8</Code>. While &ldquo;Ask before starting a download&rdquo; is on — the default — it waits at the desktop until someone confirms it there; magnet and <Code>.torrent</Code> links start straight away.</>],
          ['Totals and time left', 'Not shown. Each row has its own speed; there is no total, active count or time-remaining estimate.'],
          ['Authentication', <>A random 32-character token, created once and kept across restarts. The link carries it as <Code>?token=…</Code>; the page then removes it from the address bar and sends it in a header.</>],
          ['Binding', <>Loopback by default. LAN mode — on request, and only with TLS configured — listens on every network interface.</>],
          ['Transport', <>HTTP on loopback, HTTPS required off it (<Code>NEXA_TLS_CERT</Code> / <Code>NEXA_TLS_KEY</Code>)</>],
          ['Internet access', <>Not provided. There is no relay, no port forwarding helper and no account. Use a VPN or Tailscale if you need it away from home.</>],
          ['Settings editing', <>Not exposed — the dashboard drives the queue, not the app&apos;s configuration.</>],
          ['File browsing', <>Not exposed. It never serves your downloaded files, only their metadata.</>],
        ]}
      />

      <H2 id="use">Turning it on</H2>
      <P>
        From the app: <strong className="text-white">Settings &rarr; Remote dashboard (control from
        your phone)</strong>. Tick <strong className="text-white">Run the web dashboard while Nexa is
        open</strong>, choose a port (8088 unless you change it), optionally allow LAN access, and
        press Save. Open Settings again and the section shows the link, token included, with a{' '}
        <strong className="text-white">Copy link</strong> button so you can send it to your phone.
      </P>
      <P>
        Or with command-line flags. They apply to that one launch and are never saved, and they only
        work when Nexa is not already running — a second copy just hands its URLs to the running
        one, brings it to the front and exits, and the Windows installer starts Nexa when you sign
        in. On Windows, <Code>nexa.exe</Code> prints nothing in a terminal, so the link is in
        Settings either way.
      </P>
      <Pre>{`nexa --dashboard                   # start it (port and LAN setting from Settings)
nexa --dashboard=9000              # start it on port 9000
nexa --dashboard --dashboard-lan   # LAN mode too (requires TLS)
nexa --dashboard --dashboard-token=<16+ characters>   # this token, for this launch only`}</Pre>
      <Steps
        items={[
          <>Turn it on and copy the link from Settings — it looks like <Code>http://127.0.0.1:8088/?token=…</Code>.</>,
          <>To reach it from a phone, create a certificate for your machine&apos;s LAN IP, set <Code>NEXA_TLS_CERT</Code> and <Code>NEXA_TLS_KEY</Code> in the environment Nexa starts from, then quit Nexa and start it again. The <Link to="/docs/remote" className="text-brand-300 hover:underline">remote dashboard guide</Link> has the exact <Code>openssl</Code> command.</>,
          <>Tick <strong className="text-white">Reachable from other devices on my network</strong> and press Save. The link now begins with <Code>https://</Code> and uses the first non-loopback IPv4 address Nexa finds — normally your LAN address.</>,
          <>Open the link on the phone and accept the self-signed certificate once. To come back later, open the link again: the page drops the token from the address bar as soon as it loads, so a bookmark of the open page gets &ldquo;unauthorized&rdquo;.</>,
        ]}
      />

      <H2 id="tips">Tips</H2>
      <Tips
        items={[
          'Keep the link itself — Settings → Copy link — not a bookmark of the open page, which has already dropped the token. Without the token every request is refused, which is the point.',
          <>Treat the link like a password. Its token does not change when Nexa restarts and Settings has no button to make a new one, so if it leaks, turn the dashboard off and replace the token as the <Link to="/docs/remote#token" className="text-brand-300 underline underline-offset-2">remote dashboard guide</Link> describes.</>,
          'Add the certificate to your phone as trusted once, and the browser stops warning on every visit.',
          'Away from home, use a VPN or Tailscale rather than forwarding a port. Exposing this to the internet is exactly what the TLS rule is trying to prevent, one step further.',
          'The dashboard reflects the same queue as the desktop window — a pause or resume from either shows up in the other. It lists downloads in the order they were added, not the order you arranged on the desktop.',
          'A home-screen shortcut will not work: it is made from the open page, which has already dropped the token. Keep the link somewhere you can tap it instead, such as a note.',
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
                LAN access has to be turned on <em>and</em> TLS configured. With LAN access on but
                no usable certificate, the dashboard does not start at all — not even on
                loopback — and the app logs why. To see it, turn on &ldquo;Save error logs to a
                file&rdquo; in Settings and press Save, then use Export logs… and look for the line
                naming <Code>NEXA_TLS_CERT</Code> and <Code>NEXA_TLS_KEY</Code>.
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
            symptom: 'The page says “unauthorized”',
            fix: (
              <>
                The address has no token, or not the one Nexa is using. Usually it is a bookmark, a
                refresh or a home-screen shortcut of the open page: the page drops the token from the
                address bar once it loads, so that address asks without one. Open the link itself
                again (Settings &rarr; Copy link). If Nexa was started with{' '}
                <Code>--dashboard-token</Code>, that launch uses that token instead of the saved one.
                After 20 failed tries in a minute from one address, it answers &ldquo;too many
                attempts&rdquo;, even to the right link, until the minute is up.
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
