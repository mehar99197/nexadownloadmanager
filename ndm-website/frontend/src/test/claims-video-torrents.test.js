import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The video grabber, BitTorrent and torrent docs pages must say what the app
 * does. Each phrase below was once on one of these pages and was false:
 * checked against src/grabber/HlsGrabber.cpp, src/torrent/TorrentManager.cpp,
 * src/core/DownloadEngine.cpp, src/core/ProxyConfig.cpp and the extension.
 *
 * Reads the page sources rather than rendering them. Whitespace is collapsed
 * so a phrase still matches when JSX wraps it across lines.
 */
const source = (path) =>
  readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');

const video = source('../pages/features/FeatureVideoGrabber.jsx');
const torrent = source('../pages/features/FeatureBittorrent.jsx');
const docs = source('../pages/docs/DocsTorrents.jsx');

function expectGone(text, phrases) {
  for (const phrase of phrases) expect(text, `still says "${phrase}"`).not.toContain(phrase);
}

function expectSaid(text, phrases) {
  for (const phrase of phrases) expect(text, `does not say "${phrase}"`).toContain(phrase);
}

describe('Video grabber page', () => {
  it('no longer promises what the grabber does not do', () => {
    expectGone(video, [
      // Open streams go straight to ffmpeg; Nexa fetches in parallel only with cookies.
      'fetches its segments in parallel',
      'many at a time, not in playback order',
      "'16 at a time by default'",
      'configurable in Settings → Video sites',
      'it is in Settings → Video sites',
      // One failed segment fails the grab, and a stream has no known total.
      'retried individually',
      'the percentage is real',
      'Segment count and throughput are in the details window',
      // A stream-copy remux into a new MP4, always MP4, no subtitles.
      'bit-for-bit',
      'Byte-identical',
      'MKV',
      'embedded on request',
      // The extension lists HLS variants; nothing adds an audio-only entry.
      'plus audio-only',
      'Audio-only is on the same menu',
      'both are fetched and combined',
      // Detection is network sniffing; no Origin header is sent.
      'media-source blob',
      '<Code>Origin</Code>',
      // No DRM check exists, and stopping a stream keeps nothing.
      'the grabber will tell you so',
      'This stream is DRM protected',
      'from the current edge until you stop it',
      'the part already fetched is muxed and kept',
      // Iframe players get the button in the corner; a sniffed MP4 gets it too.
      'cross-origin iframe the content script cannot reach',
      'a plain progressive MP4, in which case there is nothing to grab',
      // Nexa routes only its own host list to yt-dlp (resources/cloud_providers.json).
      'thousand-odd sites',
      'The app logs which one',
      'drop the parallel-segment count',
    ]);
  });

  it('says what the grabber does instead', () => {
    expectSaid(video, [
      'HLS stream connections',
      'not a valid m3u8 playlist',
      'Separate HLS audio tracks are not merged yet',
      'does not check for DRM',
      'no subtitle option for streams',
      'Always MP4',
    ]);
  });
});

describe('BitTorrent page', () => {
  it('no longer promises what the torrent engine does not do', () => {
    expectGone(torrent, [
      // libtorrent has no proxy configured; ProxyConfig covers Qt and yt-dlp only.
      'system network and proxy',
      // Nothing about torrents is saved; startup restores HTTP tasks and schedules.
      'session state is persisted',
      'resume from 0% after restarting',
      // No magnet handler, no paste shortcut, no .torrent in the import dialog.
      'Ctrl+V',
      'click a <Code>magnet:</Code> link in the browser',
      'open it from the file dialog',
      'Reinstalling registers the handler',
      // Torrents have their own caps and always use the Torrents folder.
      'obeys the same global speed limit',
      'one bandwidth budget',
      'one speed limit',
      'same category rules',
      // The row shows progress, peers and download rate, never ratio or upload.
      'and the current ratio',
      'peer count and seed ratio',
    ]);
  });

  it('states exactly how torrent traffic relates to the proxy', () => {
    expectSaid(torrent, [
      'Torrent traffic (peers, trackers and DHT) never goes through a proxy',
      'not the one in Settings &rarr; Network, and not your system proxy',
    ]);
  });

  it('says what the torrent engine does instead', () => {
    expectSaid(torrent, [
      'torrents are not restored when Nexa restarts',
      'Download with Nexa',
      'Category rules do not apply to torrents',
    ]);
  });
});

describe('Torrents docs page', () => {
  it('no longer promises a magnet handler, Open with, or a quiet-hours schedule', () => {
    expectGone(docs, [
      'quiet hours',
      'links are handed to Nexa',
      'open it with Nexa',
      'same pause, resume and speed controls',
      'recognises the file type',
    ]);
  });

  it('says how magnet links actually reach Nexa', () => {
    expectSaid(docs, ['Download with Nexa', 'does not open Nexa']);
  });
});
