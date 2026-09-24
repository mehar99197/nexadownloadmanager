import { Link } from 'react-router-dom';
import usePageMeta from '../../hooks/usePageMeta';
import DocsShell, { H2, P, Steps, Bullets, Code, Note } from './DocsShell';

export default function DocsYoutube() {
  usePageMeta({
    title: 'YouTube & video sites',
    description: 'Download from YouTube and the other video sites Nexa hands to yt-dlp: the quality menu in the extension, playlists, and fixing “authentication required (HTTP 403)” with the extension or Site Logins.',
  });

  return (
    <DocsShell
      title="YouTube & video sites"
      intro="For YouTube and the sites listed below, Nexa hands the link to yt-dlp, which ships inside the app, and the download shows up in the same list as a normal file. On any other site, a video downloads only when the browser extension finds a direct, HLS or DASH stream on the page, or when you paste the address of the video file itself."
    >
      <H2 id="sites">Which sites</H2>
      <P>Nexa sends links from these sites to yt-dlp:</P>
      <Bullets
        items={[
          <><strong className="text-white">Video:</strong> YouTube (including Shorts and YouTube Music), Vimeo, Dailymotion, Bilibili and Twitch.</>,
          <><strong className="text-white">Social:</strong> X (Twitter), Facebook, Instagram, TikTok, Reddit and LinkedIn. Threads links go to yt-dlp too, but it has no Threads support: use <strong className="text-white">Grab media on this page</strong> in the extension&apos;s toolbar popup instead.</>,
          <><strong className="text-white">Music:</strong> Apple Music, but its full tracks are DRM-protected and cannot be downloaded.</>,
          <><strong className="text-white">Courses, Pro plan only:</strong> Udemy (one lecture at a time; whole courses are not supported), LinkedIn Learning and Pluralsight. Coursera and Skillshare have no yt-dlp support and work only through the stream the extension detects on the page, one lecture at a time: on Coursera the Download with NDM button offers it, on Skillshare use Grab media on this page.</>,
        ]}
      />
      <P>
        Udemy, Coursera, LinkedIn Learning, Skillshare, Pluralsight, Vimeo and Facebook are the
        login sites, where Nexa can use your browser login (see the 403 section below). YouTube never uses your login in Nexa.
      </P>

      <H2 id="basics">Two ways to start</H2>
      <Bullets
        items={[
          <><strong className="text-white">Add the link in the app.</strong> Click <strong className="text-white">+ New download</strong> or press <Code>Ctrl+N</Code>; a web link you have copied is filled in for you. You can also drop a link on the window. A link added this way downloads at the best quality available.</>,
          <><strong className="text-white">Use the extension.</strong> Hover a video on one of the sites yt-dlp reads and a <strong className="text-white">Download with NDM</strong> button appears over it. Click it, pick a quality, and the app takes over. Prefer this on the login sites, because it sends your login with the link.</>,
        ]}
      />

      <H2 id="quality">Quality picker</H2>
      <P>
        The quality menu is in the extension. On YouTube, X, TikTok, Reddit, Dailymotion, Twitch
        and Bilibili, the <strong className="text-white">Download with NDM</strong> button asks
        yt-dlp which qualities the video really has and lists Best available, every height on offer
        (2160p60, 1080p and so on) and Audio only (M4A). On Vimeo, Facebook, Instagram, LinkedIn,
        Udemy and Pluralsight it offers Best available and Audio only (M4A) instead, because the
        check cannot see formats behind a login. Nexa asks yt-dlp for the best
        video stream at or below your choice and the best audio, then merges them with the bundled
        ffmpeg into one MP4. A link added in the app always gets the best quality: the app has no quality picker and no default-quality setting.
      </P>
      <Note>
        Very high resolutions on YouTube are often only offered as VP9 or AV1. They play fine in
        modern players. Nexa has no option to ask for H.264, and picking 1080p or lower does not
        guarantee it.
      </Note>

      <H2 id="playlists">Playlists and channels</H2>
      <P>
        To get a whole playlist or channel, paste its link into New download and tick{' '}
        <strong className="text-white">Download whole course / playlist</strong>, or, on a YouTube
        playlist, pick a quality under <strong className="text-white">Entire playlist</strong> in the
        extension&apos;s menu. The playlist is one row: its Size column shows how many videos it has,
        the bar fills as they finish, and hovering its status shows a line like{' '}
        <Code>4/37 videos · 1.2 GB · 3 downloading</Code>. The files land in one folder named after
        the playlist, numbered in playlist order.{' '}
        <strong className="text-white">Playlist videos in parallel</strong> in Settings sets how many
        download at once (three unless you change it). The plan does not hold them back: Free runs 3 direct downloads at once (videos and torrents not counted).
        A video that cannot be downloaded, such as a private or deleted one, is skipped and the rest
        carry on. The finished row says how many videos were saved and counts DRM-protected ones
        separately; other skipped videos are not listed.
      </P>

      <H2 id="403">Fixing “authentication required (HTTP 403)”</H2>
      <P>
        A 403 from a media site means one of two things: the site wants you signed in (age-gated,
        members-only, purchased or private content), or the signed media URL has expired / was
        generated by a yt-dlp that is too old for the site&apos;s current player. Nexa tells the
        two apart in the error text where it can:
      </P>
      <Bullets
        items={[
          <><Code>authentication required (HTTP 403)</Code> — on a login site, sign in and retry with your login (below). YouTube never uses your login in Nexa, so signing in will not fix it there.</>,
          <><Code>media server refused the download (HTTP 403) — the stream URL expired or yt-dlp is out of date</Code> — this is <em>not</em> a login problem. Retry first: yt-dlp reads the page again and gets a fresh address. If it keeps failing, update Nexa, which is how a newer yt-dlp reaches you (below).</>,
          <><Code>sign-in required — re-export cookies</Code> — YouTube&apos;s &ldquo;confirm you&apos;re not a bot&rdquo; wall. Despite the wording, cookies cannot fix it, because YouTube never uses your login in Nexa. Retry later or from another network, and check for a Nexa update.</>,
        ]}
      />
      <P>To give Nexa your login on a login site:</P>
      <Steps
        items={[
          <><strong className="text-white">Easiest:</strong> sign in to the site in your browser, then start the download with the extension&apos;s <strong className="text-white">Download with NDM</strong> button. The extension sends the site&apos;s cookies through the local bridge, and yt-dlp uses your login for that download.</>,
          <><strong className="text-white">Without the extension:</strong> in the app open <strong className="text-white">Tools &rarr; Site logins…</strong>, pick the site and the browser you are signed in with, and click <strong className="text-white">Use browser login</strong>. yt-dlp then reads your login from that browser on every download. On Windows this works with Firefox; Chrome, Edge and Brave lock their cookies (see the note below).</>,
          <>Retry the download. Logins expire: if a site starts failing again weeks later, sign in to it again in your browser.</>,
        ]}
      />
      <Note tone="warn" title="Windows note">
        yt-dlp&apos;s own <Code>--cookies-from-browser</Code> cannot read Chrome, Edge or Brave
        cookies on Windows any more (Chrome 127+ App-Bound Encryption). The extension route is
        unaffected because it reads cookies through the browser&apos;s API.
      </Note>

      <H2 id="update">Keeping yt-dlp current</H2>
      <P>
        Sites change their players constantly and yt-dlp releases fixes within days. Nexa has no
        separate yt-dlp updater: yt-dlp ships inside Nexa, and your copy changes only when you install a Nexa update.
        If a site that used to work suddenly fails, use{' '}
        <strong className="text-white">Help &rarr; Check for updates…</strong> first.
      </P>

      <P>
        Course platforms (Udemy, Coursera) have their own guide: <Link to="/docs/courses" className="text-brand-300 hover:underline">Courses</Link>.
      </P>
    </DocsShell>
  );
}
