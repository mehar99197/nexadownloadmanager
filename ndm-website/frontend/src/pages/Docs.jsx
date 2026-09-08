import { Link } from 'react-router-dom';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';
import { DOCS_NAV } from './docs/DocsShell';

export default function Docs() {
  usePageMeta({
    title: 'Docs',
    description:
      'Nexa Download Manager documentation: installing on Windows and Linux, the browser extension, YouTube and course downloads, torrents, the remote phone dashboard and license activation.',
  });

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />Documentation</span>
        <h1 className="mt-5 text-white">Get set up in <span className="text-gradient">minutes.</span></h1>
        <p>
          Short, specific guides for installing Nexa, wiring up your browser and
          getting the most out of every kind of download.
        </p>
      </div>

      <div className="mt-12 flex flex-wrap justify-center gap-5">
        {DOCS_NAV.map((item, i) => (
          <Card key={item.to} as={Link} to={item.to} className="card-hover block w-full !p-6 sm:w-[calc(50%-0.625rem)] lg:w-[calc(33.333%-0.834rem)]">
            <span className="text-xs font-bold uppercase tracking-[0.16em] text-brand-300">Guide {i + 1}</span>
            <h2 className="mt-2 text-base font-bold text-white">{item.label}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">{item.blurb}</p>
            <span className="mt-4 inline-block text-sm font-semibold text-brand-300">Read guide &rarr;</span>
          </Card>
        ))}
      </div>

      <Card className="mt-10 !p-6 sm:!p-8">
        <h2 className="text-lg font-bold text-white">Quick start</h2>
        <ol className="mt-4 grid gap-4 sm:grid-cols-3">
          {[
            ['Install the app', 'Run the Windows installer or install the .deb on Ubuntu/Debian. yt-dlp, ffmpeg and aria2 come bundled.', '/docs/install'],
            ['Add the extension', 'Load it in Chrome, Edge, Brave or Firefox. The app registers the native host bridge on every launch.', '/docs/extension'],
            ['Paste or click', 'Paste a URL, magnet link or .m3u8 into the app, or hit “Download with Nexa” in your browser.', '/docs/youtube'],
          ].map(([t, d, to], i) => (
            <li key={t} className="surface-inset rounded-xl p-4">
              <span className="text-xs font-bold text-brand-300">0{i + 1}</span>
              <h3 className="mt-1 text-sm font-bold text-white">{t}</h3>
              <p className="mt-1 text-xs leading-6 text-slate-400">{d}</p>
              <Link to={to} aria-label={`Details: ${t}`} className="mt-2 inline-block text-xs font-semibold text-brand-300 hover:text-white">Details &rarr;</Link>
            </li>
          ))}
        </ol>
      </Card>
    </Section>
  );
}
