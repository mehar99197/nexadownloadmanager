#include "core/DownloadTask.h"
#include "core/SegmentDownloader.h"
#include "core/Database.h"
#include "auth/AuthUtils.h"

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

// Headers that carry the user's site credentials. These must NEVER be sent to a
// host other than the one they were captured for (a cross-host redirect to a CDN
// or third party would otherwise leak the session cookie / bearer token).
static bool isSensitiveHeader(const QByteArray &name)
{
    const QByteArray l = name.toLower();
    return l == "cookie" || l == "authorization";
}

// Apply the captured headers to `req`, dropping the sensitive ones unless the
// request targets the credential host (so cookies/tokens stay scoped to it).
static void applyScopedHeaders(QNetworkRequest &req, const HeaderList &headers,
                               const QString &credHost)
{
    const bool sameHost = credHost.isEmpty() || req.url().host() == credHost;
    for (const auto &h : headers) {
        if (!sameHost && isSensitiveHeader(h.first))
            continue;
        req.setRawHeader(h.first, h.second);
    }
}

// Extract a filename from a Content-Disposition header, handling both the plain
// `filename="x"` form and the RFC 5987 `filename*=UTF-8''x` (percent-encoded)
// form. Returns a sanitised basename, or empty if none. Public static so the
// engine's pre-download name probe can reuse it.
QString DownloadTask::filenameFromContentDisposition(const QByteArray &header)
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
        QNetworkReply *p = m_probe;
        m_probe = nullptr;
        p->disconnect(this);     // never re-enter a slot on a half-destroyed task
        p->abort();
        p->deleteLater();
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

// Choose how many parallel connections to use, scaling with file size up to 32.
int DownloadTask::preferredSegmentCount(qint64 totalBytes)
{
    if (totalBytes <= 0)                  return 1;
    if (totalBytes < 1 * 1024 * 1024)     return 1;    // < 1 MB: not worth splitting
    if (totalBytes < 10 * 1024 * 1024)    return 8;    // 1–10 MB
    if (totalBytes < 100 * 1024 * 1024)   return 16;   // 10–100 MB
    return 32;                                          // ≥ 100 MB: max acceleration
}

void DownloadTask::start()
{
    if (m_state == DownloadState::Downloading || m_state == DownloadState::Probing)
        return;

    setState(DownloadState::Probing, QStringLiteral("contacting server"));

    // The captured cookies/tokens belong to THIS host; we follow redirects
    // manually (onProbeFinished) so they can be stripped before a cross-host hop.
    m_credHost = m_url.host();
    m_probeRedirects = 0;

    QNetworkRequest req(m_url);
    req.setHeader(QNetworkRequest::UserAgentHeader, QStringLiteral("Nexa/0.1"));
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::ManualRedirectPolicy);
    req.setRawHeader("Accept-Encoding", "identity");
    applyScopedHeaders(req, m_headers, m_credHost);
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

    const int status = r->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();

    // Follow redirects MANUALLY so we can drop the site cookie/bearer before
    // sending the probe to a different host (Qt's auto-redirect would re-send
    // them, leaking credentials to the CDN/third party).
    if (status >= 300 && status < 400) {
        const QByteArray loc = r->rawHeader("Location");
        const QUrl target = loc.isEmpty() ? QUrl()
                                          : r->url().resolved(QUrl::fromEncoded(loc));
        if (target.isValid() && m_probeRedirects < 8) {
            ++m_probeRedirects;
            m_url = target;                       // the download follows the chain
            QNetworkRequest req(m_url);
            req.setHeader(QNetworkRequest::UserAgentHeader, QStringLiteral("Nexa/0.1"));
            req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                             QNetworkRequest::ManualRedirectPolicy);
            req.setRawHeader("Accept-Encoding", "identity");
            applyScopedHeaders(req, m_headers, m_credHost);   // strips creds if cross-host
            req.setRawHeader("Range", "bytes=0-0");
            m_probe = m_nam->get(req);
            connect(m_probe, &QNetworkReply::finished, this, &DownloadTask::onProbeFinished);
            return;
        }
        setState(DownloadState::Error, QStringLiteral("too many redirects"));
        return;
    }

    if (authIsStatus(status)) {
        // 401/403 on the size probe: surface the auth-specific reason immediately
        // instead of falling through to range parsing on an error page.
        setState(DownloadState::Error, authErrorDetail(status));
        return;
    }
    // Any other 4xx/5xx is a dead/blocked/rate-limited link, NOT a file. Without
    // this guard a 404/500 HTML error page (which carries a Content-Length) would
    // be parsed for size and written to disk as the user's file — silent
    // corruption for every broken link. Only an HTTP reply has a status; a 0
    // status (e.g. ftp/file) is left to the size-parsing path below.
    if (status >= 400) {
        setState(DownloadState::Error,
                 QStringLiteral("server returned HTTP %1").arg(status));
        return;
    }
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

void DownloadTask::restore(qint64 totalBytes, const QVector<SegmentInfo> &segments,
                           bool rangesSupported)
{
    m_total = totalBytes;
    m_segments = segments;
    // Use the persisted capability; fall back to the old segment-count heuristic
    // for rows written before the ranges_supported column existed (default 0).
    m_rangesSupported = rangesSupported || segments.size() > 1;
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
        makeWorker(seg);
        ++m_activeSegments;
    }
    for (auto *w : m_workers)
        w->start();

    if (m_activeSegments == 0)
        checkAllComplete();
}

SegmentDownloader *DownloadTask::makeWorker(const SegmentInfo &seg)
{
    // After redirects m_url may point at a different host than the one the
    // cookies/tokens were captured for; strip those sensitive headers so the bulk
    // segment requests never replay the site credential to a cross-host CDN.
    HeaderList workerHeaders;
    workerHeaders.reserve(m_headers.size());
    const bool sameHost = m_credHost.isEmpty() || m_url.host() == m_credHost;
    for (const auto &h : m_headers)
        if (sameHost || !isSensitiveHeader(h.first))
            workerHeaders.append(h);
    auto *w = new SegmentDownloader(seg, m_url, m_savePath, workerHeaders, m_nam, m_limiter, this);
    connect(w, &SegmentDownloader::progressed,  this, &DownloadTask::onSegmentProgressed);
    connect(w, &SegmentDownloader::completed,   this, &DownloadTask::onSegmentCompleted);
    connect(w, &SegmentDownloader::failed,      this, &DownloadTask::onSegmentFailed);
    connect(w, &SegmentDownloader::shortFinish, this, &DownloadTask::onSegmentShortFinish);
    m_workers.append(w);
    return w;
}

// Dynamic re-segmentation (work-stealing): a connection that just finished its
// segment grabs the SECOND HALF of whichever active segment has the most bytes
// still to fetch. The donor is shrunk to stop at the split point and the freed
// connection downloads the tail — so all connections stay busy until the very
// end instead of trickling down to one slow stream. This is the IDM-style trick
// that keeps the aggregate speed high through the tail of a download.
bool DownloadTask::tryResegment()
{
    // Only meaningful for a real multi-range download with a known size.
    if (!m_dynamicResegment || !m_rangesSupported || m_total <= 0)
        return false;

    // Pick the active worker with the largest un-fetched remainder.
    SegmentDownloader *donor = nullptr;
    int    donorIdx = -1;
    qint64 best = 0, donorPos = 0;
    for (auto *w : m_workers) {
        const int si = w->index();
        if (si < 0 || si >= m_segments.size() || m_segments[si].complete())
            continue;
        const qint64 pos = m_segments[si].start + w->bytesDone();   // next byte it will write
        const qint64 remaining = m_segments[si].end - pos + 1;
        if (remaining > best) { best = remaining; donor = w; donorIdx = si; donorPos = pos; }
    }

    // Not worth splitting a small remainder (the overhead/extra connection costs
    // more than it saves once the tail is tiny).
    static const qint64 kMinSplit = 4 * 1024 * 1024;   // 4 MB
    if (!donor || best < kMinSplit)
        return false;

    const qint64 oldEnd = m_segments[donorIdx].end;
    const qint64 mid    = donorPos + (oldEnd - donorPos + 1) / 2;   // first byte of the tail
    if (mid <= donorPos || mid > oldEnd)                            // safety: keep ranges valid
        return false;

    // Shrink the donor to [start, mid-1]; it stops there. The freed connection
    // fetches the tail [mid, oldEnd] — contiguous, non-overlapping, no gap.
    m_segments[donorIdx].end = mid - 1;
    donor->setEnd(mid - 1);

    SegmentInfo tail;
    tail.index = m_segments.size();
    tail.start = mid;
    tail.end   = oldEnd;
    tail.done  = 0;
    m_segments.append(tail);
    makeWorker(tail)->start();

    if (kDebug)
        qDebug().noquote() << "NEXA RESEG" << m_id << "split seg" << donorIdx
                           << "@" << mid << "-> seg" << tail.index
                           << "(" << (oldEnd - mid + 1) << "B)";
    return true;
}

void DownloadTask::clearSegments()
{
    // Take a copy and clear the member FIRST. stop() can make a worker emit
    // completed/failed synchronously, which re-enters onSegmentCompleted ->
    // tryResegment() -> makeWorker() -> m_workers.append(); appending while a
    // range-for iterates m_workers reallocates the vector and invalidates the
    // loop pointer (a use-after-free crash on Remove/pause of an active task).
    // Disconnecting first stops those callbacks from re-entering at all.
    const QVector<SegmentDownloader*> workers = m_workers;
    m_workers.clear();
    for (auto *w : workers) {
        w->disconnect(this);
        w->stop();
        w->deleteLater();
    }
}

void DownloadTask::onSegmentProgressed(int index, qint64 delta)
{
    m_done += delta;
    if (index >= 0 && index < m_segments.size())
        m_segments[index].done += delta;
    // Forward progress means this connection is healthy again: clear its retry
    // budget so only *consecutive* failures (no progress between them) count
    // toward the give-up limit, rather than failures accumulated over the whole
    // download. (Also stops the short-read and network-error paths, which share
    // m_retries, from starving each other.)
    if (delta > 0 && m_retries.contains(index))
        m_retries.remove(index);
}

void DownloadTask::onSegmentCompleted(int index)
{
    if (index >= 0 && index < m_segments.size())
        m_segments[index].done = m_segments[index].length();
    ++m_completedSegments;
    // The connection is now free — instead of going idle, steal the tail of the
    // largest remaining segment so throughput stays high through the end.
    if (m_state == DownloadState::Downloading)
        tryResegment();
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
    // A zero-byte "short finish" is a failure, not a success: the server sent no
    // body. Don't silently leave a 0-byte file marked Completed.
    if (totalReceived <= 0) {
        clearSegments();
        setState(DownloadState::Error, QStringLiteral("server returned no data"));
        return;
    }
    clearSegments();
    // Trim the pre-allocated file down to what we actually received.
    QFile f(m_savePath);
    if (f.open(QIODevice::ReadWrite))
        f.resize(totalReceived);
    f.close();
    m_total = totalReceived;
    m_done  = totalReceived;   // keep done==total so cached progress stays consistent
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
        // abort() can fire finished() SYNCHRONOUSLY, re-entering onProbeFinished
        // which nulls m_probe — then the old code dereferenced a now-null m_probe
        // (crash on Remove/pause of a still-probing task). Null + disconnect FIRST.
        QNetworkReply *p = m_probe;
        m_probe = nullptr;
        p->disconnect(this);
        p->abort();
        p->deleteLater();
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

    // Validate the partial file still matches our segment offsets. If it was
    // deleted / moved / truncated between sessions, the SegmentDownloader would
    // seek() past EOF on a freshly-created empty file, leaving the unfetched
    // leading bytes as zero-filled holes — a silently corrupt "completed" file.
    // When the file no longer backs our progress, reset and re-probe instead.
    {
        const QFileInfo fi(m_savePath);
        const bool fileBacksProgress =
            fi.exists()
            && (m_total <= 0 || fi.size() >= m_total)   // preallocated to full size
            && fi.size() >= m_done;                     // holds at least our claimed bytes
        if (!fileBacksProgress) {
            for (auto &s : m_segments) s.done = 0;
            m_done = 0;
            m_segments.clear();                         // force a clean re-probe + prealloc
            persist();
            start();
            return;
        }
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
    // not from the start of each in-flight segment. The speed tick fires every
    // 500 ms but a DB save every 500 ms is wasteful, so throttle to every 4th
    // tick (~2 s). Segment completions and state changes still persist
    // immediately, so nothing important waits on this cadence.
    if (++m_ticksSincePersist >= 4) {
        m_ticksSincePersist = 0;
        persist();
    }
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
