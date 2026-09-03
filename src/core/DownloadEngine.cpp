#include "core/DownloadEngine.h"
#include "web/PublicUrlPolicy.h"
#include "core/DownloadTask.h"
#include "core/Database.h"
#include "core/Portable.h"
#include "grabber/HlsGrabber.h"
#include "torrent/TorrentManager.h"
#include "site/YtDlpGrabber.h"
#include "site/MegaGrabber.h"
#include "site/SpotifyGrabber.h"
#include "ai/AiClient.h"
#include "auth/AuthenticationManager.h"
#include "auth/BrowserLogin.h"
#include "auth/CloudProviders.h"
#include "core/RateLimiter.h"
#include "license/LicenseManager.h"

#include <QNetworkAccessManager>
#include <QNetworkRequest>
#include <QNetworkReply>
#include <QStandardPaths>
#include <QFileInfo>
#include <QDir>
#include <QFile>
#include <QUrlQuery>
#include <QTimer>
#include <QRegularExpression>
#include <QJsonObject>
#include <QJsonArray>
#include <QUuid>
#include <climits>
#include <algorithm>

namespace nexa {

static QString safeBasename(QString name)
{
    // Keep only a filename component. This protects IPC/browser suggestions and
    // server-provided names from escaping the configured download directory.
    name.replace(QLatin1Char('\\'), QLatin1Char('/'));
    name = QFileInfo(name).fileName().trimmed();
    for (QChar &c : name) {
        if (c.unicode() < 0x20 || c == QChar(0x7f) ||
            c == QLatin1Char(':') || c == QLatin1Char('*') ||
            c == QLatin1Char('?') || c == QLatin1Char('"') ||
            c == QLatin1Char('<') || c == QLatin1Char('>') ||
            c == QLatin1Char('|') || c == QLatin1Char('%') ||
            c == QLatin1Char('(') || c == QLatin1Char(')') ||
            c == QLatin1Char('{') || c == QLatin1Char('}') ||
            c == QLatin1Char(','))
            c = QLatin1Char('_');
    }
    if (name == QLatin1String(".") || name == QLatin1String(".."))
        name.clear();
    return name.left(240);
}

DownloadEngine::DownloadEngine(QObject *parent)
    : QObject(parent)
{
    m_nam = new QNetworkAccessManager(this);
    m_db = new Database();
    m_limiter = new RateLimiter(this);   // global HTTP speed cap (0 = unlimited)

    const QString dataDir =
        portable::appDataDir();
    m_db->open(dataDir + QStringLiteral("/nexa.db"));

    m_downloadDir =
        QStandardPaths::writableLocation(QStandardPaths::DownloadLocation);
    if (m_downloadDir.isEmpty())
        m_downloadDir = QDir::homePath() + QStringLiteral("/Downloads");

    // The licence manager first: AiClient authenticates with the token it
    // holds, since the AI helpers are server-side and entitlement-gated.
    m_license = new LicenseManager(this);
    m_ai = new AiClient(m_license, this);
    connect(m_license, &LicenseManager::entitlementChanged,
            this, &DownloadEngine::applyLicensePlan);

    // Domain-scoped authentication (cookies.txt / bearer tokens). One instance
    // owned here; addDownload() resolves auth per URL and hands the APPLIED result
    // (yt-dlp flags / HeaderList) to the download classes. Config is optional.
    m_auth = new AuthenticationManager(this);

    // Data-driven cloud provider registry — single source of truth for all
    // host/sibling/routing decisions. Loaded from the embedded JSON resource.
    m_providers = new CloudProviders();
    if (m_providers->load()) {
        YtDlpGrabber::setCloudProviders(m_providers);
        browserlogin::setCloudProviders(m_providers);
    } else {
        qWarning() << "CloudProviders failed to load — falling back to hardcoded lists";
    }

    // The provider registry must be installed BEFORE autoEnableBrowserLogins():
    // Google Drive's CDN is drive.usercontent.google.com, so the correct shared
    // credential domain is google.com rather than only drive.google.com.
    autoEnableBrowserLogins();   // default the auth sites to "use my browser login"
    m_auth->loadFromJson();      // ~/.config/nexa/auth.json overrides the auto defaults

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
        QUrl safeSource = t->url();
        safeSource.setQuery(QUrlQuery());
        safeSource.setFragment(QString());
        m_ai->suggestFilename(t->fileName(), safeSource.toString(), QString(),
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

void DownloadEngine::setMaxConcurrent(int n)
{
    m_requestedMaxConcurrent = qMax(1, n);
    m_maxConcurrent = m_licensePlan == QLatin1String("free")
        ? qMin(3, m_requestedMaxConcurrent) : m_requestedMaxConcurrent;
    schedule();
}

void DownloadEngine::setAiRename(bool on)
{
    m_aiRenameRequested = on;
    m_aiRename = on && m_licensePlan != QLatin1String("free");
}

void DownloadEngine::applyLicensePlan(const QString &plan)
{
    m_licensePlan = (plan == QLatin1String("pro") || plan == QLatin1String("team"))
        ? plan : QStringLiteral("free");

    // Entitlements come from the licence server; the plan name is only the
    // fallback for a build talking to an older backend. Reading them here keeps
    // every gate in the engine driven by one source.
    //
    // Deliberately the *verified* read, not the cheap cached features(): this
    // seeds the engine's own m_authSiteDownloads / m_aiRename / cap, which other
    // gates then trust, so those cached flags are themselves guard-derived and
    // fold to Free if the licence state was tampered with. It also lives in a
    // different translation unit from verifiedFeatures(), so it is one more,
    // differently-shaped place the check has to be defeated.
    const Entitlements f = m_license->verifiedFeatures();
    const int cap = f.maxConcurrentDownloads;
    m_maxConcurrent = cap > 0 ? qMin(cap, m_requestedMaxConcurrent) : m_requestedMaxConcurrent;
    m_aiRename = m_aiRenameRequested && f.aiRename;
    m_authSiteDownloads = f.authSiteDownloads;
    schedule();
}

// Does this URL point at a site that needs a logged-in session? Matches the
// provider list when one is loaded, so adding a site to cloud_providers.json
// gates it here too without touching this file.
bool DownloadEngine::isAuthSiteUrl(const QUrl &url) const
{
    const QString host = url.host().toLower();
    if (host.isEmpty())
        return false;
    const QStringList sites = m_providers ? m_providers->authSites() : browserlogin::authSites();
    for (const QString &candidate : sites) {
        const QString d = candidate.toLower();
        if (host == d || host.endsWith(QLatin1Char('.') + d))
            return true;
    }
    return false;
}

// Default every known auth site to "use my logged-in browser" so the user never
// has to open Site Logins. yt-dlp reads the cookies LIVE from the browser on each
// download (--cookies-from-browser), so they're always current — old cookies are
// never cached or reused; each run re-reads whatever the browser holds now. We
// also pick the browser PROFILE actually logged into each site (e.g. a "School"
// profile), so a non-default profile's session is used. Runs BEFORE loadFromJson,
// so an explicit auth.json/Site-Logins credential still wins for that domain.
void DownloadEngine::autoEnableBrowserLogins()
{
    const QString browser = browserlogin::detectBrowser();
    if (browser.isEmpty())
        return;   // no supported browser on disk — leave auth to manual config
    const QStringList sites = browserlogin::authSites();
    const QHash<QString, QString> profiles = browserlogin::bestProfiles(browser, sites);
    for (const QString &domain : sites)
        m_auth->registerBrowserCookies(domain, browser, profiles.value(domain));
}

void DownloadEngine::refreshBrowserLoginFor(const QUrl &url)
{
    const QString host = url.host().toLower();
    QString domain;
    for (const QString &candidate : m_providers->authSites()) {
        const QString d = candidate.toLower();
        if ((host == d || host.endsWith(QLatin1Char('.') + d))
            && d.size() > domain.size()) {
            domain = d;
        }
    }
    if (domain.isEmpty())
        return;

    // Never replace an explicit cookies.txt or bearer credential. A missing
    // credential, or an automatically registered browser credential, is safe to
    // refresh because the browser may have been opened after Nexa started or the
    // user may have switched profiles since the previous download.
    const DomainAuth current = m_auth->resolve(url);
    if (current.kind != DomainAuth::Kind::None
        && current.kind != DomainAuth::Kind::BrowserCookies)
        return;

    const QString browser = browserlogin::detectBrowser();
    if (browser.isEmpty())
        return;
    const QString profile = browserlogin::bestProfileForDomain(browser, domain);
    m_auth->registerBrowserCookies(domain, browser, profile);
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
    ids.append(m_megaGrabbers.keys());
    ids.append(m_siteVideos.keys());     // yt-dlp video/playlist grabs
    ids.append(m_spotifyGrabbers.keys()); // Spotify track/album/playlist grabs
    ids.append(m_torrentIds.values());
    std::sort(ids.begin(), ids.end());
    ids.erase(std::unique(ids.begin(), ids.end()), ids.end());

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
    // Destroy everything that might touch the engine/DB on teardown BEFORE the DB
    // is freed. These are QObject children, so Qt would otherwise delete them
    // AFTER this body runs — i.e. after `delete m_db` — and a grabber/torrent
    // emitting a final state or running a pending callback would hit a freed DB.
    qDeleteAll(m_tasks);            m_tasks.clear();
    qDeleteAll(m_grabbers);        m_grabbers.clear();
    qDeleteAll(m_megaGrabbers);    m_megaGrabbers.clear();
    qDeleteAll(m_siteVideos);     m_siteVideos.clear();
    qDeleteAll(m_spotifyGrabbers); m_spotifyGrabbers.clear();
    delete m_torrents;             m_torrents = nullptr;
    m_torrentIds.clear();          // prevent allTerminal()/stateOf() null-deref on queued signals
    m_playlistIds.clear();
    m_held.clear();
    m_pending.clear();
    qDeleteAll(m_scheduledTimers); m_scheduledTimers.clear();
    delete m_ai;                   m_ai = nullptr;
    delete m_providers;            m_providers = nullptr;
    if (m_db) {
        m_db->close();
        delete m_db;
        m_db = nullptr;
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
    QString name = safeBasename(fileName);
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

// Apple Music CDN serves AAC audio in an MP4 container but names the files
// .mp4 — rename them to .m4a so they land in the Audio folder and open in
// audio players without confusion.
static QString normalizeAppleMusicFilename(const QUrl &url, QString name)
{
    const QString host = url.host().toLower();
    if (!host.endsWith(QLatin1String(".itunes.apple.com"))
        && host != QLatin1String("itunes.apple.com"))
        return name;
    if (QFileInfo(name).suffix().toLower() != QLatin1String("mp4"))
        return name;
    if (!name.contains(QLatin1String("aac"), Qt::CaseInsensitive))
        return name;
    name.chop(3);   // remove "mp4"
    name += QStringLiteral("m4a");
    return name;
}

// The browser extension sends a request-specific Cookie header. Prefer it over
// a domain credential file when both are present: QNetworkRequest replaces an
// earlier header with the later one, and the credential file may contain a
// reduced/stale view of the browser's cookie jar (especially for Google, where
// several cookies share names across sibling hosts).
static HeaderList mergeAuthHeaders(const HeaderList &captured,
                                   const HeaderList &auth)
{
    HeaderList merged = captured;
    for (const auto &candidate : auth) {
        const QByteArray name = candidate.first.toLower();
        const bool alreadyCaptured = std::any_of(
            captured.cbegin(), captured.cend(), [&name](const auto &h) {
                return h.first.toLower() == name;
            });
        if (!alreadyCaptured)
            merged.append(candidate);
    }
    return merged;
}

QString DownloadEngine::resolveSavePath(const QUrl &url, const QString &savePath) const
{
    if (!savePath.isEmpty())
        return savePath;
    const QString raw = QFileInfo(url.path()).fileName();
    return pathForName(normalizeAppleMusicFilename(url, raw));
}

int DownloadEngine::addDownload(const QUrl &url, const QString &savePath,
                                const HeaderList &headers, const QString &suggestedName,
                                const QString &siteFormat, bool playlist, bool userInitiated,
                                const QString &audioFormat, bool publicNetworkOnly)
{
    if (!url.isValid() || url.scheme().isEmpty())
        return -1;

    constexpr int kMaxTrackedJobs = 10000;
    const int tracked = m_tasks.size() + m_grabbers.size() + m_siteVideos.size()
                      + m_megaGrabbers.size() + m_spotifyGrabbers.size()
                      + m_torrentIds.size() + m_scheduledTimers.size();
    if (tracked >= kMaxTrackedJobs)
        return -1;

    // Login-gated course sites (Udemy, Coursera, LinkedIn Learning…) are a paid
    // feature. Refuse before any work is queued or a row appears, so the user
    // gets one clear explanation instead of a download that fails later for a
    // reason that looks like a bug.
    //
    // Be honest about what this is: a purely client-side gate. The server
    // decides the *plan*, but it is never consulted at download time — the
    // download goes straight to the course site with the user's own cookies.
    // A patched build will always be able to pass this check. It is kept
    // because it is the honest behaviour for an unmodified client, not because
    // it is unbreakable. Anything that must be unforgeable has to be something
    // the client cannot compute alone.
    // Deliberately a second, independent read. m_authSiteDownloads is the
    // cached copy every other gate uses; verifiedFeatures() re-runs the
    // Ed25519 check against the token itself. They live in different
    // translation units and fail differently, so getting past this needs both
    // a patched bool here and a defeated signature there, not one edit.
    const bool authSitesAllowed = m_authSiteDownloads
        && (!m_license || m_license->verifiedFeatures().authSiteDownloads);
    if (isAuthSiteUrl(url) && !authSitesAllowed) {
        emit downloadBlocked(url,
            tr("Downloading from %1 needs Nexa Pro. Start the free 7-day trial in Settings, "
               "or see nexadownloadmanager.com/pricing.").arg(url.host()));
        return -1;
    }

    const int id = m_db->nextId();
    // IDM-style: hold an externally-added download for confirmation instead of
    // starting it. Torrents/magnets are excluded (they're add-and-seed and don't
    // map cleanly onto the held flow); the manual New Download dialog passes
    // userInitiated=true because the user already confirmed there.
    const bool hold = m_confirmBeforeStart && !userInitiated;

    // Browser sessions can be created after Nexa starts. Refresh the automatic
    // browser credential lazily so an enrolled Udemy course opened later still
    // uses the current logged-in profile/cookies.
    if (m_providers)
        refreshBrowserLoginFor(url);

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

    // Google Drive file links use the native HTTP task when the extension (or a
    // cookies.txt credential) supplied request cookies. That path understands
    // Drive's confirm page, adopts Content-Disposition's real filename, and
    // emits byte-level progress just like every other segmented HTTP download.
    // Keep the yt-dlp fallback for a GUI-only/private link where the only
    // available credential is --cookies-from-browser; QNetworkAccessManager
    // cannot read Chrome's encrypted cookie store itself.
    const bool directFile = YtDlpGrabber::isDirectFileUrl(url);
    const bool driveHttp = m_providers && m_providers->isGoogleDriveFileUrl(url);
    const bool browserCookieFallback = authArgs.contains(QStringLiteral("--cookies-from-browser"))
                                    && authHeaders.isEmpty()
                                    && !std::any_of(headers.cbegin(), headers.cend(),
                                        [](const auto &h) {
                                            const QByteArray name = h.first.toLower();
                                            return name == QByteArrayLiteral("cookie")
                                                || name == QByteArrayLiteral("authorization");
                                        });
    if (directFile && YtDlpGrabber::available() && (!driveHttp || browserCookieFallback)) {
        const QString fixedName = suggestedName.isEmpty()
            ? QString() : QFileInfo(safeBasename(suggestedName)).completeBaseName();
        auto *g = new YtDlpGrabber(id, url, m_downloadDir, fixedName, QString(),
                                   headers, authArgs, /*playlist=*/false, this);
        g->setDirectFile(YtDlpGrabber::detectCookieBrowser());
        m_siteVideos.insert(id, g);
        connect(g, &YtDlpGrabber::progress,     this, &DownloadEngine::taskProgress);
        connect(g, &YtDlpGrabber::stateChanged, this, &DownloadEngine::taskStateChanged);
        connect(g, &YtDlpGrabber::finished,     this, &DownloadEngine::taskFinished);
        connect(g, &YtDlpGrabber::renamed,      this, &DownloadEngine::taskRenamed);
        if (hold) { m_held.insert(id); emit confirmRequested(id); return id; }
        emit taskAdded(id);
        g->start();
        return id;
    }

    // YouTube & other yt-dlp sites: drive yt-dlp (handles ciphers/SABR + mux).
    if (YtDlpGrabber::isSiteVideoUrl(url) && YtDlpGrabber::available()) {
        const QString videoDir = m_autoCategorize
            ? QDir(m_downloadDir).filePath(categoryFor(QStringLiteral("a.mp4")))  // Video/
            : m_downloadDir;
        const QString fixedName = suggestedName.isEmpty()
            ? QString()
            : QFileInfo(safeBasename(suggestedName)).completeBaseName();
        const QString fmt = YtDlpGrabber::formatForQuality(siteFormat);
        auto *g = new YtDlpGrabber(id, url, videoDir, fixedName, fmt, headers, authArgs,
                                   playlist, this);
        g->setSubtitles(m_embedSubs, m_subLangs);
        g->setAudioFormat(audioFormat);   // no-op unless this is an audio-only site
        g->setPlaylistConcurrency(m_plConcurrency);
        m_siteVideos.insert(id, g);
        if (playlist)
            m_playlistIds.insert(id);   // suppress the single-file details plate
        connect(g, &YtDlpGrabber::progress,     this, &DownloadEngine::taskProgress);
        connect(g, &YtDlpGrabber::stateChanged, this, &DownloadEngine::taskStateChanged);
        connect(g, &YtDlpGrabber::finished,     this, &DownloadEngine::taskFinished);
        connect(g, &YtDlpGrabber::renamed,      this, &DownloadEngine::taskRenamed);
        if (hold) { m_held.insert(id); emit confirmRequested(id); return id; }
        emit taskAdded(id);
        g->start();
        return id;
    }

    // MEGA.nz encrypted cloud storage: route through MegaGrabber, which handles
    // the MEGA API protocol + AES-128-CBC decryption.
    if (MegaGrabber::isMegaUrl(url)) {
        QString out = savePath;
        if (out.isEmpty())
            out = pathForName(QStringLiteral("mega-download.bin"));
        QDir().mkpath(QFileInfo(out).absolutePath());
        auto *g = new MegaGrabber(id, url, QFileInfo(out).absolutePath(), m_nam, this);
        m_megaGrabbers.insert(id, g);
        connect(g, &MegaGrabber::progress,     this, &DownloadEngine::taskProgress);
        connect(g, &MegaGrabber::stateChanged, this, &DownloadEngine::taskStateChanged);
        connect(g, &MegaGrabber::finished,     this, &DownloadEngine::taskFinished);
        if (hold) { m_held.insert(id); emit confirmRequested(id); return id; }
        emit taskAdded(id);
        g->start();
        return id;
    }

    // Spotify tracks/albums/playlists: the web stream is Widevine-DRM, so we
    // resolve public metadata and grab an unencrypted 30s preview (p.scdn.co)
    // or, when yt-dlp is available, a full YouTube audio match tagged with the
    // Spotify metadata + album art. See SpotifyGrabber.
    if (SpotifyGrabber::isSpotifyUrl(url)) {
        const QString audioDir = m_autoCategorize
            ? QDir(m_downloadDir).filePath(QStringLiteral("Audio"))
            : m_downloadDir;
        QDir().mkpath(audioDir);
        auto *g = new SpotifyGrabber(id, url, audioDir, m_nam, this);
        g->setAudioFormat(audioFormat.isEmpty() ? QStringLiteral("mp3") : audioFormat);
        m_spotifyGrabbers.insert(id, g);
        connect(g, &SpotifyGrabber::progress,     this, &DownloadEngine::taskProgress);
        connect(g, &SpotifyGrabber::stateChanged, this, &DownloadEngine::taskStateChanged);
        connect(g, &SpotifyGrabber::finished,     this, &DownloadEngine::taskFinished);
        if (hold) { m_held.insert(id); emit confirmRequested(id); return id; }
        emit taskAdded(id);
        g->start();
        return id;
    }

    // Spotify CDN audio streams (audio-ak.spotifycdn.com/…) are Widevine-DRM
    // encrypted MP4s — downloading them yields an unplayable file (plays a few
    // seconds of cleartext header, then silence). Reject with a clear error and
    // point the user at the page URL, which the grabber above can resolve.
    if (SpotifyGrabber::isSpotifyCdnUrl(url)) {
        emit taskAdded(id);
        emit taskStateChanged(id, DownloadState::Error,
            QStringLiteral("Spotify streams are Widevine-DRM encrypted and cannot be "
                           "downloaded. Paste the Spotify track/album/playlist link "
                           "(open.spotify.com/…) instead."));
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

        // libtorrent loads a magnet URI or a LOCAL .torrent file — never an
        // http(s) URL (the in-engine .torrent fetch was dropped in libtorrent 2).
        // So a remote .torrent is downloaded first, then its local copy is added.
        const bool isMagnet = asText.startsWith(QStringLiteral("magnet:"), Qt::CaseInsensitive);
        const bool isRemote = url.scheme() == QLatin1String("http") ||
                              url.scheme() == QLatin1String("https");
        if (!isMagnet && isRemote) {
            HeaderList merged = headers;
            merged += authHeaders;
            fetchTorrentFile(id, url, dir, merged);   // async; drives state itself
            return id;
        }

        if (!m_torrents || !m_torrents->add(id, asText, dir)) {   // magnet or local .torrent
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
        g->setConcurrency(m_streamConcurrency);
        g->setCredentialScope(m_providers, url.host());
        g->setPublicNetworkOnly(publicNetworkOnly);
        m_grabbers.insert(id, g);
        connect(g, &HlsGrabber::progress,     this, &DownloadEngine::taskProgress);
        connect(g, &HlsGrabber::stateChanged, this, &DownloadEngine::taskStateChanged);
        connect(g, &HlsGrabber::finished,     this, &DownloadEngine::taskFinished);
        if (hold) { m_held.insert(id); emit confirmRequested(id); return id; }
        emit taskAdded(id);
        g->start();
        return id;
    }

    QString path = resolveSavePath(url, savePath);
    if (savePath.isEmpty() && !suggestedName.isEmpty()) {
        const QString urlName = QFileInfo(url.path()).fileName();
        const QString lowerName = urlName.toLower();
        // Attachment endpoints commonly end in a generic token such as
        // /download (ChatGPT uses this shape). Prefer the browser's filename
        // in that case; otherwise a successful handoff is saved under a
        // useless name and looks like a failed download to the user.
        const bool opaqueUrlName = urlName.isEmpty() || !urlName.contains(QLatin1Char('.'))
                                || lowerName == QLatin1String("download")
                                || lowerName == QLatin1String("file");
        if (opaqueUrlName)
            path = pathForName(suggestedName);
    }

    auto *t = new DownloadTask(id, url, path, m_nam, m_db, this);
    t->setRateLimiter(m_limiter);
    t->setCloudProviders(m_providers);
    t->setPublicNetworkOnly(publicNetworkOnly);
    // Merge domain-scoped auth into the browser headers; SegmentDownloader replays
    // them via its existing setRawHeader loop, with no coupling to the manager.
    HeaderList merged = mergeAuthHeaders(headers, authHeaders);
    t->setHeaders(merged);
    // Lets the task adopt the real Content-Disposition filename, categorised.
    t->setNameResolver([this](const QString &name) { return pathForName(name); });
    m_tasks.insert(id, t);
    wireTask(t);

    if (hold) { m_held.insert(id); emit confirmRequested(id); return id; }
    // Create the queue record before probing starts. A crash while this task is
    // queued or in the probe phase must not make the user's download disappear
    // from the next startup; credentials themselves are intentionally not stored
    // in SQLite and are reacquired from the auth manager on resume.
    if (m_db)
        m_db->saveTask(*t, t->segments());
    emit taskAdded(id);
    m_pending.append(id);   // honour the concurrency limit instead of starting now
    schedule();
    if (m_pending.contains(id) && m_licensePlan == QLatin1String("free")
        && m_requestedMaxConcurrent > m_maxConcurrent)
        emit freeLimitReached(id);   // queued only because of the Free cap
    return id;
}

// ---- IDM-style held-download confirmation actions -------------------------

void DownloadEngine::startHeld(int id)
{
    if (!m_held.remove(id))
        return;
    m_resolvedNames.remove(id);
    emit taskAdded(id);                 // the row appears now, on confirmation
    if (m_tasks.contains(id)) {          // plain HTTP/FTP
        m_pending.append(id);
        schedule();
        if (m_pending.contains(id) && m_licensePlan == QLatin1String("free")
            && m_requestedMaxConcurrent > m_maxConcurrent)
            emit freeLimitReached(id);
    } else if (auto *g = m_grabbers.value(id)) {     // HLS
        g->start();
    } else if (auto *m = m_megaGrabbers.value(id)) { // MEGA
        m->start();
    } else if (auto *y = m_siteVideos.value(id)) {   // yt-dlp site video
        y->start();
    } else if (auto *s = m_spotifyGrabbers.value(id)) { // Spotify
        s->start();
    }
}

void DownloadEngine::holdLater(int id)
{
    if (!m_held.remove(id))
        return;
    m_resolvedNames.remove(id);
    emit taskAdded(id);                 // row appears, but left paused/idle
    emit taskStateChanged(id, DownloadState::Paused, QStringLiteral("queued"));
}

void DownloadEngine::cancelHeld(int id)
{
    if (!m_held.remove(id))
        return;
    m_resolvedNames.remove(id);
    // Destroy the created-but-never-started object; no row was ever emitted.
    if (auto *t = m_tasks.take(id))       t->deleteLater();
    if (auto *g = m_grabbers.take(id))    g->deleteLater();
    if (auto *m = m_megaGrabbers.take(id)) m->deleteLater();
    if (auto *y = m_siteVideos.take(id))  y->deleteLater();
    if (auto *s = m_spotifyGrabbers.take(id)) s->deleteLater();
    m_playlistIds.remove(id);
}

void DownloadEngine::setSaveLocation(int id, const QString &folder, const QString &fileName)
{
    const QString f = folder.trimmed();
    if (f.isEmpty())
        return;
    QDir().mkpath(f);
    if (auto *t = m_tasks.value(id)) {               // HTTP/FTP: full path
        const QString name = safeBasename(fileName).isEmpty()
            ? QFileInfo(t->savePath()).fileName() : fileName.trimmed();
        t->setSavePath(QDir(f).filePath(safeBasename(name)));
    } else if (auto *g = m_grabbers.value(id)) {     // HLS: full path
        const QString name = safeBasename(fileName).isEmpty()
            ? QFileInfo(g->savePath()).fileName() : fileName.trimmed();
        g->setSavePath(QDir(f).filePath(safeBasename(name)));
    } else if (auto *m = m_megaGrabbers.value(id)) { // MEGA: just the dir (files are named internally)
        Q_UNUSED(m);  // MegaGrabber names its own output; ignore folder override for now
    } else if (auto *y = m_siteVideos.value(id)) {   // yt-dlp: redirect the output dir
        y->setOutputDir(f);
    } else if (auto *s = m_spotifyGrabbers.value(id)) { // Spotify: redirect the output dir
        s->setOutputDir(f);
    }
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
    // Apply any caps the user set before the (lazily created) session existed.
    m_torrents->setSpeedLimits(m_torrentDlLimit, m_torrentUlLimit);
    m_torrents->setSeedRatio(m_seedRatio);
}

void DownloadEngine::setSpeedLimit(qint64 bytesPerSec)
{
    if (m_limiter)
        m_limiter->setLimit(bytesPerSec);
}

qint64 DownloadEngine::speedLimit() const
{
    return m_limiter ? m_limiter->limit() : 0;
}

void DownloadEngine::setTaskSpeedLimit(int id, qint64 bytesPerSec)
{
    if (DownloadTask *t = m_tasks.value(id))
        t->setSpeedLimit(bytesPerSec);
}

qint64 DownloadEngine::taskSpeedLimit(int id) const
{
    DownloadTask *t = m_tasks.value(id);
    return t ? t->speedLimit() : 0;
}

void DownloadEngine::setTorrentSpeedLimits(int downloadBytesPerSec, int uploadBytesPerSec)
{
    m_torrentDlLimit = qMax(0, downloadBytesPerSec);
    m_torrentUlLimit = qMax(0, uploadBytesPerSec);
    if (m_torrents)
        m_torrents->setSpeedLimits(m_torrentDlLimit, m_torrentUlLimit);
}

void DownloadEngine::setSeedRatio(double ratio)
{
    m_seedRatio = qMax(0.0, ratio);
    if (m_torrents)
        m_torrents->setSeedRatio(m_seedRatio);
}

void DownloadEngine::fetchTorrentFile(int id, const QUrl &url, const QString &saveDir,
                                      const HeaderList &headers)
{
    emit taskStateChanged(id, DownloadState::Probing, QStringLiteral("fetching .torrent…"));

    QNetworkRequest req(url);
    for (const auto &h : headers)
        req.setRawHeader(h.first, h.second);
    // cdimage.kali.org → kali.download is a 302; follow redirects to the file.
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::NoLessSafeRedirectPolicy);

    QNetworkReply *reply = m_nam->get(req);
    connect(reply, &QNetworkReply::finished, this, [this, id, saveDir, reply]() {
        reply->deleteLater();
        if (!m_torrentIds.contains(id))            // removed while in flight
            return;
        if (reply->error() != QNetworkReply::NoError) {
            emit taskStateChanged(id, DownloadState::Error,
                QStringLiteral("could not fetch .torrent: %1").arg(reply->errorString()));
            m_torrentIds.remove(id);
            return;
        }
        const QByteArray data = reply->readAll();
        // Bound the body: a real .torrent is tiny; anything huge is a hostile/wrong
        // response we shouldn't buffer or hand to libtorrent.
        if (data.size() > 16 * 1024 * 1024) {
            emit taskStateChanged(id, DownloadState::Error, QStringLiteral(".torrent too large"));
            m_torrentIds.remove(id);
            return;
        }
        // A .torrent is a bencoded dictionary, so it must begin with 'd'. This
        // rejects an HTML error/login page served with a 200.
        if (!data.startsWith('d')) {
            emit taskStateChanged(id, DownloadState::Error,
                QStringLiteral("not a valid .torrent (got %1 bytes)").arg(data.size()));
            m_torrentIds.remove(id);
            return;
        }
        QDir().mkpath(saveDir);
        const QString tmp = QDir(QStandardPaths::writableLocation(QStandardPaths::TempLocation))
                           .filePath(QStringLiteral("nexa-%1.torrent")
                                     .arg(QUuid::createUuid().toString(QUuid::Id128)));
        QFile f(tmp);
        if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
            emit taskStateChanged(id, DownloadState::Error, QStringLiteral("cannot write temp .torrent"));
            m_torrentIds.remove(id);
            return;
        }
        if (f.write(data) != data.size()) {
            f.close();
            QFile::remove(tmp);
            emit taskStateChanged(id, DownloadState::Error,
                                  QStringLiteral("cannot write temporary .torrent"));
            m_torrentIds.remove(id);
            return;
        }
        if (!f.flush()) {
            f.close();
            QFile::remove(tmp);
            emit taskStateChanged(id, DownloadState::Error,
                                  QStringLiteral("cannot flush temporary .torrent"));
            m_torrentIds.remove(id);
            return;
        }
        f.close();
        QFile::setPermissions(tmp, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
        if (!m_torrents) {                         // session torn down meanwhile
            m_torrentIds.remove(id);
            return;
        }
        if (!m_torrents->add(id, tmp, saveDir))    // add() emits its own Error on failure
            m_torrentIds.remove(id);
    });
}

QString DownloadEngine::nameOf(int id) const
{
    if (auto *t = m_tasks.value(id)) return t->fileName();
    if (auto *g = m_grabbers.value(id)) return g->fileName();
    if (auto *m = m_megaGrabbers.value(id)) return m->fileName();
    if (auto *y = m_siteVideos.value(id)) return y->fileName();
    if (auto *s = m_spotifyGrabbers.value(id)) return s->fileName();
    if (m_torrents && m_torrents->has(id)) return m_torrents->nameOf(id);
    return QStringLiteral("download");
}

DownloadState DownloadEngine::stateOf(int id) const
{
    if (m_held.contains(id)) return DownloadState::Paused;   // awaiting confirm prompt
    if (auto *t = m_tasks.value(id)) return t->state();
    if (auto *g = m_grabbers.value(id)) return g->state();
    if (auto *m = m_megaGrabbers.value(id)) return m->state();
    if (auto *y = m_siteVideos.value(id)) return y->state();
    if (auto *s = m_spotifyGrabbers.value(id)) return s->state();
    if (m_torrents && m_torrents->has(id)) return m_torrents->stateOf(id);
    return DownloadState::Queued;
}

QString DownloadEngine::hostOf(int id) const
{
    QUrl u;
    if (auto *t = m_tasks.value(id)) u = t->url();
    else if (auto *g = m_grabbers.value(id)) u = g->url();
    else if (auto *m = m_megaGrabbers.value(id)) u = m->url();
    else if (auto *y = m_siteVideos.value(id)) u = y->url();
    else if (auto *s = m_spotifyGrabbers.value(id)) u = s->url();
    else if (m_torrents && m_torrents->has(id)) return QStringLiteral("peer swarm");
    const QString h = u.host();
    return h.isEmpty() ? QStringLiteral("local file") : h;
}

QString DownloadEngine::savePathOf(int id) const
{
    if (auto *t = m_tasks.value(id)) return t->savePath();
    if (auto *g = m_grabbers.value(id)) return g->savePath();
    if (auto *m = m_megaGrabbers.value(id)) return m->savePath();
    if (auto *y = m_siteVideos.value(id)) return y->savePath();
    if (auto *s = m_spotifyGrabbers.value(id)) return s->savePath();
    return QString();
}

QString DownloadEngine::urlOf(int id) const
{
    if (auto *t = m_tasks.value(id)) return t->url().toString();
    if (auto *g = m_grabbers.value(id)) return g->url().toString();
    if (auto *m = m_megaGrabbers.value(id)) return m->url().toString();
    if (auto *y = m_siteVideos.value(id)) return y->url().toString();
    if (auto *s = m_spotifyGrabbers.value(id)) return s->url().toString();
    return QString();   // torrents have no single source URL
}

bool DownloadEngine::isResumable(int id) const
{
    // HTTP downloads resume only if the server honours Range (learned on probe,
    // or from a 206 seen on the live transfer).
    if (auto *t = m_tasks.value(id)) return t->rangesSupported();
    // HLS and MEGA grabs have NO partial resume — a (re)start re-downloads from
    // scratch (see HlsGrabber / MegaGrabber). Be honest: No.
    if (m_grabbers.contains(id)) return false;
    if (m_megaGrabbers.contains(id)) return false;
    if (m_spotifyGrabbers.contains(id)) return false;
    // Torrents (libtorrent keeps the piece bitfield) and yt-dlp grabs (--continue
    // partial files / skip already-saved playlist items) resume. Yes.
    return true;
}

// Lightweight pre-download probe so the confirm prompt can show the REAL filename
// (from Content-Disposition or the final redirected URL) instead of a URL token —
// just like IDM. Only meaningful for plain HTTP downloads (grabbers name videos
// from their title). Sensitive headers (Cookie/Authorization) are deliberately
// NOT sent on this throwaway request, so a cross-host redirect can't leak them.
void DownloadEngine::resolveName(int id)
{
    auto *t = m_tasks.value(id);
    if (!t || m_megaGrabbers.contains(id)) {
        // Grabbers (HLS/yt-dlp) name from their title, not Content-Disposition —
        // nothing to probe, so signal "done" immediately (no prompt-open delay).
        emit nameResolved(id, QString());
        return;
    }
    QNetworkRequest req(t->url());
    req.setHeader(QNetworkRequest::UserAgentHeader, QStringLiteral("Nexa/0.1"));
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::NoLessSafeRedirectPolicy);
    req.setRawHeader("Accept-Encoding", "identity");
    req.setRawHeader("Range", "bytes=0-0");
    for (const auto &h : t->headers()) {
        const QByteArray l = h.first.toLower();
        if (l == "cookie" || l == "authorization")
            continue;
        req.setRawHeader(h.first, h.second);
    }
    QNetworkReply *reply = m_nam->get(req);
    connect(reply, &QNetworkReply::finished, this, [this, id, reply]() {
        reply->deleteLater();
        if (!m_held.contains(id))
            return;   // user already started/cancelled it
        QString name = DownloadTask::filenameFromContentDisposition(
            reply->rawHeader("Content-Disposition"));
        if (name.isEmpty()) {
            const QString fn = QFileInfo(reply->url().path()).fileName();
            if (fn.contains(QLatin1Char('.')))   // a real filename, not a bare token
                name = fn;
        }
        if (!name.isEmpty()) {
            m_resolvedNames.insert(id, name);   // remembered so the prompt opens with it
            emit nameResolved(id, name);
        } else {
            emit nameResolved(id, QString());   // probe done, nothing better than the token
        }
    });
}

void DownloadEngine::reorderQueue(const QList<int> &idsInDisplayOrder)
{
    QList<int> np;
    np.reserve(m_pending.size());
    // Take the queued ids in the order the UI presents them...
    for (int id : idsInDisplayOrder)
        if (m_pending.contains(id) && !np.contains(id))
            np.append(id);
    // ...then keep any still-pending ids the list didn't mention (safety).
    for (int id : m_pending)
        if (!np.contains(id))
            np.append(id);
    m_pending = np;
    schedule();
}

bool DownloadEngine::allTerminal() const
{
    if (m_tasks.isEmpty() && m_grabbers.isEmpty() && m_megaGrabbers.isEmpty() &&
        m_siteVideos.isEmpty() && m_spotifyGrabbers.isEmpty() && m_torrentIds.isEmpty())
        return false;
    auto terminal = [](DownloadState s) {
        return s == DownloadState::Completed || s == DownloadState::Error;
    };
    for (auto *t : m_tasks)
        if (!terminal(t->state())) return false;
    for (auto *g : m_grabbers)
        if (!terminal(g->state())) return false;
    for (auto *m : m_megaGrabbers)
        if (!terminal(m->state())) return false;
    for (auto *y : m_siteVideos)
        if (!terminal(y->state())) return false;
    for (auto *s : m_spotifyGrabbers)
        if (!terminal(s->state())) return false;
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
    } else if (auto *m = m_megaGrabbers.value(id)) {
        m->cancel();
    } else if (auto *y = m_siteVideos.value(id)) {
        y->cancel();
    } else if (auto *s = m_spotifyGrabbers.value(id)) {
        s->cancel();
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
    } else if (auto *m = m_megaGrabbers.value(id)) {
        m->start();        // mega downloads restart from scratch too
    } else if (auto *s = m_spotifyGrabbers.value(id)) {
        s->start();        // spotify grabs restart from scratch too
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
        m_playlistIds.remove(id);
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

    if (auto *m = m_megaGrabbers.take(id)) {
        const QString path = m->savePath();
        m->cancel();
        m->deleteLater();
        if (deleteFile && !path.isEmpty())
            QFile::remove(path);
        emit taskRemoved(id);
        return;
    }

    if (auto *s = m_spotifyGrabbers.take(id)) {
        const QString path = s->savePath();
        s->cancel();
        s->deleteLater();
        if (deleteFile && !path.isEmpty() && QFileInfo(path).isFile())
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

int DownloadEngine::clearCompleted()
{
    // Snapshot first: remove() mutates the maps we'd otherwise be iterating.
    int cleared = 0;
    const auto snap = snapshot();
    for (const auto &s : snap) {
        if (s.state == DownloadState::Completed) {
            remove(s.id, false);   // keep the file; just drop it from the list
            ++cleared;
        }
    }
    if (m_db)
        m_db->clearCompleted(0);   // scrub any persisted completed rows too
    return cleared;
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
        t->setRateLimiter(m_limiter);
        t->setCloudProviders(m_providers);
        t->setNameResolver([this](const QString &name) { return pathForName(name); });
        if (!rec.segments.isEmpty())
            t->restore(rec.total, rec.segments, rec.rangesSupported, rec.etag, rec.lastModified);
        m_tasks.insert(rec.id, t);
        // Restore the byte counts into the same cache used by live progress
        // signals, so the UI can render sizes for completed/paused rows on the
        // first startup snapshot as well.
        m_progress.insert(rec.id, ProgressInfo{t->doneBytes(), t->totalBytes(), 0.0});
        wireTask(t);
        emit taskAdded(rec.id);
    }
    // Scheduled jobs come back too (a job whose time passed while Nexa was
    // closed starts right away). Headers weren't persisted, so these run without
    // the original browser cookies.
    const QVector<ScheduledRecord> jobs = m_db->loadScheduled();
    for (const ScheduledRecord &rec : jobs) {
        const QUrl url(rec.url);
        if (!url.isValid() || m_scheduled.contains(rec.id)) {
            m_db->removeScheduled(rec.id);
            continue;
        }
        armScheduled(rec.id, url, QDateTime::fromMSecsSinceEpoch(rec.startAtMs), {}, rec.name);
        emit scheduledAdded(rec.id);
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
    if (a > b || (b - a) > 10000)      // bound task expansion from untrusted batches
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

// Schemes accepted from UNTRUSTED, multi-token entry points (the LAN dashboard
// and the AI command). Whole-string validation upstream is not enough: addBatch
// splits on whitespace, so each expanded token must be re-checked here. Notably
// NOT file:// — a remote client must never make Nexa read a local file. (The
// trusted local UI may still hand addDownload() a local .torrent directly.)
static bool isAllowedRemoteScheme(const QUrl &url)
{
    const QString s = url.scheme().toLower();
    return s == QStringLiteral("http") || s == QStringLiteral("https")
        || s == QStringLiteral("magnet");
}

QList<int> DownloadEngine::addBatch(const QString &text, const HeaderList &headers)
{
    constexpr int kMaxBatchItems = 10000;
    QList<int> ids;
    static const QRegularExpression ws(QStringLiteral("\\s+"));
    const QStringList tokens = text.split(ws, Qt::SkipEmptyParts);
    for (const QString &token : tokens) {
        for (const QString &expanded : expandPattern(token)) {
            if (ids.size() >= kMaxBatchItems)
                return ids;
            const QUrl url = QUrl::fromUserInput(expanded);
            if (!url.isValid() || !isAllowedRemoteScheme(url))
                continue;   // drop file:// and any non-network token per-item
            const int id = addDownload(url, QString(), headers);
            if (id >= 0)
                ids.append(id);
        }
    }
    return ids;
}

int DownloadEngine::addRemoteDownload(const QUrl &url)
{
    if (!isPublicHttpUrl(url))
        return -1;

    // The same paid gate addDownload() applies. This path builds its own task
    // rather than going through addDownload(), so without repeating the check
    // the phone-remote dashboard was a complete way around it: a Free install
    // could queue a Udemy download from its own web API with no licence
    // tampering whatsoever.
    // Deliberately a second, independent read. m_authSiteDownloads is the
    // cached copy every other gate uses; verifiedFeatures() re-runs the
    // Ed25519 check against the token itself. They live in different
    // translation units and fail differently, so getting past this needs both
    // a patched bool here and a defeated signature there, not one edit.
    const bool authSitesAllowed = m_authSiteDownloads
        && (!m_license || m_license->verifiedFeatures().authSiteDownloads);
    if (isAuthSiteUrl(url) && !authSitesAllowed) {
        emit downloadBlocked(url,
            tr("Downloading from %1 needs Nexa Pro. Start the free 7-day trial in Settings, "
               "or see nexadownloadmanager.com/pricing.").arg(url.host()));
        return -1;
    }

    const int id = m_db->nextId();
    auto *task = new DownloadTask(id, url, resolveSavePath(url, QString()), m_nam, m_db, this);
    task->setRateLimiter(m_limiter);
    task->setCloudProviders(m_providers);
    task->setPublicNetworkOnly(true);
    task->setNameResolver([this](const QString &name) { return pathForName(name); });
    m_tasks.insert(id, task);
    wireTask(task);
    emit taskAdded(id);
    m_pending.append(id);
    schedule();
    return id;
}

QList<int> DownloadEngine::addRemoteBatch(const QString &text)
{
    constexpr int kMaxBatchItems = 10000;
    QList<int> ids;
    static const QRegularExpression whitespace(QStringLiteral("\\s+"));
    const QStringList tokens = text.split(whitespace, Qt::SkipEmptyParts);
    for (const QString &token : tokens) {
        for (const QString &expanded : expandPattern(token)) {
            if (ids.size() >= kMaxBatchItems)
                return ids;
            const int id = addRemoteDownload(QUrl::fromUserInput(expanded));
            if (id >= 0)
                ids.append(id);
        }
    }
    return ids;
}

int DownloadEngine::scheduleDownload(const QUrl &url, const QDateTime &when,
                                     const HeaderList &headers, const QString &name)
{
    if (!url.isValid() || !isAllowedRemoteScheme(url))
        return -1;
    const qint64 ms = QDateTime::currentDateTime().msecsTo(when);
    if (ms <= 0)
        return addDownload(url, QString(), headers, name, QString(), false, /*userInitiated=*/true);

    // Reserve an id NOW so the job can be listed/cancelled before it fires.
    static int fallbackId = 1000000;
    const int id = m_db ? m_db->nextId() : fallbackId++;
    if (m_db)
        m_db->saveScheduled(id, url.toString(), when.toMSecsSinceEpoch(), name);
    armScheduled(id, url, when, headers, name);
    emit scheduledAdded(id);
    return id;
}

void DownloadEngine::armScheduled(int id, const QUrl &url, const QDateTime &when,
                                  const HeaderList &headers, const QString &name)
{
    m_scheduled.insert(id, ScheduledJob{id, url, when, name});
    auto *timer = new QTimer(this);
    timer->setSingleShot(true);
    // QTimer tops out at ~24 days; wake at most daily and re-check the clock,
    // which also copes with suspend/resume and clock changes.
    static constexpr qint64 kMaxWaitMs = 24LL * 3600 * 1000;
    const qint64 ms = qMax<qint64>(0, QDateTime::currentDateTime().msecsTo(when));
    timer->setInterval(int(qMin(ms, kMaxWaitMs)));
    connect(timer, &QTimer::timeout, this, [this, id, url, headers, name, timer]() {
        if (!m_scheduled.contains(id)) {
            // Cancelled while this timeout was already queued — drop it silently.
            timer->deleteLater();
            m_scheduledTimers.remove(id);
            return;
        }
        const qint64 left = QDateTime::currentDateTime().msecsTo(m_scheduled.value(id).when);
        if (left > 1000) {
            timer->start(int(qMin(left, kMaxWaitMs)));
            return;
        }
        timer->deleteLater();
        m_scheduledTimers.remove(id);
        m_scheduled.remove(id);
        if (m_db)
            m_db->removeScheduled(id);
        emit scheduledRemoved(id);
        addDownload(url, QString(), headers, name, QString(), false, /*userInitiated=*/true);
    });
    m_scheduledTimers.insert(id, timer);
    timer->start();
}

bool DownloadEngine::cancelScheduled(int id)
{
    QTimer *timer = m_scheduledTimers.take(id);
    if (!timer && !m_scheduled.contains(id))
        return false;
    if (timer) {
        timer->stop();
        timer->deleteLater();
    }
    m_scheduled.remove(id);
    if (m_db)
        m_db->removeScheduled(id);
    emit scheduledRemoved(id);
    return true;
}

QVector<DownloadEngine::ScheduledJob> DownloadEngine::scheduledJobs() const
{
    QVector<ScheduledJob> jobs;
    jobs.reserve(m_scheduled.size());
    for (const ScheduledJob &j : m_scheduled)
        jobs.append(j);
    std::sort(jobs.begin(), jobs.end(),
              [](const ScheduledJob &a, const ScheduledJob &b) { return a.when < b.when; });
    return jobs;
}

bool DownloadEngine::aiAvailable() const
{
    return m_ai && m_ai->isConfigured();
}

void DownloadEngine::runAiCommand(const QString &naturalLanguage)
{
    if (!aiAvailable() || m_licensePlan == QLatin1String("free"))
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
            if (!url.isValid() || !isAllowedRemoteScheme(url))
                continue;   // the model's output is untrusted — never file:// etc.
            if (when.isValid() && when > QDateTime::currentDateTime())
                scheduleDownload(url, when);
            else
                addDownload(url);
        }
    });
}

} // namespace nexa
