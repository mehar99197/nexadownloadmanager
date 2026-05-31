#include "core/DownloadEngine.h"
#include "core/DownloadTask.h"
#include "core/Database.h"

#include <QNetworkAccessManager>
#include <QStandardPaths>
#include <QFileInfo>
#include <QDir>
#include <QFile>
#include <QUrlQuery>

namespace nexa {

DownloadEngine::DownloadEngine(QObject *parent)
    : QObject(parent)
{
    m_nam = new QNetworkAccessManager(this);
    m_db = new Database();

    const QString dataDir =
        QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
    m_db->open(dataDir + QStringLiteral("/nexa.db"));

    m_downloadDir =
        QStandardPaths::writableLocation(QStandardPaths::DownloadLocation);
    if (m_downloadDir.isEmpty())
        m_downloadDir = QDir::homePath() + QStringLiteral("/Downloads");
}

DownloadEngine::~DownloadEngine()
{
    qDeleteAll(m_tasks);
    m_tasks.clear();
    if (m_db) {
        m_db->close();
        delete m_db;
    }
}

QString DownloadEngine::resolveSavePath(const QUrl &url, const QString &savePath) const
{
    if (!savePath.isEmpty())
        return savePath;

    QString name = QFileInfo(url.path()).fileName();
    if (name.isEmpty())
        name = QStringLiteral("download");

    QString candidate = QDir(m_downloadDir).filePath(name);
    // Avoid clobbering an existing file: name.ext -> name (1).ext, etc.
    if (QFile::exists(candidate)) {
        const QFileInfo fi(candidate);
        const QString base = fi.completeBaseName();
        const QString suffix = fi.suffix().isEmpty() ? QString()
                                                     : (QStringLiteral(".") + fi.suffix());
        int n = 1;
        do {
            candidate = QDir(m_downloadDir)
                            .filePath(QStringLiteral("%1 (%2)%3").arg(base).arg(n).arg(suffix));
            ++n;
        } while (QFile::exists(candidate));
    }
    return candidate;
}

void DownloadEngine::wireTask(DownloadTask *t)
{
    connect(t, &DownloadTask::progress, this, &DownloadEngine::taskProgress);
    connect(t, &DownloadTask::stateChanged, this, &DownloadEngine::taskStateChanged);
    connect(t, &DownloadTask::finished, this, &DownloadEngine::taskFinished);
}

int DownloadEngine::addDownload(const QUrl &url, const QString &savePath,
                                const HeaderList &headers)
{
    if (!url.isValid() || url.scheme().isEmpty())
        return -1;

    const int id = m_db->nextId();
    const QString path = resolveSavePath(url, savePath);

    auto *t = new DownloadTask(id, url, path, m_nam, m_db, this);
    t->setHeaders(headers);
    m_tasks.insert(id, t);
    wireTask(t);

    emit taskAdded(id);
    t->start();
    return id;
}

void DownloadEngine::pause(int id)
{
    if (auto *t = m_tasks.value(id))
        t->pause();
}

void DownloadEngine::resume(int id)
{
    if (auto *t = m_tasks.value(id))
        t->resume();
}

void DownloadEngine::remove(int id, bool deleteFile)
{
    auto *t = m_tasks.take(id);
    if (!t)
        return;
    const QString path = t->savePath();
    t->pause();
    t->deleteLater();
    if (m_db)
        m_db->removeTask(id);
    if (deleteFile && !path.isEmpty())
        QFile::remove(path);
    emit taskRemoved(id);
}

void DownloadEngine::loadPersisted()
{
    if (!m_db)
        return;
    const QVector<TaskRecord> records = m_db->loadAll();
    for (const TaskRecord &rec : records) {
        if (m_tasks.contains(rec.id))
            continue;
        auto *t = new DownloadTask(rec.id, QUrl(rec.url), rec.savePath, m_nam, m_db, this);
        if (!rec.segments.isEmpty())
            t->restore(rec.total, rec.segments);
        m_tasks.insert(rec.id, t);
        wireTask(t);
        emit taskAdded(rec.id);
    }
}

void DownloadEngine::resumeUnfinished()
{
    for (DownloadTask *t : m_tasks) {
        if (t->state() != DownloadState::Completed)
            t->resume();
    }
}

} // namespace nexa
