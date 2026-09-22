#include "core/DownloadTask.h"
#include "web/PublicUrlPolicy.h"
#include "core/SegmentDownloader.h"
#include "core/RateLimiter.h"
#include "core/Database.h"
#include "auth/AuthUtils.h"
#include "auth/CloudProviders.h"

#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QTimer>
#include <QFile>
#include <QFileInfo>
#include <QDir>
#include <QDebug>
#include <QRegularExpression>
#include <QUrlQuery>
#include <QCryptographicHash>
#include <QLocale>
#include <QThread>
#include <algorithm>
#include <memory>

#ifdef Q_OS_WIN
#include <windows.h>
#include <winioctl.h>   // FSCTL_SET_SPARSE — windows.h does not always pull this in
#endif

namespace nexa {

static const bool kDebug = qEnvironmentVariableIsSet("NEXA_DEBUG");

// Shown when a finished download turns out to be DRM-encrypted (e.g. Apple Music
// full tracks). The bytes arrive fine but the samples are encrypted, so the file
// would play as silence — we report that instead of a bogus "Completed".
static const QString kDrmErrorDetail = QStringLiteral(
    "DRM-protected media — the audio/video is encrypted (e.g. Apple Music) and "
    "cannot be played. Only non-DRM previews are downloadable.");

// isSensitiveHeader() — the headers that carry the user's site credentials and
// must NEVER be sent to a host other than the one they were captured for — now
// lives in auth/AuthUtils.h, so the torrent fetch and the stream grabber apply
// exactly the same rule as this file does.

// Two hosts share a credential scope when they're the same host or are explicit
// credential siblings of the same cloud provider. The registry, not naive
// suffix inference, defines those sibling relationships.
static bool sameCredentialScope(const QString &host, const QString &credHost,
                                const CloudProviders *providers)
{
    // An unknown credential origin is never an implicit allow. The normal
    // start path always records m_credHost before the first request; this
    // guard protects restored/error paths from leaking a sensitive header.
    if (credHost.isEmpty())
        return false;
    if (host.compare(credHost, Qt::CaseInsensitive) == 0)
        return true;
    if (providers)
        return providers->sameCredentialScope(host, credHost);
    return false;
}

// Apply the captured headers to `req`, dropping the sensitive ones unless the
// request targets the credential's exact or explicitly approved sibling host.
static void applyScopedHeaders(QNetworkRequest &req, const HeaderList &headers,
                               const QString &credHost, const CloudProviders *providers)
{
    const bool inScope = sameCredentialScope(req.url().host(), credHost, providers);
    // Keep ordinary browser metadata first and credentials last. Besides making
    // the request deterministic, this avoids a few strict HTTP/2 gateways
    // treating a late-added Cookie/User-Agent pair differently from a browser
    // request. Sensitive headers are still omitted outside their credential
    // scope.
    for (const auto &h : headers) {
        if (!isSensitiveHeader(h.first))
            req.setRawHeader(h.first, h.second);
    }
    if (inScope) {
        for (const auto &h : headers) {
            if (isSensitiveHeader(h.first))
                req.setRawHeader(h.first, h.second);
        }
    }
}

// Extract a filename from a Content-Disposition header, handling both the plain
// `filename="x"` form and the RFC 5987 `filename*=UTF-8''x` (percent-encoded)
// form. Returns a sanitised basename, or empty if none. Public static so the
// engine's pre-download name probe can reuse it.
QString DownloadTask::filenameFromContentDisposition(const QByteArray &header)
{
    if (header.isEmpty())
        return QString();
    const QString value = QString::fromUtf8(header);

    const auto decodeFilename = [](QString encoded) {
        // ChatGPT currently double-escapes '+' in both filename forms:
        // C%252B%252B -> C%2B%2B -> C++. Decode at most twice so a literal
        // percent in a user-provided filename is not consumed indefinitely.
        for (int i = 0; i < 2; ++i) {
            const QString decoded = QUrl::fromPercentEncoding(encoded.toUtf8());
            if (decoded == encoded)
                break;
            encoded = decoded;
        }
        return encoded;
    };

    QString name;
    // RFC 5987 extended form takes precedence (carries proper encoding).
    static const QRegularExpression ext(
        QStringLiteral("filename\\*\\s*=\\s*[^']*''([^;]+)"), QRegularExpression::CaseInsensitiveOption);
    static const QRegularExpression plain(
        QStringLiteral("filename\\s*=\\s*\"?([^\";]+)\"?"), QRegularExpression::CaseInsensitiveOption);
    if (const auto m = ext.match(value); m.hasMatch())
        name = decodeFilename(m.captured(1).trimmed());
    else if (const auto m = plain.match(value); m.hasMatch())
        name = decodeFilename(m.captured(1).trimmed());

    name = QFileInfo(name).fileName();                       // strip any path
    name.replace(QRegularExpression(QStringLiteral("[\\\\/:*?\"<>|]")), QString());
    return name.trimmed();
}

DownloadTask::DownloadTask(int id, const QUrl &url, const QString &savePath,
                           QNetworkAccessManager *nam, Database *db, QObject *parent)
    : QObject(parent), m_id(id), m_url(url), m_savePath(savePath), m_nam(nam), m_db(db)
{
    m_speedTimer = new QTimer(this);
    m_speedTimer->setInterval(500);
    connect(m_speedTimer, &QTimer::timeout, this, &DownloadTask::emitSpeedTick);
}

DownloadTask::~DownloadTask()
{
    clearSegments();
    if (m_probe) {
        QNetworkReply *p = m_probe;
        m_probe = nullptr;
        p->disconnect(this);     // never re-enter a slot on a half-destroyed task
        p->abort();
        p->deleteLater();
    }
}

QString DownloadTask::fileName() const
{
    return QFileInfo(m_savePath).fileName();
}

void DownloadTask::setSpeedLimit(qint64 bytesPerSec)
{
    const qint64 bps = qMax<qint64>(0, bytesPerSec);
    if (bps == 0 && !m_taskLimiter)
        return;                       // already unlimited; nothing to build
    if (!m_taskLimiter)
        m_taskLimiter = new RateLimiter(this);
    m_taskLimiter->setLimit(bps);
    // Push it to the workers already running for this download.
    for (SegmentDownloader *w : m_workers)
        if (w)
            w->setTaskRateLimiter(m_taskLimiter);
}

qint64 DownloadTask::speedLimit() const
{
    return m_taskLimiter ? m_taskLimiter->limit() : 0;
}

bool DownloadTask::renameTo(const QString &newFileName)
{
    QString safeName = newFileName;
    safeName.replace(QLatin1Char('\\'), QLatin1Char('/'));
    safeName = QFileInfo(safeName).fileName().trimmed();
    for (QChar &c : safeName) {
        if (c.unicode() < 0x20 || c == QChar(0x7f) ||
            c == QLatin1Char(':') || c == QLatin1Char('*') ||
            c == QLatin1Char('?') || c == QLatin1Char('"') ||
            c == QLatin1Char('<') || c == QLatin1Char('>') ||
            c == QLatin1Char('|'))
            c = QLatin1Char('_');
    }
    // Deliberately a lighter character filter than the engine's: this is the
    // user renaming their own file, so parentheses and commas stay. The Win32
    // device-name and trailing-dot rules are not optional either way, and the
    // length cap keeps a pasted-in title from failing at the syscall.
    safeName = makeFileNamePortable(safeName.left(240));
    if (safeName.isEmpty() || safeName == QLatin1String(".") ||
        safeName == QLatin1String(".."))
        return false;

    const QFileInfo fi(m_savePath);
    const QString dir = fi.absolutePath();
    QString target = dir + QStringLiteral("/") + safeName;
    if (target == m_savePath)
        return true;
    // Don't clobber an existing file: name.ext -> name (1).ext, etc.
    if (QFile::exists(target)) {
        const QFileInfo tf(target);
        const QString base = tf.completeBaseName();
        const QString suffix = tf.suffix().isEmpty() ? QString()
                                                     : (QStringLiteral(".") + tf.suffix());
        int n = 1;
        do {
            target = dir + QStringLiteral("/%1 (%2)%3").arg(base).arg(n).arg(suffix);
            ++n;
        } while (QFile::exists(target));
    }
    if (!QFile::rename(m_savePath, target))
        return false;
    m_savePath = target;
    persist();
    return true;
}

// Apple Music (and iTunes preview) CDN domains throttle or error on parallel
// byte-range requests, so we must use exactly one connection for those hosts.
static bool isAppleMusicCdn(const QUrl &url)
{
    const QString host = url.host().toLower();
    return host.endsWith(QLatin1String(".itunes.apple.com"))
        || host == QLatin1String("itunes.apple.com");
}

// ---- Google Drive direct-download handling --------------------------------
// Drive doesn't serve files at a plain URL: share/preview links must be turned
// into the /download endpoint, large files sit behind a "Can't scan this file
// for viruses" HTML confirm page (re-request with its confirm token), and
// signed-out users get bounced to the Google login page. Without this, Nexa
// would just save the web page as the user's file.

static bool isGoogleDriveHost(const QUrl &u, const CloudProviders *providers)
{
    if (providers)
        return providers->isGoogleDriveHost(u);
    const QString h = u.host().toLower();
    return h == QLatin1String("drive.google.com")
        || h == QLatin1String("drive.usercontent.google.com")
        || h == QLatin1String("docs.google.com")
        || h == QLatin1String("photos.google.com")
        || h == QLatin1String("video.google.com");
}

// Pull the Drive file id out of any of Drive's URL shapes:
//   /file/d/{ID}/view   /uc?id={ID}   /open?id={ID}   /download?id={ID}
static QString googleDriveId(const QUrl &u)
{
    static const QRegularExpression pathRe(QStringLiteral("/file/d/([A-Za-z0-9_-]+)"));
    const auto m = pathRe.match(u.path());
    if (m.hasMatch())
        return m.captured(1);
    return QUrlQuery(u).queryItemValue(QStringLiteral("id"));
}

// Normalise a Drive share/preview link to the direct download endpoint. A URL
// that is already on drive.usercontent.google.com is left untouched (it may
// carry confirm/uuid/at tokens the extension captured). Non-Drive URLs and Docs
// editor URLs with no file id pass through unchanged.
static QUrl normalizedGoogleDrive(const QUrl &u, const CloudProviders *providers)
{
    if (!isGoogleDriveHost(u, providers)
        || u.host().compare(QLatin1String("drive.usercontent.google.com"),
                            Qt::CaseInsensitive) == 0)
        return u;
    const QString id = googleDriveId(u);
    if (id.isEmpty())
        return u;
    QUrl out(QStringLiteral("https://drive.usercontent.google.com/download"));
    QUrlQuery q;
    q.addQueryItem(QStringLiteral("id"), id);
    q.addQueryItem(QStringLiteral("export"), QStringLiteral("download"));
    out.setQuery(q);
    return out;
}

// ---- OneDrive / SharePoint direct-download handling -----------------------
// OneDrive share links come in several shapes:
//   https://1drv.ms/v/s!XXXXX              (short link, 302 → SharePoint)
//   https://onedrive.live.com/redir?...    (legacy share URL)
//   https://{tenant}-my.sharepoint.com/... (enterprise SharePoint)
// All eventually redirect to the CDN with cookies, but the initial share page
// returns HTML. Appending download=1 to the resolved URL forces binary.

static bool isOneDriveHost(const QUrl &u, const CloudProviders *providers)
{
    if (providers)
        return providers->isOneDriveHost(u);
    const QString h = u.host().toLower();
    return h == QLatin1String("onedrive.live.com")
        || h == QLatin1String("1drv.ms")
        || h.endsWith(QLatin1String(".sharepoint.com"))
        || h.endsWith(QLatin1String(".svc.ms"))
        || h.endsWith(QLatin1String(".live.net"));
}

// Normalise a OneDrive share/embed link to a direct download endpoint.
// For onedrive.live.com embed links: change /embed to /download.
// For SharePoint: append download=1 query parameter.
static QUrl normalizedOneDrive(const QUrl &u, const CloudProviders *providers)
{
    if (!isOneDriveHost(u, providers))
        return u;
    // Short links (1drv.ms) are 302 redirects; let the redirect loop handle them.
    if (u.host().toLower() == QLatin1String("1drv.ms"))
        return u;
    QUrl out(u);
    // onedrive.live.com/embed?... → onedrive.live.com/download?...
    if (u.host().toLower() == QLatin1String("onedrive.live.com")
        && u.path().startsWith(QLatin1String("/embed"))) {
        out.setPath(u.path().replace(QLatin1String("/embed"), QLatin1String("/download")));
        return out;
    }
    // SharePoint / live.com: ensure download=1 query param forces binary.
    QUrlQuery q(out);
    if (!q.hasQueryItem(QStringLiteral("download"))) {
        q.addQueryItem(QStringLiteral("download"), QStringLiteral("1"));
        out.setQuery(q);
    }
    return out;
}

// ---- Dropbox direct-download handling -------------------------------------
// Dropbox share links (https://www.dropbox.com/s/XXXXX/file.zip?...) return an
// HTML preview page by default. Changing dl=0 to dl=1 (or adding it) forces a
// direct binary download. The actual file is served from
// dl.dropboxusercontent.com — sameCredentialScope already allows the hop.

static bool isDropboxHost(const QUrl &u, const CloudProviders *providers)
{
    if (providers)
        return providers->isDropboxHost(u);
    const QString h = u.host().toLower();
    return h == QLatin1String("dropbox.com")
        || h == QLatin1String("www.dropbox.com")
        || h.endsWith(QLatin1String(".dropbox.com"))
        || h.endsWith(QLatin1String(".dropboxusercontent.com"));
}

// Normalise a Dropbox share link to force direct download.
static QUrl normalizedDropbox(const QUrl &u, const CloudProviders *providers)
{
    if (!isDropboxHost(u, providers))
        return u;
    // Already on the CDN: nothing to fix.
    if (u.host().toLower().endsWith(QLatin1String(".dropboxusercontent.com")))
        return u;
    QUrl out(u);
    QUrlQuery q(out);
    q.removeQueryItem(QStringLiteral("dl"));
    q.addQueryItem(QStringLiteral("dl"), QStringLiteral("1"));
    out.setQuery(q);
    return out;
}

// Parse Drive's "Can't scan for viruses" interstitial into the real download
// URL. Two page shapes exist: the modern <form> with hidden inputs, and the
// older inline `&confirm=TOKEN` link. `base` is the URL we requested, used to
// rebuild from a bare token. Returns an empty URL when the page is neither
// (e.g. the login page), so the caller can report "sign-in required".
static QUrl parseDriveConfirm(const QByteArray &body, const QUrl &base)
{
    const QString s = QString::fromUtf8(body);

    // Modern form: action + hidden inputs (id/export/confirm/uuid).
    static const QRegularExpression formRe(
        QStringLiteral("<form[^>]*action=\"([^\"]+)\""),
        QRegularExpression::CaseInsensitiveOption);
    if (const auto fm = formRe.match(s); fm.hasMatch()) {
        QString action = fm.captured(1);
        action.replace(QStringLiteral("&amp;"), QStringLiteral("&"));
        QUrl out(action);
        QUrlQuery q(out);                  // the action may already carry id/export
        static const QRegularExpression inputRe(
            QStringLiteral("<input[^>]*type=\"hidden\"[^>]*>"),
            QRegularExpression::CaseInsensitiveOption);
        static const QRegularExpression nameRe(QStringLiteral("name=\"([^\"]+)\""));
        static const QRegularExpression valRe(QStringLiteral("value=\"([^\"]*)\""));
        auto it = inputRe.globalMatch(s);
        bool sawConfirm = false;
        while (it.hasNext()) {
            const QString tag = it.next().captured(0);
            const auto nm = nameRe.match(tag);
            if (!nm.hasMatch())
                continue;
            const auto vm = valRe.match(tag);
            const QString name = nm.captured(1);
            q.removeQueryItem(name);
            q.addQueryItem(name, vm.hasMatch() ? vm.captured(1) : QString());
            if (name == QLatin1String("confirm"))
                sawConfirm = true;
        }
        if (sawConfirm) {
            out.setQuery(q);
            return out;
        }
    }

    // Older inline shape: a bare `confirm=TOKEN` (and maybe `uuid=`) in the body.
    static const QRegularExpression confirmRe(QStringLiteral("confirm=([0-9A-Za-z_-]+)"));
    if (const auto cm = confirmRe.match(s); cm.hasMatch()) {
        QUrl out(base);
        QUrlQuery q(out);
        q.removeQueryItem(QStringLiteral("confirm"));
        q.addQueryItem(QStringLiteral("confirm"), cm.captured(1));
        static const QRegularExpression uuidRe(QStringLiteral("uuid=([0-9A-Za-z_-]+)"));
        if (const auto um = uuidRe.match(s); um.hasMatch()) {
            q.removeQueryItem(QStringLiteral("uuid"));
            q.addQueryItem(QStringLiteral("uuid"), um.captured(1));
        }
        out.setQuery(q);
        return out;
    }
    return QUrl();
}

// ---- Generic confirm/interstitial page parser -----------------------------
// Many file hosts (MediaFire, Box, pCloud) return an HTML page with a "Download"
// button or a <meta> refresh rather than the file itself. We detect these and
// extract the real download URL so the user gets the file, not the page.

// Hosts known to serve confirm pages (suffix match).
static bool isConfirmPageHost(const QUrl &u, const CloudProviders *providers)
{
    if (providers)
        return providers->isConfirmPageHost(u);
    const QString h = u.host().toLower();
    return h == QLatin1String("mediafire.com")
        || h == QLatin1String("www.mediafire.com")
        || h.endsWith(QLatin1String(".mediafire.com"))
        || h == QLatin1String("box.com")
        || h == QLatin1String("www.box.com")
        || h.endsWith(QLatin1String(".box.com"))
        || h == QLatin1String("pcloud.com")
        || h == QLatin1String("www.pcloud.com")
        || h.endsWith(QLatin1String(".pcloud.com"))
        || h.endsWith(QLatin1String(".pcloud.link"))
        || h == QLatin1String("terabox.com")
        || h == QLatin1String("www.terabox.com")
        || h.endsWith(QLatin1String(".terabox.com"))
        || isGoogleDriveHost(u, providers);   // Google Drive already handled, but listed
}

// Extract a redirect URL from <meta http-equiv="refresh" content="0;url=...">.
static QUrl parseMetaRefresh(const QByteArray &body, const QUrl &base)
{
    static const QRegularExpression re(
        QStringLiteral("<meta\\s+http-equiv\\s*=\\s*[\"']?refresh[\"']?\\s+"
                       "content\\s*=\\s*[\"']?\\d*;\\s*url\\s*=\\s*([^\"'\\s>]+)"),
        QRegularExpression::CaseInsensitiveOption);
    const auto m = re.match(QString::fromUtf8(body));
    if (!m.hasMatch())
        return QUrl();
    QString target = m.captured(1);
    target.replace(QStringLiteral("&amp;"), QStringLiteral("&"));
    QUrl out = base.resolved(QUrl::fromUserInput(target));
    return out.isValid() ? out : QUrl();
}

// Extract a download button link from known HTML patterns.
// MediaFire: <a class="input" href="...">
// Box:       <a class="download" href="...">
// pCloud:    <a class="btn_download" href="...">
// Generic:  <a[^>]*download[^>]*href="([^"]+)"  or
//           <form[^>]*action="([^"]+)"[^>]*download
static QUrl parseDownloadButton(const QByteArray &body, const QUrl &base)
{
    const QString s = QString::fromUtf8(body);
    static const QRegularExpression downloadLinkRe(
        QStringLiteral(
            "<a[^>]*\\bclass\\s*=\\s*\"[^\"]*\\b(download|download-button|input)\\b[^\"]*\""
            "[^>]*\\bhref\\s*=\\s*\"([^\"]+)\""),
        QRegularExpression::CaseInsensitiveOption |
        QRegularExpression::DotMatchesEverythingOption);
    static const QRegularExpression genericBtn(
        QStringLiteral("<a[^>]*\\bhref\\s*=\\s*\"([^\"]+download[^\"]+)\"[^>]*>"),
        QRegularExpression::CaseInsensitiveOption);
    static const QRegularExpression formAction(
        QStringLiteral("<form[^>]*\\baction\\s*=\\s*\"([^\"]+)\"[^>]*>"
                       "(?:(?!</form>).)*download"),
        QRegularExpression::CaseInsensitiveOption |
        QRegularExpression::DotMatchesEverythingOption);

    // 1. Prefer class="download" buttons
    auto it = downloadLinkRe.globalMatch(s);
    if (it.hasNext()) {
        const QString href = it.next().captured(2);
        QUrl out = base.resolved(QUrl::fromUserInput(href));
        if (out.isValid()) return out;
    }

    // 2. Generic "download" in href
    it = genericBtn.globalMatch(s);
    if (it.hasNext()) {
        const QString href = it.next().captured(1);
        QUrl out = base.resolved(QUrl::fromUserInput(href));
        if (out.isValid()) return out;
    }

    // 3. Form with "download" text
    it = formAction.globalMatch(s);
    if (it.hasNext()) {
        const QString action = it.next().captured(1);
        QUrl out = base.resolved(QUrl::fromUserInput(action));
        if (out.isValid()) return out;
    }

    return QUrl();
}

// General confirm page resolver: tries all strategies in order.
// Returns a resolved download URL, or an empty URL if none matched.
static QUrl parseConfirmPage(const QByteArray &body, const QUrl &base,
                              const CloudProviders *providers)
{
    // Priority 1: Google Drive (specialised handler)
    if (isGoogleDriveHost(base, providers)) {
        const QUrl gd = parseDriveConfirm(body, base);
        if (gd.isValid()) return gd;
    }
    // Priority 2: meta-refresh redirect (works on any host)
    const QUrl meta = parseMetaRefresh(body, base);
    if (meta.isValid()) return meta;
    // Priority 3: download button / form
    const QUrl btn = parseDownloadButton(body, base);
    if (btn.isValid()) return btn;
    return QUrl();
}

// Choose how many parallel connections to use, scaling with file size up to 32,
// then clamped to what the licence allows (Free 16, paid 32 — see
// Entitlements::maxConnectionsPerFile). The clamp is applied last so the
// size-based scaling stays the same shape on every plan: a small file is still
// not worth splitting, it is only the ceiling that differs.
int DownloadTask::preferredSegmentCount(qint64 totalBytes, int maxConnections)
{
    const int cap = (maxConnections > 0) ? qMin(maxConnections, 32) : 32;
    if (totalBytes <= 0)                  return 1;
    if (totalBytes < 1 * 1024 * 1024)     return 1;    // < 1 MB: not worth splitting
    if (totalBytes < 10 * 1024 * 1024)    return qMin(8, cap);    // 1–10 MB
    if (totalBytes < 100 * 1024 * 1024)   return qMin(16, cap);   // 10–100 MB
    return cap;                                         // ≥ 100 MB: max acceleration
}

void DownloadTask::start()
{
    if (m_state == DownloadState::Downloading || m_state == DownloadState::Probing)
        return;

    setState(DownloadState::Probing, QStringLiteral("contacting server"));
    // A growFileAsync() worker from an earlier run of this task may still be in
    // flight; its result must not launch segments under this fresh probe.
    ++m_allocGeneration;

    // Turn cloud share/preview links into direct download endpoints up front
    // so cookies are scoped to (and sent to) the host that actually serves bytes.
    m_url = normalizedGoogleDrive(m_url, m_providers);
    m_url = normalizedOneDrive(m_url, m_providers);
    m_url = normalizedDropbox(m_url, m_providers);

    // The captured cookies/tokens belong to THIS host; we follow redirects
    // manually (onProbeFinished) so they can be stripped before a cross-host hop.
    m_credHost = m_url.host();
    m_probeRedirects = 0;
    sendProbe();
}

// Issue the ranged size/Range probe against the current m_url. A ranged
// HEAD-style GET (first byte) reveals whether the server honours Range, plus
// Content-Length / the final redirected URL. Shared by start(), the redirect
// loop, and the Google Drive confirm re-probe.
QNetworkAccessManager *DownloadTask::probeManager()
{
    // Keep Drive probes on an independent manager. QNetworkAccessManager keeps
    // connection/session state; a failed Google login redirect on the shared
    // engine manager can otherwise poison the next Drive probe. Segment workers
    // already use independent managers for the same reason.
    if (!isGoogleDriveHost(m_url, m_providers))
        return m_nam;
    if (!m_driveProbeNam)
        m_driveProbeNam = new QNetworkAccessManager(this);
    return m_driveProbeNam;
}

void DownloadTask::sendProbe()
{
    if (m_publicNetworkOnly && !isPublicHttpUrl(m_url)) {
        setState(DownloadState::Error, QStringLiteral("remote dashboard target is not a public HTTP(S) address"));
        return;
    }
    QNetworkRequest req(m_url);
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::ManualRedirectPolicy);
    req.setRawHeader("Accept-Encoding", "identity");
    const QString validator = resumeValidator();
    if (!validator.isEmpty())
        req.setRawHeader("If-Range", validator.toUtf8());
    applyScopedHeaders(req, m_headers, m_credHost, m_providers);
    if (req.rawHeader("User-Agent").isEmpty())
        req.setRawHeader("User-Agent", "Nexa/0.1");
    // Google Drive's download endpoint reliably reports Content-Length,
    // Content-Disposition, and Range support to HEAD, but some authenticated
    // CDN responses redirect/reset a ranged probe made by Qt. Use HEAD for the
    // metadata probe and reserve ranged GETs for the actual segment workers.
    m_probeWasHead = isGoogleDriveHost(m_url, m_providers);
    if (!m_probeWasHead)
        req.setRawHeader("Range", "bytes=0-0");
    if (kDebug)
        qDebug().noquote() << "NEXA PROBE" << m_id << m_url.host()
                           << "cookie=" << !req.rawHeader("Cookie").isEmpty()
                           << "auth=" << !req.rawHeader("Authorization").isEmpty()
                           << "method=" << (m_probeWasHead ? "HEAD" : "GET");
    QNetworkAccessManager *nam = probeManager();
    m_probe = m_probeWasHead ? nam->head(req) : nam->get(req);
    if (!m_probeWasHead) {
        // A server that ignores Range may start streaming the entire object in
        // response to the one-byte probe. We only need its headers; abort the
        // body as soon as Qt has received them so a large file is not buffered
        // before the real transfer even begins.
        connect(m_probe, &QNetworkReply::metaDataChanged, this, [this]() {
            if (!m_probe)
                return;
            const int status = m_probe->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
            if (status == 200)
                m_probe->abort();
        });
    }
    connect(m_probe, &QNetworkReply::finished, this, &DownloadTask::onProbeFinished);
}

void DownloadTask::onProbeFinished()
{
    QNetworkReply *r = m_probe;
    m_probe = nullptr;
    if (!r)
        return;
    r->deleteLater();

    const int status = r->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    // Qt maps a 4xx/5xx to its own error (ContentNotFoundError,
    // AuthenticationRequiredError, …), so a status the server DID send must be
    // classified below before the transport error is consulted — otherwise the
    // 401/403 and "HTTP nnn" branches are unreachable and the user only ever
    // sees Qt's generic wording.
    if (status < 400 && r->error() != QNetworkReply::NoError &&
        r->error() != QNetworkReply::OperationCanceledError) {
        if (kDebug)
            qDebug().noquote() << "NEXA PROBE-ERROR" << m_id
                               << r->error() << r->errorString();
        setState(DownloadState::Error, r->errorString());
        return;
    }

    const QByteArray ctype =
        r->header(QNetworkRequest::ContentTypeHeader).toByteArray().toLower();
    if (kDebug)
        qDebug().noquote() << "NEXA PROBE-RESULT" << m_id << r->url().host()
                           << "status=" << status << "type=" << ctype;

    // Follow redirects MANUALLY so we can drop the site cookie/bearer before
    // sending the probe to a different host (Qt's auto-redirect would re-send
    // them, leaking credentials to the CDN/third party).
    if (status >= 300 && status < 400) {
        const QByteArray loc = r->rawHeader("Location");
        const QUrl target = loc.isEmpty() ? QUrl()
                                          : r->url().resolved(QUrl::fromEncoded(loc));
        if (target.isValid() && m_probeRedirects < 8) {
            if (target.host().contains(QLatin1String("accounts.google"),
                                       Qt::CaseInsensitive)) {
                setState(DownloadState::Error,
                         QStringLiteral("Sign-in required — Google redirected the file to "
                                        "its login page. Reload the Nexa extension and "
                                        "start the download from the logged-in Drive tab."));
                return;
            }
            if (m_publicNetworkOnly && !isPublicHttpUrl(target)) {
                setState(DownloadState::Error,
                         QStringLiteral("redirect target is not a public HTTP(S) address"));
                return;
            }
            if (kDebug)
                qDebug().noquote() << "NEXA REDIRECT" << m_id << r->url().host()
                                   << "->" << target.host();
            ++m_probeRedirects;
            m_url = target;                       // the download follows the chain
            sendProbe();                          // applyScopedHeaders strips creds if cross-party
            return;
        }
        setState(DownloadState::Error, QStringLiteral("too many redirects"));
        return;
    }

    if (authIsStatus(status)) {
        // 401/403 on the size probe: surface the auth-specific reason immediately
        // instead of falling through to range parsing on an error page.
        setState(DownloadState::Error, authErrorDetail(status));
        return;
    }
    // Any other 4xx/5xx is a dead/blocked/rate-limited link, NOT a file. Without
    // this guard a 404/500 HTML error page (which carries a Content-Length) would
    // be parsed for size and written to disk as the user's file — silent
    // corruption for every broken link. Only an HTTP reply has a status; a 0
    // status (e.g. ftp/file) is left to the size-parsing path below.
    if (status >= 400) {
        setState(DownloadState::Error,
                 QStringLiteral("server returned HTTP %1").arg(status));
        return;
    }

    // A 200/206 whose body is an HTML page is almost never the file the user
    // asked for — it's a login wall, a Drive virus-scan interstitial, or an
    // error page. Saving it would silently corrupt the download (the classic
    // "downloaded 4 MB of HTML"). Detect that here, before writing anything.
    const bool servedHtml = ctype.startsWith("text/html")
                          || ctype.startsWith("application/xhtml");
    if (servedHtml && r->rawHeader("Content-Disposition").isEmpty()) {
        // Google Drive: large files sit behind a confirm page. Fetch it in full,
        // pull out the confirm token, and re-issue against the real file URL.
        if (isGoogleDriveHost(m_url, m_providers) && !m_driveConfirmed) {
            fetchGoogleDriveConfirm();
            return;
        }
        // Generic confirm page hosts (MediaFire, Box, pCloud, etc.): fetch the
        // page in full and extract the real download URL.
        if (isConfirmPageHost(m_url, m_providers)) {
            fetchConfirmPage();
            return;
        }
        // Otherwise: only treat it as an error when the target isn't itself an
        // HTML file (so a deliberate .html download still works).
        const QString ext = QFileInfo(m_savePath).suffix().toLower();
        if (ext != QLatin1String("html") && ext != QLatin1String("htm")) {
            const QString host = m_url.host().toLower();
            const bool login = host.contains(QLatin1String("accounts.google"))
                            || host.contains(QLatin1String("login"))
                            || host.contains(QLatin1String("signin"))
                            || host.contains(QLatin1String("auth"));
            setState(DownloadState::Error, login
                ? QStringLiteral("Sign-in required — the site returned its login page "
                                 "instead of the file. Start the download from the Nexa "
                                 "browser extension so your session cookies are sent.")
                : QStringLiteral("The server returned a web page, not a file — the link "
                                 "may have expired or need you to be signed in."));
            return;
        }
    }

    bool ranges = false;
    qint64 total = -1;
    const QString responseEtag = QString::fromUtf8(r->rawHeader("ETag")).trimmed();
    const QString responseLastModified = QString::fromUtf8(r->rawHeader("Last-Modified")).trimmed();
    const bool hadPartial = m_done > 0 || !m_segments.isEmpty();
    const bool validatorChanged = hadPartial &&
        ((!m_etag.isEmpty() && responseEtag != m_etag) ||
         (m_etag.isEmpty() && !m_lastModified.isEmpty() && responseLastModified != m_lastModified));
    if (validatorChanged) {
        QFile::remove(m_savePath);
        m_segments.clear();
        m_done = 0;
        m_total = -1;
    }
    if (!responseEtag.isEmpty() || !responseLastModified.isEmpty()) {
        m_etag = responseEtag;
        m_lastModified = responseLastModified;
    }

    if (status == 206) {
        // Partial Content -> ranges supported. Parse total from Content-Range.
        ranges = true;
        const QByteArray cr = r->rawHeader("Content-Range"); // e.g. "bytes 0-0/12345"
        const int slash = cr.indexOf('/');
        if (slash >= 0) {
            const QByteArray totalStr = cr.mid(slash + 1).trimmed();
            if (totalStr != "*")
                total = totalStr.toLongLong();
        }
    } else {
        // 200 OK: a normal GET ignored Range, but a Drive HEAD can explicitly
        // advertise byte ranges even though it has no response body.
        ranges = m_probeWasHead &&
                 r->rawHeader("Accept-Ranges").compare("bytes", Qt::CaseInsensitive) == 0;
        const QVariant len = r->header(QNetworkRequest::ContentLengthHeader);
        if (len.isValid())
            total = len.toLongLong();
    }

    if (r->hasRawHeader("Accept-Ranges") && r->rawHeader("Accept-Ranges") == "none")
        ranges = false;

    m_total = total;
    m_rangesSupported = ranges;

    // Prefer the real filename from Content-Disposition (CDN/redirect URLs often
    // have a random token in the path, so the URL alone gives a useless name).
    const QString serverName = filenameFromContentDisposition(r->rawHeader("Content-Disposition"));
    if (!serverName.isEmpty() && m_nameResolver) {
        const QString newPath = m_nameResolver(serverName);
        if (!newPath.isEmpty() && newPath != m_savePath) {
            m_savePath = newPath;
            emit renamedTo(fileName());
        }
    }

    beginPreallocation();
}

// Fetch a generic confirm/interstitial page IN FULL (the ranged probe only saw
// its first byte), extract the real download URL via meta-refresh, download
// button, or form action, and re-probe the resolved URL.
void DownloadTask::fetchConfirmPage()
{
    setState(DownloadState::Probing, QStringLiteral("resolving download link"));
    QNetworkRequest req(m_url);
    req.setHeader(QNetworkRequest::UserAgentHeader, QStringLiteral("Nexa/0.1"));
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::ManualRedirectPolicy);
    req.setRawHeader("Accept-Encoding", "identity");
    applyScopedHeaders(req, m_headers, m_credHost, m_providers);
    m_probe = m_nam->get(req);
    connect(m_probe, &QNetworkReply::finished, this, &DownloadTask::onConfirmPageFinished);
}

void DownloadTask::onConfirmPageFinished()
{
    QNetworkReply *r = m_probe;
    m_probe = nullptr;
    if (!r)
        return;
    r->deleteLater();

    if (r->error() != QNetworkReply::NoError &&
        r->error() != QNetworkReply::OperationCanceledError) {
        setState(DownloadState::Error, r->errorString());
        return;
    }

    const int status = r->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    // Follow one redirect level (confirm pages sometimes bounce to the CDN)
    if (status >= 300 && status < 400) {
        const QByteArray loc = r->rawHeader("Location");
        const QUrl target = loc.isEmpty() ? QUrl()
                                          : r->url().resolved(QUrl::fromEncoded(loc));
        if (target.isValid()) {
            if (m_publicNetworkOnly && !isPublicHttpUrl(target)) {
                setState(DownloadState::Error,
                         QStringLiteral("redirect target is not a public HTTP(S) address"));
                return;
            }
            m_url = target;
            m_confirmPageFetched = true;
            m_probeRedirects = 0;
            sendProbe();
            return;
        }
    }

    const QUrl resolved = parseConfirmPage(r->readAll(), m_url, m_providers);
    if (!resolved.isValid()) {
        setState(DownloadState::Error,
                 QStringLiteral("Could not extract a download link from the page. "
                                "Try downloading directly from the browser instead."));
        return;
    }
    m_url = resolved;
    // Keep the original credential origin. The resolved button URL may be on
    // an unrelated CDN; applyScopedHeaders()/makeWorker() will then strip
    // Cookie/Authorization instead of trusting HTML from the confirm page.
    m_confirmPageFetched = true;
    m_probeRedirects = 0;
    sendProbe();
}

// Fetch Google Drive's confirm interstitial IN FULL (the ranged probe only saw
// its first byte), parse the confirm token, and re-probe the resolved file URL.
void DownloadTask::fetchGoogleDriveConfirm()
{
    setState(DownloadState::Probing, QStringLiteral("resolving Google Drive link"));
    if (kDebug)
        qDebug().noquote() << "NEXA DRIVE-CONFIRM" << m_id << m_url.host();
    QNetworkRequest req(m_url);
    req.setHeader(QNetworkRequest::UserAgentHeader, QStringLiteral("Nexa/0.1"));
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::ManualRedirectPolicy);
    req.setRawHeader("Accept-Encoding", "identity");
    applyScopedHeaders(req, m_headers, m_credHost, m_providers);   // full GET, no Range
    m_probe = probeManager()->get(req);
    connect(m_probe, &QNetworkReply::finished, this, &DownloadTask::onDriveConfirmFinished);
}

void DownloadTask::onDriveConfirmFinished()
{
    QNetworkReply *r = m_probe;
    m_probe = nullptr;
    if (!r)
        return;
    r->deleteLater();

    if (r->error() != QNetworkReply::NoError &&
        r->error() != QNetworkReply::OperationCanceledError) {
        setState(DownloadState::Error, r->errorString());
        return;
    }

    const int status = r->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    // A redirect off this page usually means the file isn't public: Drive bounces
    // a signed-out request to the Google login host.
    if (status >= 300 && status < 400) {
        const QByteArray loc = r->rawHeader("Location");
        const QUrl target = loc.isEmpty() ? QUrl()
                                          : r->url().resolved(QUrl::fromEncoded(loc));
        if (target.host().contains(QLatin1String("accounts.google"))) {
            setState(DownloadState::Error,
                     QStringLiteral("This Google Drive file needs you to be signed in. "
                                    "Use the Nexa browser extension's download button so "
                                    "your Google session is included."));
            return;
        }
        if (target.isValid()) {            // redirect points straight at the file
            if (m_publicNetworkOnly && !isPublicHttpUrl(target)) {
                setState(DownloadState::Error,
                         QStringLiteral("redirect target is not a public HTTP(S) address"));
                return;
            }
            m_url = target;
            m_driveConfirmed = true;
            m_probeRedirects = 0;
            sendProbe();
            return;
        }
    }

    const QUrl confirmed = parseDriveConfirm(r->readAll(), m_url);
    if (confirmed.isEmpty()) {
        setState(DownloadState::Error,
                 QStringLiteral("Google Drive didn't return a downloadable file. The link "
                                "may be private (sign in via the Nexa extension) or expired."));
        return;
    }
    if (m_publicNetworkOnly && !isPublicHttpUrl(confirmed)) {
        setState(DownloadState::Error,
                 QStringLiteral("resolved target is not a public HTTP(S) address"));
        return;
    }
    if (kDebug)
        qDebug().noquote() << "NEXA DRIVE-CONFIRMED" << m_id << confirmed.host();
    m_url = confirmed;
    m_credHost = m_url.host();             // re-scope cookies to the resolved host
    m_driveConfirmed = true;
    m_probeRedirects = 0;
    sendProbe();
}

#ifdef Q_OS_WIN
// NTFS tracks a "valid data length" separately from the file length. SetEndOfFile
// — which is what QFile::resize() calls — moves the length but leaves valid data
// at zero, so the first write past that point makes the filesystem synchronously
// zero-fill everything in between, inside the write() call.
//
// A segmented download writes at high offsets almost immediately (segment 31
// starts 31/32 of the way in), so on a multi-gigabyte file that is gigabytes of
// zeroes written before the first payload byte lands — on this app's single
// thread, with the window frozen throughout: measured at 14 s for a 2 GB file on
// a SATA SSD, which is exactly the "Not Responding" users saw the moment a
// 32-connection download started. Marking the file sparse tells NTFS to leave
// the gaps unallocated and report them as zeroes, which is exactly what a
// partially-downloaded file wants.
//
// Best-effort by design: FAT32 and exFAT have no sparse support and simply
// refuse; growFile() then absorbs their zero-fill on the worker thread instead.
// The trade-off is that space is no longer reserved up front, so a full disk now
// surfaces as a write error mid-download instead of a failure to preallocate.
static bool markFileSparse(const QString &path)
{
    const HANDLE handle = CreateFileW(reinterpret_cast<const wchar_t *>(path.utf16()),
                                      GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE)
        return false;
    DWORD returned = 0;
    const bool ok = DeviceIoControl(handle, FSCTL_SET_SPARSE, nullptr, 0, nullptr, 0,
                                    &returned, nullptr);
    CloseHandle(handle);
    return ok;
}
#endif

// Grow an EXISTING file at `path` to `size` bytes. This is the call that can
// stall for as long as the filesystem takes to zero-fill the gap, which is why
// it only ever runs on the worker thread growFileAsync() creates:
//   * FAT32 / exFAT zero-fill inside SetEndOfFile() itself — a 2 GB file on a
//     USB stick is minutes of blocking.
//   * NTFS extends instantly but zero-fills from its valid-data-length to the
//     first write past it, inside that write (see markFileSparse). With
//     `settleValidData` the last byte is written here, so whatever fill IS going
//     to happen (sparse refused: a network share, an odd volume) happens on this
//     thread and never under a segment worker on the GUI thread. On a sparse
//     file it costs one allocation unit.
//   * ext4 / APFS / XFS extend lazily; the poke costs one block.
// Refuses to create the file: the task made it before handing over, and a path
// that has since gone (renamed, removed) must not come back as a zero file.
static bool growFile(const QString &path, qint64 size, bool settleValidData)
{
    if (size <= 0)
        return true;
    if (!QFile::exists(path))
        return false;
    QFile f(path);
    if (!f.open(QIODevice::ReadWrite))
        return false;
    if (f.size() != size && !f.resize(size))
        return false;
    if (settleValidData) {
        const char zero = 0;
        if (!f.seek(size - 1) || f.write(&zero, 1) != 1)
            return false;
        f.flush();
    }
    return true;
}

// The one place this single-threaded app uses a worker thread: a blocking
// filesystem call with no asynchronous form. The worker shares nothing — it
// gets a copy of the path and writes one result slot that the queued finished()
// delivery orders ahead of the read. `this` is the connection context, so a
// task destroyed mid-growth simply never hears back; the worker owns itself and
// is deleted once it has finished.
void DownloadTask::growFileAsync(qint64 size, bool settleValidData,
                                 std::function<void(bool)> done)
{
    auto ok = std::make_shared<bool>(false);
    QThread *worker = QThread::create([path = m_savePath, size, settleValidData, ok]() {
        *ok = growFile(path, size, settleValidData);
    });
    connect(worker, &QThread::finished, this, [ok, done]() { done(*ok); });
    connect(worker, &QThread::finished, worker, &QObject::deleteLater);
    worker->start();
}

void DownloadTask::beginPreallocation()
{
    QDir().mkpath(QFileInfo(m_savePath).absolutePath());
    {
        QFile f(m_savePath);
        if (!f.open(QIODevice::ReadWrite)) {      // creates it; never truncates
            setState(DownloadState::Error, QStringLiteral("cannot create destination file"));
            return;
        }
#ifdef Q_OS_WIN
        // Before the resize, so the extension is a hole rather than allocation.
        // Uses its own shared handle, so `f` staying open is fine.
        if (!markFileSparse(m_savePath) && kDebug)
            qDebug().noquote() << "NEXA SPARSE refused" << m_id << m_savePath;
#endif
    }
    if (m_total <= 0) {                          // unknown size: nothing to grow
        startTransfer();
        return;
    }
    const int generation = ++m_allocGeneration;
    setState(DownloadState::Probing,
             QStringLiteral("allocating %1 on disk").arg(QLocale().formattedDataSize(m_total)));
    growFileAsync(m_total, /*settleValidData=*/true, [this, generation](bool ok) {
        // Paused, or paused-and-restarted, while the worker ran: that later flow
        // owns the file now and this result is stale.
        if (generation != m_allocGeneration || m_state != DownloadState::Probing)
            return;
        if (!ok) {
            setState(DownloadState::Error,
                     QStringLiteral("cannot allocate the destination file"));
            return;
        }
        startTransfer();
    });
}

void DownloadTask::startTransfer()
{
    buildSegments(m_total, m_rangesSupported);
    persist();
    setState(DownloadState::Downloading,
             QStringLiteral("%1 connection(s)").arg(m_segments.size()));
    m_clock.start();
    m_lastTickBytes = m_done;
    m_lastTickMs = 0;
    m_speedTimer->start();
    launchSegments();
}

void DownloadTask::buildSegments(qint64 total, bool rangesSupported)
{
    m_segments.clear();
    m_done = 0;

    if (!rangesSupported || total <= 0) {
        // Single segment covering the whole file (or unknown size: end huge).
        SegmentInfo s;
        s.index = 0;
        s.start = 0;
        s.end = (total > 0) ? (total - 1) : (qint64(1) << 62);
        s.done = 0;
        m_segments.append(s);
        return;
    }

    // Apple Music CDN: single connection only — parallel ranges cause errors.
    if (isAppleMusicCdn(m_url))
        m_dynamicResegment = false;
    const int n = isAppleMusicCdn(m_url) ? 1 : preferredSegmentCount(total, m_maxConnections);
    const qint64 chunk = total / n;
    for (int i = 0; i < n; ++i) {
        SegmentInfo s;
        s.index = i;
        s.start = i * chunk;
        s.end = (i == n - 1) ? (total - 1) : ((i + 1) * chunk - 1);
        s.done = 0;
        m_segments.append(s);
    }
}

void DownloadTask::restore(qint64 totalBytes, const QVector<SegmentInfo> &segments,
                           bool rangesSupported, const QString &etag,
                           const QString &lastModified)
{
    bool valid = !segments.isEmpty();
    QVector<SegmentInfo> byStart = segments;
    std::sort(byStart.begin(), byStart.end(),
              [](const SegmentInfo &a, const SegmentInfo &b) { return a.start < b.start; });
    for (int i = 0; valid && i < segments.size(); ++i) {
        const SegmentInfo &s = segments.at(i);
        valid = s.index == i && s.start >= 0 && s.end >= s.start
             && s.done >= 0 && s.done <= s.length();
        if (totalBytes > 0)
            valid = valid && s.end < totalBytes;
    }
    if (valid && totalBytes > 0) {
        valid = byStart.first().start == 0 && byStart.last().end == totalBytes - 1;
        for (int i = 1; valid && i < byStart.size(); ++i)
            valid = byStart.at(i - 1).end + 1 == byStart.at(i).start;
    }
    if (!valid) {
        // Never trust malformed persisted offsets. Clear them so the next Resume
        // performs a clean probe instead of writing into overlapping/gapped ranges.
        m_total = -1;
        m_done = 0;
        m_segments.clear();
        m_rangesSupported = false;
        m_etag.clear();
        m_lastModified.clear();
        setState(DownloadState::Paused, QStringLiteral("saved progress invalid; restarting"));
        persist();
        return;
    }

    m_total = totalBytes;
    m_segments = segments;
    // Use the persisted capability; fall back to the old segment-count heuristic
    // for rows written before the ranges_supported column existed (default 0).
    m_rangesSupported = rangesSupported || segments.size() > 1;
    m_etag = etag;
    m_lastModified = lastModified;
    m_done = 0;
    for (const auto &s : m_segments)
        m_done += s.done;
    const QFileInfo output(m_savePath);
    const bool outputLooksComplete = output.isFile() && output.size() >= m_total;
    if (m_done >= m_total && m_total > 0 && outputLooksComplete)
        setState(DownloadState::Completed);
    else
        setState(DownloadState::Paused, QStringLiteral("restored"));
}

void DownloadTask::launchSegments()
{
    clearSegments();
    m_completedSegments = 0;
    m_activeSegments = 0;
    // A new run gets a fresh retry budget. The counters are keyed by segment
    // index and were never reset, so a task that had errored after kMaxRetries
    // on segment N came back from Resume with N's budget still spent: its very
    // next hiccup went straight to Error with no retry at all — and after a
    // re-probe the same index may belong to a completely different byte range.
    m_retries.clear();

    for (const SegmentInfo &seg : m_segments) {
        if (seg.complete()) {
            ++m_completedSegments;
            continue;
        }
        makeWorker(seg);
        ++m_activeSegments;
    }
    // start() can fail synchronously (destination not openable) and re-enter
    // onSegmentFailed(); iterate a snapshot so nothing that reshapes m_workers
    // from inside that path invalidates this loop.
    const QVector<SegmentDownloader*> launched = m_workers;
    for (auto *w : launched)
        w->start();

    if (m_activeSegments == 0)
        checkAllComplete();
}

SegmentDownloader *DownloadTask::makeWorker(const SegmentInfo &seg)
{
    // After redirects m_url may point at a different host than the one the
    // cookies/tokens were captured for; strip those sensitive headers so the bulk
    // segment requests never replay the site credential to a cross-host CDN.
    HeaderList workerHeaders;
    workerHeaders.reserve(m_headers.size());
    // The probe uses the provider registry to keep credentials across an
    // approved redirect (for example chatgpt.com -> files.oaiusercontent.com),
    // but the old worker path compared host names literally. That meant the
    // probe could authenticate successfully and every byte-range worker then
    // dropped Cookie/Authorization and failed with 401/403. Use the exact same
    // scope decision for both paths; unrelated CDN/third-party hosts still
    // receive only non-sensitive browser metadata.
    const bool inCredentialScope = sameCredentialScope(
        m_url.host(), m_credHost, m_providers);
    for (const auto &h : m_headers)
        if (inCredentialScope || !isSensitiveHeader(h.first))
            workerHeaders.append(h);
    auto *w = new SegmentDownloader(seg, m_url, m_savePath, workerHeaders, m_nam, m_limiter, this);
    w->setTaskRateLimiter(m_taskLimiter);
    w->setIfRangeValidator(resumeValidator());
    w->setPublicNetworkOnly(m_publicNetworkOnly);
    connect(w, &SegmentDownloader::progressed,  this, &DownloadTask::onSegmentProgressed);
    connect(w, &SegmentDownloader::completed,   this, &DownloadTask::onSegmentCompleted);
    connect(w, &SegmentDownloader::failed,      this, &DownloadTask::onSegmentFailed);
    connect(w, &SegmentDownloader::shortFinish, this, &DownloadTask::onSegmentShortFinish);
    connect(w, &SegmentDownloader::objectChanged, this, &DownloadTask::onSegmentObjectChanged);
    connect(w, &SegmentDownloader::sizeDiscovered, this, &DownloadTask::onSizeDiscovered);
    m_workers.append(w);
    return w;
}

QString DownloadTask::resumeValidator() const
{
    if (!m_etag.isEmpty() && !m_etag.startsWith(QLatin1String("W/")))
        return m_etag;
    return m_lastModified;
}

// Dynamic re-segmentation (work-stealing): a connection that just finished its
// segment grabs the SECOND HALF of whichever active segment has the most bytes
// still to fetch. The donor is shrunk to stop at the split point and the freed
// connection downloads the tail — so all connections stay busy until the very
// end instead of trickling down to one slow stream. This is the IDM-style trick
// that keeps the aggregate speed high through the tail of a download.
bool DownloadTask::tryResegment()
{
    // Only meaningful for a real multi-range download with a known size.
    if (!m_dynamicResegment || !m_rangesSupported || m_total <= 0)
        return false;

    // Pick the active worker with the largest un-fetched remainder.
    SegmentDownloader *donor = nullptr;
    int    donorIdx = -1;
    qint64 best = 0, donorPos = 0;
    for (auto *w : m_workers) {
        const int si = w->index();
        if (si < 0 || si >= m_segments.size() || m_segments[si].complete())
            continue;
        const qint64 pos = m_segments[si].start + w->bytesDone();   // next byte it will write
        const qint64 remaining = m_segments[si].end - pos + 1;
        if (remaining > best) { best = remaining; donor = w; donorIdx = si; donorPos = pos; }
    }

    // Not worth splitting a small remainder (the overhead/extra connection costs
    // more than it saves once the tail is tiny).
    static const qint64 kMinSplit = 4 * 1024 * 1024;   // 4 MB
    if (!donor || best < kMinSplit)
        return false;

    const qint64 oldEnd = m_segments[donorIdx].end;
    const qint64 mid    = donorPos + (oldEnd - donorPos + 1) / 2;   // first byte of the tail
    if (mid <= donorPos || mid > oldEnd)                            // safety: keep ranges valid
        return false;

    // Shrink the donor to [start, mid-1]; it stops there. The freed connection
    // fetches the tail [mid, oldEnd] — contiguous, non-overlapping, no gap.
    m_segments[donorIdx].end = mid - 1;
    donor->setEnd(mid - 1);

    SegmentInfo tail;
    tail.index = m_segments.size();
    tail.start = mid;
    tail.end   = oldEnd;
    tail.done  = 0;
    m_segments.append(tail);
    makeWorker(tail)->start();

    if (kDebug)
        qDebug().noquote() << "NEXA RESEG" << m_id << "split seg" << donorIdx
                           << "@" << mid << "-> seg" << tail.index
                           << "(" << (oldEnd - mid + 1) << "B)";
    return true;
}

void DownloadTask::clearSegments()
{
    // Take a copy and clear the member FIRST. stop() can make a worker emit
    // completed/failed synchronously, which re-enters onSegmentCompleted ->
    // tryResegment() -> makeWorker() -> m_workers.append(); appending while a
    // range-for iterates m_workers reallocates the vector and invalidates the
    // loop pointer (a use-after-free crash on Remove/pause of an active task).
    // Disconnecting first stops those callbacks from re-entering at all.
    const QVector<SegmentDownloader*> workers = m_workers;
    m_workers.clear();
    for (auto *w : workers) {
        w->disconnect(this);
        w->stop();
        w->deleteLater();
    }
}

void DownloadTask::onSegmentProgressed(int index, qint64 delta)
{
    m_done += delta;
    if (index >= 0 && index < m_segments.size())
        m_segments[index].done += delta;
    // Forward progress means this connection is healthy again: clear its retry
    // budget so only *consecutive* failures (no progress between them) count
    // toward the give-up limit, rather than failures accumulated over the whole
    // download. (Also stops the short-read and network-error paths, which share
    // m_retries, from starving each other.)
    if (delta > 0 && m_retries.contains(index))
        m_retries.remove(index);
}

// A worker learned the real file size from the live response headers that the
// size probe couldn't get (chunked / redirected / auth-gated GitHub, Drive, AI
// links). Adopt it so "File size" stops reading "Unknown" and an ETA becomes
// possible — all mid-download, without restarting anything.
void DownloadTask::onSizeDiscovered(qint64 total, bool rangesSupported)
{
    if (m_total > 0 || total <= 0)
        return;                       // already known, or nothing useful learned
    m_total = total;
    // A 206 on the live transfer proves Range support the probe missed — so the
    // download is resumable. Reflects as "Resume capability: Yes" in the UI.
    if (rangesSupported)
        m_rangesSupported = true;
    // An unknown-size download is always a single open-ended segment. Clamp it to
    // the real last byte so it finishes cleanly at EOF instead of leaning on the
    // server to close the connection.
    if (m_segments.size() == 1) {
        m_segments[0].end = total - 1;
        if (!m_workers.isEmpty() && m_workers.first())
            m_workers.first()->setEnd(total - 1);
    }
    // Grow the file to the real length so a later pause finds it backing the
    // progress (resume() wants size >= total). Off-thread, because on FAT32 /
    // exFAT the extension is a synchronous zero-fill. No valid-data settling: a
    // single stream writes sequentially, so nothing ever writes past the valid
    // length, and poking the last byte could race the final write of a tiny
    // download. If the stream turned out shorter than advertised and finished
    // (truncated) while the worker was still growing, put the truncation back.
    growFileAsync(total, /*settleValidData=*/false, [this](bool) {
        if (m_state == DownloadState::Completed && m_total > 0
            && QFileInfo(m_savePath).size() > m_total) {
            QFile f(m_savePath);
            if (f.open(QIODevice::ReadWrite))
                f.resize(m_total);
        }
    });
    persist();
    emit progress(m_id, m_done, m_total, 0.0);   // UI now shows size + time-left
}

void DownloadTask::onSegmentCompleted(int index)
{
    if (index >= 0 && index < m_segments.size())
        m_segments[index].done = m_segments[index].length();
    ++m_completedSegments;
    // The connection is now free — instead of going idle, steal the tail of the
    // largest remaining segment so throughput stays high through the end.
    if (m_state == DownloadState::Downloading)
        tryResegment();
    persist();
    checkAllComplete();
}

void DownloadTask::onSegmentFailed(int index, const QString &error)
{
    if (m_state == DownloadState::Paused)
        return;
    // Transient network error — retry this one segment a few times (it resumes
    // from where it stopped) before giving up on the whole download.
    if (m_retries.value(index) < kMaxRetries) {
        retrySegment(index, error);
        return;
    }
    m_speedTimer->stop();
    clearSegments();
    setState(DownloadState::Error,
             QStringLiteral("segment %1: %2").arg(index).arg(error));
    persist();
}

void DownloadTask::onSegmentShortFinish(int index, qint64 received)
{
    Q_UNUSED(received);
    if (m_state == DownloadState::Paused)
        return;

    // The server closed cleanly having sent fewer bytes than the range we
    // requested. If there might be more (transient early close), retry up to
    // kMaxShortReadRetries times — the segment resumes from its current offset.
    // Apple Music CDN in particular cuts connections repeatedly before the file
    // is fully served; a higher cap lets us survive those interruptions.
    //
    // Only when a resume is possible at all, though. An unknown-length body from
    // a server that ignores Range (a chunked, dynamically generated download —
    // the single open-ended segment with no Range support) cannot be resumed:
    // every "bytes=N-" retry comes back as a fresh 200 from byte zero, which the
    // worker rightly rejects, and the whole download died with "server ignored
    // the byte-range resume request" even though every byte had already
    // arrived. For such a server the one clean close IS the end of the object
    // (RFC 7230 §3.3.3: with no length, the message ends when the connection
    // closes), so accept it at once instead of burning the retry budget.
    const bool resumable = m_rangesSupported || m_segments.size() != 1;
    if (resumable && m_retries.value(index) < kMaxShortReadRetries) {
        retrySegment(index, QStringLiteral("short read"));
        return;
    }

    // Still short after retries: the server genuinely has no more data, i.e. the
    // advertised total was larger than the real content. Accept what we have.
    if (m_segments.size() == 1) {
        finalizeShort(m_done);
        return;
    }
    // Multi-segment short read leaves a gap we can't fill — fail clearly.
    m_speedTimer->stop();
    clearSegments();
    setState(DownloadState::Error,
             QStringLiteral("segment %1 ended early (incomplete)").arg(index));
    persist();
}

// A resumed connection found a different object behind the URL (the If-Range
// validator no longer matches, or the server restarted from byte zero). Nothing
// on disk can be trusted, and no retry can fix it: every attempt would hit the
// same mismatch, so this used to burn the retry budget and end in an Error that
// Resume reproduced forever — the only way out was to remove and re-add the
// download. Do what the probe path does when it sees a changed validator on a
// fresh start: drop the partial file and layout, then probe again from scratch.
void DownloadTask::onSegmentObjectChanged(int index)
{
    Q_UNUSED(index);
    if (m_state != DownloadState::Downloading)
        return;
    m_speedTimer->stop();
    clearSegments();                       // stop() closes every worker's handle
    QFile::remove(m_savePath);
    m_segments.clear();
    m_done = 0;
    m_total = -1;
    m_rangesSupported = false;
    m_etag.clear();
    m_lastModified.clear();
    m_completedSegments = 0;
    m_activeSegments = 0;
    m_retries.clear();
    // Leave the "downloading" state silently: start() refuses to run while
    // Downloading/Probing, and announcing Paused here would let the engine hand
    // this slot to another queued task for the instant before the re-probe.
    m_state = DownloadState::Queued;
    persist();
    start();
}

void DownloadTask::retrySegment(int index, const QString &reason)
{
    m_retries[index] = m_retries.value(index) + 1;
    if (kDebug)
        qDebug().noquote() << "NEXA RETRY" << m_id << "seg" << index
                           << "attempt" << m_retries[index] << reason;
    // Restart just this segment after a short backoff; it resumes from seg.done.
    for (auto *w : m_workers) {
        if (w->index() == index) {
            const int delayMs = 400 * m_retries.value(index);
            QTimer::singleShot(delayMs, this, [this, w]() {
                if (m_state == DownloadState::Downloading && m_workers.contains(w))
                    w->start();
            });
            return;
        }
    }
}

// A DRM-protected MP4 (Apple Music, and other EME/CENC web players) downloads
// byte-for-byte perfectly, but every audio/video sample is AES-encrypted under a
// key we never have — so the file plays as silence/garbage. Rather than mark such
// a download "Completed" and hand the user a useless silent file, detect Common
// Encryption and fail with a clear reason.
//
// The signalling lives in the `moov` (the encrypted sample entries enca/encv plus
// the protection boxes sinf/schm/tenc) and in optional top-level `pssh` boxes. We
// walk the top-level boxes to find `moov` wherever it sits, then scan its (small)
// body for those markers — none of which appear in clean media. Returns an empty
// string when the file is not encrypted (or isn't an MP4 we should check).
static QString drmBlockReason(const QString &path)
{
    // Only the ISO-BMFF / MP4 family carries CENC; skip the cost for everything else.
    static const QStringList kMp4Suffixes = {
        QStringLiteral("mp4"), QStringLiteral("m4a"), QStringLiteral("m4v"),
        QStringLiteral("m4b"), QStringLiteral("m4p"), QStringLiteral("mov")};
    if (!kMp4Suffixes.contains(QFileInfo(path).suffix().toLower()))
        return QString();

    QFile f(path);
    if (!f.open(QIODevice::ReadOnly))
        return QString();

    auto be32 = [](const uchar *p) -> quint64 {
        return (quint64(p[0]) << 24) | (quint64(p[1]) << 16)
             | (quint64(p[2]) << 8)  |  quint64(p[3]);
    };
    const qint64 fileSize = f.size();
    qint64 pos = 0;
    // Walk only the top-level boxes (ftyp, moov, mdat, moof…): a handful of seeks,
    // never a full read of a large media file.
    while (pos + 8 <= fileSize) {
        if (!f.seek(pos))
            break;
        const QByteArray hdr = f.read(16);
        if (hdr.size() < 8)
            break;
        const uchar *h = reinterpret_cast<const uchar *>(hdr.constData());
        quint64 boxSize = be32(h);
        const QByteArray type = hdr.mid(4, 4);
        qint64 headerLen = 8;
        if (boxSize == 1) {                 // 64-bit largesize
            if (hdr.size() < 16) break;
            boxSize = (be32(h + 8) << 32) | be32(h + 12);
            headerLen = 16;
        } else if (boxSize == 0) {          // extends to EOF
            boxSize = quint64(fileSize - pos);
        }
        if (boxSize < quint64(headerLen))   // malformed: stop, don't loop forever
            break;
        if (type == "pssh")                 // a DRM system header at top level
            return QStringLiteral("DRM-protected");
        if (type == "moov") {
            // Cap the body read so a (pathologically) huge moov can't be slurped whole.
            const qint64 bodyLen = qMin<qint64>(qint64(boxSize) - headerLen, 4 * 1024 * 1024);
            const QByteArray body = f.read(bodyLen);
            static const char *kMarkers[] = {"enca", "encv", "tenc", "pssh"};
            for (const char *m : kMarkers)
                if (body.contains(QByteArray::fromRawData(m, 4)))
                    return QStringLiteral("DRM-protected");
            return QString();               // moov scanned, no protection -> clean
        }
        pos += qint64(boxSize);
    }
    return QString();
}

void DownloadTask::finalizeShort(qint64 totalReceived)
{
    m_speedTimer->stop();
    // A zero-byte "short finish" is a failure, not a success: the server sent no
    // body. Don't silently leave a 0-byte file marked Completed.
    if (totalReceived <= 0) {
        clearSegments();
        setState(DownloadState::Error, QStringLiteral("server returned no data"));
        return;
    }
    clearSegments();
    // Trim the pre-allocated file down to what we actually received.
    QFile f(m_savePath);
    if (f.open(QIODevice::ReadWrite))
        f.resize(totalReceived);
    f.close();
    m_total = totalReceived;
    m_done  = totalReceived;   // keep done==total so cached progress stays consistent
    if (!m_segments.isEmpty()) {
        m_segments[0].end = totalReceived - 1;
        m_segments[0].done = totalReceived;
    }
    m_completedSegments = m_segments.size();
    if (!drmBlockReason(m_savePath).isEmpty()) {
        setState(DownloadState::Error, kDrmErrorDetail);
        persist();
        return;
    }

    QString completionDetail;
    if (const QString hashError = verifyHash(&completionDetail); !hashError.isEmpty()) {
        setState(DownloadState::Error, hashError);   // data-integrity failure
        persist();
        return;
    }

    setState(DownloadState::Completed, completionDetail);
    persist();
    emit progress(m_id, m_total, m_total, 0.0);
    emit finished(m_id);
}

void DownloadTask::checkAllComplete()
{
    if (m_completedSegments < m_segments.size())
        return;
    m_speedTimer->stop();
    clearSegments();
    if (m_total <= 0)
        m_total = m_done;          // unknown-size stream: final size is what we got
    if (!drmBlockReason(m_savePath).isEmpty()) {
        setState(DownloadState::Error, kDrmErrorDetail);
        persist();
        return;
    }

    QString completionDetail;
    if (const QString hashError = verifyHash(&completionDetail); !hashError.isEmpty()) {
        setState(DownloadState::Error, hashError);   // data-integrity failure
        persist();
        return;
    }

    setState(DownloadState::Completed, completionDetail);
    persist();
    emit progress(m_id, m_done, m_total, 0.0);
    emit finished(m_id);
}

// Verify the finished file against an expected SHA-256, if one was supplied.
// Returns an error to fail the download with, or an empty string to continue;
// *detail receives the completion text.
//
// The hash is computed ONLY when something asked for it. Both completion paths
// used to hash unconditionally, and computeSha256() consults m_expectedSha256
// only *after* reading the file — so every finished download was read end to
// end on the GUI thread, freezing the window (and stalling every other active
// download, which share that thread) in proportion to its size, to produce a
// value no caller ever looked at. Only the updater sets an expected hash.
QString DownloadTask::verifyHash(QString *detail)
{
    *detail = QStringLiteral("done");
    m_hashResult = HashVerification{};
    if (m_expectedSha256.isEmpty())
        return QString();

    m_hashResult = computeSha256();
    // A hash was demanded and could not be produced (unreadable or empty
    // file). Fail closed: the caller that asked for verification — the
    // updater, about to run this file — must never see "Completed" here.
    if (!m_hashResult.hasExpected)
        return QStringLiteral("hash verification failed: the file could not be read");
    if (m_hashResult.verified) {
        if (kDebug)
            qDebug().noquote() << "NEXA HASH VERIFIED" << m_id << m_hashResult.sha256;
        *detail = QStringLiteral("done (hash verified)");
        return QString();
    }
    return QStringLiteral("hash mismatch: expected %1, got %2")
        .arg(m_expectedSha256.toLower(), m_hashResult.sha256);
}

// Compute SHA-256 hash of the downloaded file for integrity verification.
// This is called after download completion but before marking as "Completed".
HashVerification DownloadTask::computeSha256() const
{
    HashVerification result;

    // Only compute if we have a valid file
    QFileInfo fi(m_savePath);
    if (!fi.exists() || fi.size() == 0) {
        return result;
    }

    QFile file(m_savePath);
    if (!file.open(QIODevice::ReadOnly)) {
        return result;
    }

    QCryptographicHash hash(QCryptographicHash::Sha256);
    constexpr qint64 chunkSize = 1024 * 1024; // 1 MB chunks
    qint64 totalRead = 0;

    while (!file.atEnd()) {
        const QByteArray chunk = file.read(chunkSize);
        if (chunk.isEmpty())
            break;
        hash.addData(chunk);
        totalRead += chunk.size();
    }
    file.close();

    result.sha256 = QString::fromLatin1(hash.result().toHex());

    // Check against expected hash if provided
    if (!m_expectedSha256.isEmpty()) {
        result.hasExpected = true;
        // Normalize both to lowercase for comparison
        result.verified = (m_expectedSha256.toLower() == result.sha256.toLower());
    }

    return result;
}

void DownloadTask::pause()
{
    if (m_state != DownloadState::Downloading && m_state != DownloadState::Probing)
        return;
    m_speedTimer->stop();
    ++m_allocGeneration;   // orphan an in-flight allocation worker (see start())
    if (m_probe) {
        // abort() can fire finished() SYNCHRONOUSLY, re-entering onProbeFinished
        // which nulls m_probe — then the old code dereferenced a now-null m_probe
        // (crash on Remove/pause of a still-probing task). Null + disconnect FIRST.
        QNetworkReply *p = m_probe;
        m_probe = nullptr;
        p->disconnect(this);
        p->abort();
        p->deleteLater();
    }
    clearSegments();
    setState(DownloadState::Paused, QStringLiteral("paused"));
    persist();   // after the state change, so the row says Paused, not Downloading
}

bool DownloadTask::changeUrl(const QUrl &newUrl, const HeaderList &headers)
{
    // Re-aiming a task that has workers in flight would leave them writing the
    // old object into the same file as the new one. Stop it first.
    if (m_state == DownloadState::Downloading || m_state == DownloadState::Probing)
        return false;
    if (!newUrl.isValid() || newUrl.host().isEmpty())
        return false;
    const QString scheme = newUrl.scheme().toLower();
    if (scheme != QLatin1String("http") && scheme != QLatin1String("https"))
        return false;

    m_url = newUrl;
    if (!headers.isEmpty())
        m_headers = headers;

    // The user handed us THIS address for THIS download, so the captured
    // cookies/tokens are scoped to the new host deliberately -- unlike a
    // redirect, which is the server's choice and must not widen the scope by
    // itself. resume() with segments already laid out never calls start(), so
    // without this the sensitive headers would still be scoped to the dead host
    // and makeWorker() would strip them: the refresh would 401 instead of
    // running, which is the whole failure it exists to fix.
    m_credHost = m_url.host();

    // The old address's redirect / confirm-page bookkeeping says nothing about
    // the new one; carrying it over makes the fresh URL fail for the previous
    // URL's reasons.
    m_probeRedirects = 0;
    m_driveConfirmed = false;
    m_confirmPageFetched = false;
    m_retries.clear();

    persist();   // saveTask() reads url(), so the new address survives a restart
    return true;
}

void DownloadTask::resume()
{
    if (m_state == DownloadState::Completed || m_state == DownloadState::Downloading)
        return;

    // Never probed yet (fresh restored task) -> probe first.
    if (m_segments.isEmpty() || m_total < 0) {
        start();
        return;
    }

    // Validate the partial file still matches our segment offsets. If it was
    // deleted / moved / truncated between sessions, the SegmentDownloader would
    // seek() past EOF on a freshly-created empty file, leaving the unfetched
    // leading bytes as zero-filled holes — a silently corrupt "completed" file.
    // When the file no longer backs our progress, reset and re-probe instead.
    {
        const QFileInfo fi(m_savePath);
        const bool fileBacksProgress =
            fi.exists()
            && (m_total <= 0 || fi.size() >= m_total)   // preallocated to full size
            && fi.size() >= m_done;                     // holds at least our claimed bytes
        if (!fileBacksProgress) {
            for (auto &s : m_segments) s.done = 0;
            m_done = 0;
            m_segments.clear();                         // force a clean re-probe + prealloc
            persist();
            start();
            return;
        }
    }

    setState(DownloadState::Downloading, QStringLiteral("resuming"));
    m_clock.start();
    m_lastTickBytes = m_done;
    m_lastTickMs = 0;
    m_speedTimer->start();
    launchSegments();
}

void DownloadTask::emitSpeedTick()
{
    const qint64 nowMs = m_clock.elapsed();
    const qint64 dMs = nowMs - m_lastTickMs;
    double bps = 0.0;
    if (dMs > 0)
        bps = double(m_done - m_lastTickBytes) * 1000.0 / double(dMs);
    m_lastTickMs = nowMs;
    m_lastTickBytes = m_done;
    emit progress(m_id, m_done, m_total, bps);

    // Persist segment offsets periodically so a crash/kill resumes from disk,
    // not from the start of each in-flight segment. The speed tick fires every
    // 500 ms but a DB save every 500 ms is wasteful, so throttle to every 4th
    // tick (~2 s). Segment completions and state changes still persist
    // immediately, so nothing important waits on this cadence.
    if (++m_ticksSincePersist >= 4) {
        m_ticksSincePersist = 0;
        persist();
    }
}

void DownloadTask::setState(DownloadState s, const QString &detail)
{
    if (kDebug) {
        if (s == DownloadState::Probing)
            qDebug().noquote() << "NEXA BEGIN" << m_id;
        else if (s == DownloadState::Completed || s == DownloadState::Error)
            qDebug().noquote() << "NEXA END" << m_id;
    }
    m_state = s;
    emit stateChanged(m_id, s, detail);
}

void DownloadTask::persist()
{
    if (m_db)
        m_db->saveTask(*this, m_segments);
}

} // namespace nexa
