import { Link } from 'react-router-dom';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';

/* Every claim on this page was checked against the source before it was
   written. Two of them are uncomfortable and are stated anyway: AI rename
   sends a filename and a URL to our server, and the Free plan's ad request
   reaches us with your licence token and therefore your IP. A privacy page
   that omits its own awkward cases is marketing. */

const PRINCIPLES = [
  {
    title: 'Your files are yours',
    body: 'Downloads go from the server straight to your disk. They are never proxied, mirrored, scanned or stored by us. We could not hand over your files if we were asked to, because we never have them.',
  },
  {
    title: 'Credentials stay local',
    body: 'The browser extension reads cookies for the site you are downloading from and passes them to the Nexa app on your own machine, over the browser’s local native-messaging pipe. They do not cross the internet.',
  },
  {
    title: 'You can check all of this',
    body: 'The app, the browser extension and the native-messaging bridge are open source. Everything on this page is a claim you can verify by reading the code rather than trusting us.',
  },
];

const FLOWS = [
  {
    what: 'The files you download',
    where: 'Server → your disk',
    reaches: 'Never reaches us',
    tone: 'good',
    detail: 'The transfer is between your machine and whoever hosts the file. We are not in the path at any point.',
  },
  {
    what: 'Cookies and request headers',
    where: 'Browser → extension → local bridge → Nexa app',
    reaches: 'Never reaches us',
    tone: 'good',
    detail: 'A local pipe on your own computer. The extension has no server of its own to talk to.',
  },
  {
    what: 'URLs, filenames, download history',
    where: 'Local SQLite database on your machine',
    reaches: 'Never reaches us',
    tone: 'good',
    detail: 'Your queue and history are a file in the app’s data folder. There is no sync and no backup to us.',
  },
  {
    what: 'Licence check (every few hours)',
    where: 'Nexa app → our server',
    reaches: 'Plan, device fingerprint, app version, IP',
    tone: 'info',
    detail: 'Sends your licence key or account token plus a device fingerprint — a SHA-256 of your primary network adapter’s MAC and machine id. The raw MAC never leaves your computer, and the fingerprint cannot be reversed into it. It carries nothing about what you are downloading.',
  },
  {
    what: 'Update check (daily, can be turned off)',
    where: 'Nexa app → our server',
    reaches: 'Operating system, IP',
    tone: 'info',
    detail: 'Asks whether a newer release exists for your platform. The response is Ed25519-signed so a tampered feed cannot hand your app an installer.',
  },
  {
    what: 'Ad request — Free plan only',
    where: 'Nexa app → our server',
    reaches: 'Licence token, placement, IP',
    tone: 'warn',
    detail: 'The in-app promo strip is fetched from us, so that request reaches our server with your token and therefore your IP address. It contains nothing about your downloads. Pro and Team do not make this request at all — the app stops asking once the plan is paid.',
  },
  {
    what: 'AI rename — off by default, Pro only',
    where: 'Nexa app → our server → Anthropic',
    reaches: 'The filename, the source URL and the content type',
    tone: 'warn',
    detail: 'This is the one feature that sends something about a download off your machine, and it is why it ships switched off. When you enable it, the current filename, the URL it came from and its content type are sent to our server, which asks Anthropic’s API for a better name and returns it. Nothing else about the file — never its contents. Leave the toggle off and none of it happens.',
  },
  {
    what: 'Account data (only if you sign in)',
    where: 'Browser → our server',
    reaches: 'Email, name, plan, session',
    tone: 'info',
    detail: 'Ordinary account data for the website. Signing in is optional — the Free plan works without an account at all.',
  },
];

const TONE = {
  good: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  info: 'border-brand-400/25 bg-brand-400/10 text-brand-300',
  warn: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
};

const PERMISSIONS = [
  [
    'Read and change data on all sites',
    'To spot a streaming manifest on the page you are watching and draw the download button, and to read cookies for that site when you click it. It cannot be narrowed to a site list, because you can download from anywhere. It acts on the page you use it on; it does not collect in the background.',
  ],
  [
    'Communicate with cooperating native applications',
    'The local bridge to the Nexa app. This is the whole mechanism — without it the extension cannot do anything.',
  ],
  [
    'Access browser activity during navigation',
    'To observe the media requests a player makes. A stream manifest is fetched by JavaScript and never appears in the page, so there is no other way to find it.',
  ],
  [
    'Downloads',
    'To take over a download the browser was about to start. You can turn this off and use the right-click menu instead.',
  ],
  [
    'Cookies',
    'Read-only, for the site of the download you just triggered, sent over the local bridge to your own machine.',
  ],
  [
    'Context menus, storage',
    'The right-click entries, and the extension’s own settings.',
  ],
];

export default function Security() {
  usePageMeta({
    title: 'Security & privacy',
    description:
      'Exactly what Nexa Download Manager sends, what it never sends, what every browser-extension permission is for, and the two features that do transmit something — stated plainly.',
  });

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />Security &amp; privacy</span>
        <h1 className="mt-5 text-white">Your downloads stay on <span className="text-gradient">your machine.</span></h1>
        <p>
          Here is precisely what leaves your computer, what does not, and the two places where the
          answer is less comfortable than we would like.
        </p>
      </div>

      <div className="mt-12 grid gap-5 md:grid-cols-3">
        {PRINCIPLES.map((p) => (
          <Card key={p.title}>
            <h2 className="text-base font-bold text-white">{p.title}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">{p.body}</p>
          </Card>
        ))}
      </div>

      <Card className="mt-8">
        <h2 className="text-lg font-bold text-white">Where every piece of data goes</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
          One row per thing the app handles. Three of them reach us and two of those deserve the
          amber mark; the rest never leave your computer.
        </p>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <caption className="sr-only">
              What each kind of data is, where it travels, and what reaches Nexa&apos;s servers
            </caption>
            <thead>
              <tr className="surface-inset !border-x-0 !border-t-0 border-b border-white/10">
                <th scope="col" className="px-5 py-3.5 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Data</th>
                <th scope="col" className="px-5 py-3.5 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Path</th>
                <th scope="col" className="px-5 py-3.5 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Reaches us</th>
              </tr>
            </thead>
            <tbody>
              {FLOWS.map((f) => (
                <tr key={f.what} className="border-b border-white/5 align-top last:border-0">
                  <th scope="row" className="px-5 py-4 font-normal">
                    <span className="font-semibold text-slate-200">{f.what}</span>
                    <p className="mt-1.5 max-w-sm text-xs leading-5 text-slate-500">{f.detail}</p>
                  </th>
                  <td className="px-5 py-4 text-xs leading-5 text-slate-400">{f.where}</td>
                  <td className="px-5 py-4">
                    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-bold ${TONE[f.tone]}`}>
                      {f.reaches}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="text-lg font-bold text-white">What we do not collect</h2>
          <ul className="mt-4 space-y-2.5 text-sm leading-6 text-slate-400">
            {[
              'The URLs you download from — except when you switch AI rename on, which is covered above.',
              'The names or contents of your files.',
              'Your site logins, cookies or passwords.',
              'Usage analytics. There is no analytics SDK in the desktop app — not a disabled one, none at all.',
              'Crash reports. The app has no crash reporter; the optional troubleshooting log writes to a file on your disk and is never uploaded.',
              'Your browsing history, or anything about pages you visit without downloading from them.',
            ].map((line) => (
              <li key={line} className="flex gap-2.5">
                <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-300" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <h2 className="text-lg font-bold text-white">What we do hold</h2>
          <ul className="mt-4 space-y-2.5 text-sm leading-6 text-slate-400">
            {[
              'Your email address and name, if you created an account.',
              'Your plan, licence key and which devices currently hold a seat — shown to you on your dashboard, where you can sign any of them out.',
              'A device fingerprint per activated machine: a one-way hash, kept so seat limits and key-sharing checks can work at all.',
              'Payment records from Stripe — the last four digits and the amount. Card numbers are handled by Stripe and never touch our servers.',
              'Server access logs including IP addresses, kept short-term for abuse and rate limiting.',
              'Reviews and support messages you send us, obviously.',
            ].map((line) => (
              <li key={line} className="flex gap-2.5">
                <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-300" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card className="mt-8">
        <h2 className="text-lg font-bold text-white">The browser extension&apos;s permissions</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
          &ldquo;Read and change all your data on all websites&rdquo; is an alarming sentence and
          most extensions never explain it. Here is every permission Nexa asks for and what it is
          actually used for.
        </p>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-sm">
            <caption className="sr-only">Browser permissions requested by the Nexa extension</caption>
            <thead>
              <tr className="surface-inset !border-x-0 !border-t-0 border-b border-white/10">
                <th scope="col" className="px-5 py-3.5 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Permission</th>
                <th scope="col" className="px-5 py-3.5 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Why</th>
              </tr>
            </thead>
            <tbody>
              {PERMISSIONS.map(([name, why]) => (
                <tr key={name} className="border-b border-white/5 align-top last:border-0">
                  <th scope="row" className="px-5 py-3.5 font-semibold text-slate-200">{name}</th>
                  <td className="px-5 py-3.5 text-slate-400">{why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="text-lg font-bold text-white">Security measures</h2>
          <ul className="mt-4 space-y-2.5 text-sm leading-6 text-slate-400">
            <li className="flex gap-2.5"><span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-300" /><span><strong className="text-slate-200">HTTPS everywhere.</strong> The app refuses to talk to a licence or ads endpoint over plain HTTP, and those endpoints are compiled in — a release build cannot be pointed somewhere else by an environment variable.</span></li>
            <li className="flex gap-2.5"><span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-300" /><span><strong className="text-slate-200">Signed updates.</strong> The update feed is Ed25519-signed and verified in the app. Whoever controls a plain feed controls both the installer URL and the checksum it is checked against, so a checksum alone proves nothing.</span></li>
            <li className="flex gap-2.5"><span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-300" /><span><strong className="text-slate-200">Credentials in the OS keychain.</strong> Your licence key or account token lives in Windows Credential Manager or the Secret Service on Linux, not in a settings file.</span></li>
            <li className="flex gap-2.5"><span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-300" /><span><strong className="text-slate-200">The remote dashboard is loopback-only by default</strong>, needs a token on every request, and flatly refuses to bind to your LAN without TLS — because the token would otherwise cross your Wi-Fi in clear text.</span></li>
            <li className="flex gap-2.5"><span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-300" /><span><strong className="text-slate-200">Two-factor authentication</strong> on the website, and one session per browser that can be revoked individually.</span></li>
            <li className="flex gap-2.5"><span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-300" /><span><strong className="text-slate-200">Optional SHA-256 verification</strong> on any download, and every release on the download page publishes its checksum.</span></li>
          </ul>
        </Card>

        <Card>
          <h2 className="text-lg font-bold text-white">Your rights, and the honest caveats</h2>
          <p className="mt-3 text-sm leading-6 text-slate-400">
            You can ask for a copy of everything we hold about you, ask us to correct it, or ask us
            to delete your account and its data. Email{' '}
            <a href="mailto:support@nexadownloadmanager.com" className="text-brand-300 hover:underline">
              support@nexadownloadmanager.com
            </a>{' '}
            and we will action it. Deleting your account removes your profile, licence and device
            records; payment records are kept where tax law requires it.
          </p>
          <p className="mt-3 text-sm leading-6 text-slate-400">
            We aim to meet GDPR and CCPA obligations, and the practices above are built for that —
            data minimisation is the design rather than a policy bolted on. We are a small team and
            have not been through a formal external audit, so we will not display a compliance badge
            we have not earned. The binding document is the{' '}
            <Link to="/privacy" className="text-brand-300 hover:underline">privacy policy</Link>.
          </p>
        </Card>
      </div>

      <Card className="mt-8">
        <h2 className="text-lg font-bold text-white">Reporting a vulnerability</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
          If you have found a security problem, please email{' '}
          <a href="mailto:security@nexadownloadmanager.com" className="text-brand-300 hover:underline">
            security@nexadownloadmanager.com
          </a>{' '}
          rather than opening a public issue. Tell us what you found, how to reproduce it and what
          you think the impact is. We will confirm receipt within two working days, keep you updated
          while we fix it, and credit you in the release notes unless you would rather we did not.
          We do not run a paid bounty programme yet and will say so up front rather than leaving you
          to wonder.
        </p>
      </Card>

      <div className="surface-panel mx-auto mt-10 max-w-3xl rounded-[var(--radius-3)] px-6 py-6">
        <p className="text-sm font-bold text-white">Read it yourself.</p>
        <p className="mt-1 text-xs text-slate-400">
          A tool that reads your cookies should be one you can inspect. The source and every release
          are public.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button to="/privacy">Privacy policy</Button>
          <Button to="/contact" variant="ghost">Ask us a privacy question</Button>
        </div>
      </div>
    </Section>
  );
}
