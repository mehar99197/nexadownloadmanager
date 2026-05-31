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
#include <algorithm>

namespace nexa {

static const bool kDebug = qEnvironmentVariableIsSet("NEXA_DEBUG");

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
        connect(w, &SegmentDownloader::progressed, this, &DownloadTask::onSegmentProgressed);
        connect(w, &SegmentDownloader::completed,  this, &DownloadTask::onSegmentCompleted);
        connect(w, &SegmentDownloader::failed,     this, &DownloadTask::onSegmentFailed);
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
    m_speedTimer->stop();
    clearSegments();
    persist();
    setState(DownloadState::Error,
             QStringLiteral("segment %1: %2").arg(index).arg(error));
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
