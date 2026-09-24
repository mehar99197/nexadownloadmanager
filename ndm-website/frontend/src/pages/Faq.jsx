import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';

const A = ({ to, children }) => <Link to={to} className="text-brand-300 hover:underline">{children}</Link>;
const M = ({ children }) => <code className="font-mono text-xs text-brand-100">{children}</code>;

/* ------------------------------------------------------------------ *
 *  Every answer opens with the answer. A reader scanning for "yes" or "no"
 *  should find it in the first line and stop; the detail is for whoever needs
 *  it. `keywords` is what the search box matches beyond the question text —
 *  the words people actually type, including the error messages.
 * ------------------------------------------------------------------ */
const SECTIONS = [
  {
    id: 'start',
    label: 'Getting started',
    items: [
      {
        q: 'Is Nexa completely free?',
        keywords: 'price cost free plan pay',
        a: <>Yes, and it stays free. The Free plan never expires and includes the browser extension, the video grabber, YouTube via yt-dlp, BitTorrent and cloud links. It runs three plain file downloads at a time — the rest queue rather than fail — with up to 16 connections per file, offers two themes and shows a single promo strip inside the app. Pro allows up to 32 downloads at once and 32 connections per file, removes the promo, unlocks all 64 themes, and adds course-site downloads, AI rename and Smart add, at $5/month or $45/year. Every account also gets a 7-day Pro trial with no card required. See <A to="/pricing">pricing</A>.</>,
      },
      {
        q: 'Which operating systems are supported?',
        keywords: 'windows linux mac macos ubuntu debian platform',
        a: <>Windows 10 or newer, and Ubuntu 24.04 or newer (x86-64) via a <M>.deb</M> package. macOS is not shipped: the codebase is Qt and builds there, and our CI produces an app bundle, but it is unsigned so Gatekeeper refuses it. We would rather say that than sell you a broken download. Register interest on the <A to="/contact?topic=macos">contact page</A> and we will tell you when it lands.</>,
      },
      {
        q: 'How do I install Nexa?',
        keywords: 'install setup exe deb installer',
        a: <>Download the installer for your platform from the <A to="/download">download page</A> and run it. On Windows that is a single <M>.exe</M>; on Ubuntu, <M>sudo apt install ./nexa_*.deb</M>. yt-dlp and ffmpeg are bundled, so there is nothing else to install. Launch the app once afterwards — that is what registers the browser bridge. Full walkthrough in the <A to="/docs/install">install guide</A>.</>,
      },
      {
        q: 'What is the difference between Free and Pro?',
        keywords: 'pro upgrade plan difference features',
        a: <>Free runs three plain file downloads at a time (videos, streams, MEGA links and torrents do not count toward it), uses up to 16 connections per file, shows one in-app promo strip and includes two themes. Pro lets you run up to 32 downloads at once (you set the number in Settings → Downloads) with up to 32 connections per file, removes the promo, unlocks all 64 themes, allows downloads from the login-gated course sites (Udemy, Coursera, Skillshare, Pluralsight and LinkedIn Learning), and adds AI rename and Smart add. Everything else — the extension, the video grabber, YouTube, torrents, the scheduler, the remote dashboard — is in both. Team is Pro for five machines at a time on one account.</>,
      },
      {
        q: 'Do I need to create an account?',
        keywords: 'account signup register login required',
        a: <>No. The Free plan works with no account at all — install it and download. An account is only needed to start a Pro trial, to buy a plan, or to have your plan follow you to another computer. If you do sign in, the app picks the plan up by itself; there is no license key to copy.</>,
      },
      {
        q: 'How do I update Nexa?',
        keywords: 'update upgrade version new release',
        a: <>Install the newer build over the old one. The Windows installer and the <M>.deb</M> both upgrade in place and keep your queue, history and settings. The app also checks for updates daily (you can turn that off) and tells you when one exists; Help → Check for updates… checks on the spot. yt-dlp ships inside Nexa and has no updater of its own: a newer copy arrives only when you install a Nexa update, which is the fix for most &ldquo;this site stopped working&rdquo; problems. See the <A to="/changelog">changelog</A>.</>,
      },
      {
        q: 'Can I use Nexa without the browser extension?',
        keywords: 'without extension standalone paste url',
        a: <>Yes, with trade-offs. Paste any URL, magnet link or <M>.m3u8</M> into the app and it downloads normally. What you lose is the session: a URL copied out of a browser carries no cookies, so a download behind a login usually fails with a 403. The exception is the login sites Nexa knows, such as Vimeo, Google Drive and the course sites, where it reads the login from your browser itself — from Firefox or a Chromium browser on Linux, but only from Firefox on Windows. You also lose the extension&apos;s quality menu, so a pasted video URL downloads the best quality, and its stream detection on sites Nexa does not hand to yt-dlp. For public files the app alone is entirely sufficient.</>,
      },
      {
        q: 'What languages is Nexa available in?',
        keywords: 'language translation localisation urdu arabic hindi spanish',
        a: <>The app ships translations for Arabic, German, Spanish, French, Hindi, Indonesian, Brazilian Portuguese, Russian, Turkish, Urdu and Simplified Chinese, alongside English. Pick one in Settings → General; it applies at the next launch. Coverage varies by language — some are more complete than others, and untranslated strings fall back to English rather than showing blanks. The website itself is currently English only.</>,
      },
      {
        q: 'Where are downloads saved by default?',
        keywords: 'folder location save path downloads directory',
        a: <>Your system Downloads folder — <M>%USERPROFILE%\Downloads</M> on Windows, <M>~/Downloads</M> on Linux — with files sorted into category subfolders (Video, Audio, Documents, Compressed, Programs, Images, Other). Change the base folder in Settings → General → Download folder, change where each category points with the Categories… button in the same section (it works only while sorting into subfolders is on), or set a location per download when you add one. The toolbar&apos;s &ldquo;Open folder&rdquo; button jumps straight there.</>,
      },
      {
        q: 'Can I import downloads from IDM or JDownloader?',
        keywords: 'import idm jdownloader ef2 crawljob migrate',
        a: <>Partly. Nexa reads IDM <M>.ef2</M> export files, JDownloader <M>.crawljob</M> files and plain lists of links — File → Import. What transfers is the URLs and their names; in-progress transfers do not carry over, because the partial files and segment state are in the other program&apos;s own format. In practice: export your queue, import it here, and let the finished ones re-download.</>,
      },
    ],
  },
  {
    id: 'extension',
    label: 'Browser extension',
    items: [
      {
        q: 'Which browsers are supported?',
        keywords: 'chrome firefox edge brave opera vivaldi safari browser',
        a: <>Chrome, Microsoft Edge, Brave and Firefox are supported and tested. Other Chromium browsers — Vivaldi, Opera, Arc — generally work with the Chrome build, but we do not test them every release. Safari is not supported: it uses a different extension format that would need a separate build and an Apple developer account. See the <A to="/features/browser-extension">extension page</A>.</>,
      },
      {
        q: 'How do I install the extension?',
        keywords: 'install extension unpacked zip store',
        a: <>For now, from the packaged zip on the <A to="/download">download page</A> — the Chrome Web Store and Firefox Add-ons listings are still in review. Unzip it somewhere permanent, open <M>chrome://extensions</M>, turn on Developer mode, and use &ldquo;Load unpacked&rdquo;. Firefox uses <M>about:debugging</M> → Load Temporary Add-on. Then launch Nexa once and reload your tabs. Step-by-step in the <A to="/docs/extension">extension guide</A>.</>,
      },
      {
        q: 'Why does the extension need so many permissions?',
        keywords: 'permissions privacy read change data all sites scary',
        a: <>Because it has to watch the page you are on to find the video, and read that site&apos;s cookies so the download is authorised as you. It cannot be scoped to a list of sites, since you can download from anywhere. None of it leaves your computer: cookies travel over a local pipe to the Nexa app, not to us. Every permission is listed with its reason on the <A to="/security">security page</A>.</>,
      },
      {
        q: 'It says “Nexa: engine unavailable”. What do I do?',
        keywords: 'engine unavailable error bridge native messaging not running',
        a: <>The extension reached the bridge and nothing answered: the app is not running, or has never been launched since you installed the extension. Start Nexa, wait for the window, and reload the page. If it persists, launch the app once more — every launch rewrites the native-host manifest, which repairs a registration broken by a browser update or a profile reset.</>,
      },
      {
        q: 'Why is the extension not detecting videos?',
        keywords: 'no button video not detected grabber missing',
        a: <>Three usual causes. Playback has not started, so the player has not fetched its manifest — press play. The player is inside a cross-origin iframe the content script cannot reach. Or the video is a plain MP4 with no manifest, in which case there is nothing to detect: right-click it and choose &ldquo;Download with Nexa&rdquo;. Check the extension is also enabled for that site in the toolbar popup.</>,
      },
      {
        q: 'Can I use the extension without the app installed?',
        keywords: 'extension only standalone without app',
        a: <>No. The extension downloads nothing itself — it is a bridge that hands URLs, headers and cookies to the desktop app over native messaging. Without the app there is nothing on the other end, and you will see &ldquo;engine unavailable&rdquo; on every click.</>,
      },
      {
        q: 'How do I stop it taking over downloads on a particular site?',
        keywords: 'disable site exclude takeover per-site',
        a: <>Open the Nexa toolbar popup while you are on that site and turn off the per-site toggle. The browser then handles downloads there as normal, and the right-click &ldquo;Download with Nexa&rdquo; entry still works when you want it. You can also turn takeover off globally and use the right-click menu only.</>,
      },
      {
        q: 'The extension keeps getting disabled. Why?',
        keywords: 'disabled removed keeps turning off firefox temporary',
        a: <>In Firefox this is expected until the Add-ons listing is live: <M>about:debugging</M> installs a temporary add-on that is removed at every restart. In Chromium browsers, an unpacked extension survives restarts but the browser may nag about developer-mode extensions and can disable one whose folder has been moved or deleted — keep the unzipped folder where it is.</>,
      },
      {
        q: 'How do I update the extension?',
        keywords: 'update extension new version',
        a: <>Download the new zip, unzip it over the old folder, then press the reload icon on the extension&apos;s card in <M>chrome://extensions</M>. Once the store listings are live this becomes automatic.</>,
      },
      {
        q: 'Does it work in incognito or private windows?',
        keywords: 'incognito private browsing window',
        a: <>Yes, if you allow it. Chromium browsers need &ldquo;Allow in Incognito&rdquo; ticked on the extension&apos;s details page; Firefox has the same setting under &ldquo;Run in Private Windows&rdquo;. The app still has to be running. Note that a private window has its own cookie jar, so a site you are signed into normally may look signed out there.</>,
      },
    ],
  },
  {
    id: 'video',
    label: 'YouTube & video',
    items: [
      {
        q: 'Can I download YouTube videos?',
        keywords: 'youtube download video mp4',
        a: <>Yes. Paste the URL into the app or use the extension button on the page. The button shows the title and the qualities yt-dlp finds for that video, and Nexa downloads the one you choose; a pasted URL downloads the best quality available. Either way the separate video and audio streams are merged into one file automatically. Playlists and channels work the same way. Details on the <A to="/features/youtube-sites">YouTube &amp; video sites page</A>.</>,
      },
      {
        q: 'Why do I get a 403 error on YouTube?',
        keywords: '403 forbidden error authentication required youtube failed',
        a: <>Two different problems share that code, and Nexa words them differently. &ldquo;Authentication required (HTTP 403)&rdquo; means the video wants a signed-in session, and Nexa never sends your YouTube login — not from the extension, not from your browser — so a video that needs one cannot be downloaded. &ldquo;Media server refused the download — the stream URL expired or yt-dlp is out of date&rdquo; is not a login problem: update Nexa, which carries its own copy of yt-dlp (Help → Check for updates…), and retry. Full guide: <A to="/docs/youtube">downloading from YouTube</A>.</>,
      },
      {
        q: 'How do I download a whole playlist?',
        keywords: 'playlist channel bulk all videos',
        a: <>Paste the playlist URL and tick &ldquo;Download whole course / playlist&rdquo; before confirming. The playlist becomes one row that counts its videos as they finish, and they are saved into a subfolder named after the playlist. Settings → Downloads → Playlist videos in parallel sets how many download at once — three by default, up to eight, on any plan. Private, deleted and members-only entries are skipped rather than failing the whole playlist, and the row ends by saying how many videos were saved.</>,
      },
      {
        q: 'Can I choose the video quality?',
        keywords: 'quality resolution 1080p 4k 2160p choose',
        a: <>Yes, from the extension button on the video: its menu lists the resolutions that video actually offers, up to 4K or 8K where it has them, plus &ldquo;Best available&rdquo; and audio-only. Nexa asks yt-dlp for the best stream at or below your choice. There is no default-quality setting, and a video URL pasted into the app always downloads the best available. If only low qualities appear, see the 360p question below.</>,
      },
      {
        q: 'Does Nexa download subtitles?',
        keywords: 'subtitles captions srt vtt language',
        a: <>Yes. Turn it on in Settings → Video sites and list the languages you want. Subtitles can be embedded into the file or saved alongside it. Auto-generated captions are included where the site offers them, and are marked as such. Sites that publish no subtitle track obviously cannot provide one.</>,
      },
      {
        q: 'Can I download age-restricted videos?',
        keywords: 'age restricted 18 sign in gated',
        a: <>Not from YouTube when it asks you to sign in: Nexa never sends your YouTube login. Age-gated content is a login problem rather than a technical one, so on a site where Nexa does use your login, such as Vimeo, start the download from the extension button on a page where you are signed in and it behaves like any other video.</>,
      },
      {
        q: 'What about YouTube Premium or purchased videos?',
        keywords: 'premium paid purchased rental drm netflix',
        a: <>Premium-only formats are out of reach: Nexa never sends your YouTube login, so yt-dlp sees what a signed-out viewer sees. Purchased or rented films are usually DRM-protected, and Nexa does not break DRM — the app will tell you rather than producing an unplayable file. The same applies to Netflix, Prime Video, Disney+ and anything else using Widevine, PlayReady or FairPlay.</>,
      },
      {
        q: 'Why is only 360p available for some videos?',
        keywords: '360p low quality only one format',
        a: <>You are seeing the format list yt-dlp was given. A common cause is an out-of-date yt-dlp that can no longer decipher the higher formats — update Nexa, which carries its own copy (Help → Check for updates…), and try again before anything else. On a site where Nexa uses your login, such as Vimeo, a signed-out session is often handed a reduced list too, so sign in and retry through the extension. Signing in changes nothing on YouTube, because Nexa never sends your YouTube login.</>,
      },
      {
        q: 'Can I download private or unlisted videos?',
        keywords: 'private unlisted hidden link only',
        a: <>Unlisted videos work like public ones — the link is all that is needed. Private YouTube videos do not, because Nexa never sends your YouTube login. On a site where Nexa uses your login, such as Vimeo, a private video works if the account you are signed in to has access and you start the download from the extension so that session travels with it. Nothing here grants access you do not already have.</>,
      },
      {
        q: 'Which other video sites are supported?',
        keywords: 'sites supported vimeo twitch tiktok instagram soundcloud list',
        a: <>A fixed list, not every site yt-dlp supports. Besides YouTube, the sites Nexa hands to yt-dlp include Vimeo, Twitch, X, Instagram, Facebook, Threads, TikTok, Reddit, Dailymotion and Bilibili, plus the course sites Udemy, Skillshare, Pluralsight and LinkedIn Learning on Pro. Anywhere else, play the video with the extension installed: when the page plays a direct, HLS or DASH stream, the extension finds it and Nexa downloads it; when it does not, Nexa cannot. More on the <A to="/features/youtube-sites">feature page</A>.</>,
      },
    ],
  },
  {
    id: 'torrents',
    label: 'Torrents',
    items: [
      {
        q: 'How do I download a torrent?',
        keywords: 'torrent file download start magnet',
        a: <>Drag a <M>.torrent</M> file onto the window. For a magnet link, right-click it in your browser and choose &ldquo;Download with Nexa&rdquo;, paste it into File → New download (<M>Ctrl+N</M>), or drag it onto the window; with clipboard monitoring on (Tools → Monitor clipboard for links, off by default), Nexa also offers to grab one you copy. It lands in the same list as everything else, under your download folder, with its own speed limits in Settings → BitTorrent. There is no separate torrent window or second application. More on the <A to="/features/bittorrent">BitTorrent page</A>.</>,
      },
      {
        q: 'Does Nexa support magnet links?',
        keywords: 'magnet link dht metadata',
        a: <>Yes, including DHT and peer exchange, so a magnet with no working tracker still finds peers. A magnet briefly shows &ldquo;fetching metadata&rdquo; before any progress appears — that is the client finding peers who can describe the torrent, and it is a normal part of the protocol rather than a stall. Clicking a magnet link does not open Nexa, because Nexa does not register itself as your system&apos;s magnet handler: right-click the link and choose &ldquo;Download with Nexa&rdquo;, or paste it into File → New download.</>,
      },
      {
        q: 'What is seeding, and can I control it?',
        keywords: 'seeding ratio upload stop sharing',
        a: <>Seeding is uploading the file to other people after you have finished downloading it — it is how BitTorrent works at all. Out of the box Nexa does not seed: Settings → BitTorrent → Seed to ratio starts at <M>0</M>, shown as &ldquo;Don&apos;t seed&rdquo;, so a torrent stops the moment it completes. Set a ratio and Nexa keeps uploading until it reaches it, then stops on its own — <M>1.0</M> means you have given back as much as you took. You can also stop any row by hand.</>,
      },
      {
        q: 'Why is my torrent download slow?',
        keywords: 'torrent slow speed peers seeds',
        a: <>Torrent speed belongs to the swarm, not to your connection: few seeds means slow no matter how fast your line is. Check the peer count on the row first. If it is healthy and you are still slow, raise your upload limit — BitTorrent prioritises peers who give back, so throttling your upload to nothing makes your own download slower. Some networks also block BitTorrent entirely.</>,
      },
      {
        q: 'Can I create torrent files?',
        keywords: 'create torrent make tracker seed new',
        a: <>No. Nexa downloads torrents; it is not a torrent creation tool or a tracker, and there are no plans to make it one. Use a dedicated client such as qBittorrent for that. Selective file download within a torrent is also not supported yet — a torrent currently downloads in full.</>,
      },
    ],
  },
  {
    id: 'billing',
    label: 'Account & billing',
    items: [
      {
        q: 'How do I cancel my subscription?',
        keywords: 'cancel subscription stop billing unsubscribe',
        a: <>Open <A to="/billing">Billing</A> and click &ldquo;Cancel subscription&rdquo;. Your plan stays active until the end of the period you already paid for and then simply does not renew — no cancellation fee, no email to anyone, no retention flow. If you are on a trial, use &ldquo;End trial now&rdquo; instead; it stops the trial immediately and returns you to Free without ever charging you.</>,
      },
      {
        q: 'What payment methods do you accept?',
        keywords: 'payment card paypal stripe methods visa mastercard',
        a: <>Payments run through Stripe, which accepts major credit and debit cards and the local wallets it supports in your country. Card details are entered on Stripe&apos;s own page and never touch our servers. Note that paid plans are not open yet — the site cannot take money today, and the pricing page says so.</>,
      },
      {
        q: 'Is there a refund policy?',
        keywords: 'refund money back guarantee 14 days',
        a: <>Yes: within 14 days of any charge, email <a href="mailto:support@nexadownloadmanager.com" className="text-brand-300 hover:underline">support@nexadownloadmanager.com</a> and we refund it in full, no questions asked. After 14 days charges are not refundable, but we will still cancel immediately on request so you are not billed again. The details are in the <A to="/terms">terms</A>.</>,
      },
      {
        q: 'How do I activate a license key?',
        keywords: 'activate license licence key serial activation code',
        a: <>Easiest is not to: sign in to your account in Settings → Account and the plan follows you, with no key to copy. If you prefer a key, open Settings → Account → &ldquo;Use a license key instead&rdquo;, paste it and activate. The two are mutually exclusive on purpose — signing in clears a stored key, and activating a key signs you out. See <A to="/docs/license">signing in &amp; seats</A>.</>,
      },
      {
        q: 'Can I move my license to another computer?',
        keywords: 'transfer move license licence another computer new pc seat',
        a: <>Yes, and you do not need to ask us. A plan covers a number of machines <em>at a time</em>, not a fixed list: Pro is one, Team is five. Sign out on the old machine, or open your <A to="/dashboard">dashboard</A> and sign that device out remotely — the seat frees itself immediately and the new computer can take it. A machine that crashes frees its seat automatically when the lease lapses.</>,
      },
      {
        q: 'What happens if my payment fails?',
        keywords: 'payment failed declined card expired',
        a: <>Nothing sudden. Stripe retries a failed payment over several days and emails you. Your plan keeps working throughout, and for a few days after, so a card that expired over a weekend does not interrupt anything. If it ultimately fails, the plan drops back to Free — the app keeps working, with the Free limits. Your license key is never deleted, so paying again restores everything.</>,
      },
      {
        q: 'How do I update my payment method?',
        keywords: 'update card change payment method billing details',
        a: <>Open <A to="/billing">Billing</A> and use &ldquo;Manage billing&rdquo;, which opens Stripe&apos;s own portal. You can change the card, update your address and download past invoices there. We never see or store card numbers, which is also why we cannot change one for you.</>,
      },
      {
        q: 'Can I get an invoice for my company?',
        keywords: 'invoice receipt vat tax company business',
        a: <>Yes. Every payment produces an invoice in the Stripe billing portal, reachable from <A to="/billing">Billing</A>, and you can add a company name, address and VAT number there so they appear on it. If you need something the portal cannot produce, email support and we will sort it out.</>,
      },
    ],
  },
  {
    id: 'trouble',
    label: 'Troubleshooting',
    items: [
      {
        q: 'A download is stuck at 99%. What do I do?',
        keywords: 'stuck 99 percent frozen not finishing hang',
        a: <>Pause the row and resume it. This is almost always one connection whose socket died without an error — the server stopped sending but never closed, so the app is waiting on bytes that will not arrive. Resuming re-opens only the outstanding ranges, so nothing already downloaded is lost.</>,
      },
      {
        q: 'Download speed is slower than I expected',
        keywords: 'slow speed bandwidth throttle performance',
        a: <>Check three things in order. Is a speed limit set — globally in Settings → Downloads, or on that row via right-click? Does the details window show <M>Resume capability: No</M> for a plain file download, meaning the server refused to be split? And is the server itself simply slow, which no download manager can fix? More connections is not automatically faster: past about eight, most servers are the bottleneck.</>,
      },
      {
        q: 'A file downloaded but will not open',
        keywords: 'corrupt file broken wont open damaged invalid',
        a: <>Usually the server sent an error page instead of the file — a login wall or a rate-limit notice saved under the right filename. Check the size: a few kilobytes where you expected megabytes confirms it. Re-download it from the extension while signed in. If the size is right but the file is bad, paste the publisher&apos;s SHA-256 into the new-download dialog and let Nexa verify it next time.</>,
      },
      {
        q: 'Nexa will not start',
        keywords: 'wont start crash launch nothing happens startup',
        a: <>Check whether it is already running in the system tray — Nexa is single-instance, so a second launch quietly hands over to the first. If not, start it from a terminal (<M>nexa</M>) so you can see any error it prints. On Windows, an antivirus quarantining part of the installation is the usual cause. Reinstalling over the top preserves your queue and settings.</>,
      },
      {
        q: 'My downloads disappeared after restarting',
        keywords: 'downloads gone missing history lost after restart',
        a: <>Only plain file downloads come back after a restart — video, stream and torrent rows are not restored. Nothing is cleared on its own either: a finished row leaves the list only when you remove it, choose Downloads → Clear completed, or press &ldquo;Clear completed downloads&rdquo; at the bottom of the window. The files themselves are untouched on disk either way. If plain file downloads are missing too, the app is running as a different user or in portable mode from a different folder, and so is reading a different database.</>,
      },
      {
        q: '“Connection refused”',
        keywords: 'connection refused error network cannot connect',
        a: <>Something declined the connection outright rather than timing out. For a download, the host is down or blocking you. For the remote dashboard, the server is not listening — the dashboard is off, the app is not running, or a firewall is blocking the port. For the browser extension, this appears as &ldquo;engine unavailable&rdquo; instead.</>,
      },
      {
        q: '“Disk full” but I have plenty of space',
        keywords: 'disk full space error no space left',
        a: <>On a FAT32 or exFAT drive, Nexa sets aside the full file size before it starts writing, so a 40&nbsp;GB download needs 40&nbsp;GB free at the beginning rather than at the end. On NTFS, ext4, APFS and XFS it does not: the file fills in as data arrives, and a disk that runs out partway stops the download with a write error. The other causes are a destination on a different drive from the one you checked, a filesystem with a per-file size limit (FAT32 stops at 4&nbsp;GB), or a disk quota on a shared machine.</>,
      },
      {
        q: 'A scheduled download did not start',
        keywords: 'scheduled schedule did not start timer missed',
        a: <>Nexa was not running at that moment — the app cannot wake itself, and minimised to the tray is what &ldquo;running&rdquo; means. Scheduled jobs re-arm when you next launch it, so an overdue one starts then. If it started and failed with 403, it needed a login: headers and cookies are deliberately not stored with a scheduled job, so schedule public URLs only.</>,
      },
      {
        q: 'The remote dashboard shows “connection refused”',
        keywords: 'dashboard remote phone refused cannot connect lan',
        a: <>Usually it is still bound to loopback, which means &ldquo;this machine only&rdquo;. LAN access has to be turned on <em>and</em> TLS configured — the app refuses to serve your access token over plain HTTP across Wi-Fi, and logs why. Check the log for that line. Otherwise: wrong port, app not running, or a desktop firewall. See <A to="/docs/remote">the guide</A>.</>,
      },
      {
        q: 'AI rename is not working',
        keywords: 'ai rename not working smart filename',
        a: <>Check three things: it is off by default, so it has to be enabled in Settings; it is a Pro entitlement, so a Free account will not run it; and it needs a working internet connection at the moment the download finishes. It also declines to rename when it cannot do better than the existing name, which looks like nothing happening but is intentional.</>,
      },
      {
        q: 'How do I completely reset Nexa?',
        keywords: 'reset factory defaults clean wipe settings start over',
        a: <>Quit the app, then delete two things: its data folder, <M>%APPDATA%\Nexa</M> on Windows or <M>~/.local/share/Nexa</M> on Linux, which holds the queue, history and categories; and its settings, the registry key <M>HKEY_CURRENT_USER\Software\Nexa\Nexa</M> on Windows or the <M>~/.config/Nexa</M> folder on Linux. Your downloaded files are elsewhere and are not touched. Your license key and account sign-in sit in the OS credential store instead, so sign out or remove the key in Settings → Account first if you also want those cleared. The app rebuilds everything from defaults on the next launch.</>,
      },
      {
        q: 'Where are Nexa’s settings and database stored?',
        keywords: 'settings location config database file appdata where stored',
        a: <>On Windows, the database is <M>%APPDATA%\Nexa\Nexa\nexa.db</M> and preferences are in the registry under <M>HKEY_CURRENT_USER\Software\Nexa\Nexa</M>; on Linux, they are <M>~/.local/share/Nexa/Nexa/nexa.db</M> and <M>~/.config/Nexa/Nexa.conf</M>. The database is a SQLite file holding the queue, history and categories. Your license key and account sign-in are kept in the OS credential store: Windows Credential Manager, or the Secret Service on Linux. In portable mode — a <M>portable.txt</M> beside the executable — the database and preferences move into a <M>NexaData</M> folder next to the app instead, which is what makes it runnable from a USB stick.</>,
      },
    ],
  },
];

const ALL = SECTIONS.flatMap((s) => s.items.map((i) => ({ ...i, section: s.label, sectionId: s.id })));

/**
 * "Was this helpful?" under each answer.
 *
 * The vote goes to POST /api/faq/vote, which keeps two counters per question
 * and nothing about who voted. localStorage is still used, but only to remember
 * that THIS browser already answered, so the reader is not asked the same
 * question every time they open the page - it is not where the vote lives.
 *
 * When the request fails the page says so rather than showing a thank-you it
 * has not earned. A reader who is told their feedback landed when it did not is
 * worse off than one who is told to try again.
 */
function Helpful({ id }) {
  const key = `faq-vote:${id}`;
  const [vote, setVote] = useState(() => {
    try { return localStorage.getItem(key); } catch { return null; }
  });
  const [failed, setFailed] = useState(false);
  const [sending, setSending] = useState(false);

  const cast = async (value) => {
    if (sending) return;
    setSending(true);
    setFailed(false);
    try {
      await api.post('/faq/vote', { question: id, helpful: value === 'yes' });
      setVote(value);
      // Only after it actually reached us: a browser that recorded the vote
      // locally on a failed request would never offer to send it again.
      try { localStorage.setItem(key, value); } catch { /* private mode: it just will not persist */ }
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };

  if (vote) {
    return (
      <p className="mt-4 text-xs text-slate-500">
        Thanks — that is recorded.{' '}
        {vote === 'no' && (
          <>
            <Link to="/contact" className="text-brand-300 hover:underline">Tell us what was missing</Link>{' '}
            and we will rewrite it.
          </>
        )}
      </p>
    );
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <span className="text-xs text-slate-500">Was this helpful?</span>
      {/* min-h-11 and a wider tap box: at 41x43 these were a pixel under the
          44px minimum and only as wide as the word. They appear under all 55
          answers, so it is the most-repeated target on the site. */}
      <button type="button" disabled={sending} onClick={() => cast('yes')} className="btn btn-ghost !px-4 !py-2 min-h-11 min-w-16 text-xs">Yes</button>
      <button type="button" disabled={sending} onClick={() => cast('no')} className="btn btn-ghost !px-4 !py-2 min-h-11 min-w-16 text-xs">No</button>
      {failed && (
        <span className="text-xs text-amber-300">That did not reach us — please try again.</span>
      )}
    </div>
  );
}

function Item({ item, open }) {
  return (
    // cv-row: the page lays out fifty-five of these on every load. The class
    // lets the browser skip layout and paint for the ones nowhere near the
    // screen and stand a remembered height in for them, so the scrollbar is
    // honest. Find-in-page, an anchor link and focus each un-skip a row on
    // their own — nothing here becomes unreachable.
    <Card as="details" className="cv-row group !p-0" open={open}>
      {/* Denser on a phone, unchanged from `sm` up. Fifty-five rows at
          px-6 py-5 is where /faq's 8.6 screens came from; 4px off each side of
          each row is half a screen back. py-4 still leaves the summary ~56px
          tall, so the tap target stays over the 44px minimum. */}
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4 text-left text-[0.95rem] font-bold text-white marker:hidden sm:gap-4 sm:px-6 sm:py-5 sm:text-base [&::-webkit-details-marker]:hidden">
        <span>{item.q}</span>
        <svg
          width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          className="shrink-0 text-brand-300 transition-transform group-open:rotate-180"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </summary>
      <div className="border-t border-white/5 px-4 py-4 text-sm leading-7 text-slate-400 sm:px-6 sm:py-5">
        {item.a}
        <Helpful id={item.q} />
      </div>
    </Card>
  );
}

export default function Faq() {
  usePageMeta({
    title: 'FAQ',
    description:
      'Fifty-five answers about Nexa Download Manager: pricing and the free plan, installing, the browser extension, YouTube and 403 errors, torrents, billing and refunds, and the things that actually go wrong.',
  });

  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const results = useMemo(() => {
    if (!q) return null;
    return ALL.filter((item) =>
      item.q.toLowerCase().includes(q)
      || item.section.toLowerCase().includes(q)
      || (item.keywords || '').includes(q));
  }, [q]);

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />Questions</span>
        <h1 className="mt-5 text-white">Straight <span className="text-gradient">answers.</span></h1>
        <p>
          {ALL.length} of them, grouped by what you are trying to do. Every answer starts with the
          answer.
        </p>
      </div>

      <div className="mx-auto mt-10 max-w-3xl">
        <label htmlFor="faq-search" className="sr-only">Search the FAQ</label>
        <input
          id="faq-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search — try “403”, “refund”, “magnet”, “reset”…"
          className="w-full rounded-[var(--radius-2)] border border-[var(--color-surface-border)] bg-[var(--color-surface-2)] px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:border-brand-400/50 focus:outline-none"
        />
        {results && (
          <p className="mt-3 text-xs text-slate-500" role="status">
            {results.length === 0
              ? 'Nothing matched. Try a different word, or ask us directly.'
              : `${results.length} of ${ALL.length} answers match.`}
          </p>
        )}
        {/* Fifty-five rows in six groups, and the only way to the last group
            was to scroll past the first five. Plain fragment links: the
            sections already carry these ids and scroll-mt for the header. */}
        {!results && (
          <nav aria-label="FAQ sections" className="mt-4 flex flex-wrap gap-2">
            {SECTIONS.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-white/5 bg-surface-2 px-3 text-xs font-medium text-slate-300 transition hover:text-white"
              >
                {section.label}
                <span className="text-slate-500">
                  {section.items.length}
                  <span className="sr-only"> questions</span>
                </span>
              </a>
            ))}
          </nav>
        )}
      </div>

      {results ? (
        <div className="mx-auto mt-8 max-w-3xl space-y-3">
          {results.map((item, i) => (
            <div key={item.q}>
              <p className="mb-1.5 text-xs font-bold uppercase tracking-[0.14em] text-brand-300">{item.section}</p>
              <Item item={item} open={i === 0} />
            </div>
          ))}
        </div>
      ) : (
        <div className="mx-auto mt-10 max-w-3xl space-y-12">
          {SECTIONS.map((section) => (
            <div key={section.id} id={section.id} className="scroll-mt-24">
              <h2 className="text-lg font-bold text-white">
                {section.label}
                <span className="ml-2 text-xs font-semibold text-slate-500">{section.items.length}</span>
              </h2>
              <div className="mt-4 space-y-3">
                {section.items.map((item) => (
                  <Item key={item.q} item={item} open={false} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="surface-panel mx-auto mt-12 flex max-w-3xl flex-wrap items-center justify-center gap-x-6 gap-y-4 rounded-xl px-6 py-5 text-center sm:text-left">
        <p className="text-sm text-slate-300">Still stuck? The docs go deeper, and we answer email.</p>
        <div className="flex gap-3">
          <Button to="/docs" variant="ghost">Docs</Button>
          <Button to="/contact">Contact</Button>
        </div>
      </div>
    </Section>
  );
}
