import { useEffect, useState } from 'react';
import api, { unwrap } from '../api/client';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Spinner from '../components/Spinner';

const OS_OPTIONS = [
  {
    key: 'windows',
    label: 'Windows',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
        <path d="M3 12V6.5l8-1.1v6.6H3zm0 1.5h8v6.7l-8-1.1V13.5zm9-8.4L21 3v9h-9V5.1zm0 15.3V12h9v9l-9-1.2z" />
      </svg>
    ),
  },
  {
    key: 'linux',
    label: 'Linux',
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1.41 15.5c-.22.44-.45.87-.47 1.35-.02.47.34 1.09.73 1.5-.3.06-.61.13-.91.15-.56.04-.89-.29-1.06-.74-.17-.45-.13-.96.08-1.38.21-.42.53-.76.86-1.08.29-.29.65-.57.77-.92.06-.18.05-.42-.05-.62s-.33-.28-.57-.33c-.24-.05-.5-.04-.73.02-.23.06-.42.2-.59.35-.33.3-.57.68-.84 1.02-.27.34-.56.66-.69 1.09-.13.42-.1.91.15 1.28.25.37.67.58 1.11.52.24-.03.48-.09.7-.16.22-.07.43-.16.56-.31.14-.15.22-.36.21-.58-.01-.21-.14-.42-.26-.59-.12-.17-.25-.34-.29-.52-.03-.18.02-.4.18-.48.15-.08.32.01.43.13.11.12.18.26.24.41zm3.28-1.51c-.17-.45-.64-.67-1.09-.64-.27.02-.54.07-.81.1-.45.06-.97.09-1.29-.27-.23-.26-.24-.63-.14-.96.1-.32.27-.61.41-.91.14-.3.25-.63.23-1.05-.02-.42-.22-.78-.51-1.05-.49-.46-1.08-.85-1.74-1.13-.27-.12-.55-.23-.79-.04-.22.17-.26.46-.22.71.04.25.13.48.23.71.17.39.44.76.62 1.16.19.4.3.85.21 1.27-.08.36-.3.63-.55.85-.25.22-.52.41-.78.63-.27.22-.55.47-.73.79-.18.32-.23.7-.14 1.04.09.34.3.61.56.81.27.2.6.3.93.3.67.01 1.35-.16 2-.35.41-.12.82-.26 1.18-.08.29.14.47.4.59.7.12.29.19.6.29.89.05.14.13.28.26.36.13.08.33.06.46-.02.13-.08.21-.21.27-.35.16-.37.31-.74.25-1.14-.04-.28-.18-.55-.35-.78-.17-.23-.38-.44-.62-.62.08-.05.16-.1.22-.16.32-.31.53-.75.6-1.22.06-.47-.05-.97-.25-1.38zM12 3.84c.65 0 1.25.14 1.8.38-.21.19-.39.44-.47.73-.08.29-.03.63.14.92.17.29.43.52.73.69.3.17.63.27.97.32.14.02.29.03.43.02.55.04 1.12-.01 1.69.07.28.04.57.1.83.22.25.11.47.28.63.49.05.06.09.13.12.21.05.1.72.17 1.05.25.19.1.36.25.48.43.13.17.21.38.24.6.03.22.01.46-.05.67-.06.21-.17.41-.32.57-.14.16-.32.28-.52.34s-.42.06-.64.02l-.2-.03c-.22-.05-.41-.17-.54-.34-.13-.17-.19-.39-.17-.6.02-.22.1-.42.23-.59.03-.04.06-.07.11-.11l.06-.06c.14-.27.15-.58.02-.85-.13-.27-.39-.47-.69-.53-.3-.06-.65-.02-.97.11-.32.13-.61.33-.85.58-.24.25-.42.56-.53.89l-.02.01c-.43.4-.78.88-1.03 1.42-.25.54-.39 1.13-.4 1.73-.01.6.1 1.21.32 1.76.22.55.55 1.06.96 1.47.42.42.92.74 1.47.95.55.21 1.15.31 1.73.3h.03c.58-.01 1.14-.12 1.64-.35.5-.22.94-.55 1.28-.96.34-.42.57-.92.67-1.45.1-.53.07-1.09-.1-1.61-.07-.22-.2-.42-.37-.59-.17-.16-.38-.28-.6-.35s-.47-.07-.7-.02c-.23.05-.44.15-.61.3s-.29.34-.35.53c-.1.34-.22.68-.36 1.01-.14.33-.3.66-.52.95-.21.29-.47.55-.77.76z" />
      </svg>
    ),
  },
];

export default function Download() {
  const [release, setRelease] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [os, setOs] = useState('');

  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      try {
        const res = await api.get('/releases/latest');
        if (!cancelled) setRelease(unwrap(res));
      } catch {
        if (!cancelled) setError('Failed to load download links.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetch();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!os) {
      const ua = navigator.userAgent;
      if (ua.includes('Win')) setOs('windows');
      else if (ua.includes('Linux')) setOs('linux');
    }
  }, [os]);

  return (
    <Section className="relative overflow-hidden">
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />Latest release / v{release?.version || '0.1.0'}</span>
        <h1 className="mt-5 text-white">Get the <span className="text-gradient">full-speed</span> experience.</h1>
        <p>
          Choose your platform and bring NexaDownloadManager to the desktop.
          Fast by default, free to start, and ready for every kind of transfer.
        </p>
      </div>

      {loading ? (
        <Spinner center />
      ) : error ? (
        <div className="mt-10 text-center">
          <p className="text-red-300">{error}</p>
        </div>
      ) : (
        <>
          <div className="mx-auto mt-12 grid max-w-3xl gap-5 sm:grid-cols-2">
            {OS_OPTIONS.map(({ key, label, icon }) => {
              const url = key === 'windows' ? release?.windowsUrl : release?.linuxUrl;

              return (
                <Card key={key} className="card-hover text-center !p-7">
                  <div className="icon-tile mx-auto">
                    {icon}
                  </div>
                  <h3 className="mt-5 text-lg font-bold text-white">{label}</h3>
                  {release?.version && (
                    <p className="mt-2 text-xs font-medium uppercase tracking-[0.12em] text-slate-500">
                      Version {release.version}
                    </p>
                  )}
                  <div className="mt-5">
                    <Button
                      href={url || '#'}
                      className="w-full"
                      variant={key === os ? 'primary' : 'ghost'}
                    >
                      {key === os ? 'Download for ' + label : 'Download'}
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>

          {release?.changelog && (
            <Card className="mx-auto mt-10 max-w-3xl !p-7">
              <div className="flex items-center justify-between gap-4">
                <h3 className="text-lg font-bold text-white">
                  What&apos;s new in v{release.version}
                </h3>
                <span className="hidden rounded-full border border-brand-400/25 bg-brand-400/10 px-3 py-1 text-[0.65rem] font-bold uppercase tracking-[0.12em] text-brand-300 sm:inline-flex">Release notes</span>
              </div>
              <p className="mt-4 whitespace-pre-wrap border-t border-white/10 pt-4 text-sm leading-relaxed text-slate-400">
                {release.changelog}
              </p>
            </Card>
          )}
        </>
      )}
    </Section>
  );
}
