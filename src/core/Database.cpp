#include "core/Database.h"
#include "core/DownloadTask.h"

#include <QSqlQuery>
#include <QSqlError>
#include <QVariant>
#include <QFileInfo>
#include <QDir>
#include <QDebug>

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
    ensureSchema();

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
        " state INTEGER DEFAULT 0)"));
    q.exec(QStringLiteral(
        "CREATE TABLE IF NOT EXISTS segments ("
        " download_id INTEGER NOT NULL,"
        " idx INTEGER NOT NULL,"
        " start INTEGER NOT NULL,"
        " stop INTEGER NOT NULL,"
        " done INTEGER NOT NULL,"
        " PRIMARY KEY (download_id, idx))"));
}

int Database::nextId()
{
    return m_nextId++;
}

void Database::saveTask(const DownloadTask &task, const QVector<SegmentInfo> &segments)
{
    if (!m_db.isOpen())
        return;

    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT INTO downloads (id, url, save_path, total, state) "
        "VALUES (:id, :url, :path, :total, :state) "
        "ON CONFLICT(id) DO UPDATE SET "
        " url=excluded.url, save_path=excluded.save_path,"
        " total=excluded.total, state=excluded.state"));
    q.bindValue(QStringLiteral(":id"), task.id());
    q.bindValue(QStringLiteral(":url"), task.url().toString());
    q.bindValue(QStringLiteral(":path"), task.savePath());
    q.bindValue(QStringLiteral(":total"), task.totalBytes());
    q.bindValue(QStringLiteral(":state"), int(task.state()));
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
}

void Database::removeTask(int id)
{
    if (!m_db.isOpen())
        return;
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("DELETE FROM downloads WHERE id = :id"));
    q.bindValue(QStringLiteral(":id"), id);
    q.exec();
    q.prepare(QStringLiteral("DELETE FROM segments WHERE download_id = :id"));
    q.bindValue(QStringLiteral(":id"), id);
    q.exec();
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
