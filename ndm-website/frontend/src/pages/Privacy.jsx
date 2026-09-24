import { Link } from 'react-router-dom';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';
import ScrollRegion from '../components/ScrollRegion';
import { turnstileEnabled } from '../components/Turnstile';
import { googleAuthEnabled } from '../components/GoogleButton';

const LAST_UPDATED = 'September 24, 2026';

// Plausible loads only when the site is built with a domain for it (main.jsx),
// so the policy names it only then.
const plausibleEnabled = () => Boolean(import.meta.env.VITE_PLAUSIBLE_DOMAIN);

const PERMISSIONS = [
  {
    name: 'downloads',
    why: 'Sees each download the browser starts and, once the desktop app has accepted it, cancels the browser’s copy. The “take over downloads” switch, your paused sites and the size and file-type filters decide which downloads it takes.',
  },
  {
    name: 'cookies',
    why: 'Read-only. When a download is handed to Nexa, the extension reads the cookies for its address and, for some services, their sign-in domain as well: an Instagram download also carries your facebook.com cookies, a OneDrive or microsoft.com download your live.com cookies, and a Google Drive download every google.com cookie. They go to the desktop app over native messaging; the app uses them for your downloads from that site, and they never reach our servers.',
  },
  {
    name: 'webRequest',
    why: 'Watches the requests in every tab, not only the one you are looking at, for media-like addresses (streams, video and audio files, archives, installers and PDFs) and keeps a list per tab for the download button and the toolbar badge. The list stays in the browser’s memory and is dropped when the tab navigates or closes. On about two dozen AI-assistant sites (ChatGPT, Claude, Gemini, Perplexity and others) it also keeps each request’s headers, Cookie and Authorization included, for two minutes, so downloading an attachment can reuse them. It only observes: nothing is modified or blocked.',
  },
  {
    name: 'nativeMessaging',
    why: 'Talks to the small nexa-host bridge that the desktop app registers on your machine; the bridge starts the app if it is not running. Every hand-off, quality lookup and link list reaches the app this way.',
  },
  {
    name: 'contextMenus',
    why: 'Adds four entries to the right-click menu: “Download with Nexa” on links, “Download video/audio with Nexa” on videos, audio and images, “Download all links on page” and “Download whole course with Nexa”.',
  },
  {
    name: 'storage',
    why: 'Keeps your extension settings, the names and sites of your last 8 hand-offs and your last 20 errors in the browser’s local storage on this computer. The per-tab media lists, the captured AI-site headers and recent quality lists sit in session storage, which the browser keeps in memory and clears when it closes. Nothing is synced to us or to your browser account.',
  },
  {
    name: 'notifications',
    why: 'Shows a system notification after each hand-off (“Sent to Nexa”, which you can turn off), with the result of sending a page’s links, and when something fails.',
  },
  {
    name: 'scripting',
    why: 'Adds the page script that draws the download button to tabs that were already open when the extension was installed or the browser started; pages opened later get it from the manifest. The Chrome and Firefox versions both use it.',
  },
  {
    name: 'tabs',
    why: 'Reads the address and title of the tab you are using, to name files, set the referrer and send the page to Nexa. When the extension is installed and each time the browser starts, it reads the address of every open tab to decide where to add the download button.',
  },
  {
    name: 'Host access to all sites (<all_urls>)',
    why: 'Media and course sites are unpredictable, so the download button, stream detection and cookie reading have to work on any site you visit. The page script runs on every page and looks for video players; to list a stream’s qualities, the extension downloads the stream’s HLS master playlist from the site you are watching, with that site’s cookies. Nothing it reads is sent to our servers.',
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

function Code({ children }) {
  return <code className="surface-inset rounded px-1 font-mono text-[0.9em] text-brand-100">{children}</code>;
}

const LINK = 'text-slate-200 underline underline-offset-2 hover:text-brand-300';

export default function Privacy() {
  usePageMeta({
    title: 'Privacy Policy',
    description:
      'What Nexa Download Manager collects and why: account details and sign-in records on the website; a license key or sign-in token, a device fingerprint, the computer’s name and the app version from the app; what you give the AI features, only if you use them; and nothing from the browser extension, whose cookies never reach our servers.',
  });

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />Legal</span>
        <h1 className="mt-5 text-white">Privacy <span className="text-gradient">Policy.</span></h1>
        <p>
          The short version: the website knows your account and keeps records of your sign-ins; the
          app tells us your license key or sign-in token, a device fingerprint, your computer&apos;s
          name and the app version — and, only if you use the AI features, the file name and address
          or the text they work on; the browser extension never talks to us at all.
          Last updated {LAST_UPDATED}.
        </p>
      </div>

      <Card className="mx-auto mt-12 max-w-3xl space-y-6 !p-7 sm:!p-9">
        <Block title="1. The website and user portal">
          <p>When you create an account we store:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>your name and email address;</li>
            <li>a bcrypt hash of your password — never the password itself;</li>
            <li>if you use Google sign-in, your Google account ID and the address of your Google profile picture;</li>
            <li>if you turn on two-factor authentication, its secret (encrypted) and hashes of your recovery codes;</li>
            <li>whether your email is verified, and counts of wrong passwords and two-factor codes, with any lock-out they triggered;</li>
            <li>for each browser you sign in on, a hashed session token and the IP address and browser it signed in from, kept until 30 days after that session was last used or signed out;</li>
            <li>your plan, license key, seat count and trial dates;</li>
            <li>each computer that has used your license: its device fingerprint and name, when it was first and last seen, and the app version it reports when signed in;</li>
            <li>for a paid license, a verdict on whether the key looks shared, based on how many different computers have used it overall and in the last week; past a high threshold the server suspends the key by itself;</li>
            <li>if you run a Team, the email addresses you invite;</li>
            <li>if you pay, your Stripe customer and subscription IDs, and for each payment its amount, currency, plan, billing cycle, Stripe payment ID, status and date. Card details are entered on Stripe&apos;s pages and never reach our servers;</li>
            <li>reviews you choose to post, with your display name.</li>
          </ul>
          <p>We also keep:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>a security log of sign-ins and other security events (failed sign-ins, lock-outs, password resets, two-factor changes, desktop sign-ins), each with the email address involved, the IP address and the browser, for 90 days;</li>
            <li>an audit log of account actions such as plan changes, license-key rotations, team invitations and account deletions, which names the email addresses involved and is not deleted on a schedule;</li>
            <li>when you sign the desktop app in, the IP address the request came from: with the sign-in request for about a day, and in the security log once you approve it;</li>
            <li>messages you send through the contact form, with your name, email address, topic, IP address and browser, and our replies. They are also emailed to our support mailbox and are not deleted automatically.</li>
          </ul>
          <p>
            We use this to run your account, keep it secure, bill you, answer support requests and
            send transactional email (verification, password reset, receipts). We do not send
            marketing email and we do not sell or share your data with advertisers.
          </p>
        </Block>

        <Block title="2. The desktop app">
          <p>
            The Windows and Linux app works fully offline for downloading. It contacts our servers
            for four things only:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong className="text-slate-200">Your plan</strong>, once you have signed the app in or
              entered a license key. It checks your plan at every launch and every 6 hours after that
              (<Code>POST /api/license/validate</Code>), sends a heartbeat every 5 minutes while it runs
              to hold your seat (<Code>/api/license/heartbeat</Code>, plus an early one after every tenth
              finished download), and hands the seat back when it closes
              (<Code>/api/license/release</Code>). Signing in uses the handshake under{' '}
              <Code>/api/device</Code>. The plan check, heartbeat and release carry your license key or
              your account&apos;s device token, and all of these requests, sign-in included, carry a
              device fingerprint (a hash derived from hardware and OS identifiers, so we can count
              seats). The plan check, the heartbeat and the sign-in also send the
              computer&apos;s name (its hostname and operating system), and the plan check and the
              sign-in send the app version. We keep each computer&apos;s name and app version with your
              account, and delete them with it. Without a key or a sign-in, the app makes none of these
              requests.
            </li>
            <li>
              <strong className="text-slate-200">Updates.</strong> Once a day — you can turn this
              off in Settings — and whenever you choose Check for updates, the app asks whether a
              newer release exists for your operating system. The request names your operating system
              and the app version.
            </li>
            <li>
              <strong className="text-slate-200">Promos, on the Free plan</strong> — see section 6.
            </li>
            <li>
              <strong className="text-slate-200">AI features, on Pro and Team, only when you use
              them</strong> — see section 5.
            </li>
          </ul>
          <p>
            Apart from the AI features, none of these requests include your download history, URLs,
            filenames, or anything about the files on your computer. Every request reaches our
            server with your IP address, and the server&apos;s log records that address and the path
            requested (not the query string). The same log receives the security events described in
            section 1. It is trimmed by size, not by date, so how long a line stays depends on how
            busy the server is.
          </p>
          <p>
            Your download history is a SQLite database in the app&apos;s data folder. In portable mode
            the settings sit in that folder too; otherwise they are in the Windows registry or, on
            Linux, a config file in your home folder. Your license key and your account&apos;s sign-in
            token are kept in Windows Credential Manager or the Linux Secret Service. Cookies the
            extension passes over for a signed-in site are written to temporary files, which the app
            deletes when it exits.
          </p>
          <p>
            Downloads themselves connect directly from your computer to the server hosting the
            file (or to peers, for torrents). We are not in the middle and do not see the traffic.
            For YouTube, the yt-dlp helper the app runs also downloads its challenge-solver scripts
            from GitHub the first time it needs them, and caches them; it runs them with Node.js,
            Deno or Bun if one of them is installed on your computer, and none comes with Nexa.
          </p>
        </Block>

        <Block title="3. The browser extension">
          <p>
            The extension exists to hand downloads from your browser to the app running on the same
            computer. It talks to that app over the browser&apos;s native messaging channel, a local
            pipe to the nexa-host program on your machine, and it never contacts
            nexadownloadmanager.com. When you hand over a download, it sends the app the address, the
            referrer, your browser&apos;s user agent and the cookies the download needs, which for some
            services include the cookies of their sign-in domain (section 4 has examples). On
            AI-assistant sites it also sends the headers the browser used to request that file,
            Authorization included.
          </p>
          <p>Some of its work happens in the background, without a click:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>it notes media-like request addresses in every open tab, so it can offer the download button there;</li>
            <li>on about two dozen AI-assistant sites it keeps each request&apos;s headers, Cookie and Authorization included, for two minutes, so downloading an attachment can reuse them (private windows are skipped);</li>
            <li>
              on YouTube video pages, and on any page of TikTok, X, Reddit, Dailymotion, Twitch,
              Bilibili and Threads, it sends the page&apos;s address, or that of the video in view, to
              the Nexa app about a second after the page loads, so the app can look up the
              video&apos;s qualities with yt-dlp. If
              the app is not running, the bridge starts it. Switching off the floating download
              button, or pausing the site, stops this.
            </li>
          </ul>
          <p>
            All of that stays between your browser and the app on your computer. The extension
            reaches one other place: when you open the download button&apos;s quality list for a
            stream, it downloads that stream&apos;s HLS master playlist from the site you are watching,
            with that site&apos;s cookies, to read which qualities it offers. It never sends cookies or
            the sites you visit to us. Section 4 lists every permission it asks for and why, and the{' '}
            <Link to="/docs/extension" className={LINK}>extension guide</Link> explains how it works.
          </p>
        </Block>

        <Block title="4. What the extension can access and why">
          <ScrollRegion className="mt-3 rounded-xl border border-white/5" label="Browser extension permissions and why each is needed — scrolls sideways">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Browser extension permissions and why each one is needed</caption>
              <thead>
                <tr className="surface-inset !border-x-0 !border-t-0 border-b border-white/10 text-xs uppercase tracking-wide text-slate-500">
                  <th scope="col" className="px-4 py-3 font-semibold">Permission</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Why it&apos;s needed</th>
                </tr>
              </thead>
              <tbody>
                {PERMISSIONS.map((p) => (
                  <tr key={p.name} className="border-b border-white/5 align-top last:border-0">
                    <th scope="row" className="whitespace-nowrap px-4 py-3 text-left font-mono text-xs font-normal text-brand-100">{p.name}</th>
                    <td className="px-4 py-3 leading-6 text-slate-400">{p.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        </Block>

        <Block title="5. Optional AI features (Pro and Team)">
          <p>
            Off by default. <strong className="text-slate-200">AI rename</strong> is a setting you
            switch on. While it is on, each time a file finishes downloading the app sends that
            file&apos;s name and the web address it came from — with the query string removed — to
            our server, together with your license token so the server can check your plan. Our
            server passes them to Anthropic&apos;s API, which suggests a cleaner name, and returns
            the suggestion to the app.
          </p>
          <p>
            <strong className="text-slate-200">Smart add (AI)</strong>, in the app&apos;s File menu,
            works the same way with the text you type into it, and only when you submit some.
          </p>
          <p>
            Our server does not store what it passes on — only its ordinary access log (section 2)
            is kept — and the contents of your files never leave your computer. Anthropic processes
            these requests under its own commercial terms and privacy policy. Leave AI rename off
            and do not use Smart add, and none of this is sent.
          </p>
        </Block>

        <Block title="6. In-app promos on the Free plan">
          <p>
            The Free plan shows one promo strip inside the desktop app. To fetch it, Nexa asks our
            own server for the current promos. The request names the placement
            (<Code>app_banner</Code>), its User-Agent names the app version, and once the app holds a
            license token it carries that too; the token is what tells the server your plan. No
            profile, no browsing history, no download list, and no third-party ad network is
            involved: the promos are ours and they are served from our own API. If a promo has an
            image, the app downloads it from the https address the promo gives, which can be on
            another server.
          </p>
          <p>
            We count how many times a promo was shown and how many times it was clicked. Those are
            plain counters on the promo itself — they are not attributed to you, and nothing is
            stored per install. Following a promo opens the link in your normal browser, where that
            site&apos;s own privacy policy applies.
          </p>
          <p>
            Pro and Team are ad-free once the app has confirmed your plan, normally a few seconds
            after launch. Until then every install runs as Free, so a paid install asks for promos
            once at launch, without its license token, and may show one for a moment, which is
            counted. After that the app stops asking, and the server refuses to return a promo for a
            paid license token.
          </p>
        </Block>

        <Block title="7. Analytics and cookies on the website">
          <p>This website sets these cookies of its own:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <Code>ndm_refresh</Code> keeps you signed in. It is httpOnly, so page scripts cannot
              read it, and it is sent only to our sign-in endpoints. It lasts 30 days and is renewed
              while you use the site.
            </li>
            <li>
              <Code>ndm_session</Code> goes with it. It holds no secret and page scripts can read it;
              it only tells the site to try restoring your sign-in. It lasts as long as{' '}
              <Code>ndm_refresh</Code>.
            </li>
            {googleAuthEnabled() && (
              <li>
                <Code>ndm_gnonce</Code> is set when the sign-in or registration page loads Google
                sign-in. It is httpOnly, lasts 30 minutes, and ties Google&apos;s answer to your
                browser. Google&apos;s sign-in script on those pages also sets its own{' '}
                <Code>g_state</Code> cookie.
              </li>
            )}
          </ul>
          <p>
            {plausibleEnabled()
              ? 'This site counts page views with Plausible Analytics, which sets no cookies: its script reports each page you view, and the page you came from, to Plausible.'
              : 'This site runs no analytics.'}
            {' '}We do not use advertising trackers.
          </p>
        </Block>

        <Block title="8. Who else sees your data">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong className="text-slate-200">Hostinger</strong> hosts this website and its API, so
              everything the site stores passes through its servers, and our nightly backups are
              kept there.
            </li>
            <li>
              <strong className="text-slate-200">Google</strong>. Gmail&apos;s mail servers send our
              account email (verification, password resets, receipts, license keys, sign-in and
              lock-out notices, trial reminders and team invitations), deliver contact-form messages
              to our support mailbox, and carry our replies. Google Fonts load on every
              page, so Google receives your IP address and browser details when it serves them.
              {googleAuthEnabled() && (
                <>
                  {' '}Google&apos;s sign-in script loads on the sign-in and registration pages, and if
                  you use &ldquo;Continue with Google&rdquo;, Google tells us your Google account ID,
                  name, email address and profile picture.
                </>
              )}
            </li>
            <li>
              <strong className="text-slate-200">Stripe</strong> handles payments, only when you buy a
              plan. Card details are entered on Stripe&apos;s pages.
            </li>
            <li>
              <strong className="text-slate-200">Anthropic</strong> runs AI rename and Smart add, only
              when you use them: our server passes on the file names, addresses and text described in
              section 5.
            </li>
            <li>
              <strong className="text-slate-200">Have I Been Pwned</strong>. When you set or change a
              password, our server sends the first five characters of its SHA-1 hash to HIBP&apos;s
              range API to check it against known breaches. The password and the rest of the hash
              stay on our server.
            </li>
            {turnstileEnabled() && (
              <li>
                <strong className="text-slate-200">Cloudflare Turnstile</strong> checks that a person
                is filling in the registration, forgot-password, contact and review forms. Its script
                loads on those pages, and when you submit one, our server sends Cloudflare your IP
                address with the check.
              </li>
            )}
            {plausibleEnabled() && (
              <li>
                <strong className="text-slate-200">Plausible</strong> counts page views, as described
                in section 7.
              </li>
            )}
          </ul>
          <p>We disclose data beyond that only when legally required.</p>
        </Block>

        <Block title="9. Retention and your rights">
          <p>
            Account data is kept while the account exists. Under &ldquo;Your data&rdquo; on your{' '}
            <Link to="/profile" className={LINK}>profile page</Link> you can download a copy of it —
            your profile, plans, license keys, devices, payments, review and team — and delete the
            account yourself. Deletion is immediate: your profile, license, devices, sessions,
            reviews and team memberships go at once. A few records outlive it:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>payment records, which we keep for tax, no longer linked to an account;</li>
            <li>our audit log, whose entries about your account — plan changes, key rotations, two-factor changes, team invitations and the deletion itself — name your email address;</li>
            <li>the security log, for up to 90 days, and the server log described in section 2, until it is trimmed;</li>
            <li>messages you sent through the contact form, with our replies;</li>
            <li>nightly database backups, for about two weeks;</li>
            <li>if you paid, Stripe&apos;s own customer record: we cancel your subscription with Stripe but do not delete the customer, so Stripe&apos;s privacy policy governs what it keeps.</li>
          </ul>
          <p>
            For a copy of anything the download does not cover, to correct something, or for any
            other request, email{' '}
            <a href="mailto:support@nexadownloadmanager.com" className="text-slate-200 hover:text-brand-300">support@nexadownloadmanager.com</a>.
            You can update your name and password from the{' '}
            <Link to="/profile" className="text-slate-200 hover:text-brand-300">profile page</Link>.
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
