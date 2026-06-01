#include "core/DownloadEngine.h"
#include "core/DownloadTask.h"
#include "core/Database.h"
#include "grabber/HlsGrabber.h"
#include "torrent/TorrentManager.h"
#include "site/YtDlpGrabber.h"
#include "ai/AiClient.h"
#include "auth/AuthenticationManager.h"

#include <QNetworkAccessManager>
#include <QStandardPaths>
#include <QFileInfo>
#include <QDir>
#include <QFile>
#include <QUrlQuery>
#include <QTimer>
#include <QRegularExpression>
#include <QJsonObject>
#include <QJsonArray>
#include <climits>
#include <algorithm>

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

    m_ai = new AiClient(this);

    // Domain-scoped authentication (cookies.txt / bearer tokens). One instance
    // owned here; addDownload() resolves auth per URL and hands the APPLIED result
    // (yt-dlp flags / HeaderList) to the download classes. Config is optional.
    m_auth = new AuthenticationManager(this);
    m_auth->loadFromJson();   // ~/.config/nexa/auth.json — ignore failure

    // Cache live progress so the dashboard/API can report it on demand.
    connect(this, &DownloadEngine::taskProgress, this, &DownloadEngine::cacheProgress);
    connect(this, &DownloadEngine::taskRemoved,  this, &DownloadEngine::dropProgress);

    // AI smart-rename: when a file download finishes, ask the model for a clean
    // name and rename it on disk (only when enabled and a key is configured).
    connect(this, &DownloadEngine::taskFinished, this, [this](int id) {
        if (!m_aiRename || !m_ai->isConfigured())
            return;
        DownloadTask *t = m_tasks.value(id);
        if (!t)
            return;                        // file downloads only
        m_ai->suggestFilename(t->fileName(), t->url().toString(), QString(),
                              [this, id](const QString &newName) {
            DownloadTask *t = m_tasks.value(id);
            if (!t || newName.isEmpty() || newName == t->fileName())
                return;
            if (t->renameTo(newName))
                emit taskRenamed(id, t->fileName());
        });
    });
    // A paused/finished/errored task isn't moving — clear its cached speed so the
    // API doesn't keep reporting the last sampled rate.
    connect(this, &DownloadEngine::taskStateChanged, this,
            [this](int id, DownloadState s, const QString &) {
                if (s == DownloadState::Paused || s == DownloadState::Completed ||
                    s == DownloadState::Error) {
                    if (auto it = m_progress.find(id); it != m_progress.end())
                        it->speed = 0.0;
                }
            });
}

void DownloadEngine::cacheProgress(int id, qint64 done, qint64 total, double bytesPerSec)
{
    ProgressInfo &p = m_progress[id];
    p.done = done;
    p.total = total;
    p.speed = bytesPerSec;
}

void DownloadEngine::dropProgress(int id)
{
    m_progress.remove(id);
}

QVector<DownloadEngine::TaskSnapshot> DownloadEngine::snapshot() const
{
    QList<int> ids = m_tasks.keys();
    ids.append(m_grabbers.keys());
    ids.append(m_torrentIds.values());
    std::sort(ids.begin(), ids.end());

    QVector<TaskSnapshot> out;
    out.reserve(ids.size());
    for (int id : ids) {
        TaskSnapshot s;
        s.id = id;
        s.name = nameOf(id);
        s.state = stateOf(id);
        const ProgressInfo p = m_progress.value(id);
        s.done = p.done;
        s.total = p.total;
        s.speed = p.speed;
        out.append(s);
    }
    return out;
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

QString DownloadEngine::pathForName(const QString &fileName) const
{
    QString name = fileName;
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

QString DownloadEngine::resolveSavePath(const QUrl &url, const QString &savePath) const
{
    if (!savePath.isEmpty())
        return savePath;
    return pathForName(QFileInfo(url.path()).fileName());
}

int DownloadEngine::addDownload(const QUrl &url, const QString &savePath,
                                const HeaderList &headers, const QString &suggestedName,
                                const QString &siteFormat, bool playlist)
{
    if (!url.isValid() || url.scheme().isEmpty())
        return -1;

    const int id = m_db->nextId();

    // Resolve domain-scoped auth for this URL ONCE, into the two forms the
    // download classes already understand: finished yt-dlp CLI flags and
    // HeaderList entries. Both are empty when no credential matches (or the host
    // is excluded, e.g. YouTube), so non-auth downloads are entirely unaffected.
    const QStringList authArgs    = m_auth->ytDlpArgs(url);
    const HeaderList  authHeaders = m_auth->headerAuthFor(url);

    // Pre-flight: refuse an expired/malformed credential BEFORE any request, so
    // the user is told to re-auth instead of waiting on a guaranteed 401/403.
    const AuthResult av = m_auth->validateFor(url);
    if (!av.ok) {
        emit taskAdded(id);   // create the id so the UI shows the failed job
        emit taskStateChanged(id, DownloadState::Error, av.detail);
        return id;
    }

    // YouTube & other yt-dlp sites: drive yt-dlp (handles ciphers/SABR + mux).
    if (YtDlpGrabber::isSiteVideoUrl(url) && YtDlpGrabber::available()) {
        const QString videoDir = m_autoCategorize
            ? QDir(m_downloadDir).filePath(categoryFor(QStringLiteral("a.mp4")))  // Video/
            : m_downloadDir;
        const QString fixedName = suggestedName.isEmpty()
            ? QString()
            : QFileInfo(suggestedName).completeBaseName();
        const QString fmt = YtDlpGrabber::formatForQuality(siteFormat);
        auto *g = new YtDlpGrabber(id, url, videoDir, fixedName, fmt, headers, authArgs,
                                   playlist, this);
        m_siteVideos.insert(id, g);
        connect(g, &YtDlpGrabber::progress,     this, &DownloadEngine::taskProgress);
        connect(g, &YtDlpGrabber::stateChanged, this, &DownloadEngine::taskStateChanged);
        connect(g, &YtDlpGrabber::finished,     this, &DownloadEngine::taskFinished);
        emit taskAdded(id);
        g->start();
        return id;
    }

    // Torrents (magnet links / .torrent files) go to the libtorrent session.
    const QString asText = (url.scheme() == QLatin1String("magnet"))
                               ? url.toString()
                               : (url.isLocalFile() ? url.toLocalFile() : url.toString());
    if (TorrentManager::isTorrentUrl(asText)) {
        ensureTorrents();
        const QString dir = m_autoCategorize
                                ? QDir(m_downloadDir).filePath(QStringLiteral("Torrents"))
                                : m_downloadDir;
        m_torrentIds.insert(id);
        emit taskAdded(id);
        if (!m_torrents->add(id, asText, dir)) {
            m_torrentIds.remove(id);
            return -1;
        }
        return id;
    }

    // Adaptive streams (HLS/DASH) go to the grabber, which yields a single MP4.
    if (HlsGrabber::isStreamUrl(url)) {
        QString out = savePath;
        if (out.isEmpty()) {
            // Prefer the page title (suggestedName) for the video's filename.
            QString base = suggestedName.isEmpty()
                               ? QFileInfo(url.path()).completeBaseName()
                               : QFileInfo(suggestedName).completeBaseName();
            if (base.isEmpty())
                base = QStringLiteral("stream");
            out = pathForName(base + QStringLiteral(".mp4"));   // categorised (Video/)
        }
        HlsGrabber *g = nullptr;
        {
            HeaderList merged = headers;
            merged += authHeaders;   // domain-scoped Cookie/Authorization, if any
            g = new HlsGrabber(id, url, out, merged, this);
        }
        m_grabbers.insert(id, g);
        connect(g, &HlsGrabber::progress,     this, &DownloadEngine::taskProgress);
        connect(g, &HlsGrabber::stateChanged, this, &DownloadEngine::taskStateChanged);
        connect(g, &HlsGrabber::finished,     this, &DownloadEngine::taskFinished);
        emit taskAdded(id);
        g->start();
        return id;
    }

    QString path = resolveSavePath(url, savePath);
    if (savePath.isEmpty() && !suggestedName.isEmpty() &&
        QFileInfo(url.path()).fileName().isEmpty())
        path = pathForName(suggestedName);   // URL has no filename; use the hint

    auto *t = new DownloadTask(id, url, path, m_nam, m_db, this);
    // Merge domain-scoped auth into the browser headers; SegmentDownloader replays
    // them via its existing setRawHeader loop, with no coupling to the manager.
    HeaderList merged = headers;
    merged += authHeaders;
    t->setHeaders(merged);
    // Lets the task adopt the real Content-Disposition filename, categorised.
    t->setNameResolver([this](const QString &name) { return pathForName(name); });
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
    // Surface a server-provided (Content-Disposition) rename to the UI/dashboard.
    connect(t, &DownloadTask::renamedTo, this,
            [this, t](const QString &name) { emit taskRenamed(t->id(), name); });
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

void DownloadEngine::ensureTorrents()
{
    if (m_torrents)
        return;
    m_torrents = new TorrentManager(this);
    connect(m_torrents, &TorrentManager::progress,     this, &DownloadEngine::taskProgress);
    connect(m_torrents, &TorrentManager::stateChanged, this, &DownloadEngine::taskStateChanged);
    connect(m_torrents, &TorrentManager::finished,     this, &DownloadEngine::taskFinished);
}

QString DownloadEngine::nameOf(int id) const
{
    if (auto *t = m_tasks.value(id)) return t->fileName();
    if (auto *g = m_grabbers.value(id)) return g->fileName();
    if (auto *y = m_siteVideos.value(id)) return y->fileName();
    if (m_torrents && m_torrents->has(id)) return m_torrents->nameOf(id);
    return QStringLiteral("download");
}

DownloadState DownloadEngine::stateOf(int id) const
{
    if (auto *t = m_tasks.value(id)) return t->state();
    if (auto *g = m_grabbers.value(id)) return g->state();
    if (auto *y = m_siteVideos.value(id)) return y->state();
    if (m_torrents && m_torrents->has(id)) return m_torrents->stateOf(id);
    return DownloadState::Queued;
}

bool DownloadEngine::allTerminal() const
{
    if (m_tasks.isEmpty() && m_grabbers.isEmpty() && m_siteVideos.isEmpty() &&
        m_torrentIds.isEmpty())
        return false;
    auto terminal = [](DownloadState s) {
        return s == DownloadState::Completed || s == DownloadState::Error;
    };
    for (auto *t : m_tasks)
        if (!terminal(t->state())) return false;
    for (auto *g : m_grabbers)
        if (!terminal(g->state())) return false;
    for (auto *y : m_siteVideos)
        if (!terminal(y->state())) return false;
    for (int id : m_torrentIds)
        if (!terminal(m_torrents->stateOf(id))) return false;
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
    } else if (auto *y = m_siteVideos.value(id)) {
        y->cancel();
    } else if (m_torrents && m_torrentIds.contains(id)) {
        m_torrents->pause(id);
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
    } else if (auto *y = m_siteVideos.value(id)) {
        y->start();        // yt-dlp resumes its .part files
    } else if (m_torrents && m_torrentIds.contains(id)) {
        m_torrents->resume(id);
    }
}

void DownloadEngine::remove(int id, bool deleteFile)
{
    if (m_torrents && m_torrentIds.contains(id)) {
        m_torrents->remove(id, deleteFile);
        m_torrentIds.remove(id);
        emit taskRemoved(id);
        return;
    }

    if (auto *y = m_siteVideos.take(id)) {
        const QString path = y->savePath();
        y->cancel();
        y->deleteLater();
        if (deleteFile && !path.isEmpty())
            QFile::remove(path);
        emit taskRemoved(id);
        return;
    }

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
        t->setNameResolver([this](const QString &name) { return pathForName(name); });
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

bool DownloadEngine::aiAvailable() const
{
    return m_ai && m_ai->isConfigured();
}

void DownloadEngine::runAiCommand(const QString &naturalLanguage)
{
    if (!aiAvailable())
        return;
    m_ai->interpretCommand(naturalLanguage, [this](const QJsonObject &obj) {
        const QJsonArray downloads = obj.value(QStringLiteral("downloads")).toArray();
        const QJsonObject schedule = obj.value(QStringLiteral("schedule")).toObject();
        const QString atIso = schedule.value(QStringLiteral("atIso")).toString();
        const QDateTime when = atIso.isEmpty()
                                   ? QDateTime()
                                   : QDateTime::fromString(atIso, Qt::ISODate);

        for (const QJsonValue &d : downloads) {
            const QString u = d.toObject().value(QStringLiteral("url")).toString().trimmed();
            if (u.isEmpty())
                continue;
            const QUrl url = QUrl::fromUserInput(u);
            if (when.isValid() && when > QDateTime::currentDateTime())
                scheduleDownload(url, when);
            else
                addDownload(url);
        }
    });
}

} // namespace nexa
