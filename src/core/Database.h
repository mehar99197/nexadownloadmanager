#pragma once
#include <QString>
#include <QVector>
#include <QSqlDatabase>
#include "core/Categories.h"
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
    int                  categoryId = 0;   // 0 = none recorded (pre-categories row)
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

    // Download categories. The table is seeded with CategoryStore::defaults()
    // the first time it is created, so an existing install keeps landing files
    // in the same Video/ and Audio/ folders it always has.
    QVector<Category> loadCategories();
    // Inserts when `cat.id` is 0 and writes the assigned id back; updates
    // otherwise. Returns false and leaves `cat` alone on failure.
    bool saveCategory(Category &cat);
    // Deletes a category and clears it off every download that referenced it.
    // SQLite does not enforce the foreign key by default, so doing this in one
    // transaction is what keeps a deleted id from lingering on old rows.
    bool removeCategory(int id);
    // Persist the whole visible order in one transaction (drag-to-reorder).
    bool saveCategoryOrder(const QVector<Category> &ordered);
    void setTaskCategory(int downloadId, int categoryId);

private:
    void ensureSchema();
    void seedCategoriesIfEmpty();
    void pruneOrphanSegments();   // drop segment rows with no parent download
    QSqlDatabase m_db;
    int          m_nextId = 1;
};

} // namespace nexa
