import { Link } from 'react-router-dom';
import { useConsent } from '../context/ConsentContext';

/**
 * The consent banner (WP-18).
 *
 * Deliberately not a modal: it does not trap focus and it does not cover the
 * page. Nothing on this site needs consent to work — only the optional Google
 * sign-in button does — so blocking the product to demand an answer would be
 * both hostile and disproportionate.
 *
 * Accept and Decline are given equal weight. A banner where "Accept" is a
 * button and "Decline" is a grey link is not a free choice, and regulators
 * have said so repeatedly.
 */
export default function CookieConsent() {
  const { decided, grant, deny } = useConsent();

  if (decided) return null;

  return (
    <section
      role="region"
      aria-label="Cookie consent"
      className="fixed inset-x-0 bottom-0 z-[60] border-t border-[var(--color-surface-border)] bg-[var(--color-nav-bg)] backdrop-blur-xl"
    >
      <div className="container-x flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-sm leading-6 text-slate-300">
          <span className="font-bold text-white">Optional third-party sign-in.</span>{' '}
          Signing in with Google loads a script from Google, which sets a cookie on your device.
          Nothing else on this site needs one, and we do not use analytics or advertising cookies.
          You can change your mind any time on the{' '}
          <Link to="/privacy" className="text-brand-300 hover:underline">privacy page</Link>.
        </p>
        <div className="flex shrink-0 gap-3">
          <button type="button" onClick={deny} className="btn btn-ghost">
            Decline
          </button>
          <button type="button" onClick={grant} className="btn btn-primary">
            Accept
          </button>
        </div>
      </div>
    </section>
  );
}
