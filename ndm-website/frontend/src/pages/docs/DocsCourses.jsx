import { Link } from 'react-router-dom';
import usePageMeta from '../../hooks/usePageMeta';
import DocsShell, { H2, P, Steps, Bullets, Code, Note } from './DocsShell';

export default function DocsCourses() {
  usePageMeta({
    title: 'Courses',
    description: 'Download lectures from Udemy and Coursera courses you are enrolled in, one at a time, with the Nexa browser extension. Course sites need Nexa Pro or Team.',
  });

  return (
    <DocsShell
      title="Udemy & Coursera courses"
      intro="For courses you are enrolled in, Nexa downloads lectures one at a time — with your login — so you can watch offline."
    >
      <Note title="Needs Pro or Team">
        Course sites are part of Nexa Pro and Team. On the Free plan the app refuses downloads from
        Udemy, Coursera, Skillshare, Pluralsight and LinkedIn Learning with{' '}
        <Code>Downloading from … needs Nexa Pro</Code>. The 7-day Pro trial includes them: start it
        from the <Link to="/pricing" className="underline underline-offset-2">pricing page</Link> (one
        per account, no card needed), then sign in to the app with that account under Settings
        &rarr; Account.
      </Note>

      <Note tone="warn" title="Only courses you have access to">
        This works with your own account and only for courses you have enrolled in or bought. It
        does not bypass paywalls, and DRM-protected lectures (common on Udemy) cannot be
        downloaded — Nexa reports <Code>this video is DRM-protected</Code> and stops.
      </Note>

      <H2 id="setup">Before you start</H2>
      <Bullets
        items={[
          <>Install the <Link to="/docs/extension" className="text-brand-300 hover:underline">browser extension</Link> — course sites require your session cookies, and the extension is the reliable way to hand them over.</>,
          <>Sign in to Udemy or Coursera in that browser and open the course you want.</>,
          <>Have the desktop app running.</>,
        ]}
      />

      <H2 id="udemy">Download a Udemy lecture</H2>
      <Steps
        items={[
          <>Open the lecture in your browser, on the page that plays it.</>,
          <>Click <strong className="text-white">Download with NDM</strong> at the top right of the video. It shows for a few seconds when the page opens; after that, move the pointer over the video to bring it back.</>,
          <>Choose <strong className="text-white">This lecture only</strong> for the video, in the best quality Udemy offers, or <strong className="text-white">Audio only (m4a)</strong> for just the sound. Course sites get no list of resolutions. Skip <strong className="text-white">Entire course — all lectures</strong> (see Whole courses, below).</>,
          <>The lecture joins Nexa&apos;s queue as one download. Open the next lecture and repeat.</>,
        ]}
      />
      <P>
        Subtitles are off by default. To embed a lecture&apos;s subtitles when Udemy has them, turn
        on <strong className="text-white">Download and embed subtitles</strong> under Settings
        &rarr; Video sites and list the languages you want.
      </P>

      <H2 id="coursera">Download a Coursera lecture</H2>
      <Steps
        items={[
          <>Open the lecture and start the video playing, so the page loads it.</>,
          <>Click <strong className="text-white">Download with NDM</strong>. The panel lists the video the page is playing; if it says <Code>Nothing downloadable here yet</Code>, let the video play for a moment and open the panel again.</>,
          <>Pick an entry. Nexa downloads that video itself and names the file after the lecture.</>,
        ]}
      />
      <P>
        yt-dlp has no Coursera support, so Nexa takes the video the page itself plays — one lecture
        at a time.
      </P>

      <H2 id="whole-course">Whole courses</H2>
      <P>
        Nexa does not support downloading a whole course from Udemy or Coursera. On a Udemy lecture
        the panel still lists <strong className="text-white">Entire course — all lectures</strong>, and
        the right-click menu has <strong className="text-white">Download whole course with Nexa</strong>,
        but neither gets you a course: yt-dlp cannot read a course from Udemy&apos;s current pages
        (Nexa reports that as <Code>Udemy course download is not supported</Code>), and it has no
        Coursera support at all. Download one lecture at a time.
      </P>

      <H2 id="problems">If it fails</H2>
      <Bullets
        items={[
          <><Code>authentication required (HTTP 403)</Code> or <Code>login required</Code> — your login did not reach Nexa. Start the download from <strong className="text-white">Download with NDM</strong> while you are signed in to the site in that browser. If you pasted the address into Nexa instead, click Settings in the app, then <strong className="text-white">Site logins…</strong>, pick the site and the browser you are signed in with, and click <strong className="text-white">Use browser login</strong>. On Windows that cannot read Chrome, Edge or Brave, which lock their cookies away from other programs: use Firefox there, or start from the extension.</>,
          <>If the error says yt-dlp is out of date, or is not listed here, try updating Nexa. There is no separate yt-dlp updater: each Nexa release ships its own copy. Click Settings in the app, then <strong className="text-white">Check for updates…</strong>, and try the lecture again.</>,
        ]}
      />
      <P>
        The cookies the extension sends for a course site are written to a temporary file in a
        private folder on your machine, used only for that site, and deleted when Nexa exits. A
        browser login from Site logins writes no file: yt-dlp reads that browser&apos;s cookies each
        time it runs. Neither is sent to our servers. See the{' '}
        <Link to="/privacy" className="text-brand-300 hover:underline">privacy policy</Link> for exactly what the extension can access.
      </P>
    </DocsShell>
  );
}
