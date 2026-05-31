#include "core/DownloadTask.h"
#include "core/SegmentDownloader.h"
#include "core/Database.h"

#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QTimer>
#include <QFile>
#include <QFileInfo>
#include <QDir>
#include <QDebug>
#include <QRegularExpression>
#include <algorithm>

namespace nexa {

static const bool kDebug = qEnvironmentVariableIsSet("NEXA_DEBUG");

// Extract a filename from a Content-Disposition header, handling both the plain
// `filename="x"` form and the RFC 5987 `filename*=UTF-8''x` (percent-encoded)
// form. Returns a sanitised basename, or empty if none.
static QString filenameFromContentDisposition(const QByteArray &header)
{
    if (header.isEmpty())
        return QString();
    const QString value = QString::fromUtf8(header);

    QString name;
    // RFC 5987 extended form takes precedence (carries proper encoding).
    static const QRegularExpression ext(
        QStringLiteral("filename\\*\\s*=\\s*[^']*''([^;]+)"), QRegularExpression::CaseInsensitiveOption);
    static const QRegularExpression plain(
        QStringLiteral("filename\\s*=\\s*\"?([^\";]+)\"?"), QRegularExpression::CaseInsensitiveOption);
    if (const auto m = ext.match(value); m.hasMatch())
        name = QUrl::fromPercentEncoding(m.captured(1).trimmed().toUtf8());
    else if (const auto m = plain.match(value); m.hasMatch())
        name = m.captured(1).trimmed();

    name = QFileInfo(name).fileName();                       // strip any path
    name.replace(QRegularExpression(QStringLiteral("[\\\\/:*?\"<>|]")), QString());
    return name.trimmed();
}

DownloadTask::DownloadTask(int id, const QUrl &url, const QString &savePath,
                           QNetworkAccessManager *nam, Database *db, QObject *parent)
    : QObject(parent), m_id(id), m_url(url), m_savePath(savePath), m_nam(nam), m_db(db)
{
    m_speedTimer = new QTimer(this);
    m_speedTimer->setInterval(500);
    connect(m_speedTimer, &QTimer::timeout, this, &DownloadTask::emitSpeedTick);
}

DownloadTask::~DownloadTask()
{
    clearSegments();
    if (m_probe) {
        m_probe->abort();
        m_probe->deleteLater();
    }
}

QString DownloadTask::fileName() const
{
    return QFileInfo(m_savePath).fileName();
}

bool DownloadTask::renameTo(const QString &newFileName)
{
    const QFileInfo fi(m_savePath);
    const QString dir = fi.absolutePath();
    QString target = dir + QStringLiteral("/") + newFileName;
    if (target == m_savePath)
        return true;
    // Don't clobber an existing file: name.ext -> name (1).ext, etc.
    if (QFile::exists(target)) {
        const QFileInfo tf(target);
        const QString base = tf.completeBaseName();
        const QString suffix = tf.suffix().isEmpty() ? QString()
                                                     : (QStringLiteral(".") + tf.suffix());
        int n = 1;
        do {
            target = dir + QStringLiteral("/%1 (%2)%3").arg(base).arg(n).arg(suffix);
            ++n;
        } while (QFile::exists(target));
    }
    if (!QFile::rename(m_savePath, target))
        return false;
    m_savePath = target;
    persist();
    return true;
}

// Choose how many parallel connections to use, scaling with file size and
// capping at 16 (more than that rarely helps and annoys servers).
int DownloadTask::preferredSegmentCount(qint64 totalBytes)
{
    if (totalBytes <= 0)              return 1;
    if (totalBytes < 1 * 1024 * 1024) return 1;    // < 1 MB: not worth splitting
    if (totalBytes < 10 * 1024 * 1024) return 4;
    if (totalBytes < 100 * 1024 * 1024) return 8;
    return 16;
}

void DownloadTask::start()
{
    if (m_state == DownloadState::Downloading || m_state == DownloadState::Probing)
        return;

    setState(DownloadState::Probing, QStringLiteral("contacting server"));

    QNetworkRequest req(m_url);
    req.setHeader(QNetworkRequest::UserAgentHeader, QStringLiteral("Nexa/0.1"));
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::NoLessSafeRedirectPolicy);
    req.setRawHeader("Accept-Encoding", "identity");
    for (const auto &h : m_headers)
        req.setRawHeader(h.first, h.second);
    // A ranged HEAD-style probe: ask for the first byte to learn whether the
    // server honours Range, plus Content-Length / final redirected URL.
    req.setRawHeader("Range", "bytes=0-0");

    m_probe = m_nam->get(req);
    connect(m_probe, &QNetworkReply::finished, this, &DownloadTask::onProbeFinished);
}

void DownloadTask::onProbeFinished()
{
    QNetworkReply *r = m_probe;
    m_probe = nullptr;
    if (!r)
        return;
    r->deleteLater();

    if (r->error() != QNetworkReply::NoError &&
        r->error() != QNetworkReply::OperationCanceledError) {
        setState(DownloadState::Error, r->errorString());
        return;
    }

    // Follow redirects: use the final URL for the real download.
    const QUrl finalUrl = r->url();
    if (finalUrl.isValid() && finalUrl != m_url)
        m_url = finalUrl;

    const int status = r->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    bool ranges = false;
    qint64 total = -1;

    if (status == 206) {
        // Partial Content -> ranges supported. Parse total from Content-Range.
        ranges = true;
        const QByteArray cr = r->rawHeader("Content-Range"); // e.g. "bytes 0-0/12345"
        const int slash = cr.indexOf('/');
        if (slash >= 0) {
            const QByteArray totalStr = cr.mid(slash + 1).trimmed();
            if (totalStr != "*")
                total = totalStr.toLongLong();
        }
    } else {
        // 200 OK: server ignored Range -> single stream, size from Content-Length.
        ranges = false;
        const QVariant len = r->header(QNetworkRequest::ContentLengthHeader);
        if (len.isValid())
            total = len.toLongLong();
    }

    if (r->hasRawHeader("Accept-Ranges") && r->rawHeader("Accept-Ranges") == "none")
        ranges = false;

    m_total = total;
    m_rangesSupported = ranges;

    // Prefer the real filename from Content-Disposition (CDN/redirect URLs often
    // have a random token in the path, so the URL alone gives a useless name).
    const QString serverName = filenameFromContentDisposition(r->rawHeader("Content-Disposition"));
    if (!serverName.isEmpty() && m_nameResolver) {
        const QString newPath = m_nameResolver(serverName);
        if (!newPath.isEmpty() && newPath != m_savePath) {
            m_savePath = newPath;
            emit renamedTo(fileName());
        }
    }

    if (!preallocateFile()) {
        setState(DownloadState::Error, QStringLiteral("cannot create destination file"));
        return;
    }

    buildSegments(total, ranges);
    persist();
    setState(DownloadState::Downloading,
             QStringLiteral("%1 connection(s)").arg(m_segments.size()));
    m_clock.start();
    m_lastTickBytes = m_done;
    m_lastTickMs = 0;
    m_speedTimer->start();
    launchSegments();
}

bool DownloadTask::preallocateFile()
{
    QDir().mkpath(QFileInfo(m_savePath).absolutePath());
    QFile f(m_savePath);
    if (!f.open(QIODevice::ReadWrite))
        return false;
    if (m_total > 0) {
        if (!f.resize(m_total)) {
            f.close();
            return false;
        }
    }
    f.close();
    return true;
}

void DownloadTask::buildSegments(qint64 total, bool rangesSupported)
{
    m_segments.clear();
    m_done = 0;

    if (!rangesSupported || total <= 0) {
        // Single segment covering the whole file (or unknown size: end huge).
        SegmentInfo s;
        s.index = 0;
        s.start = 0;
        s.end = (total > 0) ? (total - 1) : (qint64(1) << 62);
        s.done = 0;
        m_segments.append(s);
        return;
    }

    const int n = preferredSegmentCount(total);
    const qint64 chunk = total / n;
    for (int i = 0; i < n; ++i) {
        SegmentInfo s;
        s.index = i;
        s.start = i * chunk;
        s.end = (i == n - 1) ? (total - 1) : ((i + 1) * chunk - 1);
        s.done = 0;
        m_segments.append(s);
    }
}

void DownloadTask::restore(qint64 totalBytes, const QVector<SegmentInfo> &segments)
{
    m_total = totalBytes;
    m_segments = segments;
    m_rangesSupported = segments.size() > 1;
    m_done = 0;
    for (const auto &s : m_segments)
        m_done += s.done;
    if (m_done >= m_total && m_total > 0)
        setState(DownloadState::Completed);
    else
        setState(DownloadState::Paused, QStringLiteral("restored"));
}

void DownloadTask::launchSegments()
{
    clearSegments();
    m_completedSegments = 0;
    m_activeSegments = 0;

    for (const SegmentInfo &seg : m_segments) {
        if (seg.complete()) {
            ++m_completedSegments;
            continue;
        }
        auto *w = new SegmentDownloader(seg, m_url, m_savePath, m_headers, m_nam, this);
        connect(w, &SegmentDownloader::progressed,  this, &DownloadTask::onSegmentProgressed);
        connect(w, &SegmentDownloader::completed,   this, &DownloadTask::onSegmentCompleted);
        connect(w, &SegmentDownloader::failed,      this, &DownloadTask::onSegmentFailed);
        connect(w, &SegmentDownloader::shortFinish, this, &DownloadTask::onSegmentShortFinish);
        m_workers.append(w);
        ++m_activeSegments;
    }
    for (auto *w : m_workers)
        w->start();

    if (m_activeSegments == 0)
        checkAllComplete();
}

void DownloadTask::clearSegments()
{
    for (auto *w : m_workers) {
        w->stop();
        w->deleteLater();
    }
    m_workers.clear();
}

void DownloadTask::onSegmentProgressed(int index, qint64 delta)
{
    m_done += delta;
    if (index >= 0 && index < m_segments.size())
        m_segments[index].done += delta;
}

void DownloadTask::onSegmentCompleted(int index)
{
    if (index >= 0 && index < m_segments.size())
        m_segments[index].done = m_segments[index].length();
    ++m_completedSegments;
    persist();
    checkAllComplete();
}

void DownloadTask::onSegmentFailed(int index, const QString &error)
{
    if (m_state == DownloadState::Paused)
        return;
    // Transient network error — retry this one segment a few times (it resumes
    // from where it stopped) before giving up on the whole download.
    if (m_retries.value(index) < kMaxRetries) {
        retrySegment(index, error);
        return;
    }
    m_speedTimer->stop();
    clearSegments();
    persist();
    setState(DownloadState::Error,
             QStringLiteral("segment %1: %2").arg(index).arg(error));
}

void DownloadTask::onSegmentShortFinish(int index, qint64 received)
{
    Q_UNUSED(received);
    if (m_state == DownloadState::Paused)
        return;

    // The server closed cleanly having sent fewer bytes than the range we
    // requested. If there might be more (transient early close), retry a couple
    // of times — the segment resumes from its current offset.
    if (m_retries.value(index) < 2) {
        retrySegment(index, QStringLiteral("short read"));
        return;
    }

    // Still short after retries: the server genuinely has no more data, i.e. the
    // advertised total was larger than the real content. Accept what we have.
    if (m_segments.size() == 1) {
        finalizeShort(m_done);
        return;
    }
    // Multi-segment short read leaves a gap we can't fill — fail clearly.
    m_speedTimer->stop();
    clearSegments();
    persist();
    setState(DownloadState::Error,
             QStringLiteral("segment %1 ended early (incomplete)").arg(index));
}

void DownloadTask::retrySegment(int index, const QString &reason)
{
    m_retries[index] = m_retries.value(index) + 1;
    if (kDebug)
        qDebug().noquote() << "NEXA RETRY" << m_id << "seg" << index
                           << "attempt" << m_retries[index] << reason;
    // Restart just this segment after a short backoff; it resumes from seg.done.
    for (auto *w : m_workers) {
        if (w->index() == index) {
            const int delayMs = 400 * m_retries.value(index);
            QTimer::singleShot(delayMs, this, [this, w]() {
                if (m_state == DownloadState::Downloading && m_workers.contains(w))
                    w->start();
            });
            return;
        }
    }
}

void DownloadTask::finalizeShort(qint64 totalReceived)
{
    m_speedTimer->stop();
    clearSegments();
    // Trim the pre-allocated file down to what we actually received.
    QFile f(m_savePath);
    if (f.open(QIODevice::ReadWrite))
        f.resize(totalReceived);
    f.close();
    m_total = totalReceived;
    if (!m_segments.isEmpty()) {
        m_segments[0].end = totalReceived - 1;
        m_segments[0].done = totalReceived;
    }
    m_completedSegments = m_segments.size();
    setState(DownloadState::Completed, QStringLiteral("done"));
    persist();
    emit progress(m_id, m_total, m_total, 0.0);
    emit finished(m_id);
}

void DownloadTask::checkAllComplete()
{
    if (m_completedSegments < m_segments.size())
        return;
    m_speedTimer->stop();
    clearSegments();
    if (m_total <= 0)
        m_total = m_done;          // unknown-size stream: final size is what we got
    setState(DownloadState::Completed, QStringLiteral("done"));
    persist();
    emit progress(m_id, m_done, m_total, 0.0);
    emit finished(m_id);
}

void DownloadTask::pause()
{
    if (m_state != DownloadState::Downloading && m_state != DownloadState::Probing)
        return;
    m_speedTimer->stop();
    if (m_probe) {
        m_probe->abort();
        m_probe->deleteLater();
        m_probe = nullptr;
    }
    clearSegments();
    persist();
    setState(DownloadState::Paused, QStringLiteral("paused"));
}

void DownloadTask::resume()
{
    if (m_state == DownloadState::Completed || m_state == DownloadState::Downloading)
        return;

    // Never probed yet (fresh restored task) -> probe first.
    if (m_segments.isEmpty() || m_total < 0) {
        start();
        return;
    }
    setState(DownloadState::Downloading, QStringLiteral("resuming"));
    m_clock.start();
    m_lastTickBytes = m_done;
    m_lastTickMs = 0;
    m_speedTimer->start();
    launchSegments();
}

void DownloadTask::emitSpeedTick()
{
    const qint64 nowMs = m_clock.elapsed();
    const qint64 dMs = nowMs - m_lastTickMs;
    double bps = 0.0;
    if (dMs > 0)
        bps = double(m_done - m_lastTickBytes) * 1000.0 / double(dMs);
    m_lastTickMs = nowMs;
    m_lastTickBytes = m_done;
    emit progress(m_id, m_done, m_total, bps);

    // Persist segment offsets periodically so a crash/kill resumes from disk,
    // not from the start of each in-flight segment.
    persist();
}

void DownloadTask::setState(DownloadState s, const QString &detail)
{
    if (kDebug) {
        if (s == DownloadState::Probing)
            qDebug().noquote() << "NEXA BEGIN" << m_id;
        else if (s == DownloadState::Completed || s == DownloadState::Error)
            qDebug().noquote() << "NEXA END" << m_id;
    }
    m_state = s;
    emit stateChanged(m_id, s, detail);
}

void DownloadTask::persist()
{
    if (m_db)
        m_db->saveTask(*this, m_segments);
}

} // namespace nexa
