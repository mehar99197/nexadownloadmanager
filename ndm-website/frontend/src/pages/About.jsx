import { Link } from 'react-router-dom';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import { SOURCE_URL } from '../components/Footer';

const FACTS = [
  { label: 'Platforms', value: 'Windows & Linux', note: 'macOS is building but not yet signed' },
  { label: 'License', value: 'Free core', note: 'Free: 3 direct downloads at once; Pro: up to 32' },
  { label: 'Engine', value: 'C++ / Qt 6', note: 'native, no Electron' },
  { label: 'Status', value: 'Public beta', note: 'shipping openly, bugs and all' },
];

export default function About() {
  usePageMeta({
    title: 'About',
    description:
      'Who builds Nexa Download Manager, why it exists, and what we will and will not do with your data.',
  });

  return (
    <>
      <Section>
        <p className="eyebrow"><span className="eyebrow-dot" />About</p>
        <h1 className="mt-3 max-w-3xl text-4xl font-extrabold tracking-tight text-white md:text-5xl">
          A download manager that treats you like an adult
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-slate-400">
          Nexa started with a simple annoyance: the best-known download manager on Windows is
          paid, closed and Windows-only, and browsers still download big files on a single
          connection. Nexa splits a file across up to 32 connections on Pro (16 on Free), resumes
          exactly where it stopped, grabs video from the page you are on, and handles torrents and
          cloud links in the same queue — on Windows and Linux.
        </p>
      </Section>

      <Section className="pt-0">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FACTS.map((f) => (
            <Card key={f.label} className="p-5">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{f.label}</p>
              <p className="mt-2 text-lg font-bold text-white">{f.value}</p>
              <p className="mt-1 text-sm text-zinc-400">{f.note}</p>
            </Card>
          ))}
        </div>
      </Section>

      <Section className="pt-0">
        <div className="grid gap-6 md:grid-cols-2">
          <Card className="p-7">
            <h2 className="text-xl font-bold text-white">What we believe</h2>
            <ul className="mt-4 space-y-3 text-sm leading-6 text-zinc-400">
              <li>
                <strong className="text-slate-200">Your files are yours.</strong> Downloads happen on
                your machine, to your disk. Nothing is proxied through our servers, and we could not
                see your files if we wanted to. Two opt-in Pro features are the exception: AI rename
                (off by default) sends a finished file&apos;s name and its URL without the query
                string, and Smart add sends the text you type, to our server, which passes them to
                Anthropic.
              </li>
              <li>
                <strong className="text-slate-200">Credentials stay local.</strong> The browser
                extension reads cookies for the site you are downloading from and hands them to the
                Nexa app running on your own computer, over the browser&apos;s native-messaging
                bridge. They are never sent to us. The{' '}
                <Link to="/privacy" className="text-brand-300 hover:underline">privacy policy</Link>{' '}
                spells out every permission and why it exists.
              </li>
              <li>
                <strong className="text-slate-200">Free should be genuinely usable.</strong> The free
                plan is not a trial: extension, video grabber, YouTube support and BitTorrent are all
                included forever. Pro runs up to 32 direct downloads at once instead of 3, doubles the
                connections per file to 32, drops the in-app promos, and adds login-gated course
                sites, AI renaming and Smart add.
              </li>
              <li>
                <strong className="text-slate-200">Say what is true.</strong> We do not publish
                invented user counts, and we mark features that are not finished as unfinished.
              </li>
            </ul>
          </Card>

          <Card className="p-7">
            <h2 className="text-xl font-bold text-white">Where it is honest to be cautious</h2>
            <ul className="mt-4 space-y-3 text-sm leading-6 text-zinc-400">
              <li>
                <strong className="text-slate-200">This is a beta.</strong> The download engine is
                well covered by tests; some site integrations depend on{' '}
                <code className="surface-inset rounded px-1.5 py-0.5 text-xs text-brand-200">yt-dlp</code>,
                which the sites themselves break from time to time. Keeping the app updated is how
                those fixes reach you.
              </li>
              <li>
                <strong className="text-slate-200">macOS is not shipped.</strong> The code builds
                there and CI produces an app bundle, but it is unsigned, so Gatekeeper will refuse
                it. We would rather say that than sell you a broken download.
              </li>
              <li>
                <strong className="text-slate-200">Only download what you may.</strong> Nexa is a
                transfer tool. It does not break DRM, and using it against a site&apos;s terms is
                your call and your responsibility.
              </li>
            </ul>
          </Card>
        </div>
      </Section>

      <Section className="pt-0">
        <Card className="flex flex-col items-start gap-5 p-8 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-bold text-white">Built in the open</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-400">
              A tool that reads your cookies should be one you can inspect. The source, the issue
              tracker and every release live{' '}
              <a href={SOURCE_URL} className="text-brand-300 hover:underline">on GitHub</a> — bug
              reports and pull requests welcome.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button to="/download">Download Nexa</Button>
            <Button to="/docs" variant="ghost">Read the docs</Button>
          </div>
        </Card>
      </Section>
    </>
  );
}
