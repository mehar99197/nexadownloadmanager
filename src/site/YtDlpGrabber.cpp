#include "site/YtDlpGrabber.h"
#include "auth/AuthUtils.h"

#include <QProcess>
#include <QFile>
#include <QFileInfo>
#include <QDir>
#include <QSet>
#include <QStandardPaths>
#include <QRegularExpression>
#include <QDebug>

namespace nexa {

static const bool kDebug = qEnvironmentVariableIsSet("NEXA_DEBUG");

namespace {

// Scale a numeric value by a yt-dlp size unit (KiB/MiB/GiB/TiB).
double applyUnit(double v, const QString &unit)
{
    const QChar u = unit.isEmpty() ? QChar() : unit.at(0).toUpper();
    if (u == 'K') v *= 1024.0;
    else if (u == 'M') v *= 1024.0 * 1024;
    else if (u == 'G') v *= 1024.0 * 1024 * 1024;
    else if (u == 'T') v *= 1024.0 * 1024 * 1024 * 1024;
    return v;
}

// Parse a yt-dlp rate string like "1.50MiB/s" into bytes/second.
double parseRate(const QString &s)
{
    static const QRegularExpression re(QStringLiteral("([\\d.]+)\\s*([KMGT]?)i?B/s"),
                                       QRegularExpression::CaseInsensitiveOption);
    const auto m = re.match(s);
    return m.hasMatch() ? applyUnit(m.captured(1).toDouble(), m.captured(2)) : 0.0;
}

// Parse a size token like "218.53KiB" into bytes.
qint64 parseSize(const QString &s)
{
    static const QRegularExpression re(QStringLiteral("([\\d.]+)\\s*([KMGT]?)i?B"),
                                       QRegularExpression::CaseInsensitiveOption);
    const auto m = re.match(s);
    return m.hasMatch() ? qint64(applyUnit(m.captured(1).toDouble(), m.captured(2))) : -1;
}

// A readable course/playlist folder name pulled from the page URL slug, e.g.
//   udemy.com/course/pythonforbeginnersintro/learn/lecture/123 -> "pythonforbeginnersintro"
//   youtube.com/playlist?list=PL... (no /course/) -> "" (caller falls back).
// Far friendlier than yt-dlp's numeric playlist_id when no real title is known.
QString urlSlug(const QUrl &url)
{
    static const QRegularExpression courseRe(QStringLiteral("/course/([^/]+)"));
    const auto m = courseRe.match(url.path());
    return m.hasMatch() ? m.captured(1) : QString();
}

} // namespace

YtDlpGrabber::YtDlpGrabber(int id, const QUrl &pageUrl, const QString &outputDir,
                           const QString &fixedName, const QString &formatSelector,
                           const HeaderList &headers, const QStringList &authArgs,
                           bool playlist, QObject *parent)
    : QObject(parent), m_id(id), m_url(pageUrl), m_dir(outputDir),
      m_fixedName(fixedName), m_format(formatSelector), m_headers(headers),
      m_authArgs(authArgs), m_playlist(playlist)
{
    if (m_playlist) {
        // A playlist yields many files in a subfolder; show the course/playlist
        // name (caller-supplied title, else the URL slug, else "Playlist").
        QString base = m_fixedName.isEmpty() ? urlSlug(m_url) : m_fixedName;
        if (base.isEmpty())
            base = QStringLiteral("Playlist");
        m_savePath = QDir(m_dir).filePath(base);
    } else {
        const QString placeholder = m_fixedName.isEmpty() ? QStringLiteral("video") : m_fixedName;
        m_savePath = QDir(m_dir).filePath(placeholder + QStringLiteral(".mp4"));
    }
    m_outFile = QStandardPaths::writableLocation(QStandardPaths::TempLocation) +
                QStringLiteral("/nexa-ytout-%1.txt").arg(m_id);
}

YtDlpGrabber::~YtDlpGrabber()
{
    if (m_proc) {
        m_proc->disconnect(this);
        m_proc->kill();
        m_proc->waitForFinished(1000);
    }
    for (QProcess *p : m_plProcs) {
        if (!p) continue;
        p->disconnect(this);
        p->kill();
        p->waitForFinished(500);
    }
}

bool YtDlpGrabber::available()
{
    return !QStandardPaths::findExecutable(QStringLiteral("yt-dlp")).isEmpty();
}

bool YtDlpGrabber::isSiteVideoUrl(const QUrl &url)
{
    const QString host = url.host().toLower();
    if (host.endsWith(QStringLiteral("youtube.com")) ||
        host == QStringLiteral("youtu.be") ||
        host.endsWith(QStringLiteral(".youtu.be")))
        return !url.path().contains(QStringLiteral("/videoplayback"));  // not a raw media URL

    // Public video sites whose real stream the browser can't grab (blob/MSE or
    // signed CDN) but yt-dlp can. Routing the PAGE url through yt-dlp gives the
    // actual video instead of a sniffed static asset. No login needed.
    static const QStringList kVideoSites = {
        QStringLiteral("tiktok.com"),
        QStringLiteral("instagram.com"),
        QStringLiteral("twitter.com"),
        QStringLiteral("x.com"),
        QStringLiteral("facebook.com"),
        QStringLiteral("fb.watch"),
        QStringLiteral("reddit.com"),
        QStringLiteral("dailymotion.com"),
        QStringLiteral("twitch.tv"),
        QStringLiteral("bilibili.com"),
    };
    for (const QString &s : kVideoSites)
        if (host == s || host.endsWith(QLatin1Char('.') + s))
            return true;

    // Other yt-dlp-extracted sites we route through yt-dlp so its extractor (and
    // our domain-scoped cookie/bearer auth) handle login-gated video. yt-dlp
    // supports 1000+ sites; this is the curated set Nexa routes by default —
    // extend as needed. AuthenticationManager applies cookies/Bearer for these.
    static const QStringList kAuthSites = {
        QStringLiteral("udemy.com"),
        QStringLiteral("vimeo.com"),
        QStringLiteral("coursera.org"),
        QStringLiteral("skillshare.com"),
        QStringLiteral("pluralsight.com"),
        QStringLiteral("linkedin.com"),   // LinkedIn Learning
    };
    for (const QString &s : kAuthSites)
        if (host == s || host.endsWith(QLatin1Char('.') + s))
            return true;
    return false;
}

QString YtDlpGrabber::formatForQuality(const QString &quality)
{
    QString q = quality.trimmed().toLower();
    if (q == QStringLiteral("audio"))
        return QStringLiteral("bestaudio/best");
    bool isNum = false;
    const int h = q.remove('p').toInt(&isNum);
    if (isNum && h > 0)
        return QStringLiteral("bestvideo[height<=%1]+bestaudio/best[height<=%1]/best").arg(h);
    return QStringLiteral("bestvideo*+bestaudio/best");   // "best" / unknown
}

QString YtDlpGrabber::fileName() const
{
    return QFileInfo(m_savePath).fileName();
}

void YtDlpGrabber::setSubtitles(bool embed, const QString &langs)
{
    m_embedSubs = embed;
    if (!langs.trimmed().isEmpty())
        m_subLangs = langs.trimmed();
}

void YtDlpGrabber::setPlaylistConcurrency(int n)
{
    m_plConcurrency = qBound(1, n, 8);
}

void YtDlpGrabber::setState(DownloadState s, const QString &detail)
{
    m_state = s;
    emit stateChanged(m_id, s, detail);
}

void YtDlpGrabber::start()
{
    if (m_state == DownloadState::Downloading || m_state == DownloadState::Probing)
        return;
    m_cancelled = false;
    QDir().mkpath(m_dir);

    // Playlist/course: put every video inside a folder named after the course.
    // The caller-supplied name (e.g. the course title from the extension) wins;
    // else yt-dlp's playlist title, then its id. Udemy leaves playlist_title
    // empty ("NA"), so never rely on it alone. Sanitise the literal folder name:
    // strip path separators AND yt-dlp template-special chars (% ( ) { }) so a
    // course title can't break the -o template or escape the download dir.
    // Folder name for a playlist: PREFER yt-dlp's real playlist_title (it knows
    // the actual title from the site), and fall back to the caller-supplied name
    // / URL slug only when yt-dlp has no title (e.g. some auth courses). So even
    // if the extension sent a placeholder like "YouTube Playlist", a YouTube
    // playlist still lands in a folder named its real title. The fallback is
    // stripped of output-template-special chars so it embeds safely as a literal.
    QString plFallback = m_fixedName.trimmed();
    if (plFallback.isEmpty())
        plFallback = urlSlug(m_url);            // e.g. "pythonforbeginnersintro" from the URL
    plFallback.replace(QRegularExpression(QStringLiteral("[/\\\\%(){}|,]+")), QStringLiteral("_"));
    if (plFallback.isEmpty())
        plFallback = QStringLiteral("Playlist");
    const QString plFolder = QStringLiteral("%(playlist_title|") + plFallback + QStringLiteral(")s");

    const QString tmpl = m_playlist
        ? QDir(m_dir).filePath(plFolder + QStringLiteral("/%(playlist_index)03d - %(title)s.%(ext)s"))
        : (m_fixedName.isEmpty()
               ? QDir(m_dir).filePath(QStringLiteral("%(title)s.%(ext)s"))
               : QDir(m_dir).filePath(m_fixedName + QStringLiteral(".%(ext)s")));

    m_conns = 1;
    const QStringList common = commonArgs(tmpl);

    // For a Udemy whole-course (playlist) job, the URL we give yt-dlp must be a
    // page that actually contains the numeric course id: yt-dlp's udemy:course
    // extractor SCRAPES the id out of the fetched page. The course landing page
    // (and the root-slug form) is a login-walled SPA WITHOUT the id, but the
    // in-course lecture page udemy.com/course/<slug>/learn/lecture/ carries it
    // and the extractor then enumerates the full curriculum. Normalise to that
    // form (idempotent when the URL is already a lecture URL). Host preserved so
    // enterprise tenants (company.udemy.com) keep working.
    // NB: DRM-protected lectures still cannot be downloaded (yt-dlp can't decrypt
    // Widevine); a course mixing DRM + plain videos yields only the plain ones.
    QUrl runUrl = m_url;
    if (m_playlist && m_url.host().toLower().endsWith(QStringLiteral("udemy.com"))) {
        const QString slug = urlSlug(m_url);
        if (!slug.isEmpty() && !m_url.path().contains(QStringLiteral("/learn/lecture/")))
            runUrl = QUrl(QStringLiteral("https://%1/course/%2/learn/lecture/")
                              .arg(m_url.host(), slug));
    }
    m_lastError.clear();
    m_tail.clear();

    // Playlist: download several videos in parallel (yt-dlp is one-at-a-time).
    if (m_playlist) {
        startPlaylistParallel(common, runUrl);
        return;
    }

    // Single video: one yt-dlp process (unchanged behaviour).
    QStringList args = common;
    args << QStringLiteral("--no-playlist")
         << QStringLiteral("--print-to-file") << QStringLiteral("after_move:filepath") << m_outFile
         << QStringLiteral("--") << runUrl.toString();   // -- : URL never parsed as a flag

    m_proc = new QProcess(this);
    m_proc->setProcessChannelMode(QProcess::MergedChannels);
    connect(m_proc, &QProcess::readyReadStandardOutput, this, &YtDlpGrabber::onOutput);
    connect(m_proc, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished),
            this, [this](int code, QProcess::ExitStatus) { onProcessFinished(code); });

    setState(DownloadState::Downloading, QStringLiteral("starting yt-dlp"));
    m_proc->start(QStringLiteral("yt-dlp"), args);
    m_proc->closeWriteChannel();   // EOF on stdin: an interactive prompt aborts, never hangs
}

// yt-dlp flags shared by the single-video process and every parallel playlist
// worker. The per-mode bits (--no-playlist / --yes-playlist + --playlist-items,
// the per-worker --print-to-file path, and the URL) are appended by the caller.
QStringList YtDlpGrabber::commonArgs(const QString &tmpl) const
{
    QStringList args;
    args << QStringLiteral("--newline") << QStringLiteral("--progress")
         << QStringLiteral("--no-color") << QStringLiteral("--no-warnings")
         // Give up on a stalled network read instead of hanging forever.
         << QStringLiteral("--socket-timeout") << QStringLiteral("30")
         << QStringLiteral("--no-mtime") << QStringLiteral("--restrict-filenames")
         << QStringLiteral("--merge-output-format") << QStringLiteral("mp4")
         // Machine-readable progress (byte counts, speed, fragment indices).
         << QStringLiteral("--progress-template")
         << QStringLiteral("download:[NEXA]|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|"
                           "%(progress.total_bytes_estimate)s|%(progress.speed)s|"
                           "%(progress.fragment_index)s|%(progress.fragment_count)s")
         << QStringLiteral("-f") << (m_format.isEmpty() ? QStringLiteral("bestvideo*+bestaudio/best") : m_format)
         << QStringLiteral("-o") << tmpl;

    if (m_embedSubs) {
        args << QStringLiteral("--write-subs") << QStringLiteral("--write-auto-subs")
             << QStringLiteral("--sub-langs") << m_subLangs
             << QStringLiteral("--embed-subs");
    }

    // Per-stream acceleration (aria2c multi-connection, else native fragments).
    const QString aria2 = QStandardPaths::findExecutable(QStringLiteral("aria2c"));
    if (!aria2.isEmpty()) {
        args << QStringLiteral("--downloader") << QStringLiteral("aria2c")
             << QStringLiteral("--downloader-args")
             << QStringLiteral("aria2c:-x16 -s16 -k1M --summary-interval=1 "
                               "--console-log-level=warn --enable-color=false");
    } else {
        args << QStringLiteral("--concurrent-fragments") << QStringLiteral("16")
             << QStringLiteral("--http-chunk-size") << QStringLiteral("10M");
    }

    // Domain-scoped auth flags only (never the browser UA/cookies — that breaks
    // yt-dlp's own extractor). Empty for YouTube.
    args << m_authArgs;
    return args;
}

// Launch N workers, each handling a round-robin slice of the playlist
// (--playlist-items "j::N"), so up to N videos download at once. Each writes its
// finalised file paths to its own file; we aggregate count + speed across them.
void YtDlpGrabber::startPlaylistParallel(const QStringList &common, const QUrl &runUrl)
{
    m_plProcs.clear();
    m_plOutFiles.clear();
    m_plRates.clear();
    m_plFinished = 0;
    m_plDoneVideos = 0;
    m_plTotal = 0;
    m_plLastEmitMs = 0;
    m_plName.clear();
    m_plClock.start();

    const int K = qBound(1, m_plConcurrency, 8);
    setState(DownloadState::Downloading,
             QStringLiteral("starting playlist (%1 in parallel)").arg(K));

    for (int j = 0; j < K; ++j) {
        const QString outf = m_outFile + QStringLiteral(".%1").arg(j);
        // yt-dlp --print-to-file APPENDS; remove any leftover from a previous run
        // of this id (pause→resume reuses the same paths) so counts aren't doubled.
        QFile::remove(outf);
        m_plOutFiles << outf;
        QStringList a = common;
        a << QStringLiteral("--yes-playlist")
          << QStringLiteral("--playlist-items") << QStringLiteral("%1::%2").arg(j + 1).arg(K)
          // Record "<full-playlist-count>|<final-path>" per saved video. The
          // count is the WHOLE playlist size (yt-dlp's playlist_count), NOT the
          // per-shard "item N of M" — with --playlist-items that M is only this
          // shard's slice (e.g. 10 for 60 videos across 6 shards). after_move is
          // a late stage so this does NOT imply --simulate (downloads still run).
          << QStringLiteral("--print-to-file")
          << QStringLiteral("after_move:%(playlist_count)s|%(filepath)s") << outf
          << QStringLiteral("--") << runUrl.toString();

        auto *p = new QProcess(this);
        p->setProcessChannelMode(QProcess::MergedChannels);
        connect(p, &QProcess::readyReadStandardOutput, this, &YtDlpGrabber::onPlOutput);
        connect(p, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished),
                this, [this](int, QProcess::ExitStatus) { onPlProcFinished(); });
        m_plProcs << p;
        m_plRates.insert(p, 0.0);
        p->start(QStringLiteral("yt-dlp"), a);
        p->closeWriteChannel();   // EOF on stdin: a prompt aborts, never hangs
    }
}

void YtDlpGrabber::cancel()
{
    m_cancelled = true;
    if (m_proc) {
        // Disconnect BEFORE killing: otherwise the killed process's queued
        // finished() can be delivered after a later resume (when m_cancelled is
        // back to false) and be mistaken for a real completion.
        m_proc->disconnect(this);
        m_proc->terminate();
        if (!m_proc->waitForFinished(1500))
            m_proc->kill();
        m_proc->deleteLater();
        m_proc = nullptr;
    }
    for (QProcess *p : m_plProcs) {     // parallel playlist workers
        if (!p) continue;
        // Same here: disconnect so a stale finished() from an old worker can't
        // bump the NEXT run's finished-count and complete it early (which showed
        // "Complete" at e.g. 318/429 after a pause+resume).
        p->disconnect(this);
        p->terminate();
        if (!p->waitForFinished(1200))
            p->kill();
        p->deleteLater();
    }
    m_plProcs.clear();
    m_plRates.clear();
    setState(DownloadState::Paused, QStringLiteral("cancelled"));
}

void YtDlpGrabber::onOutput()
{
    if (!m_proc)
        return;
    // When downloading a playlist, prefix each per-video status with its position.
    auto withPl = [this](const QString &base) {
        return (m_playlist && m_plTotal > 0)
            ? QStringLiteral("video %1/%2 · %3").arg(m_plItem).arg(m_plTotal).arg(base)
            : base;
    };
    while (m_proc->canReadLine()) {
        const QString line = QString::fromUtf8(m_proc->readLine()).trimmed();
        if (line.isEmpty())
            continue;

        // Keep a short tail + the last error for diagnostics on failure.
        m_tail.append(line);
        if (m_tail.size() > 20)
            m_tail.removeFirst();
        if (line.startsWith(QStringLiteral("ERROR:"), Qt::CaseInsensitive))
            m_lastError = line;
        // Classify auth failures precisely (HTTP 401/403, login/course-access,
        // bot sign-in) so onProcessFinished reports a clear auth reason instead
        // of a generic "code N". Checked on every line, not just ERROR: lines.
        if (const QString why = authReasonFromYtDlpLine(line); !why.isEmpty())
            m_lastError = QStringLiteral("ERROR: ") + why;
        if (line.contains(QStringLiteral("DRM protected"), Qt::CaseInsensitive))
            m_lastError = QStringLiteral("ERROR: this video is DRM-protected — "
                                         "Udemy DRM can't be downloaded");
        if (kDebug)
            qDebug().noquote() << "NEXA yt-dlp" << m_id << line;

        // Playlist position: "[download] Downloading item 3 of 13" (or "video N of M").
        if (m_playlist) {
            static const QRegularExpression itemRe(
                QStringLiteral("Downloading (?:item|video) (\\d+) of (\\d+)"));
            if (const auto im = itemRe.match(line); im.hasMatch()) {
                m_plItem = im.captured(1).toInt();
                m_plTotal = im.captured(2).toInt();
                m_lastPct = -1;            // each new video animates from 0
                m_lastEmitDone = -1;
                setState(DownloadState::Downloading,
                         QStringLiteral("playlist: video %1 of %2").arg(m_plItem).arg(m_plTotal));
                continue;
            }
        }

        // aria2c summary line (multi-connection downloader):
        //   "[#1e2ef5 39MiB/67MiB(57%) CN:16 DL:11MiB ETA:2s]"
        //   done=39MiB total=67MiB pct=57 CN=live connections DL=rate (per second)
        static const QRegularExpression aria(QStringLiteral(
            "\\[#\\S+\\s+([0-9.]+\\s*[KMGT]?i?B)/([0-9.]+\\s*[KMGT]?i?B)\\((\\d+)%\\)"
            "\\s+CN:(\\d+)\\s+DL:([0-9.]+\\s*[KMGT]?i?B)"));
        const auto am = aria.match(line);
        if (am.hasMatch()) {
            const qint64 done  = parseSize(am.captured(1));
            const qint64 total = parseSize(am.captured(2));
            const int    p     = am.captured(3).toInt();
            m_conns            = am.captured(4).toInt();
            const double bps   = double(parseSize(am.captured(5)));
            const bool worth = (p != m_lastPct) || (done - m_lastEmitDone >= 512 * 1024) ||
                               (m_lastEmitDone < 0);
            if (worth) {
                m_lastPct = p;
                m_lastEmitDone = done;
                emit progress(m_id, done, total, bps);
                setState(DownloadState::Downloading,
                         withPl(QStringLiteral("%1 connections").arg(m_conns)));
            }
            continue;
        }

        // Structured progress line from --progress-template:
        //   [NEXA]|downloaded|total|total_estimate|speed|frag_index|frag_count
        // Missing values arrive as "NA". This is the primary progress path.
        if (line.startsWith(QStringLiteral("[NEXA]|"))) {
            const QStringList f = line.split(QLatin1Char('|'));
            auto num = [&f](int i) -> double {
                if (i >= f.size()) return -1.0;
                bool ok = false;
                const double v = f.at(i).toDouble(&ok);
                return ok ? v : -1.0;
            };
            const qint64 done  = qint64(num(1));
            qint64       total = qint64(num(2));
            if (total <= 0) total = qint64(num(3));     // fall back to the estimate
            const double bps   = qMax(0.0, num(4));
            const int fragIdx  = int(num(5));
            const int fragCnt  = int(num(6));

            // Connection count: with fragmented (DASH) streams we run up to 16
            // fragment downloads at once; a progressive single file is one stream.
            QString detail;
            if (fragCnt > 1) {
                m_conns = qMin(16, fragCnt);
                detail = QStringLiteral("%1 connections · fragment %2/%3")
                             .arg(m_conns).arg(qMax(0, fragIdx)).arg(fragCnt);
            } else {
                m_conns = 1;
                detail = QStringLiteral("1 connection");
            }

            // Throttle: emit when the percent ticks or ~512 KiB more has arrived,
            // so a fast download doesn't repaint the table hundreds of times/sec.
            const int p = (total > 0 && done >= 0) ? int(done * 100.0 / total + 0.5) : -1;
            const bool worth = (p != m_lastPct) || (done - m_lastEmitDone >= 512 * 1024) ||
                               (m_lastEmitDone < 0);
            if (worth) {
                m_lastPct = p;
                m_lastEmitDone = done;
                emit progress(m_id, done, total, bps);
                setState(DownloadState::Downloading, withPl(detail));
            }
            continue;
        }

        // e.g. "[download]  36.0% of  218.53KiB at  222.40KiB/s ETA 00:00"
        static const QRegularExpression pct(
            QStringLiteral("\\[download\\]\\s+([\\d.]+)%(?:\\s+of\\s+~?\\s*([\\d.]+\\s*[KMGT]?i?B))?"));
        const auto pm = pct.match(line);
        if (pm.hasMatch()) {
            const double pf = pm.captured(1).toDouble();
            const int p = int(pf + 0.5);
            const qint64 total = pm.captured(2).isEmpty() ? -1 : parseSize(pm.captured(2));
            const qint64 done = total > 0 ? qint64(total * pf / 100.0) : -1;
            double bps = 0.0;
            const int at = line.indexOf(QStringLiteral(" at "));
            if (at >= 0)
                bps = parseRate(line.mid(at + 4));
            if (p != m_lastPct) {
                m_lastPct = p;
                emit progress(m_id, done, total, bps);
                setState(DownloadState::Downloading, withPl(QStringLiteral("%1%").arg(p)));
            }
            continue;
        }
        // A new stream is starting (YouTube delivers video and audio separately):
        // restart the throttle so the next stream animates from 0 again.
        if (line.startsWith(QStringLiteral("[download] Destination:"))) {
            m_lastPct = -1;
            m_lastEmitDone = -1;
        } else if (line.startsWith(QStringLiteral("[Merger]"))) {
            setState(DownloadState::Downloading, QStringLiteral("merging audio + video"));
        } else if (line.startsWith(QStringLiteral("[ExtractAudio]"))) {
            setState(DownloadState::Downloading, QStringLiteral("extracting audio"));
        }
    }
}

void YtDlpGrabber::resolveOutputFile()
{
    // yt-dlp wrote the final path to m_outFile via --print-to-file.
    QFile f(m_outFile);
    if (f.open(QIODevice::ReadOnly)) {
        const QString p = QString::fromUtf8(f.readAll()).trimmed();
        f.close();
        QFile::remove(m_outFile);
        // The path comes from yt-dlp expanding a SITE-controlled title template;
        // ensure it actually landed inside our output dir (defense-in-depth on top
        // of --restrict-filenames) before trusting it as the save path.
        if (!p.isEmpty() && QFileInfo::exists(p)) {
            const QString canon = QFileInfo(p).canonicalFilePath();
            const QString base  = QFileInfo(m_dir).canonicalFilePath();
            if (!canon.isEmpty() && !base.isEmpty()
                && (canon == base || canon.startsWith(base + QLatin1Char('/')))) {
                m_savePath = canon;
                return;
            }
        }
    }
    // Fallback: newest media file in the output directory.
    const QDir dir(m_dir);
    const QStringList matches = dir.entryList(
        {QStringLiteral("*.mp4"), QStringLiteral("*.mkv"), QStringLiteral("*.webm"),
         QStringLiteral("*.m4a"), QStringLiteral("*.opus"), QStringLiteral("*.mp3")},
        QDir::Files, QDir::Time);
    if (!matches.isEmpty())
        m_savePath = dir.filePath(matches.first());
}

void YtDlpGrabber::onProcessFinished(int exitCode)
{
    if (m_proc) { m_proc->deleteLater(); m_proc = nullptr; }
    if (m_cancelled)
        return;

    if (m_playlist) {
        // yt-dlp appended one finalised path per video to m_outFile. Count them;
        // success = at least one video saved (a playlist run can exit non-zero if
        // a single private/age-gated entry failed, while the rest downloaded fine).
        int n = 0;
        QString folder;
        QFile f(m_outFile);
        if (f.open(QIODevice::ReadOnly)) {
            const QStringList paths = QString::fromUtf8(f.readAll())
                                          .split(QLatin1Char('\n'), Qt::SkipEmptyParts);
            f.close();
            QFile::remove(m_outFile);
            n = paths.size();
            if (!paths.isEmpty())
                folder = QFileInfo(paths.last()).absolutePath();
        }
        if (!folder.isEmpty())
            m_savePath = folder;   // so "open" lands in the playlist folder
        if (n > 0) {
            setState(DownloadState::Completed,
                     QStringLiteral("saved %1 video%2").arg(n).arg(n == 1 ? "" : "s"));
            emit finished(m_id);
        } else {
            QString why = m_lastError;
            why.remove(QRegularExpression(QStringLiteral("^ERROR:\\s*"),
                                          QRegularExpression::CaseInsensitiveOption));
            if (why.isEmpty())
                why = m_tail.isEmpty() ? QStringLiteral("code %1").arg(exitCode) : m_tail.last();
            if (why.length() > 160)
                why = why.left(157) + QStringLiteral("…");
            setState(DownloadState::Error, why);
        }
        return;
    }

    resolveOutputFile();
    const bool ok = (exitCode == 0) && QFileInfo::exists(m_savePath) &&
                    QFileInfo(m_savePath).size() > 0;
    if (ok) {
        const qint64 sz = QFileInfo(m_savePath).size();   // real final size, not "100 B"
        emit progress(m_id, sz, sz, 0.0);
        setState(DownloadState::Completed, QStringLiteral("saved %1").arg(fileName()));
        emit finished(m_id);
    } else {
        // Surface the real reason: the yt-dlp ERROR line (trimmed) if we have it.
        QString why = m_lastError;
        why.remove(QRegularExpression(QStringLiteral("^ERROR:\\s*"), QRegularExpression::CaseInsensitiveOption));
        if (why.isEmpty())
            why = m_tail.isEmpty() ? QStringLiteral("code %1").arg(exitCode) : m_tail.last();
        if (why.length() > 160)
            why = why.left(157) + QStringLiteral("…");
        if (kDebug)
            qDebug().noquote() << "NEXA yt-dlp FAILED" << m_id << "\n" << m_tail.join('\n');
        setState(DownloadState::Error, why);
    }
}

// ---- parallel playlist workers -------------------------------------------

int YtDlpGrabber::countPlaylistDone()
{
    // Each worker appends "<playlist_count>|<final-path>" per saved video. Count
    // UNIQUE paths (each video has a distinct path, so this de-dups re-runs on
    // resume — what previously pushed the total past 100%, e.g. "42/20"). The
    // playlist_count is the WHOLE playlist size, so we also learn the real total
    // here (the per-shard "item N of M" can't give it under --playlist-items).
    QSet<QString> paths;
    for (const QString &f : m_plOutFiles) {
        QFile qf(f);
        if (qf.open(QIODevice::ReadOnly)) {
            const QStringList lines = QString::fromUtf8(qf.readAll())
                                          .split(QLatin1Char('\n'), Qt::SkipEmptyParts);
            for (const QString &l : lines) {
                const int sep = l.indexOf(QLatin1Char('|'));
                if (sep > 0) {
                    const int n = l.left(sep).toInt();
                    if (n > m_plTotal) m_plTotal = n;
                    paths.insert(l.mid(sep + 1).trimmed());
                } else {
                    paths.insert(l.trimmed());   // tolerate a count-less line
                }
            }
            qf.close();
        }
    }
    return paths.size();
}

void YtDlpGrabber::emitPlaylistProgress()
{
    m_plDoneVideos = countPlaylistDone();
    if (m_plTotal > 0)
        m_plDoneVideos = qMin(m_plDoneVideos, m_plTotal);   // never report > 100%
    double rate = 0.0;
    for (double r : m_plRates) rate += r;          // combined speed of all workers
    const int active = qMax(0, int(m_plProcs.size()) - m_plFinished);
    // done/total are VIDEO COUNTS for a playlist (the UI shows "N videos").
    emit progress(m_id, m_plDoneVideos, m_plTotal > 0 ? m_plTotal : -1, rate);
    if (m_plTotal > 0)
        setState(DownloadState::Downloading,
                 QStringLiteral("%1/%2 videos · %3 downloading")
                     .arg(m_plDoneVideos).arg(m_plTotal).arg(active));
    else
        setState(DownloadState::Downloading,
                 QStringLiteral("%1 videos · %2 downloading").arg(m_plDoneVideos).arg(active));
}

void YtDlpGrabber::onPlOutput()
{
    auto *p = qobject_cast<QProcess*>(sender());
    if (!p)
        return;
    while (p->canReadLine()) {
        const QString line = QString::fromUtf8(p->readLine()).trimmed();
        if (line.isEmpty())
            continue;
        m_tail.append(line);
        if (m_tail.size() > 40)
            m_tail.removeFirst();
        if (line.startsWith(QStringLiteral("ERROR:"), Qt::CaseInsensitive))
            m_lastError = line;
        if (const QString why = authReasonFromYtDlpLine(line); !why.isEmpty())
            m_lastError = QStringLiteral("ERROR: ") + why;
        // Tally DRM-protected lectures (Widevine — undownloadable), keyed by lecture
        // id so the same failure across retries counts once. Surfaced on completion.
        if (line.contains(QStringLiteral("DRM protected"), Qt::CaseInsensitive)) {
            static const QRegularExpression drmRe(QStringLiteral("\\[udemy\\]\\s*(\\d+)"));
            const auto dm = drmRe.match(line);
            m_drmVideoIds.insert(dm.hasMatch() ? dm.captured(1) : line);
        }
        if (kDebug)
            qDebug().noquote() << "NEXA yt-dlp[pl]" << m_id << line;

        // NB: the per-video "Downloading item N of M" line is intentionally NOT
        // used for the total — under --playlist-items "j::K" its M is only this
        // shard's slice (e.g. 10 of a 60-video playlist). The real total comes
        // from yt-dlp's playlist_count, recorded in the per-video output file and
        // read in countPlaylistDone().

        // Real playlist title (yt-dlp: "[download] Downloading playlist: TITLE").
        // Use it for the displayed name so the row/plate shows the playlist's
        // actual title instead of a placeholder. (The folder on disk is already
        // named by yt-dlp's %(playlist_title)s.)
        if (m_plName.isEmpty()) {
            static const QRegularExpression titleRe(
                QStringLiteral("Downloading playlist:\\s*(.+)$"));
            if (const auto tm = titleRe.match(line); tm.hasMatch()) {
                m_plName = tm.captured(1).trimmed();
                if (!m_plName.isEmpty()) {
                    m_savePath = QDir(m_dir).filePath(m_plName);
                    emit renamed(m_id, fileName());
                }
            }
        }

        // This worker's current speed (structured line, else aria2 DL:, else "at RATE").
        double rate = -1.0;
        if (line.startsWith(QStringLiteral("[NEXA]|"))) {
            const QStringList f = line.split(QLatin1Char('|'));
            if (f.size() > 4) {
                bool ok = false;
                const double v = f.at(4).toDouble(&ok);
                if (ok) rate = qMax(0.0, v);
            }
        } else {
            static const QRegularExpression aria(QStringLiteral("DL:([0-9.]+\\s*[KMGT]?i?B)"));
            if (const auto am = aria.match(line); am.hasMatch()) {
                rate = double(parseSize(am.captured(1)));
            } else if (line.contains(QStringLiteral("[download]"))) {
                const int at = line.indexOf(QStringLiteral(" at "));
                if (at >= 0) {
                    const double r = parseRate(line.mid(at + 4));
                    if (r > 0) rate = r;
                }
            }
        }
        if (rate >= 0.0)
            m_plRates[p] = rate;
    }

    // Throttle the aggregate emit so a burst of worker lines doesn't repaint madly.
    const qint64 now = m_plClock.elapsed();
    if (now - m_plLastEmitMs >= 400) {
        m_plLastEmitMs = now;
        emitPlaylistProgress();
    }
}

void YtDlpGrabber::onPlProcFinished()
{
    if (auto *p = qobject_cast<QProcess*>(sender()))
        m_plRates[p] = 0.0;
    ++m_plFinished;
    if (m_cancelled)
        return;
    if (m_plFinished < m_plProcs.size()) {
        emitPlaylistProgress();    // reflect one fewer worker downloading
        return;
    }

    // All workers exited — tally the saved videos and the playlist folder.
    int total = countPlaylistDone();
    if (m_plTotal > 0)
        total = qMin(total, m_plTotal);
    QString folder;
    for (const QString &f : m_plOutFiles) {
        QFile qf(f);
        if (qf.open(QIODevice::ReadOnly)) {
            const QStringList lines = QString::fromUtf8(qf.readAll())
                                          .split(QLatin1Char('\n'), Qt::SkipEmptyParts);
            qf.close();
            if (!lines.isEmpty() && folder.isEmpty()) {
                QString path = lines.last();
                const int sep = path.indexOf(QLatin1Char('|'));   // strip "<count>|"
                if (sep > 0) path = path.mid(sep + 1);
                folder = QFileInfo(path.trimmed()).absolutePath();
            }
        }
        QFile::remove(f);
    }
    if (!folder.isEmpty()) {
        m_savePath = folder;       // so "open" lands in the playlist folder
        emit renamed(m_id, fileName());   // show the real (on-disk) folder name
    }

    if (kDebug)
        qDebug().noquote() << "NEXA PL-DONE" << m_id << "videos=" << total
                           << "folder=" << folder;
    const int drm = m_drmVideoIds.size();
    if (total > 0) {
        m_plDoneVideos = total;
        emit progress(m_id, total, m_plTotal > 0 ? m_plTotal : total, 0.0);
        // Be honest about DRM: a course where most lectures are Widevine-protected
        // saves only its few plain videos — say so, or "saved 2 videos" reads like
        // it stopped early. yt-dlp/aria2 cannot decrypt Udemy DRM; nothing can here.
        QString detail = QStringLiteral("saved %1 video%2").arg(total).arg(total == 1 ? "" : "s");
        if (drm > 0)
            detail += QStringLiteral(" · %1 DRM-protected (can't download)").arg(drm);
        setState(DownloadState::Completed, detail);
        emit finished(m_id);
    } else if (drm > 0) {
        // Every lecture that ran was DRM-protected — make the reason unmistakable
        // rather than surfacing a raw yt-dlp error line.
        setState(DownloadState::Error,
                 QStringLiteral("all %1 video%2 are DRM-protected — Udemy DRM can't be downloaded")
                     .arg(drm).arg(drm == 1 ? "" : "s"));
    } else {
        QString why = m_lastError;
        why.remove(QRegularExpression(QStringLiteral("^ERROR:\\s*"),
                                      QRegularExpression::CaseInsensitiveOption));
        if (why.isEmpty())
            why = m_tail.isEmpty() ? QStringLiteral("no videos downloaded") : m_tail.last();
        if (why.length() > 160)
            why = why.left(157) + QStringLiteral("…");
        setState(DownloadState::Error, why);
    }
}

} // namespace nexa
