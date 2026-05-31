#include "site/YtDlpGrabber.h"

#include <QProcess>
#include <QFile>
#include <QFileInfo>
#include <QDir>
#include <QStandardPaths>
#include <QRegularExpression>

namespace nexa {

namespace {

// Parse a yt-dlp rate string like "1.50MiB/s" into bytes/second.
double parseRate(const QString &s)
{
    static const QRegularExpression re(QStringLiteral("([\\d.]+)\\s*([KMG]?i?B)/s"),
                                       QRegularExpression::CaseInsensitiveOption);
    const auto m = re.match(s);
    if (!m.hasMatch())
        return 0.0;
    double v = m.captured(1).toDouble();
    const QString unit = m.captured(2).toUpper();
    if (unit.startsWith('K')) v *= 1024;
    else if (unit.startsWith('M')) v *= 1024 * 1024;
    else if (unit.startsWith('G')) v *= 1024.0 * 1024 * 1024;
    return v;
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

    // Forward the browser-captured identity so age/region/login-gated videos work.
    for (const auto &h : m_headers) {
        if (h.first.compare("User-Agent", Qt::CaseInsensitive) == 0)
            args << QStringLiteral("--user-agent") << QString::fromUtf8(h.second);
        else if (h.first.compare("Referer", Qt::CaseInsensitive) == 0)
            args << QStringLiteral("--referer") << QString::fromUtf8(h.second);
        else
            args << QStringLiteral("--add-header")
                 << QStringLiteral("%1:%2").arg(QString::fromUtf8(h.first), QString::fromUtf8(h.second));
    }
    args << m_url.toString();

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

        static const QRegularExpression pct(QStringLiteral("\\[download\\]\\s+([\\d.]+)%"));
        const auto pm = pct.match(line);
        if (pm.hasMatch()) {
            const int p = int(pm.captured(1).toDouble() + 0.5);
            double bps = 0.0;
            const int at = line.indexOf(QStringLiteral(" at "));
            if (at >= 0)
                bps = parseRate(line.mid(at + 4));
            if (p != m_lastPct) {
                m_lastPct = p;
                emit progress(m_id, p, 100, bps);
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
        setState(DownloadState::Error, QStringLiteral("yt-dlp failed (code %1)").arg(exitCode));
    }
}

} // namespace nexa
