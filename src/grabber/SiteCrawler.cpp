#include "grabber/SiteCrawler.h"

#include "core/DownloadEngine.h"
#include "web/PublicUrlPolicy.h"

#include <QDir>
#include <QFileInfo>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRegularExpression>
#include <QTimer>

namespace nexa {

namespace {

const QStringList kImageExts = {
    QStringLiteral("jpg"), QStringLiteral("jpeg"), QStringLiteral("png"),
    QStringLiteral("gif"), QStringLiteral("webp"), QStringLiteral("svg"),
    QStringLiteral("bmp"), QStringLiteral("tiff"), QStringLiteral("ico"),
};

const QStringList kVideoExts = {
    QStringLiteral("mp4"), QStringLiteral("mkv"), QStringLiteral("webm"),
    QStringLiteral("avi"), QStringLiteral("mov"), QStringLiteral("m4v"),
    QStringLiteral("flv"), QStringLiteral("wmv"),
};

const QStringList kDocExts = {
    QStringLiteral("pdf"), QStringLiteral("doc"), QStringLiteral("docx"),
    QStringLiteral("xls"), QStringLiteral("xlsx"), QStringLiteral("ppt"),
    QStringLiteral("pptx"), QStringLiteral("txt"), QStringLiteral("epub"),
};

// Extensions that mean "this is a page", plus no extension at all. Without
// this list every link to /about.html was queued as a file to download AND as
// a page to walk, so a crawl saved the site's HTML twice over.
const QStringList kPageExts = {
    QStringLiteral("html"), QStringLiteral("htm"),  QStringLiteral("xhtml"),
    QStringLiteral("shtml"), QStringLiteral("php"), QStringLiteral("asp"),
    QStringLiteral("aspx"), QStringLiteral("jsp"),  QStringLiteral("cgi"),
    QStringLiteral("do"),   QStringLiteral("action"),
};

QStringList patternsFor(const QStringList &exts)
{
    QStringList out;
    for (const QString &e : exts)
        out << QStringLiteral("*.") + e;
    return out;
}

// One path segment, made safe to put on a filesystem.
//
// Returns an empty string for anything that must not become a directory: "..",
// ".", and (on Windows) a segment carrying a drive colon. The caller drops
// empty results rather than substituting something, because silently turning
// ".." into "__" still lets a crafted path build a directory tree the user did
// not ask for.
// Every outgoing request is shaped here: identified user agent, the caller's
// headers, a transfer timeout (a hung server used to stall the crawl for good,
// since only one page is ever in flight) and a redirect policy that will not
// downgrade https to http.
QNetworkRequest buildRequest(const CrawlConfig &cfg, const QUrl &url)
{
    QNetworkRequest req(url);
    req.setRawHeader("User-Agent", cfg.userAgent.toUtf8());
    for (const auto &h : cfg.headers)
        req.setRawHeader(h.first, h.second);
    req.setTransferTimeout(SiteCrawler::kRequestTimeoutMs);
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::NoLessSafeRedirectPolicy);
    req.setMaximumRedirectsAllowed(5);
    return req;
}

QString safeSegment(QString seg)
{
    seg = QUrl::fromPercentEncoding(seg.toUtf8()).trimmed();
    if (seg.isEmpty() || seg == QLatin1String(".") || seg == QLatin1String(".."))
        return QString();
    // Characters no filesystem we target accepts, plus the colon that would
    // make "C:" a drive reference on Windows.
    static const QRegularExpression bad(QStringLiteral("[<>:\"|?*\\\\/\\x00-\\x1f]"));
    seg.replace(bad, QStringLiteral("_"));
    seg = makeFileNamePortable(seg);
    if (seg.isEmpty() || seg == QLatin1String(".") || seg == QLatin1String(".."))
        return QString();
    return seg.left(120);
}

} // namespace

CrawlConfig CrawlConfig::forImages(const QUrl &url, const QString &saveFolder)
{
    CrawlConfig c;
    c.seedUrl = url;
    c.saveFolder = saveFolder;
    c.includePatterns = patternsFor(kImageExts);
    return c;
}

CrawlConfig CrawlConfig::forVideos(const QUrl &url, const QString &saveFolder)
{
    CrawlConfig c;
    c.seedUrl = url;
    c.saveFolder = saveFolder;
    c.includePatterns = patternsFor(kVideoExts);
    return c;
}

CrawlConfig CrawlConfig::forDocuments(const QUrl &url, const QString &saveFolder)
{
    CrawlConfig c;
    c.seedUrl = url;
    c.saveFolder = saveFolder;
    c.includePatterns = patternsFor(kDocExts);
    return c;
}

CrawlConfig CrawlConfig::forAllFiles(const QUrl &url, const QString &saveFolder)
{
    CrawlConfig c;
    c.seedUrl = url;
    c.saveFolder = saveFolder;
    return c;   // no include patterns = take everything that is not a page
}

CrawlConfig CrawlConfig::forOffline(const QUrl &url, const QString &saveFolder)
{
    CrawlConfig c;
    c.seedUrl = url;
    c.saveFolder = saveFolder;
    // Was depth 999 with no file limit, which is not "offline copy of a site",
    // it is "download the internet". Deep enough for a real site, bounded
    // enough to finish.
    c.maxDepth = 5;
    c.maxFiles = 5000;
    c.sameDomainOnly = true;
    c.preserveStructure = true;
    return c;
}

SiteCrawler::SiteCrawler(DownloadEngine *engine, QObject *parent)
    : QObject(parent), m_engine(engine)
{
    m_nam = new QNetworkAccessManager(this);
    m_pumpTimer = new QTimer(this);
    m_pumpTimer->setSingleShot(true);
    connect(m_pumpTimer, &QTimer::timeout, this, &SiteCrawler::pump);

    // The crawler does not download files itself — it hands them to the engine
    // and waits. These three are how a concurrency slot comes back; without
    // them the crawl stalled after `maxConcurrent` files and never finished.
    if (m_engine) {
        connect(m_engine, &DownloadEngine::taskFinished,
                this, &SiteCrawler::onEngineTaskFinished);
        connect(m_engine, &DownloadEngine::taskStateChanged,
                this, &SiteCrawler::onEngineTaskState);
        connect(m_engine, &DownloadEngine::taskRemoved,
                this, &SiteCrawler::onEngineTaskRemoved);
    }
}

SiteCrawler::~SiteCrawler()
{
    abortCurrentReply();
}

void SiteCrawler::abortCurrentReply()
{
    if (!m_currentReply)
        return;
    QNetworkReply *reply = m_currentReply;
    m_currentReply = nullptr;          // cleared first: abort() fires finished()
    reply->disconnect(this);
    reply->abort();
    reply->deleteLater();
}

void SiteCrawler::start(const CrawlConfig &config)
{
    if (m_status == CrawlStatus::Running || m_status == CrawlStatus::Paused)
        return;

    m_config = config;
    m_config.maxDepth = qBound(0, m_config.maxDepth, kMaxDepthCeiling);
    m_config.maxConcurrent = qBound(1, m_config.maxConcurrent, 8);
    m_config.requestDelayMs = qBound(0, m_config.requestDelayMs, 60000);
    if (m_config.maxFiles <= 0 || m_config.maxFiles > kMaxFilesCeiling)
        m_config.maxFiles = kMaxFilesCeiling;
    if (m_config.userAgent.trimmed().isEmpty()) {
        // A crawler with no User-Agent is refused by a good share of sites and
        // is impolite besides: an operator should be able to see who called.
        m_config.userAgent = QStringLiteral("Mozilla/5.0 (compatible; NexaGrabber/1.0; +https://nexadownloadmanager.com)");
    }

    m_seenPages.clear();
    m_pageQueue.clear();
    m_seenFiles.clear();
    m_fileQueue.clear();
    m_pending.clear();
    m_pagesCrawled = m_filesFound = m_filesDownloaded = 0;
    m_filesFailed = m_filesSkipped = 0;
    m_totalBytes = 0;
    m_robotsTxt.clear();
    m_startTime = QDateTime::currentDateTime();
    m_clock.start();

    if (m_config.saveFolder.trimmed().isEmpty()) {
        setStatus(CrawlStatus::Error);
        emit error(tr("Choose a folder to save into first."));
        emit finished(summary());
        return;
    }
    // The seed comes from a text box, so it gets the same check as everything
    // the crawl finds later: no file://, no localhost, no private ranges.
    if (!reachable(m_config.seedUrl)) {
        setStatus(CrawlStatus::Error);
        emit error(tr("That address cannot be grabbed: only public http:// and https:// "
                      "sites are allowed."));
        emit finished(summary());
        return;
    }

    setStatus(CrawlStatus::Running);
    m_seenPages.insert(m_config.seedUrl.toString(QUrl::RemoveFragment));
    m_pageQueue.enqueue({m_config.seedUrl, 0});

    if (m_config.respectRobotsTxt)
        fetchRobotsTxt();
    else
        schedulePump();
}

void SiteCrawler::pause()
{
    if (m_status != CrawlStatus::Running)
        return;
    setStatus(CrawlStatus::Paused);
    m_pumpTimer->stop();
    // The page being fetched is put back so resuming re-reads it. It was
    // already marked seen, so without this it would simply be skipped.
    if (m_currentReply && m_currentPageUrl.isValid())
        m_pageQueue.prepend({m_currentPageUrl, m_currentDepth});
    abortCurrentReply();
}

void SiteCrawler::resume()
{
    if (m_status != CrawlStatus::Paused)
        return;
    setStatus(CrawlStatus::Running);
    schedulePump();
}

void SiteCrawler::cancel(bool)
{
    if (m_status != CrawlStatus::Running && m_status != CrawlStatus::Paused)
        return;
    m_pumpTimer->stop();
    abortCurrentReply();
    m_pageQueue.clear();
    m_fileQueue.clear();
    finish(CrawlStatus::Cancelled);
}

CrawlSummary SiteCrawler::summary() const
{
    CrawlSummary s;
    s.pagesCrawled = m_pagesCrawled;
    s.filesFound = m_filesFound;
    s.filesDownloaded = m_filesDownloaded;
    s.filesFailed = m_filesFailed;
    s.filesSkipped = m_filesSkipped;
    s.totalBytes = m_totalBytes;
    s.durationMs = int(m_clock.isValid() ? m_clock.elapsed() : 0);
    return s;
}

void SiteCrawler::setStatus(CrawlStatus s) { m_status = s; }

void SiteCrawler::finish(CrawlStatus how)
{
    if (m_status == CrawlStatus::Completed || m_status == CrawlStatus::Cancelled
        || m_status == CrawlStatus::Error)
        return;                        // finished() is emitted exactly once
    setStatus(how);
    emit finished(summary());
}

void SiteCrawler::schedulePump()
{
    if (m_status != CrawlStatus::Running)
        return;
    if (!m_pumpTimer->isActive())
        m_pumpTimer->start(m_config.requestDelayMs);
}

int SiteCrawler::fileBudgetRemaining() const
{
    return m_config.maxFiles - (m_filesDownloaded + m_filesFailed + m_filesSkipped
                                + int(m_pending.size()));
}

bool SiteCrawler::reachable(const QUrl &url) const
{
    if (!url.isValid() || url.host().isEmpty())
        return false;
    const QString scheme = url.scheme().toLower();
    if (scheme != QLatin1String("http") && scheme != QLatin1String("https"))
        return false;
    return isPublicHttpUrl(url);
}

void SiteCrawler::fetchRobotsTxt()
{
    QUrl robots = m_config.seedUrl;
    robots.setPath(QStringLiteral("/robots.txt"));
    robots.setQuery(QString());
    robots.setFragment(QString());

    m_currentPageUrl = QUrl();
    m_currentReply = m_nam->get(buildRequest(m_config, robots));
    connect(m_currentReply, &QNetworkReply::finished,
            this, &SiteCrawler::onRobotsTxtFetched);
}

void SiteCrawler::onRobotsTxtFetched()
{
    auto *reply = qobject_cast<QNetworkReply *>(sender());
    if (!reply || reply != m_currentReply)
        return;                        // a reply we already abandoned
    if (reply->error() == QNetworkReply::NoError)
        m_robotsTxt = QString::fromUtf8(reply->readAll().left(512 * 1024));
    m_currentReply = nullptr;
    reply->deleteLater();
    schedulePump();
}

void SiteCrawler::pump()
{
    if (m_status != CrawlStatus::Running)
        return;
    if (m_currentReply)
        return;                        // a page is already in flight

    // Files first: they are the point of the exercise, and finishing the ones
    // already found beats discovering more.
    if (!m_fileQueue.isEmpty()) {
        if (m_pending.size() >= m_config.maxConcurrent)
            return;                    // a slot will free itself and re-pump
        if (fileBudgetRemaining() <= 0) {
            m_fileQueue.clear();
        } else {
            checkFile(m_fileQueue.dequeue());
            return;
        }
    }

    // Then pages, skipping any that have gone past the depth limit.
    while (!m_pageQueue.isEmpty()) {
        const auto [url, depth] = m_pageQueue.dequeue();
        if (depth > m_config.maxDepth)
            continue;                  // was a silent stall: dequeued, then nothing
        fetchPage(url, depth);
        return;
    }

    // Nothing queued and nothing outstanding: that is the end.
    if (m_pending.isEmpty())
        finish(CrawlStatus::Completed);
}

void SiteCrawler::fetchPage(const QUrl &url, int depth)
{
    if (!reachable(url) || !allowedByRobots(url)) {
        schedulePump();
        return;
    }
    m_currentPageUrl = url;
    m_currentDepth = depth;

    QNetworkRequest req = buildRequest(m_config, url);
    req.setRawHeader("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1");
    m_currentReply = m_nam->get(req);
    connect(m_currentReply, &QNetworkReply::finished, this, &SiteCrawler::onPageFetched);
}

void SiteCrawler::onPageFetched()
{
    auto *reply = qobject_cast<QNetworkReply *>(sender());
    if (!reply || reply != m_currentReply)
        return;
    m_currentReply = nullptr;

    const QUrl url = reply->url();
    const int depth = m_currentDepth;
    m_currentPageUrl = QUrl();

    if (reply->error() != QNetworkReply::NoError) {
        // A page that will not load is a page problem, not a file problem —
        // reporting it as fileFailed put phantom rows in the results table.
        emit pageFailed(url, reply->errorString());
        reply->deleteLater();
        schedulePump();
        return;
    }

    // Only parse markup. A 40 MB binary served at a .html URL should not be
    // read into a QString and regex-scanned.
    const QString type = reply->header(QNetworkRequest::ContentTypeHeader).toString().toLower();
    const QByteArray body = reply->readAll().left(8 * 1024 * 1024);
    reply->deleteLater();

    if (!type.isEmpty() && !type.contains(QLatin1String("html"))
        && !type.contains(QLatin1String("xml"))) {
        schedulePump();
        return;
    }

    ++m_pagesCrawled;
    parsePage(body, url, depth);
    schedulePump();
}

bool SiteCrawler::looksLikePage(const QUrl &url)
{
    const QString ext = QFileInfo(url.path()).suffix().toLower();
    if (ext.isEmpty())
        return true;                   // "/docs", "/about/" and friends
    if (ext.size() > 5)
        return true;                   // not really an extension
    return kPageExts.contains(ext);
}

void SiteCrawler::considerFile(const QUrl &url, int *foundOnPage)
{
    if (!reachable(url))
        return;
    const QString key = url.toString(QUrl::RemoveFragment);
    if (m_seenFiles.contains(key))
        return;
    // Include/exclude now apply to every candidate. They used to be checked on
    // <a href> links only, so "images only" still downloaded every <img> on
    // the page and "documents only" downloaded the site's artwork.
    const QString name = QFileInfo(url.path()).fileName();
    if (!m_config.includePatterns.isEmpty()
        && !matchesAnyPattern(m_config.includePatterns, name))
        return;
    if (matchesAnyPattern(m_config.excludePatterns, name))
        return;
    if (fileBudgetRemaining() - m_fileQueue.size() <= 0)
        return;

    m_seenFiles.insert(key);
    m_fileQueue.enqueue(url);
    ++m_filesFound;
    if (foundOnPage)
        ++*foundOnPage;
}

void SiteCrawler::considerPage(const QUrl &url, int depth, const QUrl &baseUrl)
{
    if (depth > m_config.maxDepth)
        return;
    if (m_seenPages.size() >= kMaxQueuedPages)
        return;
    if (!reachable(url))
        return;
    if (m_config.sameDomainOnly && url.host().compare(baseUrl.host(), Qt::CaseInsensitive) != 0)
        return;
    const QString key = url.toString(QUrl::RemoveFragment);
    if (m_seenPages.contains(key))
        return;
    m_seenPages.insert(key);           // marked on ENQUEUE, not on fetch
    m_pageQueue.enqueue({url, depth});
}

void SiteCrawler::parsePage(const QByteArray &body, const QUrl &baseUrl, int depth)
{
    const QString html = QString::fromUtf8(body);
    int foundOnPage = 0;

    // <base href> changes what relative links resolve against; ignoring it
    // pointed every relative link at the wrong directory on sites that use it.
    QUrl base = baseUrl;
    static const QRegularExpression baseRx(
        QStringLiteral("<base[^>]+href\\s*=\\s*[\"']([^\"']+)[\"']"),
        QRegularExpression::CaseInsensitiveOption);
    const auto baseMatch = baseRx.match(html);
    if (baseMatch.hasMatch()) {
        const QUrl candidate = baseUrl.resolved(QUrl(baseMatch.captured(1).trimmed()));
        if (candidate.isValid())
            base = candidate;
    }

    auto resolve = [&base](QString raw) -> QUrl {
        raw = raw.trimmed();
        if (raw.isEmpty() || raw.startsWith(QLatin1Char('#'))
            || raw.startsWith(QLatin1String("javascript:"), Qt::CaseInsensitive)
            || raw.startsWith(QLatin1String("mailto:"), Qt::CaseInsensitive)
            || raw.startsWith(QLatin1String("data:"), Qt::CaseInsensitive))
            return QUrl();
        const QUrl u(raw);
        if (!u.isValid())
            return QUrl();
        return u.isRelative() ? base.resolved(u) : u;
    };

    // Anchors: a file to fetch, or a page to walk, never both.
    static const QRegularExpression aRx(
        QStringLiteral("<a[^>]+href\\s*=\\s*[\"']([^\"']+)[\"']"),
        QRegularExpression::CaseInsensitiveOption);
    auto it = aRx.globalMatch(html);
    while (it.hasNext()) {
        const QUrl link = resolve(it.next().captured(1));
        if (!link.isValid())
            continue;
        if (looksLikePage(link))
            considerPage(link, depth + 1, base);
        else
            considerFile(link, &foundOnPage);
    }

    // Media: img/src, img/srcset, source/src, video, audio, iframe posters.
    static const QRegularExpression mediaRx(
        QStringLiteral("<(?:img|source|video|audio|embed)[^>]+(?:src|data-src)\\s*=\\s*[\"']([^\"']+)[\"']"),
        QRegularExpression::CaseInsensitiveOption);
    it = mediaRx.globalMatch(html);
    while (it.hasNext()) {
        const QUrl link = resolve(it.next().captured(1));
        if (link.isValid() && !looksLikePage(link))
            considerFile(link, &foundOnPage);
    }

    emit pageCrawled(baseUrl, foundOnPage);
    emit progress(m_pagesCrawled, m_filesFound, m_filesDownloaded);
}

void SiteCrawler::checkFile(const QUrl &url)
{
    if (!reachable(url)) {
        schedulePump();
        return;
    }
    QNetworkReply *reply = m_nam->head(buildRequest(m_config, url));
    reply->setProperty("fileUrl", url);
    connect(reply, &QNetworkReply::finished, this, &SiteCrawler::onFileHeadFinished);
}

void SiteCrawler::onFileHeadFinished()
{
    auto *reply = qobject_cast<QNetworkReply *>(sender());
    if (!reply)
        return;
    const QUrl url = reply->property("fileUrl").toUrl();
    const bool failed = reply->error() != QNetworkReply::NoError;
    const int http = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    const qint64 size = reply->header(QNetworkRequest::ContentLengthHeader).toLongLong();
    const QString mime = reply->header(QNetworkRequest::ContentTypeHeader).toString();
    const QString errText = reply->errorString();
    reply->deleteLater();

    if (m_status != CrawlStatus::Running)
        return;

    // Plenty of servers answer HEAD with 405 or 501. Refusing to answer a HEAD
    // is not evidence the file is missing, so fall through to the download and
    // let the engine find out.
    const bool headUnsupported = (http == 405 || http == 501);
    if (failed && !headUnsupported) {
        ++m_filesFailed;
        emit fileFailed(url, errText);
        schedulePump();
        return;
    }

    if (!headUnsupported && size > 0) {
        QString why;
        if (m_config.minFileSize > 0 && size < m_config.minFileSize)
            why = tr("too small");
        else if (m_config.maxFileSize > 0 && size > m_config.maxFileSize)
            why = tr("too large");
        else if (m_config.maxTotalSize > 0 && m_totalBytes + size > m_config.maxTotalSize)
            why = tr("would exceed the total size limit");
        if (!why.isEmpty()) {
            ++m_filesSkipped;
            CrawlFileResult r;
            r.url = url;
            r.size = size;
            r.error = why;
            r.skipped = true;
            emit fileDownloaded(r);
            schedulePump();
            return;
        }
    }

    queueDownload(url, mime, size);
}

void SiteCrawler::queueDownload(const QUrl &url, const QString &mimeType, qint64 size)
{
    const QString savePath = safeSavePath(m_config.saveFolder, url, m_config.preserveStructure);
    if (savePath.isEmpty()) {
        // The URL's path tried to climb out of the save folder, or reduced to
        // nothing usable. Refusing is the whole point of the check.
        ++m_filesSkipped;
        CrawlFileResult r;
        r.url = url;
        r.error = tr("unsafe path");
        r.skipped = true;
        emit fileDownloaded(r);
        schedulePump();
        return;
    }
    QDir().mkpath(QFileInfo(savePath).absolutePath());

    emit fileFound(url, mimeType, size);
    emit fileDownloading(url, savePath);

    const int id = m_engine
        ? m_engine->addDownload(url, savePath, m_config.headers, QString(), QString(),
                                false, /*userInitiated=*/true, QString(),
                                /*publicNetworkOnly=*/true)
        : -1;
    if (id < 0) {
        ++m_filesFailed;
        emit fileFailed(url, tr("Could not queue this download."));
        schedulePump();
        return;
    }
    m_pending.insert(id, Pending{url, savePath, size});
    schedulePump();                    // keep discovering while it downloads
}

void SiteCrawler::releaseSlot(int id, bool ok, const QString &detail)
{
    auto it = m_pending.find(id);
    if (it == m_pending.end())
        return;                        // not one of ours
    const Pending p = it.value();
    m_pending.erase(it);

    CrawlFileResult r;
    r.url = p.url;
    r.localPath = p.localPath;
    r.size = p.size;
    r.success = ok;
    if (ok) {
        ++m_filesDownloaded;
        m_totalBytes += qMax<qint64>(0, p.size);
        emit fileDownloaded(r);
    } else {
        ++m_filesFailed;
        r.error = detail;
        emit fileFailed(p.url, detail);
    }
    emit progress(m_pagesCrawled, m_filesFound, m_filesDownloaded);

    if (m_status == CrawlStatus::Running) {
        schedulePump();
    } else if (m_pending.isEmpty() && m_status == CrawlStatus::Paused) {
        // nothing to do; resume() will pick it up
    }
}

void SiteCrawler::onEngineTaskFinished(int id)
{
    releaseSlot(id, true, QString());
}

void SiteCrawler::onEngineTaskState(int id, nexa::DownloadState state, const QString &detail)
{
    if (state == DownloadState::Error)
        releaseSlot(id, false, detail.isEmpty() ? tr("download failed") : detail);
}

void SiteCrawler::onEngineTaskRemoved(int id)
{
    // The user deleted the row. The slot has to come back or the crawl hangs
    // on a download that no longer exists.
    releaseSlot(id, false, tr("removed"));
}

bool SiteCrawler::allowedByRobots(const QUrl &url) const
{
    if (!m_config.respectRobotsTxt || m_robotsTxt.isEmpty())
        return true;
    // robots.txt was fetched from the seed's host, so it only speaks for that
    // host. Applying it to a different one was simply wrong.
    if (url.host().compare(m_config.seedUrl.host(), Qt::CaseInsensitive) != 0)
        return true;
    return robotsAllows(m_robotsTxt, m_config.userAgent, url.path());
}

bool SiteCrawler::robotsAllows(const QString &robotsTxt, const QString &userAgent,
                               const QString &path)
{
    if (robotsTxt.isEmpty())
        return true;
    const QString target = path.isEmpty() ? QStringLiteral("/") : path;

    // Longest matching rule wins, and Allow beats Disallow at equal length —
    // the convention every major crawler follows. The old version honoured
    // Disallow only, so a site that carved an exception out with Allow had
    // that exception ignored.
    int bestLen = -1;
    bool bestAllow = true;
    bool inScope = false;
    bool sawExactAgent = false;

    auto scan = [&](bool exactAgentPass) {
        inScope = false;
        for (QString line : robotsTxt.split(QLatin1Char('\n'))) {
            const int hash = line.indexOf(QLatin1Char('#'));
            if (hash >= 0)
                line.truncate(hash);
            line = line.trimmed();
            if (line.isEmpty())
                continue;
            const int colon = line.indexOf(QLatin1Char(':'));
            if (colon < 0)
                continue;
            const QString key = line.left(colon).trimmed().toLower();
            const QString value = line.mid(colon + 1).trimmed();

            if (key == QLatin1String("user-agent")) {
                const bool exact = !userAgent.isEmpty()
                    && userAgent.contains(value, Qt::CaseInsensitive) && value != QLatin1String("*");
                if (exact)
                    sawExactAgent = true;
                inScope = exactAgentPass ? exact : (value == QLatin1String("*"));
                continue;
            }
            if (!inScope || value.isEmpty())
                continue;
            if (key != QLatin1String("allow") && key != QLatin1String("disallow"))
                continue;
            // A bare "Disallow:" means nothing is disallowed; handled above by
            // the empty-value skip.
            if (!target.startsWith(value))
                continue;
            const int len = value.size();
            if (len > bestLen || (len == bestLen && key == QLatin1String("allow"))) {
                bestLen = len;
                bestAllow = (key == QLatin1String("allow"));
            }
        }
    };

    scan(true);                        // a section naming us wins outright
    if (!sawExactAgent && bestLen < 0)
        scan(false);                   // otherwise fall back to User-agent: *
    return bestLen < 0 ? true : bestAllow;
}

bool SiteCrawler::matchesAnyPattern(const QStringList &patterns, const QString &fileName)
{
    if (patterns.isEmpty())
        return false;
    for (const QString &p : patterns) {
        const QString trimmed = p.trimmed();
        if (trimmed.isEmpty())
            continue;
        // NonPathWildcardConversion: without it Qt treats '/' as special and
        // "*.jpg" silently matched nothing, so every preset downloaded zero
        // files. Matching the NAME rather than the path is also what a person
        // typing "*.jpg" means.
        //
        // That flag is Qt 6.6; the CI runner and Ubuntu 24.04 are on 6.4, where
        // it does not compile at all. The two conversions differ only in how
        // '*' treats '/' — 6.6 lets it cross a separator, earlier Qt emits
        // [^/]* — and everything here is matched against a bare file name that
        // can never contain one (callers pass QFileInfo::fileName()), so the
        // fallback agrees with it for every input this function can see.
        // SiteCrawlerTest pins that behaviour on both.
#if QT_VERSION >= QT_VERSION_CHECK(6, 6, 0)
        const QRegularExpression rx(
            QRegularExpression::wildcardToRegularExpression(
                trimmed, QRegularExpression::NonPathWildcardConversion),
            QRegularExpression::CaseInsensitiveOption);
#else
        const QRegularExpression rx(
            QRegularExpression::wildcardToRegularExpression(trimmed),
            QRegularExpression::CaseInsensitiveOption);
#endif
        if (rx.match(fileName).hasMatch())
            return true;
    }
    return false;
}

QString SiteCrawler::safeSavePath(const QString &saveFolder, const QUrl &url,
                                  bool preserveStructure)
{
    const QString base = QDir(saveFolder).absolutePath();
    if (base.isEmpty())
        return QString();

    const QStringList raw = url.path().split(QLatin1Char('/'), Qt::SkipEmptyParts);
    QStringList clean;
    for (const QString &seg : raw) {
        const QString s = safeSegment(seg);
        if (!s.isEmpty())
            clean << s;
    }

    QString fileName = clean.isEmpty() ? QString() : clean.takeLast();
    if (fileName.isEmpty()) {
        // "https://host/" and "https://host/dir/" have no name of their own.
        fileName = QStringLiteral("index");
        const QString q = url.query();
        if (!q.isEmpty()) {
            const QString tag = safeSegment(q);
            if (!tag.isEmpty())
                fileName += QLatin1Char('-') + tag.left(40);
        }
    }

    QString path = base;
    if (preserveStructure) {
        for (const QString &seg : clean)
            path += QLatin1Char('/') + seg;
    }
    path += QLatin1Char('/') + fileName;

    // Belt and braces. Every segment was sanitised individually, but the check
    // that actually matters is whether the finished path is still inside the
    // folder the user picked — that is the property being defended, and it is
    // cheap to assert directly.
    const QString clean_ = QDir::cleanPath(path);
    if (clean_ != base && !clean_.startsWith(base + QLatin1Char('/')))
        return QString();
    return clean_;
}

} // namespace nexa
