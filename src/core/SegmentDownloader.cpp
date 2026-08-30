#include "core/SegmentDownloader.h"
#include "core/RateLimiter.h"
#include "auth/AuthUtils.h"
#include "web/PublicUrlPolicy.h"
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QByteArray>
#include <QRegularExpression>

namespace nexa {

static bool parseContentRange(const QByteArray &raw, qint64 *start, qint64 *end,
                              qint64 *total)
{
    static const QRegularExpression re(
        QStringLiteral("\\Abytes\\s+(\\d+)-(\\d+)/(\\d+|\\*)\\z"),
        QRegularExpression::CaseInsensitiveOption);
    const auto match = re.match(QString::fromLatin1(raw).trimmed());
    if (!match.hasMatch())
        return false;

    bool okStart = false, okEnd = false, okTotal = true;
    const qint64 parsedStart = match.captured(1).toLongLong(&okStart);
    const qint64 parsedEnd = match.captured(2).toLongLong(&okEnd);
    const qint64 parsedTotal = match.captured(3) == QLatin1String("*")
        ? -1 : match.captured(3).toLongLong(&okTotal);
    if (!okStart || !okEnd || !okTotal || parsedEnd < parsedStart)
        return false;
    if (start) *start = parsedStart;
    if (end)   *end = parsedEnd;
    if (total) *total = parsedTotal;
    return true;
}

SegmentDownloader::SegmentDownloader(const SegmentInfo &seg,
                                     const QUrl &url,
                                     const QString &filePath,
                                     const HeaderList &headers,
                                     QNetworkAccessManager *nam,
                                     RateLimiter *limiter,
                                     QObject *parent)
    : QObject(parent), m_seg(seg), m_url(url), m_filePath(filePath),
      m_headers(headers), m_limiter(limiter) {
    // Each segment gets its OWN network manager. QNetworkAccessManager caps at
    // 6 simultaneous connections *per host*, so sharing one would throttle us to
    // 6 parallel segments. A dedicated manager per segment unlocks the full
    // 8–16 way parallelism that lets Nexa match/beat IDM. (nam is unused.)
    Q_UNUSED(nam);
    m_nam = new QNetworkAccessManager(this);
    m_file.setFileName(m_filePath);
    // While a global speed limit is active, the limiter wakes us ~20×/s so we
    // can drain bytes we had to leave buffered when the token budget ran dry.
    if (m_limiter) {
        connect(m_limiter, &RateLimiter::replenished, this, &SegmentDownloader::pump);
        // If the limit is toggled mid-download, (un)bound the socket read buffer
        // on the in-flight reply so backpressure is applied/relaxed immediately
        // (otherwise an unbounded buffer would keep filling at full line speed).
        connect(m_limiter, &RateLimiter::limitedChanged, this, [this](bool limited) {
            if (m_reply)
                m_reply->setReadBufferSize(limited ? (2 * 1024 * 1024) : 0);
            if (limited)
                pump();
        });
    }
}

SegmentDownloader::~SegmentDownloader() {
    if (m_reply) {
        m_reply->abort();
        m_reply->deleteLater();
    }
    if (m_file.isOpen())
        m_file.close();
}

void SegmentDownloader::start() {
    m_stopped = false;
    m_responseError.clear();
    if (m_seg.complete()) {
        emit completed(m_seg.index);
        return;
    }

    // The destination file is pre-allocated by DownloadTask; open it shared and
    // seek to where this segment should resume writing.
    if (!m_file.isOpen()) {
        if (!m_file.open(QIODevice::ReadWrite)) {
            emit failed(m_seg.index, QStringLiteral("cannot open file: %1").arg(m_file.errorString()));
            return;
        }
    }
    if (!m_file.seek(m_seg.start + m_seg.done)) {
        emit failed(m_seg.index, QStringLiteral("seek failed: %1").arg(m_file.errorString()));
        return;
    }

    if (m_publicNetworkOnly && !isPublicHttpUrl(m_url)) {
        emit failed(m_seg.index, QStringLiteral("remote dashboard target is not a public HTTP(S) address"));
        return;
    }

    QNetworkRequest req(m_url);
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::ManualRedirectPolicy);
    if (m_url.host().endsWith(QStringLiteral("google.com"), Qt::CaseInsensitive))
        req.setAttribute(QNetworkRequest::Http2AllowedAttribute, false);
    // Ask for raw, uncompressed bytes so the data we receive matches the byte
    // ranges/sizes exactly. Without this a server may gzip the response and we'd
    // see fewer bytes than the advertised length ("clean but short" finish).
    req.setRawHeader("Accept-Encoding", "identity");
    if (!m_ifRangeValidator.isEmpty())
        req.setRawHeader("If-Range", m_ifRangeValidator.toUtf8());

    // Replay the browser-captured headers (cookies, UA, referrer, auth) so that
    // authenticated / CDN links are served instead of 403'd.
    // Match the probe's deterministic header order: browser metadata first,
    // then the request-scoped credentials.
    for (const auto &h : m_headers) {
        const QByteArray name = h.first.toLower();
        if (name != QByteArrayLiteral("cookie") &&
            name != QByteArrayLiteral("authorization"))
            req.setRawHeader(h.first, h.second);
    }
    for (const auto &h : m_headers) {
        const QByteArray name = h.first.toLower();
        if (name == QByteArrayLiteral("cookie") ||
            name == QByteArrayLiteral("authorization"))
            req.setRawHeader(h.first, h.second);
    }
    if (req.rawHeader("User-Agent").isEmpty())
        req.setRawHeader("User-Agent", "Nexa/0.1");

    // Request only the remaining bytes of this segment: start+done .. end (inclusive).
    const qint64 from = m_seg.start + m_seg.done;
    m_requestStart = from;
    m_requestEnd = m_seg.end;
    m_openEndedRequest = m_requestEnd >= (qint64(1) << 61);
    const QByteArray range = "bytes=" + QByteArray::number(from) + "-" + QByteArray::number(m_seg.end);
    req.setRawHeader("Range", range);

    m_reply = m_nam->get(req);
    // When throttled, bound Qt's read buffer so that pausing our reads actually
    // applies TCP backpressure (the socket stops being drained, the sender slows)
    // instead of letting unread data pile up in memory at full line speed.
    // Unlimited downloads keep an unbounded buffer for maximum throughput.
    m_reply->setReadBufferSize((m_limiter && m_limiter->isLimited())
                                   || (m_taskLimiter && m_taskLimiter->isLimited())
                               ? (2 * 1024 * 1024) : 0);
    connect(m_reply, &QNetworkReply::metaDataChanged, this, &SegmentDownloader::onMetaData);
    connect(m_reply, &QNetworkReply::readyRead, this, &SegmentDownloader::onReadyRead);
    connect(m_reply, &QNetworkReply::finished, this, &SegmentDownloader::onFinished);
}

// The size probe (a bytes=0-0 request) often can't learn the total — Drive,
// GitHub artifacts and many AI-export endpoints answer it with a chunked or
// redirected response that carries no length. The LIVE download response usually
// DOES carry a Content-Range/Content-Length the probe never saw; surface it once
// so the task can show a real file size + ETA mid-flight. Status-gated so a 3xx
// redirect body's length is never mistaken for the file size.
void SegmentDownloader::onMetaData() {
    if (!m_reply)
        return;
    if (!m_stopped && m_responseError.isEmpty()) {
        m_responseError = responseValidationError();
        if (!m_responseError.isEmpty()) {
            m_reply->abort();
            return;
        }
    }
    const int status = m_reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    if (!m_ifRangeValidator.isEmpty() && (status == 200 || status == 206)) {
        const bool etagValidator = m_ifRangeValidator.startsWith(QLatin1Char('"'));
        const QString responseValidator = QString::fromUtf8(
            m_reply->rawHeader(etagValidator ? "ETag" : "Last-Modified")).trimmed();
        if ((m_seg.start + m_seg.done > 0 && status == 200) ||
            responseValidator.isEmpty() || responseValidator != m_ifRangeValidator) {
            m_validatorMismatch = true;
            m_reply->abort();
            return;
        }
    }
    if (m_announcedSize)
        return;
    qint64 total = -1;
    if (status == 206) {
        // 206 Partial Content -> "Content-Range: bytes from-to/TOTAL".
        const QByteArray cr = m_reply->rawHeader("Content-Range");
        const int slash = cr.indexOf('/');
        if (slash >= 0) {
            const QByteArray t = cr.mid(slash + 1).trimmed();
            if (t != "*")
                total = t.toLongLong();
        }
    } else if (status == 200 && m_seg.start + m_seg.done == 0) {
        // 200 = whole file in one stream; Content-Length is the full size, but
        // only trustworthy when we asked from byte 0 (a 200 to a ranged request
        // means the server restarted at 0 and is sending everything).
        const QVariant len = m_reply->header(QNetworkRequest::ContentLengthHeader);
        if (len.isValid())
            total = len.toLongLong();
    }
    if (total > 0) {
        m_announcedSize = true;
        // A 206 proves the server honours Range — i.e. the download is resumable,
        // even if the bytes=0-0 probe couldn't establish it.
        emit sizeDiscovered(total, status == 206);
    }
}

QString SegmentDownloader::responseValidationError() const
{
    if (!m_reply)
        return QString();
    const int status = m_reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    if (status == 0 || status >= 300)
        return QString(); // network/HTTP errors are handled by onFinished().

    if (m_requestStart > 0 && status != 206)
        return QStringLiteral("server ignored the byte-range resume request");

    if (status == 206) {
        qint64 start = -1, end = -1, total = -1;
        if (!parseContentRange(m_reply->rawHeader("Content-Range"), &start, &end, &total))
            return QStringLiteral("server returned an invalid Content-Range");
        if (start != m_requestStart || end < start || end > m_requestEnd)
            return QStringLiteral("server returned the wrong byte range");
        if (total >= 0 && m_requestEnd >= total)
            return QStringLiteral("server returned an out-of-bounds byte range");
        return QString();
    }

    // A 200 response is safe only when the request started at byte zero. If a
    // known-size segment receives the whole file, do not accept its prefix as
    // that segment: the server has ignored Range and the result would corrupt
    // the completed file.
    if (status == 200 && m_requestStart == 0) {
        const QVariant length = m_reply->header(QNetworkRequest::ContentLengthHeader);
        const qint64 requested = m_requestEnd - m_requestStart + 1;
        if (length.isValid() && length.toLongLong() > requested)
            return QStringLiteral("server ignored the byte-range request");
    }
    return QString();
}

void SegmentDownloader::stop() {
    m_stopped = true;
    if (m_reply) {
        m_reply->abort();   // triggers onFinished with OperationCanceledError
    }
}

void SegmentDownloader::setEnd(qint64 newEnd) {
    m_seg.end = newEnd;
    if (m_openEndedRequest)
        m_requestEnd = newEnd;
    // pump() caps writes at the (now smaller) segment length, so the worker will
    // stop on its own. If we've already fetched up to the new end, finish now.
    if (m_seg.complete() && m_reply)
        m_reply->abort();
}

void SegmentDownloader::onReadyRead() {
    pump();
}

void SegmentDownloader::setTaskRateLimiter(RateLimiter *limiter)
{
    if (m_taskLimiter == limiter)
        return;
    if (m_taskLimiter)
        disconnect(m_taskLimiter, nullptr, this, nullptr);
    m_taskLimiter = limiter;
    if (!m_taskLimiter)
        return;
    connect(m_taskLimiter, &RateLimiter::replenished, this, &SegmentDownloader::pump);
    connect(m_taskLimiter, &RateLimiter::limitedChanged, this, [this](bool limited) {
        if (m_reply)
            m_reply->setReadBufferSize(limited || (m_limiter && m_limiter->isLimited())
                                           ? (2 * 1024 * 1024) : 0);
        if (limited)
            pump();
    });
}

void SegmentDownloader::pump() {
    if (!m_reply || m_validatorMismatch)
        return;
    // ONLY a 200/206 body is the user's file. A 3xx redirect page, a 401/403 auth
    // page, a 404 and a 5xx all carry a body too, and QNetworkReply delivers it
    // through readyRead exactly like real payload — responseValidationError()
    // deliberately defers every status >= 300 to onFinished(), so without this
    // guard those bytes are written AT THE SEGMENT'S OFFSET and counted as
    // progress. That silently corrupts the output file, and once the advanced
    // offset is persisted it corrupts the resumed download as well. A status of 0
    // means a non-HTTP scheme (ftp/file), which has no status to check.
    if (const int status = m_reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        status != 0 && status != 200 && status != 206) {
        return;
    }
    // Drain as much as the rate limiter currently allows. Reading only the
    // granted amount (not readAll) leaves the rest buffered; replenished() calls
    // us again when more budget accrues. With no limiter, `granted == want` so
    // this is a straight readAll-equivalent at full speed.
    while (true) {
        const qint64 avail = m_reply->bytesAvailable();
        if (avail <= 0)
            break;
        // Never read past this segment's boundary (guards against servers that
        // ignore the Range header and stream the whole file).
        const qint64 segLeft = m_seg.length() - m_seg.done;
        if (segLeft <= 0)
            break;
        const qint64 want = qMin(avail, segLeft);
        // Both budgets must allow the read; the tighter one wins. Whatever the
        // looser limiter granted beyond that is handed straight back, so its
        // accounting stays accurate.
        qint64 granted = m_limiter ? m_limiter->consume(want) : want;
        if (granted > 0 && m_taskLimiter) {
            const qint64 perTask = m_taskLimiter->consume(granted);
            if (perTask < granted && m_limiter)
                m_limiter->refund(granted - perTask);
            granted = perTask;
        }
        if (granted <= 0)
            break;   // out of budget for now — replenished() will resume us

        const QByteArray chunk = m_reply->read(granted);
        if (chunk.isEmpty()) {
            // Nothing actually readable: give the whole reservation back.
            if (m_limiter) m_limiter->refund(granted);
            if (m_taskLimiter) m_taskLimiter->refund(granted);
            break;
        }
        if (chunk.size() < granted) {
            if (m_limiter)     m_limiter->refund(granted - chunk.size());
            if (m_taskLimiter) m_taskLimiter->refund(granted - chunk.size());
        }
        const qint64 written = m_file.write(chunk.constData(), chunk.size());
        if (written > 0) {
            m_seg.done += written;            // account for whatever actually landed
            emit progressed(m_seg.index, written);
        }
        if (written != chunk.size()) {
            // A short write (disk full) silently drops the unwritten tail of
            // `chunk`, which we've already consumed from the reply — that would be
            // an undetectable gap/corruption. Treat it as a (retryable) failure.
            emit failed(m_seg.index,
                written < 0 ? QStringLiteral("write failed: %1").arg(m_file.errorString())
                            : QStringLiteral("disk full (incomplete write)"));
            stop();
            return;
        }
    }

    if (m_seg.complete() && m_reply) {
        // Got everything we need for this segment; stop early.
        m_reply->abort();
    }
}

void SegmentDownloader::onFinished() {
    if (!m_reply)
        return;
    if (m_validatorMismatch) {
        m_reply->deleteLater();
        m_reply = nullptr;
        emit failed(m_seg.index, QStringLiteral("remote object changed during resume"));
        return;
    }
    if (!m_stopped && m_responseError.isEmpty())
        m_responseError = responseValidationError();
    if (!m_stopped && !m_responseError.isEmpty()) {
        const QString error = m_responseError;
        m_reply->deleteLater();
        m_reply = nullptr;
        emit failed(m_seg.index, error);
        return;
    }
    const int httpStatus = m_reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    if (!m_stopped && httpStatus >= 300 && httpStatus < 400) {
        const QByteArray location = m_reply->rawHeader("Location");
        const QUrl target = location.isEmpty() ? QUrl()
            : m_reply->url().resolved(QUrl::fromEncoded(location));
        const QString scheme = target.scheme().toLower();
        const bool sameHost = target.host().compare(m_url.host(), Qt::CaseInsensitive) == 0;
        const bool downgrade = m_url.scheme().compare(QStringLiteral("https"),
                                                       Qt::CaseInsensitive) == 0
                            && scheme == QLatin1String("http");
        if (++m_redirects > 8 || !target.isValid() || !sameHost || downgrade ||
            (scheme != QLatin1String("http") && scheme != QLatin1String("https")) ||
            (m_publicNetworkOnly && !isPublicHttpUrl(target))) {
            m_reply->deleteLater();
            m_reply = nullptr;
            emit failed(m_seg.index, QStringLiteral("unsafe or looping range redirect"));
            return;
        }
        m_url = target;
        m_reply->deleteLater();
        m_reply = nullptr;
        // Keep the segment offset and retry the same range on the validated
        // same-origin target. m_redirects is intentionally preserved across
        // this restart so redirect loops are bounded.
        start();
        return;
    }
    // Final drain: write any bytes still buffered (left unread under the rate
    // limit when the token budget ran out). They're already downloaded, so
    // writing them now doesn't violate the cap — and it prevents a throttled
    // transfer from looking "short" below and being wrongly truncated/retried.
    // Status-gated for the same reason pump() is: this drain runs BEFORE the
    // 401/403/416 classification below, so an unguarded drain writes the error
    // page into the output file and counts it as progress.
    const bool bodyIsPayload = (httpStatus == 0 || httpStatus == 200 || httpStatus == 206);
    while (bodyIsPayload && m_reply->bytesAvailable() > 0) {
        const qint64 segLeft = m_seg.length() - m_seg.done;
        if (segLeft <= 0)
            break;
        const QByteArray chunk = m_reply->read(qMin(m_reply->bytesAvailable(), segLeft));
        if (chunk.isEmpty())
            break;
        const qint64 w = m_file.write(chunk.constData(), chunk.size());
        if (w > 0) {
            m_seg.done += w;
            emit progressed(m_seg.index, w);
        }
        if (w != chunk.size())
            break;   // short write (disk full): leave the segment incomplete -> retried
    }
    const QNetworkReply::NetworkError err = m_reply->error();
    const QString errorString = m_reply->errorString();
    m_reply->deleteLater();
    m_reply = nullptr;
    m_file.flush();

    if (m_seg.complete()) {
        emit completed(m_seg.index);
        return;
    }
    if (m_publicNetworkOnly && httpStatus >= 300 && httpStatus < 400) {
        emit failed(m_seg.index, QStringLiteral("late redirect blocked for remote dashboard download"));
        return;
    }
    if (m_stopped || err == QNetworkReply::OperationCanceledError) {
        // Intentional pause/abort — keep m_seg.done for resume, stay silent.
        return;
    }
    if (authIsStatus(httpStatus)) {
        // 401/403: credentials missing/expired. Surface a precise auth reason
        // (routes to DownloadTask::onSegmentFailed -> Error). Retrying won't help.
        emit failed(m_seg.index, authErrorDetail(httpStatus));
        return;
    }
    if (httpStatus == 416) {
        // A 416 means the remote object no longer matches the persisted range.
        // Treating it as EOF could mark an old prefix as a valid completed file.
        emit failed(m_seg.index, QStringLiteral("requested range is no longer satisfiable"));
        return;
    }
    if (err == QNetworkReply::NoError) {
        // Only an open-ended segment (unknown total) may use a clean short read
        // as EOF. A known-size range ending early indicates object drift or a
        // broken server; retry it, but never finalize a truncated prefix.
        if (m_openEndedRequest)
            emit shortFinish(m_seg.index, m_seg.done);
        else
            emit failed(m_seg.index, QStringLiteral("server closed before the requested range ended"));
        return;
    }
    emit failed(m_seg.index, errorString);
}

} // namespace nexa
