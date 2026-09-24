import { Link } from 'react-router-dom';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import ScrollRegion from '../components/ScrollRegion';
import { SOURCE_URL } from '../components/Footer';

/* Every claim on this page was checked against the source before it was
   written. Some of them are uncomfortable and are stated anyway: AI rename
   sends a filename and a URL to our server, Smart add sends whatever you type
   into it, and the Free plan's ad request reaches us with your license token
   and therefore your IP. A privacy page that omits its own awkward cases is
   marketing. */

const PRINCIPLES = [
  {
    title: 'Your files are yours',
    body: 'Downloads go from the server straight to your disk. They are never proxied, mirrored, scanned or stored by us. We could not hand over your files if we were asked to, because we never have them.',
  },
  {
    title: 'Credentials never reach us',
    body: 'The browser extension reads the cookies a download needs and passes them to the Nexa app on your own machine, over the browser’s local native-messaging pipe. The app uses them for your downloads from that site. They never reach our servers.',
  },
  {
    title: 'You can check all of this',
    body: (
      <>
        The app, the browser extension and the native-messaging bridge are open source. Everything
        on this page is a claim you can verify by{' '}
        <a href={SOURCE_URL} className="text-brand-300 hover:underline">reading the code</a>{' '}
        rather than trusting us.
      </>
    ),
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
    where: 'Browser → extension → local bridge → Nexa app → the site you download from',
    reaches: 'Never reaches us',
    tone: 'good',
    detail: 'A local pipe on your own computer, then the download request itself. The extension has no server of its own to talk to.',
  },
  {
    what: 'URLs, filenames, download history',
    where: 'Local SQLite database on your machine',
    reaches: 'Never reaches us',
    tone: 'good',
    detail: 'Your queue and history are a file in the app’s data folder. There is no sync and no backup to us.',
  },
  {
    what: 'YouTube challenge solver',
    where: 'yt-dlp → GitHub',
    reaches: 'Never reaches us',
    tone: 'good',
    detail: 'For YouTube, including the quality lookup the extension asks the app for, the yt-dlp helper downloads its challenge-solver scripts from GitHub the first time it needs them, then caches them. It runs them with Node.js, Deno or Bun if you have one installed; none comes with Nexa.',
  },
  {
    what: 'License check: at launch, every 6 hours, and a heartbeat every 5 minutes',
    where: 'Nexa app → our server',
    reaches: 'License key or account token, device fingerprint, computer name, app version, IP',
    tone: 'info',
    detail: 'Only once the app is signed in or has a license key. It checks your plan at launch and every 6 hours (/api/license/validate), sends a heartbeat every 5 minutes to hold its seat (/api/license/heartbeat), with an extra one after every tenth finished download, and gives the seat back when it closes (/api/license/release); signing in uses /api/device. The check, heartbeat and release carry your license key or account token, and every one of these requests carries a device fingerprint — a SHA-256 of your primary network adapter’s MAC and machine id. The raw MAC never leaves your computer, and the fingerprint cannot be reversed into it. The check and the heartbeat add the computer’s name (hostname and operating system), the check adds the app version, and we keep both with your account. None of it says what you are downloading.',
  },
  {
    what: 'Update check (daily, can be turned off)',
    where: 'Nexa app → our server',
    reaches: 'Operating system, app version, IP',
    tone: 'info',
    detail: 'Asks whether a newer release exists for your platform; the request names your operating system and the app version. The response is Ed25519-signed so a tampered feed cannot hand your app an installer.',
  },
  {
    what: 'Promo request — Free plan',
    where: 'Nexa app → our server',
    reaches: 'Placement, app version, license token if any, IP',
    tone: 'warn',
    detail: 'The in-app promo strip is fetched from us, so that request reaches our server with your IP address, the app version and, once the app holds one, your license token. It contains nothing about your downloads. A promo’s image comes from whatever address the promo gives, which can be another server. Pro and Team stop asking as soon as the app has confirmed the plan, normally a few seconds after launch; before that, a paid install asks once without its token, and a promo it shows in that moment is counted.',
  },
  {
    what: 'AI rename — off by default, Pro and Team',
    where: 'Nexa app → our server → Anthropic',
    reaches: 'The filename and the source URL, minus its query string',
    tone: 'warn',
    detail: 'This is the one feature that sends something about a download off your machine on its own, and it is why it ships switched off. When you enable it, a finished file’s name and the address it came from — with the query string stripped — are sent to our server, which asks Anthropic’s API for a better name and returns it. Nothing else about the file — never its contents. Leave the toggle off and none of it happens.',
  },
  {
    what: 'Smart add (AI) — Pro and Team, only when you use it',
    where: 'Nexa app → our server → Anthropic',
    reaches: 'Exactly the text you type into it',
    tone: 'warn',
    detail: 'Smart add turns a sentence such as “download these two links tonight at 2am” into queued downloads. What you type — links included — is sent with your license token to our server, which has Anthropic’s API read it and returns the result. Nothing is sent until you submit some text.',
  },
  {
    what: 'Account data (only if you sign in)',
    where: 'Browser → our server',
    reaches: 'Email, name, plan, sessions with IP and browser',
    tone: 'info',
    detail: 'Ordinary account data for the website, plus the IP address and browser of each signed-in session and a 90-day security log of sign-ins. Signing in is optional — the Free plan works without an account at all.',
  },
];

const TONE = {
  good: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  info: 'border-brand-400/25 bg-brand-400/10 text-brand-300',
  warn: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
};

const PERMISSIONS = [
  [
    'Host access to all sites (<all_urls>)',
    'The download button runs on every page, requests are watched on every site, and cookies can be read for any site you download from. To list a stream’s qualities the extension also downloads its HLS master playlist from the site you are watching, with that site’s cookies. It cannot be narrowed to a site list, because you can download from anywhere.',
  ],
  [
    'nativeMessaging',
    'The local bridge to the Nexa app, which starts the app if it is not running. Every hand-off goes this way, and so does the quality lookup the extension starts by itself about a second after a YouTube video page, or a page on the other public video sites it supports, loads.',
  ],
  [
    'webRequest',
    'Observes the requests every tab makes, in the background, to spot streams and media files. A stream manifest is fetched by JavaScript and never appears in the page, so there is no other way to find it. On about two dozen AI-assistant sites it also keeps each request’s headers, Cookie and Authorization included, for two minutes, so an attachment download can reuse them. It never blocks or changes a request.',
  ],
  [
    'downloads',
    'To take over a download the browser was about to start, and cancel the browser’s copy once Nexa has it. You can turn this off and use the right-click menu instead.',
  ],
  [
    'cookies',
    'Read-only. Reads the cookies for a download you hand to Nexa and, for some services, their sign-in domain too — facebook.com for Instagram, live.com for OneDrive and microsoft.com, every google.com cookie for Google Drive — and sends them over the local bridge to your own machine.',
  ],
  [
    'tabs',
    'Reads the address and title of the tab you use, to name files and send pages to Nexa. On install and each time the browser starts, it reads every open tab’s address to add the download button to it.',
  ],
  [
    'scripting',
    'Adds the download button to tabs that were already open when the extension was installed or the browser started.',
  ],
  [
    'storage',
    'The extension’s own settings, your last 8 hand-offs and your last 20 errors, kept in the browser on this computer. Per-tab media lists and captured headers live in session storage, which the browser clears when it closes.',
  ],
  [
    'contextMenus',
    'Four right-click entries: Download with Nexa, Download video/audio with Nexa, Download all links on page, and Download whole course with Nexa.',
  ],
  [
    'notifications',
    '“Sent to Nexa” after each hand-off (you can turn it off), the result of sending a page’s links, and errors.',
  ],
];

export default function Security() {
  usePageMeta({
    title: 'Security & privacy',
    description:
      'Exactly what Nexa Download Manager sends, what it never sends, what every browser-extension permission is for, and the three requests that deserve a closer look — stated plainly.',
  });

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />Security &amp; privacy</span>
        <h1 className="mt-5 text-white">Your downloads stay on <span className="text-gradient">your machine.</span></h1>
        <p>
          Here is precisely what leaves your computer, what does not, and the three places where the
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
          One row per thing the app handles. Six of them reach us, and three of those deserve the
          amber mark; the other four never reach us at all.
        </p>
        <ScrollRegion className="mt-5" label="Where each kind of data travels — scrolls sideways">
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
        </ScrollRegion>
      </Card>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="text-lg font-bold text-white">What we do not collect</h2>
          <ul className="mt-4 space-y-2.5 text-sm leading-6 text-slate-400">
            {[
              'The URLs you download from — except when you switch AI rename on or type them into Smart add, both covered above.',
              'The contents of your files, ever. Their names only pass through when AI rename is on, as above.',
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
              'Your plan, your license key, and every computer that has used it: its name, when it was first and last seen and, for a signed-in app, its version. Your dashboard lists them, and you can sign any of them out there.',
              'A device fingerprint per activated machine: a one-way hash, kept so seat limits and key-sharing checks can work at all.',
              'Payment records: amount, currency, plan, billing cycle, Stripe’s payment ID, status and date. No card digits — cards are handled by Stripe and never touch our servers.',
              'The IP address and browser of each signed-in website session, until 30 days after its last use, and a 90-day security log of sign-ins with the email address, IP address and browser involved.',
              'Server logs of each request’s IP address and path, trimmed by size rather than by date.',
              'If you use them: your Google account ID and picture address, your two-factor secret (encrypted) and recovery-code hashes, and the addresses you invite to a Team.',
              'Reviews you post, and contact-form messages with the IP address and browser they came from. Those messages are not deleted automatically.',
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
        <ScrollRegion className="mt-5" label="Browser permissions requested by the extension — scrolls sideways">
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
        </ScrollRegion>
      </Card>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="text-lg font-bold text-white">Security measures</h2>
          <ul className="mt-4 space-y-2.5 text-sm leading-6 text-slate-400">
            <li className="flex gap-2.5"><span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-300" /><span><strong className="text-slate-200">HTTPS everywhere.</strong> The app refuses to talk to a license or ads endpoint over plain HTTP, and those endpoints are compiled in — a release build cannot be pointed somewhere else by an environment variable.</span></li>
            <li className="flex gap-2.5"><span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-300" /><span><strong className="text-slate-200">Signed updates.</strong> The update feed is Ed25519-signed and verified in the app. Whoever controls a plain feed controls both the installer URL and the checksum it is checked against, so a checksum alone proves nothing.</span></li>
            <li className="flex gap-2.5"><span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-300" /><span><strong className="text-slate-200">Credentials in the OS keychain.</strong> Your license key or account token lives in Windows Credential Manager or the Secret Service on Linux, not in a settings file.</span></li>
            <li className="flex gap-2.5"><span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-300" /><span><strong className="text-slate-200">The remote dashboard is loopback-only by default</strong>, needs a token on every request, and flatly refuses to bind to your LAN without TLS — because the token would otherwise cross your Wi-Fi in clear text.</span></li>
            <li className="flex gap-2.5"><span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-300" /><span><strong className="text-slate-200">Two-factor authentication</strong> on the website, and one session per browser that can be revoked individually.</span></li>
            <li className="flex gap-2.5"><span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-300" /><span><strong className="text-slate-200">Optional SHA-256 verification</strong> for direct file downloads, and every release on the download page publishes its checksum.</span></li>
          </ul>
        </Card>

        <Card>
          <h2 className="text-lg font-bold text-white">Your rights, and the honest caveats</h2>
          <p className="mt-3 text-sm leading-6 text-slate-400">
            Under &ldquo;Your data&rdquo; on your{' '}
            <Link to="/profile" className="text-brand-300 underline underline-offset-2">profile page</Link>{' '}
            you can download a copy of your account data and delete your account yourself. Deletion
            is immediate and removes your profile, license, device records and sessions. Afterwards,
            payment records are kept for tax; our audit log keeps its entries naming your email
            address, the deletion included; the security log keeps its entries for up to 90 days;
            contact-form messages stay; backups made before the deletion stay until they are removed; and if you
            paid, Stripe keeps its own customer record, because we cancel the subscription rather
            than delete the customer. To correct anything else, or for anything the download does
            not cover, email{' '}
            <a href="mailto:support@nexadownloadmanager.com" className="text-brand-300 hover:underline">
              support@nexadownloadmanager.com
            </a>.
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
          <Button href={SOURCE_URL} variant="ghost">Source on GitHub</Button>
          <Button to="/contact" variant="ghost">Ask us a privacy question</Button>
        </div>
      </div>
    </Section>
  );
}
