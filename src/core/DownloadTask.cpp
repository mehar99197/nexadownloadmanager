#include "core/DownloadTask.h"
#include "core/SegmentDownloader.h"
#include "core/Database.h"
#include "auth/AuthUtils.h"

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
#include <QSet>
#include <algorithm>

namespace nexa {

static const bool kDebug = qEnvironmentVariableIsSet("NEXA_DEBUG");

// Shown when a finished download turns out to be DRM-encrypted (e.g. Apple Music
// full tracks). The bytes arrive fine but the samples are encrypted, so the file
// would play as silence — we report that instead of a bogus "Completed".
static const QString kDrmErrorDetail = QStringLiteral(
    "DRM-protected media — the audio/video is encrypted (e.g. Apple Music) and "
    "cannot be played. Only non-DRM previews are downloadable.");

// Headers that carry the user's site credentials. These must NEVER be sent to a
// host other than the one they were captured for (a cross-host redirect to a CDN
// or third party would otherwise leak the session cookie / bearer token).
static bool isSensitiveHeader(const QByteArray &name)
{
    const QByteArray l = name.toLower();
    return l == "cookie" || l == "authorization";
}

// Best-effort registrable domain (eTLD+1) WITHOUT a public-suffix list: take the
// last two labels, or the last three when the second-to-last is a well-known
// second-level domain (co.uk, com.au, …) so siblings under those don't collapse
// together. Good enough to decide whether two hosts are the same first party.
static QString registrableDomain(const QString &host)
{
    const QStringList parts = host.toLower().split(QLatin1Char('.'), Qt::SkipEmptyParts);
    if (parts.size() <= 2)
        return parts.join(QLatin1Char('.'));
    static const QSet<QString> kSld = {
        QStringLiteral("co"),  QStringLiteral("com"), QStringLiteral("net"),
        QStringLiteral("org"), QStringLiteral("gov"), QStringLiteral("edu"),
        QStringLiteral("ac"),  QStringLiteral("ne"),  QStringLiteral("or"),
    };
    const int n = parts.size();
    if (parts[n - 2].size() <= 3 && kSld.contains(parts[n - 2]))
        return QStringList(parts.mid(n - 3)).join(QLatin1Char('.'));
    return QStringList(parts.mid(n - 2)).join(QLatin1Char('.'));
}

// Two hosts share a credential scope when they're the same host OR the same
// first party (registrable domain). This lets a session cookie follow a redirect
// from drive.google.com to drive.usercontent.google.com, or from site.com to its
// own cdn.site.com — exactly as a browser's domain cookie would — while still
// stripping it on a hop to an unrelated third party.
static bool sameCredentialScope(const QString &host, const QString &credHost)
{
    if (credHost.isEmpty() || host.compare(credHost, Qt::CaseInsensitive) == 0)
        return true;
    return registrableDomain(host) == registrableDomain(credHost);
}

// Apply the captured headers to `req`, dropping the sensitive ones unless the
// request targets the credential's first party (so cookies/tokens stay scoped).
static void applyScopedHeaders(QNetworkRequest &req, const HeaderList &headers,
                               const QString &credHost)
{
    const bool inScope = sameCredentialScope(req.url().host(), credHost);
    for (const auto &h : headers) {
        if (!inScope && isSensitiveHeader(h.first))
            continue;
        req.setRawHeader(h.first, h.second);
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

    QString name;
    // RFC 5987 extended form takes precedence (carries proper encoding).
    static const QRegularExpression ext(
        QStringLiteral("filename\\*\\s*=\\s*[^']*''([^;]+)"), QRegularExpression::CaseInsensitiveOption);
    static const QRegularExpression plain(
        QStringLiteral("filename\\s*=\\s*\"?([^\";]+)\"?"), QRegularExpression::CaseInsensitiveOption);
    if (const auto m = ext.match(value); m.hasMatch())
        name = QUrl::fromPercentEncoding(m.captured(1).trimmed().toUtf8());
    else if (const auto m = plain.match(value); m.hasMatch())
        name = m.captured(1).trimmed();

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

bool DownloadTask::renameTo(const QString &newFileName)
{
    const QFileInfo fi(m_savePath);
    const QString dir = fi.absolutePath();
    QString target = dir + QStringLiteral("/") + newFileName;
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

static bool isGoogleDriveHost(const QUrl &u)
{
    const QString h = u.host().toLower();
    return h == QLatin1String("drive.google.com")
        || h == QLatin1String("drive.usercontent.google.com")
        || h == QLatin1String("docs.google.com");
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
static QUrl normalizedGoogleDrive(const QUrl &u)
{
    if (!isGoogleDriveHost(u)
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

// Choose how many parallel connections to use, scaling with file size up to 32.
int DownloadTask::preferredSegmentCount(qint64 totalBytes)
{
    if (totalBytes <= 0)                  return 1;
    if (totalBytes < 1 * 1024 * 1024)     return 1;    // < 1 MB: not worth splitting
    if (totalBytes < 10 * 1024 * 1024)    return 8;    // 1–10 MB
    if (totalBytes < 100 * 1024 * 1024)   return 16;   // 10–100 MB
    return 32;                                          // ≥ 100 MB: max acceleration
}

void DownloadTask::start()
{
    if (m_state == DownloadState::Downloading || m_state == DownloadState::Probing)
        return;

    setState(DownloadState::Probing, QStringLiteral("contacting server"));

    // Turn a Drive share/preview link into its direct /download endpoint up front
    // so cookies are scoped to (and sent to) the host that actually serves bytes.
    m_url = normalizedGoogleDrive(m_url);

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
void DownloadTask::sendProbe()
{
    QNetworkRequest req(m_url);
    req.setHeader(QNetworkRequest::UserAgentHeader, QStringLiteral("Nexa/0.1"));
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::ManualRedirectPolicy);
    req.setRawHeader("Accept-Encoding", "identity");
    applyScopedHeaders(req, m_headers, m_credHost);
    req.setRawHeader("Range", "bytes=0-0");
    m_probe = m_nam->get(req);
    connect(m_probe, &QNetworkReply::finished, this, &DownloadTask::onProbeFinished);
}

void DownloadTask::onProbeFinished()
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

    // Follow redirects MANUALLY so we can drop the site cookie/bearer before
    // sending the probe to a different host (Qt's auto-redirect would re-send
    // them, leaking credentials to the CDN/third party).
    if (status >= 300 && status < 400) {
        const QByteArray loc = r->rawHeader("Location");
        const QUrl target = loc.isEmpty() ? QUrl()
                                          : r->url().resolved(QUrl::fromEncoded(loc));
        if (target.isValid() && m_probeRedirects < 8) {
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
    const QByteArray ctype =
        r->header(QNetworkRequest::ContentTypeHeader).toByteArray().toLower();
    const bool servedHtml = ctype.startsWith("text/html")
                         || ctype.startsWith("application/xhtml");
    if (servedHtml && r->rawHeader("Content-Disposition").isEmpty()) {
        // Google Drive: large files sit behind a confirm page. Fetch it in full,
        // pull out the confirm token, and re-issue against the real file URL.
        if (isGoogleDriveHost(m_url) && !m_driveConfirmed) {
            fetchGoogleDriveConfirm();
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
        // 200 OK: server ignored Range -> single stream, size from Content-Length.
        ranges = false;
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

    if (!preallocateFile()) {
        setState(DownloadState::Error, QStringLiteral("cannot create destination file"));
        return;
    }

    buildSegments(total, ranges);
    persist();
    setState(DownloadState::Downloading,
             QStringLiteral("%1 connection(s)").arg(m_segments.size()));
    m_clock.start();
    m_lastTickBytes = m_done;
    m_lastTickMs = 0;
    m_speedTimer->start();
    launchSegments();
}

// Fetch Google Drive's confirm interstitial IN FULL (the ranged probe only saw
// its first byte), parse the confirm token, and re-probe the resolved file URL.
void DownloadTask::fetchGoogleDriveConfirm()
{
    setState(DownloadState::Probing, QStringLiteral("resolving Google Drive link"));
    QNetworkRequest req(m_url);
    req.setHeader(QNetworkRequest::UserAgentHeader, QStringLiteral("Nexa/0.1"));
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::ManualRedirectPolicy);
    req.setRawHeader("Accept-Encoding", "identity");
    applyScopedHeaders(req, m_headers, m_credHost);   // full GET, no Range
    m_probe = m_nam->get(req);
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
    m_url = confirmed;
    m_credHost = m_url.host();             // re-scope cookies to the resolved host
    m_driveConfirmed = true;
    m_probeRedirects = 0;
    sendProbe();
}

bool DownloadTask::preallocateFile()
{
    QDir().mkpath(QFileInfo(m_savePath).absolutePath());
    QFile f(m_savePath);
    if (!f.open(QIODevice::ReadWrite))
        return false;
    if (m_total > 0) {
        if (!f.resize(m_total)) {
            f.close();
            return false;
        }
    }
    f.close();
    return true;
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
    const int n = isAppleMusicCdn(m_url) ? 1 : preferredSegmentCount(total);
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
                           bool rangesSupported)
{
    m_total = totalBytes;
    m_segments = segments;
    // Use the persisted capability; fall back to the old segment-count heuristic
    // for rows written before the ranges_supported column existed (default 0).
    m_rangesSupported = rangesSupported || segments.size() > 1;
    m_done = 0;
    for (const auto &s : m_segments)
        m_done += s.done;
    if (m_done >= m_total && m_total > 0)
        setState(DownloadState::Completed);
    else
        setState(DownloadState::Paused, QStringLiteral("restored"));
}

void DownloadTask::launchSegments()
{
    clearSegments();
    m_completedSegments = 0;
    m_activeSegments = 0;

    for (const SegmentInfo &seg : m_segments) {
        if (seg.complete()) {
            ++m_completedSegments;
            continue;
        }
        makeWorker(seg);
        ++m_activeSegments;
    }
    for (auto *w : m_workers)
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
    const bool sameHost = m_credHost.isEmpty() || m_url.host() == m_credHost;
    for (const auto &h : m_headers)
        if (sameHost || !isSensitiveHeader(h.first))
            workerHeaders.append(h);
    auto *w = new SegmentDownloader(seg, m_url, m_savePath, workerHeaders, m_nam, m_limiter, this);
    connect(w, &SegmentDownloader::progressed,  this, &DownloadTask::onSegmentProgressed);
    connect(w, &SegmentDownloader::completed,   this, &DownloadTask::onSegmentCompleted);
    connect(w, &SegmentDownloader::failed,      this, &DownloadTask::onSegmentFailed);
    connect(w, &SegmentDownloader::shortFinish, this, &DownloadTask::onSegmentShortFinish);
    connect(w, &SegmentDownloader::sizeDiscovered, this, &DownloadTask::onSizeDiscovered);
    m_workers.append(w);
    return w;
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
    // Grow the pre-allocated file to the real length (best-effort: the write path
    // still appends correctly even if this fails, e.g. on a non-seekable FS).
    QFile f(m_savePath);
    if (f.open(QIODevice::ReadWrite)) { f.resize(total); f.close(); }
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
    persist();
    setState(DownloadState::Error,
             QStringLiteral("segment %1: %2").arg(index).arg(error));
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
    if (m_retries.value(index) < kMaxShortReadRetries) {
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
    persist();
    setState(DownloadState::Error,
             QStringLiteral("segment %1 ended early (incomplete)").arg(index));
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
    setState(DownloadState::Completed, QStringLiteral("done"));
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
    setState(DownloadState::Completed, QStringLiteral("done"));
    persist();
    emit progress(m_id, m_done, m_total, 0.0);
    emit finished(m_id);
}

void DownloadTask::pause()
{
    if (m_state != DownloadState::Downloading && m_state != DownloadState::Probing)
        return;
    m_speedTimer->stop();
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
    persist();
    setState(DownloadState::Paused, QStringLiteral("paused"));
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
