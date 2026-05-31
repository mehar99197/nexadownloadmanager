#pragma once
#include <QObject>
#include <QHash>
#include <QList>
#include <QUrl>
#include <QDateTime>
#include "core/Types.h"

class QNetworkAccessManager;

namespace nexa {

class DownloadTask;
class HlsGrabber;
class Database;

// Top-level controller: owns the network stack + database and manages the set
// of DownloadTasks. The UI talks only to this class.
class DownloadEngine : public QObject {
    Q_OBJECT
public:
    explicit DownloadEngine(QObject *parent = nullptr);
    ~DownloadEngine() override;

    // Returns the new task id, or -1 on bad input. `headers` carries the
    // browser-captured cookies/UA/referrer to replay on every request.
    int  addDownload(const QUrl &url,
                     const QString &savePath = QString(),
                     const HeaderList &headers = {});
    void pause(int id);
    void resume(int id);
    void remove(int id, bool deleteFile = false);

    // Batch add: accepts whitespace/newline-separated URLs and expands numeric
    // ranges like "http://x/file[1-20].jpg" into individual downloads.
    QList<int> addBatch(const QString &text, const HeaderList &headers = {});
    static QStringList expandPattern(const QString &token);

    // Schedule a download to start at a future time (IDM-style scheduler).
    int scheduleDownload(const QUrl &url, const QDateTime &when,
                         const HeaderList &headers = {});

    void setDownloadDir(const QString &dir) { m_downloadDir = dir; }
    QString downloadDir() const { return m_downloadDir; }

    // Max simultaneously-active file downloads; the rest wait Queued.
    void setMaxConcurrent(int n) { m_maxConcurrent = qMax(1, n); schedule(); }
    int  maxConcurrent() const { return m_maxConcurrent; }

    // Sort completed files into per-type subfolders (Video/, Audio/, ...).
    void setAutoCategorize(bool on) { m_autoCategorize = on; }
    bool autoCategorize() const { return m_autoCategorize; }
    static QString categoryFor(const QString &fileName);

    DownloadTask *task(int id) const { return m_tasks.value(id, nullptr); }
    QList<DownloadTask*> tasks() const { return m_tasks.values(); }

    // Unified accessors that work for both file downloads and stream grabs.
    QString       nameOf(int id) const;
    DownloadState stateOf(int id) const;

    // True when at least one job exists and all (downloads + grabs) are done
    // or errored — used by --batch mode to know when to exit.
    bool allTerminal() const;

    // Rebuild unfinished tasks from the database (call once at startup).
    void loadPersisted();

    // Resume every restored task that isn't finished yet (IDM-style).
    void resumeUnfinished();

signals:
    void taskAdded(int id);
    void taskProgress(int id, qint64 done, qint64 total, double bytesPerSec);
    void taskStateChanged(int id, nexa::DownloadState state, const QString &detail);
    void taskFinished(int id);
    void taskRemoved(int id);

private:
    QString resolveSavePath(const QUrl &url, const QString &savePath) const;
    void    wireTask(DownloadTask *t);
    void    schedule();              // start queued tasks up to m_maxConcurrent
    int     activeCount() const;     // tasks currently Probing/Downloading

    QNetworkAccessManager *m_nam = nullptr;
    Database              *m_db = nullptr;
    QHash<int, DownloadTask*> m_tasks;
    QHash<int, HlsGrabber*>   m_grabbers;
    QList<int>             m_pending;        // FIFO of ids waiting for a slot
    QString                m_downloadDir;
    int                    m_maxConcurrent = 4;
    bool                   m_autoCategorize = true;
    bool                   m_inSchedule = false;
};

} // namespace nexa
