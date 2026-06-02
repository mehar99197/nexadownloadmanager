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
    QVector<SegmentInfo> segments;
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

private:
    void ensureSchema();
    void pruneOrphanSegments();   // drop segment rows with no parent download
    QSqlDatabase m_db;
    int          m_nextId = 1;
};

} // namespace nexa
