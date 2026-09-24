import { Link } from 'react-router-dom';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';

const LAST_UPDATED = 'September 23, 2026';

function Clause({ n, title, children }) {
  return (
    <section className="border-t border-white/5 pt-6 first:border-0 first:pt-0">
      <h2 className="text-base font-bold text-white">
        <span className="mr-2 text-brand-300">{n}.</span>
        {title}
      </h2>
      <div className="mt-2 space-y-2 text-sm leading-7 text-slate-400">{children}</div>
    </section>
  );
}

export default function Terms() {
  usePageMeta({
    title: 'Terms of Service',
    description: 'Terms of Service for Nexa Download Manager: licensing per account, seats, 14-day refunds, acceptable use and warranty disclaimer.',
  });

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />Legal</span>
        <h1 className="mt-5 text-white">Terms of <span className="text-gradient">Service.</span></h1>
        <p>Plain-language terms for the Nexa Download Manager desktop app, browser extension and website. Last updated {LAST_UPDATED}.</p>
      </div>

      <Card className="mx-auto mt-12 max-w-3xl space-y-6 !p-7 sm:!p-9">
        <Clause n={1} title="Who we are and what these terms cover">
          <p>
            &ldquo;Nexa&rdquo;, &ldquo;we&rdquo; and &ldquo;us&rdquo; mean the operators of
            nexadownloadmanager.com. These terms apply to the Nexa Download Manager desktop
            application (Windows and Linux), the Nexa browser extension, the website, the
            user portal and the license API. By creating an account, installing the software
            or paying for a plan you agree to them. If you don&apos;t agree, don&apos;t use the service.
          </p>
        </Clause>

        <Clause n={2} title="Plans">
          <p>
            <strong className="text-slate-200">Free</strong> is free forever and limited to 3 concurrent
            downloads. <strong className="text-slate-200">Pro</strong> removes the concurrency cap and
            enables AI rename and priority support, billed monthly or yearly. <strong className="text-slate-200">Team</strong>{' '}
            includes everything in Pro for up to 5 seats. Prices are shown on the{' '}
            <Link to="/pricing" className="text-slate-200 hover:text-brand-300">pricing page</Link> in US dollars,
            exclusive of any taxes we are required to collect.
          </p>
          <p>
            Every new account may start one 7-day Pro trial without entering a card. When the trial
            ends the account returns to Free automatically; we never charge you for a trial.
          </p>
        </Clause>

        <Clause n={3} title="Licenses and seats">
          <p>
            A paid plan is licensed to the account that bought it, not to a person or a company in
            general. Each seat may be active on one device at a time; Pro includes 1 seat and Team
            includes 5. The app registers a device fingerprint when you sign in (or activate a key),
            and the license server refuses activations beyond your seat count. You can sign a
            device out from inside the app (Settings &rarr; Account &rarr; Sign out) or from your
            dashboard to free its seat.
          </p>
          <p>
            Do not share your account or resell or publish license keys. We may revoke keys that are being shared
            or that were obtained through fraud or a chargeback.
          </p>
        </Clause>

        <Clause n={4} title="Payments, renewals and cancellation">
          <p>
            Payments are processed by Stripe; we never see or store your full card number.
            Subscriptions renew automatically at the end of each billing cycle until you cancel.
            You can cancel at any time from the{' '}
            <Link to="/billing" className="text-slate-200 hover:text-brand-300">billing page</Link>; the plan
            stays active until the end of the period you already paid for and is not renewed after that.
          </p>
        </Clause>

        <Clause n={5} title="Refunds">
          <p>
            If Nexa isn&apos;t working for you, email{' '}
            <a href="mailto:support@nexadownloadmanager.com" className="text-slate-200 hover:text-brand-300">support@nexadownloadmanager.com</a>{' '}
            within 14 days of a charge and we will refund it in full. Charges older than 14 days,
            including renewals you forgot to cancel, are not refundable, although we will still
            cancel the subscription immediately on request. Refunds go back to the original
            payment method.
          </p>
        </Clause>

        <Clause n={6} title="Acceptable use">
          <p>
            Nexa is a tool for moving files you are entitled to move. You may only download
            content you have the right to download: your own files, content offered for download
            by its owner, public-domain or openly licensed material, and content from services
            you have paid for or been granted access to, in accordance with those services&apos; terms.
          </p>
          <p>You must not use Nexa to:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>infringe copyright, circumvent DRM or otherwise break the law where you live;</li>
            <li>overload, attack or scrape servers in violation of their terms;</li>
            <li>distribute malware or other harmful content;</li>
            <li>interfere with the license server, the website or other users&apos; accounts.</li>
          </ul>
          <p>
            We may suspend or terminate accounts that break these rules. You are responsible for
            what you download and for complying with the terms of the sites you download from.
          </p>
        </Clause>

        <Clause n={7} title="Third-party components">
          <p>
            The app bundles or invokes open-source tools including yt-dlp, FFmpeg, aria2 and
            libtorrent, each under its own license. The optional AI features on Pro and Team (AI
            rename and Smart add) send a file&apos;s name and source address, or the text you type,
            through our server to Anthropic&apos;s API, as the{' '}
            <Link to="/privacy" className="text-slate-200 hover:text-brand-300">privacy policy</Link>{' '}
            describes; Anthropic processes them under its own terms. We are not responsible for
            third-party services, and site-specific downloading can stop working when those sites
            change.
          </p>
        </Clause>

        <Clause n={8} title="Beta software, no warranty">
          <p>
            Nexa is currently in beta. The software, extension and website are provided
            &ldquo;as is&rdquo; and &ldquo;as available&rdquo;, without warranty of any kind, express or
            implied, including fitness for a particular purpose, merchantability and
            non-infringement. We do not promise any particular download speed, uptime or that every
            site will keep working.
          </p>
        </Clause>

        <Clause n={9} title="Limitation of liability">
          <p>
            To the fullest extent permitted by law, we are not liable for indirect, incidental,
            special or consequential damages, lost data or lost profits arising from your use of
            Nexa. Our total liability for any claim is limited to the amount you paid us in the
            12 months before the claim arose. Some jurisdictions do not allow these limits, in
            which case they apply only as far as the law allows.
          </p>
        </Clause>

        <Clause n={10} title="Your account">
          <p>
            Keep your password private and tell us promptly if you think your account has been
            compromised. You can delete your account by emailing support; we will remove your
            personal data as described in the{' '}
            <Link to="/privacy" className="text-slate-200 hover:text-brand-300">Privacy Policy</Link>.
          </p>
        </Clause>

        <Clause n={11} title="Changes to these terms">
          <p>
            We may update these terms as the product evolves. Material changes will be announced
            on this page and, for paying customers, by email at least 14 days before they take
            effect. Continuing to use Nexa after that date means you accept the new terms.
          </p>
        </Clause>

        <Clause n={12} title="Contact">
          <p>
            Questions about these terms: <Link to="/contact" className="text-slate-200 hover:text-brand-300">contact page</Link> or{' '}
            <a href="mailto:support@nexadownloadmanager.com" className="text-slate-200 hover:text-brand-300">support@nexadownloadmanager.com</a>.
          </p>
        </Clause>
      </Card>
    </Section>
  );
}
