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
#include <QTimer>
#include <QRegularExpression>
#include <climits>

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

QString DownloadEngine::categoryFor(const QString &fileName)
{
    const QString ext = QFileInfo(fileName).suffix().toLower();
    static const QStringList video = {"mp4","mkv","avi","mov","wmv","flv","webm","m4v","mpg","mpeg","ts","3gp"};
    static const QStringList audio = {"mp3","wav","flac","aac","m4a","ogg","wma","opus"};
    static const QStringList docs  = {"pdf","doc","docx","xls","xlsx","ppt","pptx","txt","epub","csv","odt"};
    static const QStringList arch  = {"zip","rar","7z","tar","gz","bz2","xz","tgz"};
    static const QStringList prog  = {"exe","msi","deb","rpm","dmg","pkg","apk","appimage","bin"};
    static const QStringList img   = {"jpg","jpeg","png","gif","bmp","svg","webp","ico","tiff"};
    if (video.contains(ext)) return QStringLiteral("Video");
    if (audio.contains(ext)) return QStringLiteral("Audio");
    if (docs.contains(ext))  return QStringLiteral("Documents");
    if (arch.contains(ext))  return QStringLiteral("Compressed");
    if (prog.contains(ext))  return QStringLiteral("Programs");
    if (img.contains(ext))   return QStringLiteral("Images");
    return QStringLiteral("Other");
}

QString DownloadEngine::resolveSavePath(const QUrl &url, const QString &savePath) const
{
    if (!savePath.isEmpty())
        return savePath;

    QString name = QFileInfo(url.path()).fileName();
    if (name.isEmpty())
        name = QStringLiteral("download");

    // Auto-categorize: drop the file into a per-type subfolder.
    QString dir = m_downloadDir;
    if (m_autoCategorize)
        dir = QDir(m_downloadDir).filePath(categoryFor(name));

    QString candidate = QDir(dir).filePath(name);
    // Avoid clobbering an existing file: name.ext -> name (1).ext, etc.
    if (QFile::exists(candidate)) {
        const QFileInfo fi(candidate);
        const QString base = fi.completeBaseName();
        const QString suffix = fi.suffix().isEmpty() ? QString()
                                                     : (QStringLiteral(".") + fi.suffix());
        int n = 1;
        do {
            candidate = QDir(dir)
                            .filePath(QStringLiteral("%1 (%2)%3").arg(base).arg(n).arg(suffix));
            ++n;
        } while (QFile::exists(candidate));
    }
    return candidate;
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
            // Run through resolveSavePath so streams get categorized (Video/).
            QUrl fake;
            fake.setPath(QStringLiteral("/") + base + QStringLiteral(".mp4"));
            out = resolveSavePath(fake, QString());
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
    m_pending.append(id);   // honour the concurrency limit instead of starting now
    schedule();
    return id;
}

void DownloadEngine::wireTask(DownloadTask *t)
{
    connect(t, &DownloadTask::progress, this, &DownloadEngine::taskProgress);
    connect(t, &DownloadTask::stateChanged, this, &DownloadEngine::taskStateChanged);
    connect(t, &DownloadTask::finished, this, &DownloadEngine::taskFinished);
    // When a task leaves the active set (done/error/paused), fill the freed slot.
    connect(t, &DownloadTask::stateChanged, this,
            [this](int, DownloadState, const QString &) { schedule(); });
}

int DownloadEngine::activeCount() const
{
    int n = 0;
    for (auto *t : m_tasks)
        if (t->state() == DownloadState::Probing || t->state() == DownloadState::Downloading)
            ++n;
    return n;
}

void DownloadEngine::schedule()
{
    if (m_inSchedule)
        return;
    m_inSchedule = true;
    while (activeCount() < m_maxConcurrent && !m_pending.isEmpty()) {
        const int id = m_pending.takeFirst();
        DownloadTask *t = m_tasks.value(id);
        if (!t)
            continue;
        const DownloadState s = t->state();
        if (s == DownloadState::Completed || s == DownloadState::Downloading ||
            s == DownloadState::Probing)
            continue;             // already running or done
        t->resume();              // start() for fresh tasks, true resume for paused
    }
    m_inSchedule = false;
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
    m_pending.removeAll(id);
    if (auto *t = m_tasks.value(id)) {
        t->pause();
        schedule();        // a slot just freed up
    } else if (auto *g = m_grabbers.value(id)) {
        g->cancel();
    }
}

void DownloadEngine::resume(int id)
{
    if (m_tasks.contains(id)) {
        if (!m_pending.contains(id))
            m_pending.append(id);   // queue it; schedule respects the limit
        schedule();
    } else if (auto *g = m_grabbers.value(id)) {
        g->start();        // streams restart from scratch (no partial resume)
    }
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
    m_pending.removeAll(id);
    const QString path = t->savePath();
    t->pause();
    t->deleteLater();
    if (m_db)
        m_db->removeTask(id);
    if (deleteFile && !path.isEmpty())
        QFile::remove(path);
    emit taskRemoved(id);
    schedule();           // promote a queued download into the freed slot
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
    for (auto it = m_tasks.constBegin(); it != m_tasks.constEnd(); ++it) {
        if (it.value()->state() != DownloadState::Completed &&
            !m_pending.contains(it.key()))
            m_pending.append(it.key());
    }
    schedule();
}

QStringList DownloadEngine::expandPattern(const QString &token)
{
    // Expand the first numeric range like file[1-20].jpg -> file1.jpg .. file20.jpg
    static const QRegularExpression re(QStringLiteral("\\[(\\d+)-(\\d+)\\]"));
    const auto m = re.match(token);
    if (!m.hasMatch())
        return {token};

    const QString aStr = m.captured(1);
    const int a = aStr.toInt();
    const int b = m.captured(2).toInt();
    const int width = aStr.length();   // preserve zero-padding of the first bound
    if (a > b || (b - a) > 100000)     // sanity cap
        return {token};

    QStringList out;
    for (int i = a; i <= b; ++i) {
        QString num = QString::number(i);
        if (num.length() < width)
            num = num.rightJustified(width, QLatin1Char('0'));
        QString s = token;
        s.replace(m.capturedStart(0), m.capturedLength(0), num);
        out.append(s);
    }
    return out;
}

QList<int> DownloadEngine::addBatch(const QString &text, const HeaderList &headers)
{
    QList<int> ids;
    static const QRegularExpression ws(QStringLiteral("\\s+"));
    const QStringList tokens = text.split(ws, Qt::SkipEmptyParts);
    for (const QString &token : tokens) {
        for (const QString &expanded : expandPattern(token)) {
            const QUrl url = QUrl::fromUserInput(expanded);
            const int id = addDownload(url, QString(), headers);
            if (id >= 0)
                ids.append(id);
        }
    }
    return ids;
}

int DownloadEngine::scheduleDownload(const QUrl &url, const QDateTime &when,
                                     const HeaderList &headers)
{
    const qint64 ms = QDateTime::currentDateTime().msecsTo(when);
    if (ms <= 0)
        return addDownload(url, QString(), headers);   // time already passed

    const int delay = int(qMin<qint64>(ms, INT_MAX));
    QTimer::singleShot(delay, this, [this, url, headers]() {
        addDownload(url, QString(), headers);
    });
    return int(ms / 1000);   // seconds until it starts (for UI feedback)
}

} // namespace nexa
