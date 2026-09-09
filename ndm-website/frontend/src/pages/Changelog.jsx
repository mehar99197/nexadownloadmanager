import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { unwrap } from '../api/client';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Spinner from '../components/Spinner';
import { formatDate } from '../utils/formatDate';

function ReleaseEntry({ release, latest }) {
  const date = formatDate(release.publishedAt);
  return (
    <Card className="!p-7">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-2xl font-extrabold tracking-tight text-white">v{release.version}</h2>
        {latest && (
          <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-1 text-xs font-bold uppercase tracking-[0.12em] text-emerald-300">
            Latest
          </span>
        )}
        {date && <span className="text-sm text-slate-500">{date}</span>}
        {Number.isFinite(Number(release.downloadCount)) && (
          <span className="ml-auto text-xs text-slate-500">
            {Number(release.downloadCount).toLocaleString('en-US')} downloads
          </span>
        )}
      </div>
      {release.changelog ? (
        <p className="mt-5 whitespace-pre-wrap border-t border-white/10 pt-5 text-sm leading-7 text-slate-300">
          {release.changelog}
        </p>
      ) : (
        <p className="mt-5 border-t border-white/10 pt-5 text-sm text-slate-500">No release notes were attached to this version.</p>
      )}
      {latest && (
        <div className="mt-6 flex flex-wrap gap-3">
          <Button to="/download" variant="ghost">Download v{release.version}</Button>
        </div>
      )}
    </Card>
  );
}

export default function Changelog() {
  usePageMeta({
    title: 'Changelog',
    description: 'Release notes for every published version of Nexa Download Manager.',
  });

  const [releases, setReleases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      try {
        const data = unwrap(await api.get('/releases/history'));
        if (!cancelled) setReleases(Array.isArray(data?.releases) ? data.releases : []);
      } catch (err) {
        if (!cancelled && err?.response?.status !== 404) setError('Failed to load release notes.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetch();
    return () => { cancelled = true; };
  }, []);

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />Release notes</span>
        <h1 className="mt-5 text-white">What <span className="text-gradient">changed.</span></h1>
        <p>Every published build of the desktop app, newest first. Checksums and installers are on the download page.</p>
      </div>

      <div className="mx-auto mt-12 max-w-3xl space-y-6">
        {loading ? (
          <Spinner center />
        ) : error ? (
          <p className="text-center text-red-300">{error}</p>
        ) : releases.length > 0 ? (
          releases.map((r) => <ReleaseEntry key={r.version} release={r} latest={Boolean(r.isLatest)} />)
        ) : (
          <Card className="!p-8 text-center">
            <span className="eyebrow"><span className="eyebrow-dot" />Nothing published yet</span>
            <h2 className="mt-4 text-xl font-bold text-white">No releases yet</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-7 text-slate-400">
              The first public build hasn&apos;t been published yet. Leave us a note and we will
              tell you the moment it is.
            </p>
            <div className="mt-6 flex justify-center gap-3">
              <Button to="/contact">Get notified</Button>
              <Button to="/docs" variant="ghost">Read the docs</Button>
            </div>
          </Card>
        )}

        <p className="text-center text-xs text-slate-500">
          Every published build is listed above, newest first.{' '}
          Looking for the extension? See the <Link to="/docs/extension" className="text-slate-300 hover:text-brand-300">extension guide</Link>.
        </p>
      </div>
    </Section>
  );
}
