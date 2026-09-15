import { Link } from 'react-router-dom';
import usePageMeta from '../../hooks/usePageMeta';
import DocsShell, { H2, P, Steps, Bullets, Code, Note } from './DocsShell';

export default function DocsLicense() {
  usePageMeta({
    title: 'Signing in & seats',
    description: 'Sign in to Nexa Download Manager with your account, how seats and device fingerprints work, manual licence keys, and what happens offline.',
  });

  return (
    <DocsShell
      title="Signing in & seats"
      intro="Your plan reaches the app by signing in with your account — no key to copy. A trial or an upgrade follows on its own. Licence keys still work for activating by hand."
    >
      <H2 id="sign-in">Signing in to the app</H2>
      <Steps
        items={[
          <>In the app open <strong className="text-white">Settings &rarr; Account</strong> and click <strong className="text-white">Sign in with Nexa</strong>. The app shows an 8-character code and opens this website.</>,
          <>Sign in here if you are not already, check the code on the page matches the one in the app, and click <strong className="text-white">Approve this computer</strong>.</>,
          <>The app notices within a few seconds and shows <Code>Signed in as you@example.com &middot; PRO license active</Code>. That computer now appears under <Link to="/dashboard" className="text-brand-300 hover:underline">Your devices</Link>, where you can sign it out at any time.</>,
        ]}
      />
      <P>
        Behind the scenes the app is handed a token bound to that computer &mdash; it is useless
        anywhere else, which is why an account can never be &ldquo;shared&rdquo; the way a key
        could. The token asks <Code>POST /api/license/validate</Code> for the plan on
        your account (or the Team you were invited onto) and receives a signed entitlement.
        Nothing about the machine leaves it except a hashed fingerprint used to count seats
        (see <Link to="/privacy" className="text-brand-300 hover:underline">privacy</Link>).
      </P>
      <Note>
        The Free plan needs no sign-in at all: the app starts on Free by itself. Signing in is
        what lets a trial or an upgrade on your account reach the app without any further step.
        If Settings has no <strong className="text-white">Account</strong> section, that machine is on an
        older version &mdash; <Link to="/download" className="text-brand-300 hover:underline">update Nexa</Link>{' '}
        and it appears. Until then, a paid plan still activates with the key from your dashboard.
      </Note>

      <H2 id="seats">Seats</H2>
      <Bullets
        items={[
          <><strong className="text-white">Pro</strong> includes 1 seat, <strong className="text-white">Team</strong> 5. A seat is one computer running the app at a time; it frees itself 15 minutes after the app closes. The Free plan has no seat limit.</>,
          <>Signing in on more computers than you have seats returns <Code>seat_limit</Code> and that computer stays on Free until one is free. Close the app elsewhere, or free the seat from your dashboard.</>,
          <>To move to a new computer: sign out on the old one (Settings &rarr; Account &rarr; <strong className="text-white">Sign out</strong>, which releases its seat) or sign it out from the dashboard, then sign in on the new one.</>,
          <>Team members sign in with their <em>own</em> account after accepting the invitation; the team&rsquo;s plan applies to them without anybody sharing a key.</>,
        ]}
      />

      <H2 id="keys">Licence keys (manual activation)</H2>
      <P>
        Paid plans still come with a key, shown on the dashboard. It is for activating by hand
        &mdash; an older version of Nexa, or a machine you set up without signing in: Settings
        &rarr; Account &rarr; <strong className="text-white">Use a licence key instead</strong>, paste it and click
        Activate. Keys look like <Code>NDM-XXXX-XXXX-XXXX</Code>. If a key has been shared,
        <strong className="text-white"> Replace key</strong> on the dashboard issues a new one and signs every
        machine activated with the old one out; computers signed in with an account are unaffected.
      </P>

      <H2 id="offline">Offline behaviour</H2>
      <P>
        After a successful check the entitlement is cached on the device. The app re-validates
        in the background when it has connectivity, but a missing network does not downgrade you:
        the cached plan stays active for up to 7 days, so you can keep using Pro on a laptop with
        no internet. If the server later reports the plan as <Code>expired</Code> or <Code>cancelled</Code>,
        the app returns to Free with a message in Settings; you stay signed in, and a renewal
        reaches the app at its next check.
      </P>
      <Note>
        A trial behaves exactly like a paid plan for its 7 days. When it ends the app returns to
        Free on its next check; upgrade from <Link to="/pricing" className="underline">pricing</Link> and the
        signed-in app picks the new plan up on its own.
      </Note>

      <H2 id="statuses">Status messages</H2>
      <Bullets
        items={[
          <><Code>signed_out</Code> &mdash; this computer was signed out from the dashboard, or the token was used elsewhere and revoked. Sign in again.</>,
          <><Code>seat_limit</Code> &mdash; no free seat for this computer right now.</>,
          <><Code>expired</Code> / <Code>cancelled</Code> &mdash; the paid plan or trial ended; the app is on Free until it is renewed.</>,
          <><Code>not_found</Code> &mdash; a typed key does not exist, or belongs to a deleted account.</>,
          <><Code>invalid</Code> &mdash; the key format is wrong.</>,
        ]}
      />
    </DocsShell>
  );
}
