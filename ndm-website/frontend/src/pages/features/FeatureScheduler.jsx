import usePageMeta from '../../hooks/usePageMeta';
import FeatureShell, {
  H2, P, Steps, Bullets, Code, Note, Figure, SpecTable, Tips, Troubles, Related,
} from './FeatureShell';

export default function FeatureScheduler() {
  usePageMeta({
    title: 'Scheduler & speed limits',
    description:
      'Start downloads at a chosen time, cap the speed of direct downloads globally or per download, and have Nexa sleep or shut the machine down when the queue is empty.',
  });

  return (
    <FeatureShell
      title="Scheduler & speed limits"
      tagline="Download when the line is free, at a speed that leaves room for everything else, and let the machine put itself to bed afterwards."
      hero={
        <Figure kind="Screenshot">
          The new-download dialog with &ldquo;Start later, at&rdquo; ticked and the date-time picker
          open.
        </Figure>
      }
    >
      <H2 id="what">What it does</H2>
      <P>
        Bandwidth is shared, and a download manager that takes all of it is a download manager you
        end up closing. Three controls fix that, and they compose: <em>when</em> a download starts,{' '}
        <em>how fast</em> it is allowed to go, and <em>what happens</em> when the queue empties.
      </P>
      <Bullets
        items={[
          <><strong className="text-white">Start later.</strong> Queue something now and have it begin at a time you choose. The app does not need to stay open in a particular state — scheduled jobs survive a restart and re-arm themselves.</>,
          <><strong className="text-white">Speed limits.</strong> A global cap on direct downloads, and a per-download cap on top of it. Both are live: change them mid-transfer and the running downloads adjust immediately. Video-site, stream and MEGA downloads are not capped; torrents have limits of their own.</>,
          <><strong className="text-white">When all downloads finish.</strong> Open the folder, put the machine to sleep, or shut it down — sleep and shutdown with a countdown you can cancel.</>,
        ]}
      />
      <P>
        The everyday shape of this: a 40&nbsp;GB download queued at 5pm to start at 2am, capped so
        it never touches the video call you are in, with the machine shutting itself down when the
        last file lands.
      </P>

      <H2 id="how">How it works</H2>
      <P>
        <strong className="text-white">Scheduling.</strong> A scheduled download is a row in the
        local SQLite database holding the URL, the start time and the suggested name. On launch Nexa
        reads that table and re-arms a timer for every job still in the future, so closing the app —
        or rebooting — does not lose the schedule. When the time arrives the job becomes an ordinary
        download and joins the queue.
      </P>
      <Note tone="warn" title="One deliberate limitation">
        Headers and cookies are <strong>not</strong> stored with a scheduled job. Persisting a
        session cookie to disk so it can be replayed at 3am is a meaningfully worse security
        trade-off than the convenience is worth. The practical consequence: schedule public URLs.
        A download that needs a login should be started from the extension at the time you want it,
        not scheduled — its session would likely have expired by then anyway.
      </Note>
      <P>
        <strong className="text-white">Speed limits</strong> are enforced with a token bucket shared
        by every direct download. Tokens accrue at the configured rate; a connection that
        wants to read waits until its bytes are covered. Because the bucket is shared, sixteen
        connections on one file and three separate files all draw from the same budget — the cap is
        a real ceiling on direct downloads, not a per-connection number that quietly multiplies. A
        per-download cap is a second, smaller bucket layered on top. Video-site grabs, streams and
        MEGA downloads do not draw from the bucket, so the cap does not slow them.
      </P>
      <P>
        BitTorrent has its own pair of limits, separate on purpose: torrent upload needs different
        headroom from HTTP download, and sharing one number would force a bad compromise.
      </P>
      <P>
        <strong className="text-white">Post-download actions</strong> run once, after a download
        completes and nothing else is left running, queued, paused or scheduled. Sleep and shutdown
        both show a 60-second countdown first, with a Cancel button in the countdown window,
        because an unattended shutdown that you did not mean is a much worse outcome than a machine
        left running.
      </P>

      <H2 id="supported">What you can set</H2>
      <SpecTable
        caption="Scheduling and bandwidth options available in Nexa"
        head={['Control', 'Detail']}
        rows={[
          ['Start at a time', 'Any future date and time, per download, set in the new-download dialog'],
          ['Survives restart', <>Yes — re-armed from the database on launch. The app must be running at the scheduled time.</>],
          ['Global speed cap', <>KB/s across all direct downloads; video-site, stream and MEGA downloads are not capped. <Code>0</Code> = unlimited. Applies live.</>],
          ['Per-download cap', 'KB/s for one row, from its right-click menu, layered under the global cap'],
          ['Torrent limits', 'Separate download and upload caps, plus the seed-ratio target'],
          ['Concurrency', 'How many direct downloads run at once — up to 3 on Free, up to 32 on Pro. Video-site, stream, MEGA and torrent jobs are not counted.'],
          ['Connections per file', 'Not a setting: Nexa picks it from the file size, up to 16 on Free and 32 on Pro. The speed cap still applies to all of them.'],
          ['When all downloads finish', 'Do nothing, open the download folder, sleep, or shut down — sleep and shutdown after a 60-second countdown you can cancel'],
          ['Queue reordering', 'Drag rows, or use Move to top, Move up and Move down in a row’s right-click menu'],
          ['Clipboard monitoring', <>Optional: copy a link anywhere and Nexa offers to queue it</>],
          ['Recurring schedules', <>Not yet — each job is a single start time. <span className="text-amber-300">Planned.</span></>],
          ['Bandwidth by time of day', <>Not automatic yet; set the cap by hand or schedule the downloads instead. <span className="text-amber-300">Planned.</span></>],
        ]}
      />

      <H2 id="use">Using it</H2>
      <P><strong className="text-white">Schedule a download</strong></P>
      <Steps
        items={[
          <>Click <strong className="text-white">+</strong> and paste the URL as usual.</>,
          <>Tick <strong className="text-white">Start later, at</strong> and pick a date and time.</>,
          <>Confirm. The download does not appear in the main list yet — it is in <strong className="text-white">Downloads &rarr; Scheduled&hellip;</strong>, where you can see or cancel it.</>,
          <>Leave Nexa running (the tray icon is enough). At the appointed time the job joins the queue and starts.</>,
        ]}
      />
      <P className="mt-4"><strong className="text-white">Cap the speed</strong></P>
      <Steps
        items={[
          <>For all direct downloads: <strong className="text-white">Settings &rarr; Downloads &rarr; Global speed limit</strong>, in KB/s. Zero means unlimited.</>,
          <>For one download: right-click its row &rarr; <strong className="text-white">Limit speed&hellip;</strong></>,
          <>Both take effect immediately on running transfers — no pause and resume needed.</>,
        ]}
      />
      <P className="mt-4"><strong className="text-white">Do something when it finishes</strong></P>
      <Steps
        items={[
          <><strong className="text-white">Settings &rarr; General &rarr; When all downloads finish</strong>, and pick the action.</>,
          <>For one session only, use <strong className="text-white">Downloads &rarr; Shut down computer when done (this session)</strong> — it clears itself afterwards so it cannot surprise you tomorrow.</>,
        ]}
      />

      <H2 id="examples">Worked examples</H2>
      <SpecTable
        caption="Common scheduling and speed-limit setups"
        head={['You want', 'Set this']}
        rows={[
          [
            'A huge file overnight, machine off afterwards',
            'Schedule for 02:00, no speed cap, "When all downloads finish → Shut down the computer".',
          ],
          [
            'Downloads that never disturb a work call',
            'Global cap at roughly 60–70% of your line. Leave it on permanently; you will stop noticing downloads exist.',
          ],
          [
            'One big file throttled, everything else full speed',
            'No global cap; right-click the big row → Limit speed. The per-download bucket handles it alone.',
          ],
          [
            'A metered or capped connection',
            'Low global cap plus concurrency of 1, so the total is predictable rather than bursty.',
          ],
          [
            'Seeding overnight only',
            'Torrent upload limit low during the day, raised at night by hand; seed ratio set so it stops on its own.',
          ],
        ]}
      />

      <H2 id="tips">Tips</H2>
      <Tips
        items={[
          'Schedule public URLs only. Anything needing a login should be started from the extension when you are signed in.',
          'The app has to be running at the scheduled time — minimised to the tray is fine, quit is not.',
          'A global cap slightly below your real line speed keeps interactive traffic snappy; at 100% of the line, everything else stutters.',
          'Check the scheduled list before closing the app for the night, so a 2am job is not waiting on a program that is not there.',
          'Sleep and shutdown both give you 60 seconds to cancel — but if you are away from the keyboard, they will happen.',
          <>Clipboard monitoring does not schedule anything: a copied link you accept starts right away. To start downloads at night, add each one with New download and tick Start later.</>,
          'The speed limits cover direct downloads. Torrents have their own pair, and video-site, stream and MEGA downloads are not capped at all — setting one and wondering why another is unaffected is the usual confusion.',
        ]}
      />

      <H2 id="trouble">When it goes wrong</H2>
      <Troubles
        items={[
          {
            symptom: 'A scheduled download never started',
            fix: (
              <>
                Nexa was not running at that moment. Scheduled jobs re-arm on launch, so it will
                start as soon as you next open the app if the time has passed — but the app cannot
                wake itself. Leave it in the tray. On Windows the installer already starts Nexa in
                the background each time you sign in; on Linux, add it to your desktop&apos;s
                startup applications.
              </>
            ),
          },
          {
            symptom: 'A scheduled download started and immediately failed with 403',
            fix: (
              <>
                It needed a session that was not stored — see the note above. Start that one from the
                extension instead, while signed in.
              </>
            ),
          },
          {
            symptom: 'The speed limit seems to be ignored',
            fix: (
              <>
                Check which limit you set. The global cap covers direct downloads; torrents
                obey the BitTorrent limits, video-site, stream and MEGA downloads are not capped at
                all, and a per-download cap can only slow a row further, never speed it
                past the global one. If a single row is slow for another reason, the cap is not
                what is holding it.
              </>
            ),
          },
          {
            symptom: 'The computer shut down unexpectedly',
            fix: (
              <>
                &ldquo;When all downloads finish&rdquo; is set to shut down, and the last download
                finished. The session-only version under the Downloads menu is safer for one-off use
                because it clears itself. Set the persistent one back to &ldquo;Do nothing&rdquo; in
                Settings.
              </>
            ),
          },
          {
            symptom: 'Sleep does nothing on Linux',
            fix: (
              <>
                The app asks the desktop environment to suspend, and some setups refuse without
                additional permissions. Shutdown works more widely. This is an environment
                limitation rather than a setting inside Nexa.
              </>
            ),
          },
        ]}
      />

      <H2 id="related">Related features</H2>
      <Related to={['/features/acceleration', '/features/bittorrent', '/features/remote-dashboard']} />
    </FeatureShell>
  );
}
