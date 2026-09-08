import { Link } from 'react-router-dom';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';

const LAST_UPDATED = 'August 30, 2026';

const PERMISSIONS = [
  {
    name: 'downloads',
    why: 'Intercepts downloads the browser is about to start so they can be handed to the desktop app instead. Without it the extension cannot take over a download.',
  },
  {
    name: 'cookies',
    why: 'Reads the cookies for the site you are downloading from (for example Udemy or Vimeo) so the desktop app can fetch content you are logged in to. Cookies go to the local app over native messaging and nowhere else.',
  },
  {
    name: 'webRequest',
    why: 'Watches network requests on the current tab to spot media streams (.m3u8 / .mpd manifests, video files) and to capture the request headers a site expects. Only used for detection; nothing is modified or blocked.',
  },
  {
    name: 'nativeMessaging',
    why: 'Talks to the tiny nexa-host bridge that the desktop app registers on your machine. This is the only channel the extension uses to send anything anywhere.',
  },
  {
    name: 'contextMenus',
    why: 'Adds “Download with Nexa” and “Download whole course with Nexa” to the right-click menu.',
  },
  {
    name: 'storage',
    why: 'Remembers your extension preferences locally (for example the default quality). Not synced to us.',
  },
  {
    name: 'tabs',
    why: 'Reads the URL and title of the active tab to name files sensibly and to know which site’s cookies to collect.',
  },
  {
    name: 'scripting',
    why: 'Injects the floating download button and stream detector into pages (Chromium only; Firefox uses a declared content script instead).',
  },
  {
    name: 'Host access to all sites (<all_urls>)',
    why: 'Media and course sites are unpredictable, so the download button, stream sniffing and cookie capture have to be able to run on any site you visit. The extension does not read page content beyond what is needed to find media, and it never sends page data to our servers.',
  },
];

function H2({ children }) {
  return <h2 className="text-base font-bold text-white">{children}</h2>;
}

function Block({ title, children }) {
  return (
    <section className="border-t border-white/5 pt-6 first:border-0 first:pt-0">
      <H2>{title}</H2>
      <div className="mt-2 space-y-2 text-sm leading-7 text-slate-400">{children}</div>
    </section>
  );
}

export default function Privacy() {
  usePageMeta({
    title: 'Privacy Policy',
    description:
      'What Nexa Download Manager collects and why: account details on the website, a license key and device fingerprint from the app, and nothing from the browser extension — cookies stay on your machine.',
  });

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />Legal</span>
        <h1 className="mt-5 text-white">Privacy <span className="text-gradient">Policy.</span></h1>
        <p>
          The short version: the website knows your account, the app tells us your license
          key and a device fingerprint, and the browser extension never talks to us at all.
          Last updated {LAST_UPDATED}.
        </p>
      </div>

      <Card className="mx-auto mt-12 max-w-3xl space-y-6 !p-7 sm:!p-9">
        <Block title="1. The website and user portal">
          <p>When you create an account we store:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>your name and email address;</li>
            <li>a bcrypt hash of your password — never the password itself;</li>
            <li>whether your email is verified, and hashed refresh tokens for your sessions;</li>
            <li>your plan, license key, seat count and trial dates;</li>
            <li>if you pay, the Stripe customer, subscription and payment references. Card numbers are entered on Stripe&apos;s pages and never reach our servers;</li>
            <li>reviews you choose to post, with your display name.</li>
          </ul>
          <p>
            We use this to run your account, bill you, answer support requests and send
            transactional email (verification, password reset, receipts). We do not send
            marketing email and we do not sell or share your data with advertisers.
          </p>
        </Block>

        <Block title="2. The desktop app">
          <p>
            The Windows and Linux app works fully offline for downloading. The only request it
            makes to our servers is <code className="surface-inset rounded px-1 font-mono text-[0.9em] text-brand-100">POST /api/license/validate</code>,
            sent when you activate a key and periodically afterwards to confirm the plan. That
            request carries exactly two things: your license key and a device fingerprint (a
            hash derived from hardware and OS identifiers, so we can enforce seats). It does not
            include your download history, URLs, filenames, or anything about the files on your computer.
          </p>
          <p>
            Download history, cookies exported for authenticated sites, and settings are stored in
            a local SQLite database and config folder on your machine. Deleting the app&apos;s data
            folder removes them.
          </p>
          <p>
            Downloads themselves connect directly from your computer to the server hosting the
            file (or to peers, for torrents). We are not in the middle and do not see the traffic.
          </p>
        </Block>

        <Block title="3. The browser extension">
          <p>
            The extension exists to hand downloads from your browser to the app running on the same
            computer. To do that for sites that require a login, it reads the cookies and the request
            headers (user agent, referer, authorisation headers) for the site you are downloading from
            — and <strong className="text-slate-200">only</strong> for that download. It passes them
            to the desktop app over the browser&apos;s native messaging channel, which is a local
            pipe between the browser and the nexa-host program on your machine.
          </p>
          <p>
            The extension has no server component. It never contacts nexadownloadmanager.com or
            any other remote host, never uploads cookies, and does not track the sites you visit.
            You can confirm this in the source, which is public on{' '}
            <a href="https://github.com/mehar99197/nexadownloadmanager" target="_blank" rel="noreferrer" className="text-slate-200 hover:text-brand-300">GitHub</a>.
          </p>
        </Block>

        <Block title="4. What the extension can access and why">
          <div className="mt-3 overflow-x-auto rounded-xl border border-white/5">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="surface-inset !border-x-0 !border-t-0 border-b border-white/10 text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3 font-semibold">Permission</th>
                  <th className="px-4 py-3 font-semibold">Why it&apos;s needed</th>
                </tr>
              </thead>
              <tbody>
                {PERMISSIONS.map((p) => (
                  <tr key={p.name} className="border-b border-white/5 align-top last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-brand-100">{p.name}</td>
                    <td className="px-4 py-3 leading-6 text-slate-400">{p.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Block>

        <Block title="5. Optional AI rename">
          <p>
            Off by default. If you enter an Anthropic API key in the app, the AI rename feature
            sends the original filename (and, for scheduling, the text you type) to Anthropic&apos;s
            API using your key. Nothing else — no file contents, no URLs beyond what is in the
            filename. Anthropic&apos;s handling of that data is covered by their privacy policy. Remove
            the key to switch the feature off.
          </p>
        </Block>

        <Block title="6. In-app promos on the Free plan">
          <p>
            The Free plan shows one promo strip inside the desktop app. To fetch it, Nexa asks our
            own server for the current promo and sends the licence token it already holds — that is
            the only thing sent, and it is what tells the server your plan. No profile, no browsing
            history, no download list, and no third-party ad network is involved: the promos are
            ours and they are served from our own API.
          </p>
          <p>
            We count how many times a promo was shown and how many times it was clicked. Those are
            plain counters on the promo itself — they are not attributed to you, and nothing is
            stored per install. Following a promo opens the link in your normal browser, where that
            site&apos;s own privacy policy applies.
          </p>
          <p>
            Pro and Team are ad-free. The server refuses to return a promo for a paid licence, so
            no request for one is made and nothing is counted.
          </p>
        </Block>

        <Block title="7. Analytics and cookies on the website">
          <p>
            By default this website runs no analytics and sets only the cookies it needs to keep
            you signed in (an httpOnly refresh cookie). The site operator may enable
            privacy-friendly, cookie-less analytics (Plausible) which counts page views without
            fingerprinting or cross-site tracking; if enabled, it is stated on this page. We do not
            use advertising trackers.
          </p>
        </Block>

        <Block title="8. Who else sees your data">
          <ul className="list-disc space-y-1 pl-5">
            <li><strong className="text-slate-200">Stripe</strong> — payments, when you subscribe.</li>
            <li><strong className="text-slate-200">Our email provider</strong> — verification, reset and receipt emails.</li>
            <li><strong className="text-slate-200">Our hosting provider</strong> — where the database and API run.</li>
            <li><strong className="text-slate-200">Anthropic</strong> — only if you enable AI rename with your own key.</li>
          </ul>
          <p>We disclose data beyond that only when legally required.</p>
        </Block>

        <Block title="9. Retention and your rights">
          <p>
            Account data is kept while the account exists. Email{' '}
            <a href="mailto:support@nexadownloadmanager.com" className="text-slate-200 hover:text-brand-300">support@nexadownloadmanager.com</a>{' '}
            to export or delete your account; we remove personal data within 30 days, keeping only
            the payment records we are legally required to retain. You can update your name and
            password from the <Link to="/profile" className="text-slate-200 hover:text-brand-300">profile page</Link>.
          </p>
        </Block>

        <Block title="10. Changes">
          <p>
            If this policy changes in a way that affects you, we will update the date at the top
            and, for material changes, email account holders before they take effect.
          </p>
        </Block>
      </Card>
    </Section>
  );
}
