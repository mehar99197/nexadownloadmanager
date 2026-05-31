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

private:
    void ensureSchema();
    QSqlDatabase m_db;
    int          m_nextId = 1;
};

} // namespace nexa
