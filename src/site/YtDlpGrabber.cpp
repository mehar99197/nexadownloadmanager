#include "site/YtDlpGrabber.h"

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

} // namespace

YtDlpGrabber::YtDlpGrabber(int id, const QUrl &pageUrl, const QString &outputDir,
                           const QString &fixedName, const QString &formatSelector,
                           const HeaderList &headers, QObject *parent)
    : QObject(parent), m_id(id), m_url(pageUrl), m_dir(outputDir),
      m_fixedName(fixedName), m_format(formatSelector), m_headers(headers)
{
    const QString placeholder = m_fixedName.isEmpty() ? QStringLiteral("video") : m_fixedName;
    m_savePath = QDir(m_dir).filePath(placeholder + QStringLiteral(".mp4"));
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

    const QString tmpl = m_fixedName.isEmpty()
        ? QDir(m_dir).filePath(QStringLiteral("%(title)s.%(ext)s"))
        : QDir(m_dir).filePath(m_fixedName + QStringLiteral(".%(ext)s"));

    QStringList args;
    args << QStringLiteral("--no-playlist")
         << QStringLiteral("--newline") << QStringLiteral("--progress")
         << QStringLiteral("--no-color") << QStringLiteral("--no-warnings")
         << QStringLiteral("--no-mtime") << QStringLiteral("--restrict-filenames")
         << QStringLiteral("--merge-output-format") << QStringLiteral("mp4")
         // record the actual final path so we can show/open it accurately
         << QStringLiteral("--print-to-file") << QStringLiteral("after_move:filepath") << m_outFile
         << QStringLiteral("-f") << (m_format.isEmpty() ? QStringLiteral("bestvideo*+bestaudio/best") : m_format)
         << QStringLiteral("-o") << tmpl;

    // Speed: download many chunks/fragments in parallel to beat YouTube's
    // per-connection throttling. Prefer aria2c (16 connections) when installed,
    // otherwise yt-dlp's native concurrent fragments + range chunking.
    const QString aria2 = QStandardPaths::findExecutable(QStringLiteral("aria2c"));
    if (!aria2.isEmpty()) {
        args << QStringLiteral("--downloader") << QStringLiteral("aria2c")
             << QStringLiteral("--downloader-args")
             << QStringLiteral("aria2c:-x16 -s16 -k1M -j16");
    } else {
        args << QStringLiteral("--concurrent-fragments") << QStringLiteral("16")
             << QStringLiteral("--http-chunk-size") << QStringLiteral("10M");
    }

    // NOTE: deliberately do NOT forward the browser's User-Agent / cookies to
    // yt-dlp. yt-dlp manages its own client/UA/cookie logic for YouTube & co.;
    // overriding the UA or injecting raw account cookies breaks its extractor.
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
        if (kDebug)
            qDebug().noquote() << "NEXA yt-dlp" << m_id << line;

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
                setState(DownloadState::Downloading, QStringLiteral("%1%").arg(p));
            }
            continue;
        }
        if (line.startsWith(QStringLiteral("[Merger]")))
            setState(DownloadState::Downloading, QStringLiteral("merging audio + video"));
        else if (line.startsWith(QStringLiteral("[ExtractAudio]")))
            setState(DownloadState::Downloading, QStringLiteral("extracting audio"));
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

    resolveOutputFile();
    const bool ok = (exitCode == 0) && QFileInfo::exists(m_savePath) &&
                    QFileInfo(m_savePath).size() > 0;
    if (ok) {
        emit progress(m_id, 100, 100, 0.0);
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
