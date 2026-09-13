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
    // Unique connection name per instance so unit tests (which create multiple
    // Database objects) don't clash on the shared QSqlDatabase registry.
    static int s_connId = 0;
    const QString connName = QStringLiteral("nexa-%1").arg(s_connId++);
    m_db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connName);
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
        " updated_at INTEGER DEFAULT 0,"
        " etag TEXT DEFAULT '',"
        " last_modified TEXT DEFAULT '')"));
    q.exec(QStringLiteral(
        "CREATE TABLE IF NOT EXISTS scheduled ("
        " id INTEGER PRIMARY KEY,"
        " url TEXT NOT NULL,"
        " start_at INTEGER NOT NULL,"
        " name TEXT DEFAULT '')"));
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

    // Same migration for ranges_supported (persisted so a paused single-segment
    // ranged download resumes with work-stealing still enabled, instead of being
    // guessed from segment count).
    bool hasRanges = false;
    QSqlQuery info2(m_db);
    if (info2.exec(QStringLiteral("PRAGMA table_info(downloads)"))) {
        while (info2.next())
            if (info2.value(1).toString() == QLatin1String("ranges_supported")) { hasRanges = true; break; }
    }
    if (!hasRanges &&
        !q.exec(QStringLiteral("ALTER TABLE downloads ADD COLUMN ranges_supported INTEGER DEFAULT 0")))
        qWarning() << "Nexa DB: adding ranges_supported column failed:" << q.lastError().text();

    auto hasColumn = [this](const QString &column) {
        QSqlQuery probe(m_db);
        if (!probe.exec(QStringLiteral("PRAGMA table_info(downloads)")))
            return false;
        while (probe.next())
            if (probe.value(1).toString() == column) return true;
        return false;
    };
    if (!hasColumn(QStringLiteral("etag")))
        q.exec(QStringLiteral("ALTER TABLE downloads ADD COLUMN etag TEXT DEFAULT ''"));
    if (!hasColumn(QStringLiteral("last_modified")))
        q.exec(QStringLiteral("ALTER TABLE downloads ADD COLUMN last_modified TEXT DEFAULT ''"));

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

    // Replace the task row and its complete segment layout atomically. Upserting
    // only the current rows leaves stale segment indexes behind when a task is
    // re-probed with fewer/different segments; those rows can corrupt a resume.
    if (!m_db.transaction()) {
        qWarning() << "Nexa DB saveTask: could not begin transaction:" << m_db.lastError().text();
        return;
    }

    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT INTO downloads (id, url, save_path, total, state, updated_at, ranges_supported, etag, last_modified) "
        "VALUES (:id, :url, :path, :total, :state, :updated, :ranges, :etag, :last_modified) "
        "ON CONFLICT(id) DO UPDATE SET "
        " url=excluded.url, save_path=excluded.save_path,"
        " total=excluded.total, state=excluded.state, updated_at=excluded.updated_at,"
        " ranges_supported=excluded.ranges_supported, etag=excluded.etag,"
        " last_modified=excluded.last_modified"));
    q.bindValue(QStringLiteral(":id"), task.id());
    q.bindValue(QStringLiteral(":url"), task.url().toString());
    q.bindValue(QStringLiteral(":path"), task.savePath());
    q.bindValue(QStringLiteral(":total"), task.totalBytes());
    q.bindValue(QStringLiteral(":state"), int(task.state()));
    q.bindValue(QStringLiteral(":updated"), QDateTime::currentSecsSinceEpoch());
    q.bindValue(QStringLiteral(":ranges"), task.rangesSupported() ? 1 : 0);
    q.bindValue(QStringLiteral(":etag"), task.etag());
    q.bindValue(QStringLiteral(":last_modified"), task.lastModified());
    if (!q.exec()) {
        qWarning() << "Nexa DB saveTask:" << q.lastError().text();
        m_db.rollback();
        return;
    }

    QSqlQuery clear(m_db);
    clear.prepare(QStringLiteral("DELETE FROM segments WHERE download_id = :did"));
    clear.bindValue(QStringLiteral(":did"), task.id());
    if (!clear.exec()) {
        qWarning() << "Nexa DB clearTaskSegments:" << clear.lastError().text();
        m_db.rollback();
        return;
    }

    // Prepared ONCE, outside the loop. This runs every ~2 s for every active
    // download, and a large file is split into 32 segments — re-preparing the
    // same statement 32 times per save was pure overhead on the GUI thread.
    QSqlQuery sq(m_db);
    sq.prepare(QStringLiteral(
        "INSERT INTO segments (download_id, idx, start, stop, done) "
        "VALUES (:did, :idx, :start, :stop, :done)"));
    for (const SegmentInfo &s : segments) {
        sq.bindValue(QStringLiteral(":did"), task.id());
        sq.bindValue(QStringLiteral(":idx"), s.index);
        sq.bindValue(QStringLiteral(":start"), s.start);
        sq.bindValue(QStringLiteral(":stop"), s.end);
        sq.bindValue(QStringLiteral(":done"), s.done);
        if (!sq.exec()) {
            qWarning() << "Nexa DB saveTask segment:" << sq.lastError().text();
            m_db.rollback();
            return;
        }
    }

    if (!m_db.commit()) {
        qWarning() << "Nexa DB saveTask commit:" << m_db.lastError().text();
        m_db.rollback();
    }
}

void Database::saveScheduled(int id, const QString &url, qint64 startAtMs, const QString &name)
{
    if (!m_db.isOpen())
        return;
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("INSERT OR REPLACE INTO scheduled (id, url, start_at, name) "
                             "VALUES (:id, :url, :at, :name)"));
    q.bindValue(QStringLiteral(":id"), id);
    q.bindValue(QStringLiteral(":url"), url);
    q.bindValue(QStringLiteral(":at"), startAtMs);
    q.bindValue(QStringLiteral(":name"), name);
    if (!q.exec())
        qWarning() << "Nexa DB: saveScheduled failed:" << q.lastError().text();
}

void Database::removeScheduled(int id)
{
    if (!m_db.isOpen())
        return;
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("DELETE FROM scheduled WHERE id = :id"));
    q.bindValue(QStringLiteral(":id"), id);
    q.exec();
}

QVector<ScheduledRecord> Database::loadScheduled()
{
    QVector<ScheduledRecord> out;
    if (!m_db.isOpen())
        return out;
    QSqlQuery q(m_db);
    if (!q.exec(QStringLiteral("SELECT id, url, start_at, name FROM scheduled ORDER BY start_at")))
        return out;
    while (q.next()) {
        ScheduledRecord r;
        r.id = q.value(0).toInt();
        r.url = q.value(1).toString();
        r.startAtMs = q.value(2).toLongLong();
        r.name = q.value(3).toString();
        m_nextId = qMax(m_nextId, r.id + 1);
        out.append(r);
    }
    return out;
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
    if (!q.exec(QStringLiteral("SELECT id, url, save_path, total, state, ranges_supported, etag, last_modified "
                               "FROM downloads ORDER BY id")))
        return out;

    while (q.next()) {
        TaskRecord rec;
        rec.id = q.value(0).toInt();
        rec.url = q.value(1).toString();
        rec.savePath = q.value(2).toString();
        rec.total = q.value(3).toLongLong();
        rec.state = static_cast<DownloadState>(q.value(4).toInt());
        rec.rangesSupported = q.value(5).toInt() != 0;
        rec.etag = q.value(6).toString();
        rec.lastModified = q.value(7).toString();

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
