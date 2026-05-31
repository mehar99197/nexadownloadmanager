#include "core/DownloadEngine.h"
#include "core/DownloadTask.h"
#include "core/Database.h"
#include "grabber/HlsGrabber.h"

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

    // Adaptive streams (HLS/DASH) go to the grabber, which yields a single MP4.
    if (HlsGrabber::isStreamUrl(url)) {
        QString out = savePath;
        if (out.isEmpty()) {
            QString base = QFileInfo(url.path()).completeBaseName();
            if (base.isEmpty())
                base = QStringLiteral("stream");
            out = resolveSavePath(QUrl(), m_downloadDir + QStringLiteral("/") + base + QStringLiteral(".mp4"));
        }
        auto *g = new HlsGrabber(id, url, out, headers, this);
        m_grabbers.insert(id, g);
        connect(g, &HlsGrabber::progress,     this, &DownloadEngine::taskProgress);
        connect(g, &HlsGrabber::stateChanged, this, &DownloadEngine::taskStateChanged);
        connect(g, &HlsGrabber::finished,     this, &DownloadEngine::taskFinished);
        emit taskAdded(id);
        g->start();
        return id;
    }

    const QString path = resolveSavePath(url, savePath);

    auto *t = new DownloadTask(id, url, path, m_nam, m_db, this);
    t->setHeaders(headers);
    m_tasks.insert(id, t);
    wireTask(t);

    emit taskAdded(id);
    t->start();
    return id;
}

QString DownloadEngine::nameOf(int id) const
{
    if (auto *t = m_tasks.value(id)) return t->fileName();
    if (auto *g = m_grabbers.value(id)) return g->fileName();
    return QStringLiteral("download");
}

DownloadState DownloadEngine::stateOf(int id) const
{
    if (auto *t = m_tasks.value(id)) return t->state();
    if (auto *g = m_grabbers.value(id)) return g->state();
    return DownloadState::Queued;
}

bool DownloadEngine::allTerminal() const
{
    if (m_tasks.isEmpty() && m_grabbers.isEmpty())
        return false;
    auto terminal = [](DownloadState s) {
        return s == DownloadState::Completed || s == DownloadState::Error;
    };
    for (auto *t : m_tasks)
        if (!terminal(t->state())) return false;
    for (auto *g : m_grabbers)
        if (!terminal(g->state())) return false;
    return true;
}

void DownloadEngine::pause(int id)
{
    if (auto *t = m_tasks.value(id))
        t->pause();
    else if (auto *g = m_grabbers.value(id))
        g->cancel();
}

void DownloadEngine::resume(int id)
{
    if (auto *t = m_tasks.value(id))
        t->resume();
    else if (auto *g = m_grabbers.value(id))
        g->start();        // streams restart from scratch (no partial resume)
}

void DownloadEngine::remove(int id, bool deleteFile)
{
    if (auto *g = m_grabbers.take(id)) {
        const QString path = g->savePath();
        g->cancel();
        g->deleteLater();
        if (deleteFile && !path.isEmpty())
            QFile::remove(path);
        emit taskRemoved(id);
        return;
    }

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
