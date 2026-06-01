#include "core/SegmentDownloader.h"
#include "auth/AuthUtils.h"
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QByteArray>

namespace nexa {

SegmentDownloader::SegmentDownloader(const SegmentInfo &seg,
                                     const QUrl &url,
                                     const QString &filePath,
                                     const HeaderList &headers,
                                     QNetworkAccessManager *nam,
                                     QObject *parent)
    : QObject(parent), m_seg(seg), m_url(url), m_filePath(filePath),
      m_headers(headers) {
    // Each segment gets its OWN network manager. QNetworkAccessManager caps at
    // 6 simultaneous connections *per host*, so sharing one would throttle us to
    // 6 parallel segments. A dedicated manager per segment unlocks the full
    // 8–16 way parallelism that lets Nexa match/beat IDM. (nam is unused.)
    Q_UNUSED(nam);
    m_nam = new QNetworkAccessManager(this);
    m_file.setFileName(m_filePath);
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

    QNetworkRequest req(m_url);
    req.setHeader(QNetworkRequest::UserAgentHeader, QStringLiteral("Nexa/0.1"));
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::NoLessSafeRedirectPolicy);
    // Ask for raw, uncompressed bytes so the data we receive matches the byte
    // ranges/sizes exactly. Without this a server may gzip the response and we'd
    // see fewer bytes than the advertised length ("clean but short" finish).
    req.setRawHeader("Accept-Encoding", "identity");

    // Replay the browser-captured headers (cookies, UA, referrer, auth) so that
    // authenticated / CDN links are served instead of 403'd.
    for (const auto &h : m_headers)
        req.setRawHeader(h.first, h.second);

    // Request only the remaining bytes of this segment: start+done .. end (inclusive).
    const qint64 from = m_seg.start + m_seg.done;
    const QByteArray range = "bytes=" + QByteArray::number(from) + "-" + QByteArray::number(m_seg.end);
    req.setRawHeader("Range", range);

    m_reply = m_nam->get(req);
    connect(m_reply, &QNetworkReply::readyRead, this, &SegmentDownloader::onReadyRead);
    connect(m_reply, &QNetworkReply::finished, this, &SegmentDownloader::onFinished);
}

void SegmentDownloader::stop() {
    m_stopped = true;
    if (m_reply) {
        m_reply->abort();   // triggers onFinished with OperationCanceledError
    }
}

void SegmentDownloader::onReadyRead() {
    if (!m_reply)
        return;
    const QByteArray chunk = m_reply->readAll();
    if (chunk.isEmpty())
        return;

    // Never write past this segment's boundary (guards against servers that
    // ignore the Range header and stream the whole file).
    qint64 allowed = m_seg.length() - m_seg.done;
    qint64 toWrite = qMin<qint64>(chunk.size(), allowed);
    if (toWrite <= 0)
        return;

    const qint64 written = m_file.write(chunk.constData(), toWrite);
    if (written < 0) {
        emit failed(m_seg.index, QStringLiteral("write failed: %1").arg(m_file.errorString()));
        stop();
        return;
    }
    m_seg.done += written;
    emit progressed(m_seg.index, written);

    if (m_seg.complete() && m_reply) {
        // Got everything we need for this segment; stop early.
        m_reply->abort();
    }
}

void SegmentDownloader::onFinished() {
    if (!m_reply)
        return;
    const QNetworkReply::NetworkError err = m_reply->error();
    const QString errorString = m_reply->errorString();
    const int httpStatus = m_reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    m_reply->deleteLater();
    m_reply = nullptr;
    m_file.flush();

    if (m_seg.complete()) {
        emit completed(m_seg.index);
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
        // Requested Range Not Satisfiable: we've asked past the end of the file,
        // so there is nothing more to fetch — treat as a short (no-more-data) end.
        emit shortFinish(m_seg.index, m_seg.done);
        return;
    }
    if (err == QNetworkReply::NoError) {
        // Connection closed cleanly but we received fewer bytes than the range
        // we asked for. The server simply has no more data for us — let the task
        // decide whether to retry or finalize at the actual size.
        emit shortFinish(m_seg.index, m_seg.done);
        return;
    }
    emit failed(m_seg.index, errorString);
}

} // namespace nexa
