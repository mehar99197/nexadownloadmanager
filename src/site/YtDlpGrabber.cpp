#include "site/YtDlpGrabber.h"
#include "auth/AuthUtils.h"

#include <QProcess>
#include <QFile>
#include <QFileInfo>
#include <QDir>
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
    QString plFolder = m_fixedName.trimmed();
    if (plFolder.isEmpty())
        plFolder = urlSlug(m_url);            // e.g. "pythonforbeginnersintro" from the URL
    plFolder.replace(QRegularExpression(QStringLiteral("[/\\\\%(){}]+")), QStringLiteral("_"));
    if (plFolder.isEmpty())
        plFolder = QStringLiteral("%(playlist_title,playlist_id)s");   // last resort

    const QString tmpl = m_playlist
        ? QDir(m_dir).filePath(plFolder + QStringLiteral("/%(playlist_index)03d - %(title)s.%(ext)s"))
        : (m_fixedName.isEmpty()
               ? QDir(m_dir).filePath(QStringLiteral("%(title)s.%(ext)s"))
               : QDir(m_dir).filePath(m_fixedName + QStringLiteral(".%(ext)s")));

    QStringList args;
    args << (m_playlist ? QStringLiteral("--yes-playlist") : QStringLiteral("--no-playlist"))
         << QStringLiteral("--newline") << QStringLiteral("--progress")
         << QStringLiteral("--no-color") << QStringLiteral("--no-warnings")
         << QStringLiteral("--no-mtime") << QStringLiteral("--restrict-filenames")
         << QStringLiteral("--merge-output-format") << QStringLiteral("mp4")
         // Machine-readable progress: one line per update with the exact byte
         // counts, speed and fragment indices so the UI shows real progress and
         // the live connection count (rather than scraping the human display).
         << QStringLiteral("--progress-template")
         << QStringLiteral("download:[NEXA]|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|"
                           "%(progress.total_bytes_estimate)s|%(progress.speed)s|"
                           "%(progress.fragment_index)s|%(progress.fragment_count)s")
         // record the actual final path so we can show/open it accurately
         << QStringLiteral("--print-to-file") << QStringLiteral("after_move:filepath") << m_outFile
         << QStringLiteral("-f") << (m_format.isEmpty() ? QStringLiteral("bestvideo*+bestaudio/best") : m_format)
         << QStringLiteral("-o") << tmpl;

    // Speed: real multi-connection downloading. YouTube serves high-quality
    // video/audio as a single googlevideo URL, which yt-dlp's own downloader can
    // only pull over ONE connection (concurrent-fragments parallelises only
    // *fragmented* streams). aria2c splits each stream across up to 16 parallel
    // connections and ramps them with the available bandwidth — the IDM-style
    // behaviour. Its periodic summary reports the live connection count (CN:n),
    // which onOutput() parses for both progress and the displayed connection count.
    m_conns = 1;
    const QString aria2 = QStandardPaths::findExecutable(QStringLiteral("aria2c"));
    if (!aria2.isEmpty()) {
        args << QStringLiteral("--downloader") << QStringLiteral("aria2c")
             << QStringLiteral("--downloader-args")
             << QStringLiteral("aria2c:-x16 -s16 -k1M --summary-interval=1 "
                               "--console-log-level=warn --enable-color=false");
    } else {
        // No aria2c: yt-dlp native. Parallelises fragmented (DASH/HLS) streams
        // via concurrent fragments; a single-file stream uses one connection.
        args << QStringLiteral("--concurrent-fragments") << QStringLiteral("16")
             << QStringLiteral("--http-chunk-size") << QStringLiteral("10M");
    }

    // NOTE: deliberately do NOT forward the browser's User-Agent / cookies to
    // yt-dlp. yt-dlp manages its own client/UA/cookie logic for YouTube & co.;
    // overriding the UA or injecting raw account cookies breaks its extractor.
    // Domain-scoped auth IS allowed though: m_authArgs holds finished flags the
    // engine's AuthenticationManager built for THIS host (e.g. --cookies for
    // udemy.com). It is EMPTY for YouTube hosts (ytDlpArgs() excludes them), so
    // the no-forward safeguard above still holds.
    args << m_authArgs;
    args << m_url.toString();
    m_lastError.clear();
    m_tail.clear();

    m_proc = new QProcess(this);
    m_proc->setProcessChannelMode(QProcess::MergedChannels);
    connect(m_proc, &QProcess::readyReadStandardOutput, this, &YtDlpGrabber::onOutput);
    connect(m_proc, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished),
            this, [this](int code, QProcess::ExitStatus) { onProcessFinished(code); });

    setState(DownloadState::Downloading, QStringLiteral("starting yt-dlp"));
    m_proc->start(QStringLiteral("yt-dlp"), args);
}

void YtDlpGrabber::cancel()
{
    m_cancelled = true;
    if (m_proc) {
        m_proc->terminate();
        if (!m_proc->waitForFinished(1500))
            m_proc->kill();
    }
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
        if (!p.isEmpty() && QFileInfo::exists(p)) {
            m_savePath = p;
            return;
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

} // namespace nexa
