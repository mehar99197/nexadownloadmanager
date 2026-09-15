import { Link } from 'react-router-dom';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';

const FAQS = [
  {
    q: 'Is Nexa free?',
    a: (
      <>
        Yes. The Free plan costs nothing, never expires and includes the browser extension, the
        video grabber, YouTube via yt-dlp and BitTorrent. It is limited to 3 downloads running at
        the same time. Every new account also gets a 7-day Pro trial with no card required.
      </>
    ),
  },
  {
    q: 'What does Pro add?',
    a: (
      <>
        Pro removes the concurrency cap (unlimited simultaneous downloads instead of 3), unlocks AI
        rename (smart filenames via Anthropic&apos;s API, using your own key) and gets you priority
        support. It is $5/month or $45/year. Team is the same features for 5 seats. See{' '}
        <Link to="/pricing" className="text-brand-300 hover:underline">pricing</Link>.
      </>
    ),
  },
  {
    q: 'Which operating systems are supported?',
    a: (
      <>
        Windows 10 or newer (installer) and Ubuntu 22.04+ / Debian 12+ (.deb package). The
        codebase is Qt and builds on macOS, but we have not shipped a signed macOS build yet —
        leave your email on the <Link to="/contact?topic=macos" className="text-brand-300 hover:underline">contact page</Link> and
        we will tell you when it lands.
      </>
    ),
  },
  {
    q: 'Is it safe? What happens to my cookies?',
    a: (
      <>
        The extension reads cookies only for the site you are downloading from and sends them to the
        Nexa app on your own computer over the browser&apos;s native messaging channel — a local
        pipe, not the internet. Nothing about your downloads is sent to our servers;
        the app only contacts us to validate a license key. Full details in the{' '}
        <Link to="/privacy" className="text-brand-300 hover:underline">privacy policy</Link>.
      </>
    ),
  },
  {
    q: 'How is Nexa different from IDM?',
    a: (
      <>
        IDM is Windows-only and closed source. Nexa runs on Windows and Linux, is open source, and
        puts HTTP downloads, HLS/DASH streams, YouTube and 1000+ sites (via yt-dlp), BitTorrent and
        cloud links (Google Drive, Mega) in one queue. It also has a phone dashboard and an optional
        AI rename. IDM has been around far longer and is more polished in places; Nexa is in beta.
        There is an honest side-by-side on the <Link to="/compare" className="text-brand-300 hover:underline">compare page</Link>.
      </>
    ),
  },
  {
    q: 'YouTube fails with “authentication required (HTTP 403)”. What now?',
    a: (
      <>
        A 403 usually means the site wants you signed in, or the signed media URL expired. Sign in
        to the site in your browser and start the download with the extension&apos;s &ldquo;Download
        with Nexa&rdquo; button so your session cookies travel with it. Alternatively use Settings
        &rarr; Site logins in the app to import a cookies.txt export. If it still fails, update
        yt-dlp — an out-of-date extractor is the other common cause. Step by step in the{' '}
        <Link to="/docs/youtube" className="text-brand-300 hover:underline">YouTube guide</Link>.
      </>
    ),
  },
  {
    q: 'How do I cancel?',
    a: (
      <>
        Open <Link to="/billing" className="text-brand-300 hover:underline">Billing</Link> and click
        &ldquo;Cancel subscription&rdquo;. Your plan stays active until the end of the period you
        already paid for and will not renew. There is no cancellation fee and no need to email anyone.
      </>
    ),
  },
  {
    q: 'What is the refund policy?',
    a: (
      <>
        Email <a href="mailto:support@nexadownloadmanager.com" className="text-brand-300 hover:underline">support@nexadownloadmanager.com</a> within
        14 days of any charge and we refund it in full, no questions asked. After 14 days charges are
        not refundable, but we will still cancel immediately on request. See the{' '}
        <Link to="/terms" className="text-brand-300 hover:underline">terms</Link>.
      </>
    ),
  },
  {
    q: 'Where are my downloaded files saved?',
    a: (
      <>
        In your system Downloads folder by default (<code className="font-mono text-xs text-brand-100">~/Downloads</code> on
        Linux, <code className="font-mono text-xs text-brand-100">%USERPROFILE%\Downloads</code> on Windows). Change it in
        Settings, or per download when you add one. The &ldquo;Open folder&rdquo; button in the
        toolbar jumps straight there.
      </>
    ),
  },
  {
    q: 'How do I update Nexa?',
    a: (
      <>
        Install the newer build over the old one — the Windows installer and the .deb both upgrade in
        place, and your queue, history and settings are kept. The{' '}
        <Link to="/changelog" className="text-brand-300 hover:underline">changelog</Link> lists what changed. yt-dlp inside the
        app can be updated separately from Settings when a site breaks between releases.
      </>
    ),
  },
  {
    q: 'Can I download an entire Udemy or Coursera course?',
    a: (
      <>
        If you are enrolled, yes. Open the course while signed in and use the extension&apos;s
        &ldquo;Download whole course with Nexa&rdquo; context-menu item; the app pulls every lecture
        as a playlist. DRM-protected lectures cannot be downloaded — the app tells you when it hits
        one. See the <Link to="/docs/courses" className="text-brand-300 hover:underline">courses guide</Link>.
      </>
    ),
  },
  {
    q: 'Does the browser extension work without the app?',
    a: (
      <>
        No. The extension is only a bridge — it hands URLs, headers and cookies to the desktop app
        through native messaging. If the app is not installed or not running you will see
        &ldquo;Nexa: engine unavailable&rdquo;. Install the app, launch it once so it registers the
        bridge, then reload the page. Troubleshooting is in the{' '}
        <Link to="/docs/extension" className="text-brand-300 hover:underline">extension guide</Link>.
      </>
    ),
  },
];

export default function Faq() {
  usePageMeta({
    title: 'FAQ',
    description:
      'Answers about Nexa Download Manager: pricing and the free plan, what Pro adds, supported platforms, safety and cookies, YouTube 403 errors, refunds, cancelling and updating.',
  });

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />Questions</span>
        <h1 className="mt-5 text-white">Straight <span className="text-gradient">answers.</span></h1>
        <p>Everything people ask before installing Nexa. Still stuck? The docs and support are one click away.</p>
      </div>

      <div className="mx-auto mt-12 max-w-3xl space-y-3">
        {FAQS.map((item, i) => (
          <Card as="details" key={item.q} className="group !p-0" open={i === 0}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-5 text-left text-base font-bold text-white marker:hidden [&::-webkit-details-marker]:hidden">
              <span>{item.q}</span>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="shrink-0 text-brand-300 transition-transform group-open:rotate-180"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </summary>
            <div className="border-t border-white/5 px-6 py-5 text-sm leading-7 text-slate-400">{item.a}</div>
          </Card>
        ))}
      </div>

      <div className="surface-panel mx-auto mt-10 flex max-w-3xl flex-wrap items-center justify-center gap-x-6 gap-y-4 rounded-xl px-6 py-5 text-center sm:text-left">
        <p className="text-sm text-slate-300">Didn&apos;t find it? Read the docs or ask us directly.</p>
        <div className="flex gap-3">
          <Button to="/docs" variant="ghost">Docs</Button>
          <Button to="/contact">Contact</Button>
        </div>
      </div>
    </Section>
  );
}
