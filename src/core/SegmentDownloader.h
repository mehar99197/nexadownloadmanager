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
    void shortFinish(int index, qint64 received);     // clean close, fewer bytes than asked
    void sizeDiscovered(qint64 total, bool rangesSupported);  // real size (+ Range support) from live headers

private slots:
    void onReadyRead();
    void onFinished();
    void onMetaData();   // parse Content-Range/Content-Length once the headers land

private:
    void pump();   // read what the rate limiter allows, write it, repeat

    SegmentInfo             m_seg;
    QUrl                    m_url;
    QString                 m_filePath;
    HeaderList              m_headers;
    QNetworkAccessManager  *m_nam = nullptr;
    RateLimiter            *m_limiter = nullptr;
    QNetworkReply          *m_reply = nullptr;
    QFile                   m_file;
    bool                    m_stopped = false;
    bool                    m_announcedSize = false;   // sizeDiscovered() emitted once
};

} // namespace nexa
