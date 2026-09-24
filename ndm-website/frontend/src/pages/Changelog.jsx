import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { lastRead, readPublic } from '../api/reads';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Skeleton, { SkeletonText, useArrival } from '../components/Skeleton';
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

/**
 * Two release entries as they will land: the version heading, its date, the
 * rule and a paragraph of notes. The spinner this replaces was one line tall,
 * so the notes arriving pushed the footnote down the page by a screen.
 */
function ChangelogSkeleton() {
  return (
    <div role="status" aria-label="Loading the release notes" className="space-y-6">
      {[0, 1].map((i) => (
        <Card key={i} className="!p-7">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-2xl font-extrabold tracking-tight">
              <SkeletonText chars={6} />
            </h2>
            <Skeleton className="h-4 w-24 rounded" />
          </div>
          <div className="mt-5 border-t border-white/10 pt-5">
            {['w-full', 'w-full', 'w-11/12', 'w-2/3'].map((w, j) => (
              <Skeleton key={j} className={`h-3.5 rounded ${w} ${j ? 'mt-3.5' : ''}`} />
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

const unpack = (data) => (Array.isArray(data?.releases) ? data.releases : []);

export default function Changelog() {
  usePageMeta({
    title: 'Changelog',
    description: 'Release notes for every published version of Nexa Download Manager.',
  });

  const [releases, setReleases] = useState(() => unpack(lastRead('/releases/history')));
  const [loading, setLoading] = useState(() => lastRead('/releases/history') === undefined);
  const [error, setError] = useState('');
  const arrive = useArrival(loading);

  useEffect(() => {
    let cancelled = false;
    readPublic('/releases/history')
      .then((data) => {
        if (!cancelled) setReleases(unpack(data));
      })
      .catch((err) => {
        if (!cancelled && err?.response?.status !== 404 && lastRead('/releases/history') === undefined) {
          setError('Failed to load release notes.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />Release notes</span>
        <h1 className="mt-5 text-white">What <span className="text-gradient">changed.</span></h1>
        <p>Every published build of the desktop app, newest first. The latest build&apos;s installer and its SHA-256 checksum are on the download page.</p>
      </div>

      <div className="mx-auto mt-12 max-w-3xl space-y-6">
        {loading ? (
          <ChangelogSkeleton />
        ) : error ? (
          <p className="text-center text-red-300">{error}</p>
        ) : releases.length > 0 ? (
          <div className={`space-y-6 ${arrive}`.trim()}>
            {releases.map((r) => <ReleaseEntry key={r.version} release={r} latest={Boolean(r.isLatest)} />)}
          </div>
        ) : (
          <Card className={`!p-8 text-center ${arrive}`.trim()}>
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
