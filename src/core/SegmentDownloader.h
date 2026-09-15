#pragma once
#include <QObject>
#include <QUrl>
#include <QFile>
#include <QNetworkRequest>
#include "core/Types.h"

class QNetworkAccessManager;
class QNetworkReply;

namespace nexa {

class RateLimiter;

// Downloads a single byte-range of a file and writes it directly into the
// destination file at the correct offset. Multiple SegmentDownloaders run
// concurrently on the same Qt event loop (async network I/O = real parallelism
// without threads).
class SegmentDownloader : public QObject {
    Q_OBJECT
public:
    SegmentDownloader(const SegmentInfo &seg,
                      const QUrl &url,
                      const QString &filePath,
                      const HeaderList &headers,
                      QNetworkAccessManager *nam,
                      RateLimiter *limiter = nullptr,
                      QObject *parent = nullptr);
    ~SegmentDownloader() override;

    void start();              // begins / resumes from seg.done
    void stop();               // aborts the in-flight request (keeps bytes done)
    void setPublicNetworkOnly(bool on) { m_publicNetworkOnly = on; }

    // Optional SECOND limiter scoped to this download alone. Reads are granted
    // by whichever of the two budgets is tighter, so a per-download cap and the
    // global cap compose instead of overriding each other. Null = only global.
    void setTaskRateLimiter(RateLimiter *limiter);
    void setIfRangeValidator(const QString &validator) { m_ifRangeValidator = validator; }

    // Shrink this segment's end (dynamic re-segmentation): the worker then stops
    // at the new boundary so a freed connection can take the tail. Only ever
    // moved EARLIER, and only ahead of the current write position.
    void setEnd(qint64 newEnd);

    int    index()     const { return m_seg.index; }
    qint64 bytesDone() const { return m_seg.done; }
    qint64 length()    const { return m_seg.length(); }
    bool   isComplete()const { return m_seg.complete(); }

signals:
    void progressed(int index, qint64 deltaBytes);   // emitted as bytes arrive
    void completed(int index);
    void failed(int index, const QString &error);    // real (retryable) error
    // The If-Range validator no longer matches (or the server restarted the
    // object from byte zero): the bytes already on disk belong to a different
    // file. Not retryable — the whole download must start over.
    void objectChanged(int index);
    void shortFinish(int index, qint64 received);     // clean close, fewer bytes than asked
    void sizeDiscovered(qint64 total, bool rangesSupported);  // real size (+ Range support) from live headers

private slots:
    void onReadyRead();
    void onFinished();
    void onMetaData();   // parse Content-Range/Content-Length once the headers land

private:
    void pump();   // read what the rate limiter allows, write it, repeat
    QString responseValidationError() const;

    SegmentInfo             m_seg;
    QUrl                    m_url;
    QString                 m_filePath;
    HeaderList              m_headers;
    QNetworkAccessManager  *m_nam = nullptr;
    RateLimiter            *m_limiter = nullptr;       // global (engine-owned)
    RateLimiter            *m_taskLimiter = nullptr;   // this download only
    QNetworkReply          *m_reply = nullptr;
    QFile                   m_file;
    bool                    m_stopped = false;
    bool                    m_announcedSize = false;   // sizeDiscovered() emitted once
    bool                    m_publicNetworkOnly = false;
    QString                 m_ifRangeValidator;
    bool                    m_validatorMismatch = false;
    qint64                  m_requestStart = 0;
    qint64                  m_requestEnd = 0;
    bool                    m_openEndedRequest = false;
    QString                 m_responseError;
    int                     m_redirects = 0;
};

} // namespace nexa
