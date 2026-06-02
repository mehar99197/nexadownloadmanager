#include "core/Database.h"
#include "core/DownloadTask.h"

#include <QSqlQuery>
#include <QSqlError>
#include <QVariant>
#include <QFileInfo>
#include <QDir>
#include <QDateTime>
#include <QDebug>
#include <limits>

namespace nexa {

bool Database::open(const QString &path)
{
    QDir().mkpath(QFileInfo(path).absolutePath());
    m_db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), QStringLiteral("nexa-main"));
    m_db.setDatabaseName(path);
    if (!m_db.open()) {
        qWarning() << "Nexa DB open failed:" << m_db.lastError().text();
        return false;
    }

    // WAL + relaxed sync: progress is persisted every ~2 s on the GUI thread, so
    // we trade the default fsync-per-commit durability for far less I/O stall.
    // WAL still survives an app crash; only a hard power-loss can lose the last
    // few seconds of progress, which simply re-downloads on resume.
    QSqlQuery pragma(m_db);
    pragma.exec(QStringLiteral("PRAGMA journal_mode=WAL"));
    pragma.exec(QStringLiteral("PRAGMA synchronous=NORMAL"));

    ensureSchema();
    pruneOrphanSegments();

    QSqlQuery q(m_db);
    if (q.exec(QStringLiteral("SELECT COALESCE(MAX(id),0) FROM downloads")) && q.next())
        m_nextId = q.value(0).toInt() + 1;
    return true;
}

void Database::close()
{
    if (m_db.isOpen())
        m_db.close();
}

void Database::ensureSchema()
{
    QSqlQuery q(m_db);
    q.exec(QStringLiteral(
        "CREATE TABLE IF NOT EXISTS downloads ("
        " id INTEGER PRIMARY KEY,"
        " url TEXT NOT NULL,"
        " save_path TEXT NOT NULL,"
        " total INTEGER DEFAULT -1,"
        " state INTEGER DEFAULT 0,"
        " updated_at INTEGER DEFAULT 0)"));
    q.exec(QStringLiteral(
        "CREATE TABLE IF NOT EXISTS segments ("
        " download_id INTEGER NOT NULL,"
        " idx INTEGER NOT NULL,"
        " start INTEGER NOT NULL,"
        " stop INTEGER NOT NULL,"
        " done INTEGER NOT NULL,"
        " PRIMARY KEY (download_id, idx))"));

    // Migration for databases created before updated_at existed. SQLite has no
    // "ADD COLUMN IF NOT EXISTS", so probe the schema and ALTER only when the
    // column is genuinely missing — otherwise we'd fire a guaranteed-to-fail
    // (and silently swallowed) ALTER on every single startup.
    bool hasUpdatedAt = false;
    QSqlQuery info(m_db);
    if (info.exec(QStringLiteral("PRAGMA table_info(downloads)"))) {
        while (info.next()) {
            if (info.value(1).toString() == QLatin1String("updated_at")) {
                hasUpdatedAt = true;
                break;
            }
        }
    }
    if (!hasUpdatedAt &&
        !q.exec(QStringLiteral("ALTER TABLE downloads ADD COLUMN updated_at INTEGER DEFAULT 0")))
        qWarning() << "Nexa DB: adding updated_at column failed:" << q.lastError().text();

    // Speeds up the cleanup query (delete completed older than N days) and the
    // by-state scans the engine does. The segments table is already covered for
    // download_id lookups by its (download_id, idx) primary key.
    q.exec(QStringLiteral("CREATE INDEX IF NOT EXISTS idx_downloads_state "
                          "ON downloads(state, updated_at)"));
}

void Database::pruneOrphanSegments()
{
    // Defensive: a crash between the two DELETEs of an old removeTask() could
    // leave segment rows with no parent. Drop them so they never resurrect.
    QSqlQuery q(m_db);
    q.exec(QStringLiteral(
        "DELETE FROM segments WHERE download_id NOT IN (SELECT id FROM downloads)"));
}

int Database::nextId()
{
    return m_nextId++;
}

void Database::saveTask(const DownloadTask &task, const QVector<SegmentInfo> &segments)
{
    if (!m_db.isOpen())
        return;

    // One transaction for the task row + every segment row. Previously each
    // segment upsert committed on its own (one fsync each); batching them into a
    // single commit is the bulk of the I/O win at the 2 s save cadence.
    const bool inTx = m_db.transaction();

    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT INTO downloads (id, url, save_path, total, state, updated_at) "
        "VALUES (:id, :url, :path, :total, :state, :updated) "
        "ON CONFLICT(id) DO UPDATE SET "
        " url=excluded.url, save_path=excluded.save_path,"
        " total=excluded.total, state=excluded.state, updated_at=excluded.updated_at"));
    q.bindValue(QStringLiteral(":id"), task.id());
    q.bindValue(QStringLiteral(":url"), task.url().toString());
    q.bindValue(QStringLiteral(":path"), task.savePath());
    q.bindValue(QStringLiteral(":total"), task.totalBytes());
    q.bindValue(QStringLiteral(":state"), int(task.state()));
    q.bindValue(QStringLiteral(":updated"), QDateTime::currentSecsSinceEpoch());
    if (!q.exec())
        qWarning() << "Nexa DB saveTask:" << q.lastError().text();

    for (const SegmentInfo &s : segments) {
        QSqlQuery sq(m_db);
        sq.prepare(QStringLiteral(
            "INSERT INTO segments (download_id, idx, start, stop, done) "
            "VALUES (:did, :idx, :start, :stop, :done) "
            "ON CONFLICT(download_id, idx) DO UPDATE SET "
            " start=excluded.start, stop=excluded.stop, done=excluded.done"));
        sq.bindValue(QStringLiteral(":did"), task.id());
        sq.bindValue(QStringLiteral(":idx"), s.index);
        sq.bindValue(QStringLiteral(":start"), s.start);
        sq.bindValue(QStringLiteral(":stop"), s.end);
        sq.bindValue(QStringLiteral(":done"), s.done);
        sq.exec();
    }

    if (inTx && !m_db.commit()) {
        qWarning() << "Nexa DB saveTask commit:" << m_db.lastError().text();
        m_db.rollback();
    }
}

void Database::removeTask(int id)
{
    if (!m_db.isOpen())
        return;
    const bool inTx = m_db.transaction();
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("DELETE FROM downloads WHERE id = :id"));
    q.bindValue(QStringLiteral(":id"), id);
    q.exec();
    q.prepare(QStringLiteral("DELETE FROM segments WHERE download_id = :id"));
    q.bindValue(QStringLiteral(":id"), id);
    q.exec();
    if (inTx)
        m_db.commit();
}

int Database::clearCompleted(int olderThanDays)
{
    if (!m_db.isOpen())
        return 0;

    const int completed = int(DownloadState::Completed);
    const qint64 cutoff = olderThanDays > 0
        ? QDateTime::currentSecsSinceEpoch() - qint64(olderThanDays) * 86400
        : 0;

    const bool inTx = m_db.transaction();
    // Drop the child segment rows first, then the parent download rows, so we
    // never momentarily orphan segments.
    QSqlQuery sq(m_db);
    sq.prepare(QStringLiteral(
        "DELETE FROM segments WHERE download_id IN "
        "(SELECT id FROM downloads WHERE state = :st AND updated_at <= :cut)"));
    sq.bindValue(QStringLiteral(":st"), completed);
    sq.bindValue(QStringLiteral(":cut"), olderThanDays > 0 ? cutoff
                                                           : std::numeric_limits<qint64>::max());
    sq.exec();

    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "DELETE FROM downloads WHERE state = :st AND updated_at <= :cut"));
    q.bindValue(QStringLiteral(":st"), completed);
    q.bindValue(QStringLiteral(":cut"), olderThanDays > 0 ? cutoff
                                                          : std::numeric_limits<qint64>::max());
    const int removed = q.exec() ? q.numRowsAffected() : 0;
    if (inTx)
        m_db.commit();
    return removed;
}

QVector<TaskRecord> Database::loadAll()
{
    QVector<TaskRecord> out;
    if (!m_db.isOpen())
        return out;

    QSqlQuery q(m_db);
    if (!q.exec(QStringLiteral("SELECT id, url, save_path, total, state FROM downloads ORDER BY id")))
        return out;

    while (q.next()) {
        TaskRecord rec;
        rec.id = q.value(0).toInt();
        rec.url = q.value(1).toString();
        rec.savePath = q.value(2).toString();
        rec.total = q.value(3).toLongLong();
        rec.state = static_cast<DownloadState>(q.value(4).toInt());

        QSqlQuery sq(m_db);
        sq.prepare(QStringLiteral(
            "SELECT idx, start, stop, done FROM segments "
            "WHERE download_id = :id ORDER BY idx"));
        sq.bindValue(QStringLiteral(":id"), rec.id);
        if (sq.exec()) {
            while (sq.next()) {
                SegmentInfo s;
                s.index = sq.value(0).toInt();
                s.start = sq.value(1).toLongLong();
                s.end   = sq.value(2).toLongLong();
                s.done  = sq.value(3).toLongLong();
                rec.segments.append(s);
            }
        }
        out.append(rec);
    }
    return out;
}

} // namespace nexa
