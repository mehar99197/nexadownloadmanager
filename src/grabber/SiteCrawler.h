#pragma once
#include <QDateTime>
#include <QElapsedTimer>
#include <QHash>
#include <QObject>
#include <QQueue>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QUrl>
#include <QVector>

#include "core/Types.h"

class QNetworkAccessManager;
class QNetworkReply;
class QTimer;

namespace nexa {

class DownloadEngine;

// One website-grab session: walk a site's pages from a seed URL and queue the
// files found on them as ordinary downloads.
//
// Two rules shape the whole class and are worth stating before the fields:
//
//  - Everything it fetches comes from somebody else's markup. A page can point
//    the crawler at http://192.168.1.1/ or a cloud metadata address, so every
//    URL — the seed, robots.txt, each page, each file — is checked against
//    isPublicHttpUrl() before a request is made. A crawler is a confused
//    deputy by construction; this is the control that stops it being one.
//
//  - The save path is derived from a URL path, which is attacker-controlled
//    text. Segments are sanitised individually and the finished path is
//    verified to still be inside the save folder, because "../../.." in a URL
//    is a file write anywhere on disk otherwise.
struct CrawlConfig {
    QUrl seedUrl;
    int maxDepth = 3;              // clamped to kMaxDepthCeiling
    int maxFiles = 1000;           // 0 = "as many as the ceiling allows"
    qint64 maxTotalSize = 0;       // 0 = unlimited
    qint64 minFileSize = 0;
    qint64 maxFileSize = 0;
    // Wildcards matched against the FILE NAME, not the whole path, so the
    // obvious "*.jpg" does what it looks like.
    QStringList includePatterns;
    QStringList excludePatterns;
    bool sameDomainOnly = true;
    bool preserveStructure = true;
    bool respectRobotsTxt = true;
    int requestDelayMs = 200;      // politeness gap between requests
    int maxConcurrent = 3;
    QString saveFolder;
    QString userAgent;
    HeaderList headers;

    static CrawlConfig forImages(const QUrl &url, const QString &saveFolder);
    static CrawlConfig forVideos(const QUrl &url, const QString &saveFolder);
    static CrawlConfig forDocuments(const QUrl &url, const QString &saveFolder);
    static CrawlConfig forAllFiles(const QUrl &url, const QString &saveFolder);
    static CrawlConfig forOffline(const QUrl &url, const QString &saveFolder);
};

enum class CrawlStatus { Idle, Running, Paused, Completed, Cancelled, Error };

struct CrawlFileResult {
    QUrl    url;
    QString localPath;
    qint64  size = 0;
    QString error;
    bool    success = false;
    bool    skipped = false;
};

struct CrawlSummary {
    int    pagesCrawled = 0;
    int    filesFound = 0;
    int    filesDownloaded = 0;
    int    filesFailed = 0;
    int    filesSkipped = 0;
    qint64 totalBytes = 0;
    int    durationMs = 0;
    QString errorMessage;
};

class SiteCrawler : public QObject {
    Q_OBJECT
public:
    // Hard ceilings. A crawl is a loop over data the crawler does not control,
    // so it needs a bound that no configuration can remove: a site that
    // generates links (a calendar, a session id in the path) is otherwise an
    // infinite walk.
    static constexpr int kMaxDepthCeiling = 12;
    static constexpr int kMaxFilesCeiling = 20000;
    static constexpr int kMaxQueuedPages  = 50000;
    static constexpr int kRequestTimeoutMs = 20000;

    explicit SiteCrawler(DownloadEngine *engine, QObject *parent = nullptr);
    ~SiteCrawler() override;

    void start(const CrawlConfig &config);
    void pause();
    void resume();
    void cancel(bool saveSession = false);

    CrawlStatus  status() const { return m_status; }
    CrawlConfig  config() const { return m_config; }
    CrawlSummary summary() const;

    // --- pure helpers, exercised directly by the tests -------------------
    // Turn a URL into an absolute save path under `saveFolder`, or an empty
    // string when the result would escape it.
    static QString safeSavePath(const QString &saveFolder, const QUrl &url,
                                bool preserveStructure);
    // Does this URL name a page to walk rather than a file to fetch?
    static bool looksLikePage(const QUrl &url);
    // robots.txt verdict for `path`, honouring Allow as well as Disallow and
    // letting the longest matching rule win, which is what crawlers agree on.
    static bool robotsAllows(const QString &robotsTxt, const QString &userAgent,
                             const QString &path);
    static bool matchesAnyPattern(const QStringList &patterns, const QString &fileName);

signals:
    void pageCrawled(const QUrl &url, int filesFound);
    void fileFound(const QUrl &fileUrl, const QString &mimeType, qint64 size);
    void fileDownloading(const QUrl &fileUrl, const QString &localPath);
    void fileDownloaded(const CrawlFileResult &result);
    void fileFailed(const QUrl &fileUrl, const QString &error);
    void pageFailed(const QUrl &pageUrl, const QString &error);
    void progress(int pagesCrawled, int filesFound, int filesDownloaded);
    void finished(const CrawlSummary &summary);
    void error(const QString &message);

private slots:
    void onRobotsTxtFetched();
    void onPageFetched();
    void onFileHeadFinished();
    void onEngineTaskFinished(int id);
    void onEngineTaskState(int id, nexa::DownloadState state, const QString &detail);
    void onEngineTaskRemoved(int id);
    void pump();

private:
    void setStatus(CrawlStatus s);
    void schedulePump();              // the ONLY way the loop continues
    void finish(CrawlStatus how);
    void abortCurrentReply();
    void fetchRobotsTxt();
    void fetchPage(const QUrl &url, int depth);
    void parsePage(const QByteArray &body, const QUrl &baseUrl, int depth);
    void considerFile(const QUrl &url, int *foundOnPage);
    void considerPage(const QUrl &url, int depth, const QUrl &baseUrl);
    void checkFile(const QUrl &url);
    void queueDownload(const QUrl &url, const QString &mimeType, qint64 size);
    void releaseSlot(int id, bool ok, const QString &detail);
    bool allowedByRobots(const QUrl &url) const;
    bool reachable(const QUrl &url) const;   // public-internet policy + scheme
    int  fileBudgetRemaining() const;

    DownloadEngine        *m_engine;
    QNetworkAccessManager *m_nam = nullptr;
    QTimer                *m_pumpTimer = nullptr;

    CrawlConfig m_config;
    CrawlStatus m_status = CrawlStatus::Idle;

    // `m_seenPages` holds everything ever ENQUEUED, not just everything
    // fetched. Checking only the fetched set let the same URL sit in the queue
    // a hundred times, which is how a crawl of a small site turned into one of
    // a large one.
    QSet<QString>            m_seenPages;
    QQueue<QPair<QUrl, int>> m_pageQueue;
    QSet<QString>            m_seenFiles;
    QQueue<QUrl>             m_fileQueue;

    QNetworkReply *m_currentReply = nullptr;
    QUrl           m_currentPageUrl;
    int            m_currentDepth = 0;

    int    m_pagesCrawled = 0;
    int    m_filesFound = 0;
    int    m_filesDownloaded = 0;
    int    m_filesFailed = 0;
    int    m_filesSkipped = 0;
    qint64 m_totalBytes = 0;

    // id -> what we asked the engine for, so a finished/errored/removed task
    // gives its concurrency slot back. Without this the crawler stopped dead
    // after `maxConcurrent` files and never reported finishing.
    struct Pending { QUrl url; QString localPath; qint64 size = 0; };
    QHash<int, Pending> m_pending;

    QString        m_robotsTxt;
    QDateTime      m_startTime;
    QElapsedTimer  m_clock;
};

} // namespace nexa

Q_DECLARE_METATYPE(nexa::CrawlConfig)
Q_DECLARE_METATYPE(nexa::CrawlSummary)
Q_DECLARE_METATYPE(nexa::CrawlFileResult)
