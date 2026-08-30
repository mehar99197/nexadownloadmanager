#pragma once
#include <QString>
#include <QVector>
#include <QSqlDatabase>
#include "core/Types.h"

namespace nexa {

class DownloadTask;

// A persisted download row plus its segment layout — enough to rebuild a
// DownloadTask and resume it after the app restarts.
struct TaskRecord {
    int                  id = 0;
    QString              url;
    QString              savePath;
    qint64               total = -1;
    DownloadState        state = DownloadState::Queued;
    bool                 rangesSupported = false;
    QString              etag;
    QString              lastModified;
    QVector<SegmentInfo> segments;
};

// A download the user asked to start at a future time (IDM-style scheduler).
// Survives restarts; headers/cookies are deliberately NOT persisted.
struct ScheduledRecord {
    int     id = 0;
    QString url;
    qint64  startAtMs = 0;   // epoch milliseconds
    QString name;            // optional suggested file name
};

// Thin SQLite persistence layer (history, queue, per-segment resume state).
class Database {
public:
    bool open(const QString &path);
    void close();

    int  nextId();                                  // monotonically increasing id
    void saveTask(const DownloadTask &task, const QVector<SegmentInfo> &segments);
    void removeTask(int id);
    QVector<TaskRecord> loadAll();

    // Delete completed downloads (and their segment rows) last touched more than
    // `olderThanDays` days ago; pass 0 to clear all completed history. Returns
    // the number of download rows removed. Surfaced via Settings.
    int  clearCompleted(int olderThanDays = 0);

    // Scheduled (not yet started) downloads.
    void saveScheduled(int id, const QString &url, qint64 startAtMs, const QString &name);
    void removeScheduled(int id);
    QVector<ScheduledRecord> loadScheduled();   // also bumps nextId() past their ids

private:
    void ensureSchema();
    void pruneOrphanSegments();   // drop segment rows with no parent download
    QSqlDatabase m_db;
    int          m_nextId = 1;
};

} // namespace nexa
