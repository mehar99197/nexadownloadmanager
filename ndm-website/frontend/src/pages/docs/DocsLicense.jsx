import { Link } from 'react-router-dom';
import usePageMeta from '../../hooks/usePageMeta';
import DocsShell, { H2, P, Steps, Bullets, Code, Note } from './DocsShell';

export default function DocsLicense() {
  usePageMeta({
    title: 'License & seats',
    description: 'Activate a Nexa Pro or Team license key in Settings, how seats and device fingerprints work, and what happens offline.',
  });

  return (
    <DocsShell
      title="License & seats"
      intro="Pro and Team unlock in the app with a key from your dashboard. Activation takes one request; after that the app works offline."
    >
      <H2 id="activate">Activating a key</H2>
      <Steps
        items={[
          <>Sign in to the website and copy your key from the <Link to="/dashboard" className="text-brand-300 hover:underline">dashboard</Link>. Keys look like <Code>NDM-XXXX-XXXX-XXXX</Code>. A trial or paid plan issues one automatically.</>,
          <>In the app open <strong className="text-white">Settings &rarr; License</strong>, paste the key and click <strong className="text-white">Activate</strong>.</>,
          <>The app sends the key plus a device fingerprint to <Code>POST /api/license/validate</Code> and shows the result in the Status line — for example <Code>Pro plan · active</Code>. The concurrency cap lifts immediately.</>,
        ]}
      />
      <P>
        The fingerprint is a hash of stable hardware and OS identifiers. It exists only so seats can
        be counted; it is not tied to your name, and it is the only thing the app ever sends us
        besides the key (see <Link to="/privacy" className="text-brand-300 hover:underline">privacy</Link>).
      </P>

      <H2 id="seats">Seats</H2>
      <Bullets
        items={[
          <><strong className="text-white">Pro</strong> includes 1 seat, <strong className="text-white">Team</strong> 5. A seat is one device; the first activation from a new device claims a seat.</>,
          <>Activating on more devices than you have seats returns <Code>device_mismatch</Code> and the app stays on Free. Free a seat first.</>,
          <>To move to a new computer: Settings &rarr; License &rarr; <strong className="text-white">Remove</strong> on the old one (this releases its seat), then activate on the new one. If the old machine is gone, <Link to="/contact?topic=license" className="text-brand-300 hover:underline">contact support</Link> and we will release it.</>,
          <>Reinstalling the OS can change the fingerprint. Remove the key before you wipe, or ask us to reset.</>,
        ]}
      />

      <H2 id="offline">Offline behaviour</H2>
      <P>
        After a successful activation the entitlement is cached on the device. The app re-validates
        in the background when it has connectivity, but a missing network does not downgrade you:
        the cached plan stays active, so you can keep using Pro on a laptop with no internet. If the
        server later reports the license as <Code>expired</Code> or <Code>cancelled</Code> (for example after a
        subscription lapses), the cache is cleared and the app returns to Free with a message in
        Settings.
      </P>
      <Note>
        A trial license behaves exactly like a paid one for its 7 days. When it ends the next
        validation returns <Code>expired</Code>; upgrade from <Link to="/pricing" className="underline">pricing</Link> and the
        same key becomes valid again — no need to re-enter it.
      </Note>

      <H2 id="statuses">Status messages</H2>
      <Bullets
        items={[
          <><Code>not_found</Code> — typo in the key, or the key belongs to a deleted account.</>,
          <><Code>expired</Code> — the subscription or trial ended. Renew and click Activate again.</>,
          <><Code>cancelled</Code> — the subscription was cancelled and its paid period has ended.</>,
          <><Code>device_mismatch</Code> — no free seat for this device.</>,
          <><Code>invalid</Code> — the key format is wrong.</>,
        ]}
      />
    </DocsShell>
  );
}
