#pragma once
#include <QObject>
#include <QUrl>
#include <QString>
#include <QVector>
#include <QHash>
#include <QElapsedTimer>
#include <functional>
#include "core/Types.h"

class QNetworkAccessManager;
class QNetworkReply;
class QTimer;

namespace nexa {

class SegmentDownloader;
class Database;
class RateLimiter;

// Represents one download: probes the server, splits the file into byte-range
// segments, runs them concurrently, tracks progress/speed, and supports
// pause/resume with on-disk persistence.
class DownloadTask : public QObject {
    Q_OBJECT
public:
    DownloadTask(int id,
                 const QUrl &url,
                 const QString &savePath,
                 QNetworkAccessManager *nam,
                 Database *db,
                 QObject *parent = nullptr);

    void setHeaders(const HeaderList &headers) { m_headers = headers; }
    HeaderList headers() const { return m_headers; }

    // Shared global rate limiter (owned by the engine). When set, each segment
    // throttles its reads against it. Null = unlimited.
    void setRateLimiter(RateLimiter *limiter) { m_limiter = limiter; }

    // Dynamic re-segmentation (work-stealing): when a connection finishes its
    // segment, it splits the largest remaining segment and takes the tail, so no
    // connection idles near the end. On by default (the IDM-style speed-up).
    void setDynamicResegment(bool on) { m_dynamicResegment = on; }

    // Given a server-provided filename, returns the full path to save to
    // (categorised + de-duplicated). Set by the engine; used when a
    // Content-Disposition header reveals the real filename.
    void setNameResolver(std::function<QString(const QString &)> resolver)
    { m_nameResolver = std::move(resolver); }

    // Rename the completed file (keeps the directory). Returns false on failure.
    bool renameTo(const QString &newFileName);
    ~DownloadTask() override;

    void start();
    void pause();
    void resume();

    // Restore an interrupted task's segment layout from the database.
    void restore(qint64 totalBytes, const QVector<SegmentInfo> &segments);

    int            id()         const { return m_id; }
    QUrl           url()        const { return m_url; }
    QString        savePath()   const { return m_savePath; }
    QString        fileName()   const;
    qint64         totalBytes() const { return m_total; }
    qint64         doneBytes()  const { return m_done; }
    DownloadState  state()      const { return m_state; }

    // Live read of the per-connection byte ranges, for the details window. Safe
    // only because the engine + segment workers run single-threaded on the GUI
    // event loop (no worker threads); snapshot if that ever changes.
    const QVector<SegmentInfo>& segments() const { return m_segments; }
    bool           rangesSupported() const { return m_rangesSupported; }

    static int preferredSegmentCount(qint64 totalBytes);

signals:
    void progress(int id, qint64 done, qint64 total, double bytesPerSec);
    void stateChanged(int id, DownloadState state, const QString &detail);
    void finished(int id);
    void renamedTo(const QString &fileName);    // server-provided name applied

private slots:
    void onProbeFinished();
    void onSegmentProgressed(int index, qint64 delta);
    void onSegmentCompleted(int index);
    void onSegmentFailed(int index, const QString &error);
    void onSegmentShortFinish(int index, qint64 received);
    void emitSpeedTick();

private:
    void setState(DownloadState s, const QString &detail = QString());
    bool preallocateFile();
    void buildSegments(qint64 total, bool rangesSupported);
    void launchSegments();
    void clearSegments();
    SegmentDownloader *makeWorker(const SegmentInfo &seg);   // create + wire + track
    bool tryResegment();          // split the largest remaining segment, steal its tail
    void persist();
    void checkAllComplete();
    void retrySegment(int index, const QString &reason);  // resume a failed segment
    void finalizeShort(qint64 totalReceived);             // accept actual size, truncate

    int                       m_id;
    QUrl                      m_url;
    QString                   m_savePath;
    QNetworkAccessManager    *m_nam = nullptr;
    Database                 *m_db = nullptr;
    RateLimiter              *m_limiter = nullptr;

    HeaderList                m_headers;
    qint64                    m_total = -1;     // -1 = unknown
    qint64                    m_done = 0;
    DownloadState             m_state = DownloadState::Queued;
    bool                      m_rangesSupported = false;
    bool                      m_dynamicResegment = true;   // work-stealing on by default

    QNetworkReply            *m_probe = nullptr;
    QVector<SegmentInfo>      m_segments;
    QVector<SegmentDownloader*> m_workers;
    int                       m_completedSegments = 0;
    int                       m_activeSegments = 0;
    QHash<int, int>           m_retries;        // per-segment retry attempts
    std::function<QString(const QString &)> m_nameResolver;
    static constexpr int      kMaxRetries = 5;

    // Speed measurement
    QTimer                   *m_speedTimer = nullptr;
    QElapsedTimer             m_clock;
    qint64                    m_lastTickBytes = 0;
    qint64                    m_lastTickMs = 0;
    int                       m_ticksSincePersist = 0;   // throttle periodic DB saves
};

} // namespace nexa
