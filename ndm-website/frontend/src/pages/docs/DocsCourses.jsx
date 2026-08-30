import { Link } from 'react-router-dom';
import usePageMeta from '../../hooks/usePageMeta';
import DocsShell, { H2, P, Steps, Bullets, Code, Note } from './DocsShell';

export default function DocsCourses() {
  usePageMeta({
    title: 'Courses',
    description: 'Download Udemy and Coursera courses you are enrolled in with the Nexa extension’s “Download whole course” action.',
  });

  return (
    <DocsShell
      title="Udemy & Coursera courses"
      intro="For courses you are enrolled in, Nexa can pull every lecture in order — with your login — so you can watch offline."
    >
      <Note tone="warn" title="Only courses you have access to">
        This works with your own account and only for courses you have enrolled in or bought. It
        does not bypass paywalls, and DRM-protected lectures (some Udemy business content) cannot
        be downloaded — Nexa reports <Code>this video is DRM-protected</Code> and skips them.
      </Note>

      <H2 id="setup">Before you start</H2>
      <Bullets
        items={[
          <>Install the <Link to="/docs/extension" className="text-brand-300 hover:underline">browser extension</Link> — course sites require your session cookies, and the extension is the reliable way to hand them over.</>,
          <>Sign in to Udemy or Coursera in that browser and open the course you want.</>,
          <>Have the desktop app running.</>,
        ]}
      />

      <H2 id="whole-course">Download a whole course</H2>
      <Steps
        items={[
          <>On the course page (the curriculum or a lecture), right-click and choose <strong className="text-white">Download whole course with Nexa</strong>. Or click the floating Nexa button and toggle &ldquo;Whole course&rdquo;.</>,
          <>The extension collects the cookies and headers for the course domain (Udemy, Coursera, Skillshare, Pluralsight, LinkedIn Learning and Vimeo are recognised out of the box) and sends the course URL as a playlist.</>,
          <>Pick a quality. The app enumerates every lecture with yt-dlp and adds them to the queue under a folder named after the course, sections numbered so they sort in order.</>,
          <>Lectures download in parallel up to your concurrency limit. Subtitles are fetched when the site offers them.</>,
        ]}
      />

      <H2 id="single">Just one lecture</H2>
      <P>
        Open the lecture and click the Nexa button without the whole-course toggle, or right-click
        &rarr; <strong className="text-white">Download with Nexa</strong>. It lands in the queue like any single
        video.
      </P>

      <H2 id="problems">If it fails</H2>
      <Bullets
        items={[
          <><Code>authentication required (HTTP 403)</Code> or <Code>login/course-access</Code> — the cookies did not make it. Make sure you started from the extension while signed in; if you pasted the URL by hand, add a <Code>cookies.txt</Code> under Settings &rarr; Site logins instead.</>,
          <>Lectures listed but zero bytes downloaded — usually an out-of-date yt-dlp. Settings &rarr; Video &rarr; Update yt-dlp, then retry the failed rows.</>,
          <>Coursera &ldquo;specialisations&rdquo; are several courses; download each course page separately.</>,
        ]}
      />
      <P>
        Course cookies are stored per domain on your machine only and are never uploaded. See the{' '}
        <Link to="/privacy" className="text-brand-300 hover:underline">privacy policy</Link> for exactly what the extension can access.
      </P>
    </DocsShell>
  );
}
