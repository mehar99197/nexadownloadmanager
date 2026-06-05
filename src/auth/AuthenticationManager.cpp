#include "auth/AuthenticationManager.h"

#include <QNetworkRequest>
#include <QDateTime>
#include <QFileInfo>
#include <QDir>
#include <QFile>
#include <QStandardPaths>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QRegularExpression>
#include <QUuid>
#include <QCryptographicHash>
#include <utility>

namespace nexa {

qint64 AuthenticationManager::nowEpoch()
{
    return QDateTime::currentSecsSinceEpoch();
}

// Host-suffix match: host == domain OR host endsWith "." + domain. Mirrors the
// convention YtDlpGrabber::isSiteVideoUrl uses, so "udemy.com" covers
// "www.udemy.com" and CDN subdomains alike. Both sides are lower-cased.
bool AuthenticationManager::hostMatchesDomain(const QString &host, const QString &domain)
{
    const QString h = host.toLower();
    const QString d = domain.toLower();
    if (d.isEmpty())
        return false;
    return h == d || h.endsWith(QLatin1Char('.') + d);
}

// YouTube hosts are owned exclusively by yt-dlp's extractor; never inject auth
// for them even if a youtube.com credential were registered by mistake. Mirrors
// the existing safeguard in YtDlpGrabber.
bool AuthenticationManager::isExcludedHost(const QString &host)
{
    const QString h = host.toLower();
    return h == QStringLiteral("youtube.com") ||
           h.endsWith(QStringLiteral(".youtube.com")) ||
           h == QStringLiteral("youtu.be") ||
           h.endsWith(QStringLiteral(".youtu.be"));
}

// The private 0700 directory where materialised cookie/bearer files live.
static QString authDirPath()
{
    QString dir = QStandardPaths::writableLocation(QStandardPaths::RuntimeLocation);
    if (dir.isEmpty())
        dir = QStandardPaths::writableLocation(QStandardPaths::TempLocation);
    if (dir.isEmpty())
        return QString();
    return dir + QStringLiteral("/nexa-auth");
}

AuthenticationManager::AuthenticationManager(QObject *parent)
    : QObject(parent)
{
    // Sweep cleartext cookie/bearer files a PREVIOUS session left behind after a
    // crash or SIGKILL (a clean exit removes them in the destructor). They hold
    // live session credentials and must not linger across runs.
    const QString dir = authDirPath();
    if (!dir.isEmpty()) {
        QDir d(dir);
        const auto stale = d.entryList({QStringLiteral("cookies-*.txt"),
                                        QStringLiteral("ytauth-*.conf")}, QDir::Files);
        for (const QString &f : stale)
            QFile::remove(d.filePath(f));
    }
}

AuthenticationManager::~AuthenticationManager()
{
    // Remove any temp yt-dlp auth config files we materialised this session so a
    // bearer token never lingers on disk after the app exits.
    for (const QString &p : std::as_const(m_tempAuthFiles))
        QFile::remove(p);
}

AuthResult AuthenticationManager::registerCookieFile(const QString &domain,
                                                     const QString &cookieFilePath)
{
    if (domain.trimmed().isEmpty())
        return AuthResult::failure(AuthError::UnknownDomain, QStringLiteral("empty domain"));

    // yt-dlp's --cookies wants an absolute path; the engine may run from anywhere.
    const QString absPath = QFileInfo(cookieFilePath).absoluteFilePath();

    QVector<Cookie> jar;
    const CookieFile::ParseResult pr = CookieFile::parse(absPath, jar);
    switch (pr.status) {
        case CookieFile::ParseStatus::Ok:
            break;
        case CookieFile::ParseStatus::FileNotFound:
            return AuthResult::failure(AuthError::FileNotFound, absPath);
        case CookieFile::ParseStatus::EmptyFile:
            return AuthResult::failure(AuthError::EmptyFile, absPath);
        case CookieFile::ParseStatus::Malformed:
            return AuthResult::failure(AuthError::MalformedFormat, pr.detail);
        case CookieFile::ParseStatus::AllExpired:
            return AuthResult::failure(AuthError::AllExpired, absPath);
    }

    DomainAuth a;
    a.kind = DomainAuth::Kind::CookieFile;
    a.domain = domain.toLower();
    a.cookieFilePath = absPath;
    m_byDomain.insert(a.domain, a);
    return AuthResult::success();
}

AuthResult AuthenticationManager::registerCookieData(const QString &domain,
                                                     const QString &cookiesTxt)
{
    if (domain.trimmed().isEmpty())
        return AuthResult::failure(AuthError::UnknownDomain, QStringLiteral("empty domain"));

    // Bound the work BEFORE touching disk: never write a hostile multi-MB blob.
    const QByteArray raw = cookiesTxt.toUtf8();
    if (raw.isEmpty())
        return AuthResult::failure(AuthError::EmptyFile, QStringLiteral("no cookie text"));
    if (raw.size() > 5 * 1024 * 1024)
        return AuthResult::failure(AuthError::MalformedFormat,
                                   QStringLiteral("cookie text too large (>5 MB)"));

    // Collapse duplicate cookies a raw browser export accumulates from repeated
    // logins (e.g. two `access_token`s at .udemy.com and www.udemy.com). Left
    // intact, yt-dlp forwards them all and the site honours the stale one and
    // bounces to a login page — the cookies LOOK valid but the download fails.
    const QByteArray bytes = CookieFile::dedupe(raw);

    // Private dir (0700) + file (0600), mirroring writeYtDlpAuthConfig, so a
    // session cookie is never briefly world-readable.
    const QString dir = authDirPath();
    if (dir.isEmpty())
        return AuthResult::failure(AuthError::FileNotFound, QStringLiteral("no writable runtime dir"));
    QDir().mkpath(dir);
    QFile::setPermissions(dir, QFile::ReadOwner | QFile::WriteOwner | QFile::ExeOwner);

    // QUuid (not a timestamp) so two extension handoffs in the same millisecond
    // can't collide and corrupt each other's cookie file.
    const QString path = dir + QStringLiteral("/cookies-")
                       + QUuid::createUuid().toString(QUuid::Id128)
                       + QStringLiteral(".txt");
    QFile::remove(path);   // clear any pre-existing file/symlink at the path first
    QFile f(path);
    if (!f.open(QIODevice::WriteOnly | QIODevice::NewOnly))
        return AuthResult::failure(AuthError::FileNotFound, path);
    f.setPermissions(QFile::ReadOwner | QFile::WriteOwner);   // lock before writing
    f.write(bytes);
    f.close();

    // Track for destructor cleanup regardless of the validation outcome.
    if (!m_tempAuthFiles.contains(path))
        m_tempAuthFiles.append(path);

    const AuthResult ar = registerCookieFile(domain, path);
    if (!ar.ok) {
        QFile::remove(path);
        m_tempAuthFiles.removeAll(path);
    }
    return ar;
}

AuthResult AuthenticationManager::registerBearerToken(const QString &domain,
                                                      const QString &token,
                                                      qint64 expiresAt)
{
    if (domain.trimmed().isEmpty())
        return AuthResult::failure(AuthError::UnknownDomain, QStringLiteral("empty domain"));
    const QString tok = token.trimmed();
    if (tok.isEmpty())
        return AuthResult::failure(AuthError::MalformedFormat, QStringLiteral("empty bearer token"));
    // SECURITY: reject anything outside the RFC 6750 b64token charset. This blocks
    // header/CRLF injection (a token like "x\r\nX-Evil: 1" would otherwise forge
    // extra HTTP headers via setRawHeader / yt-dlp --add-header) AND guarantees the
    // token is safe to embed unquoted in a yt-dlp config file. Tokens come from an
    // untrusted source (the browser extension), so this is enforced, not advisory.
    static const QRegularExpression tokRe(QStringLiteral("\\A[A-Za-z0-9._~+/-]+=*\\z"));
    if (!tokRe.match(tok).hasMatch())
        return AuthResult::failure(AuthError::MalformedFormat,
            QStringLiteral("bearer token has invalid characters (expected an RFC 6750 token)"));
    if (expiresAt > 0 && expiresAt <= nowEpoch())
        return AuthResult::failure(AuthError::TokenExpired);

    DomainAuth a;
    a.kind = DomainAuth::Kind::BearerToken;
    a.domain = domain.toLower();
    a.bearerToken = tok;
    a.expiresAt = expiresAt;
    m_byDomain.insert(a.domain, a);
    return AuthResult::success();
}

AuthResult AuthenticationManager::registerBrowserCookies(const QString &domain,
                                                         const QString &browser,
                                                         const QString &profile)
{
    if (domain.trimmed().isEmpty())
        return AuthResult::failure(AuthError::UnknownDomain, QStringLiteral("empty domain"));
    // Allowlist the browser name: it is passed to yt-dlp as a CLI value, so keep
    // it to the known set (no injection surface, and a clear error on a typo).
    static const QStringList kBrowsers = {
        QStringLiteral("chrome"), QStringLiteral("chromium"), QStringLiteral("edge"),
        QStringLiteral("brave"), QStringLiteral("firefox"), QStringLiteral("opera"),
        QStringLiteral("vivaldi"), QStringLiteral("safari"), QStringLiteral("whale"),
    };
    const QString b = browser.trimmed().toLower();
    if (!kBrowsers.contains(b))
        return AuthResult::failure(AuthError::MalformedFormat,
            QStringLiteral("unsupported browser '%1'").arg(browser));

    // The profile is a directory name (e.g. "Default", "Profile 2"), never a path
    // or flag. Reject anything with path separators / a leading dash so it can't be
    // smuggled into the yt-dlp "browser:profile" CLI value as an option or traversal.
    const QString prof = profile.trimmed();
    if (!prof.isEmpty() && (prof.contains(QLatin1Char('/')) ||
                            prof.contains(QLatin1Char('\\')) ||
                            prof.startsWith(QLatin1Char('-')) ||
                            prof.contains(QLatin1Char(':'))))
        return AuthResult::failure(AuthError::MalformedFormat,
            QStringLiteral("invalid browser profile '%1'").arg(profile));

    DomainAuth a;
    a.kind = DomainAuth::Kind::BrowserCookies;
    a.domain = domain.toLower();
    a.browser = b;
    a.browserProfile = prof;
    // QHash::insert REPLACES any existing entry for this domain — so registering
    // browser-login here supersedes a previously registered (and now stale)
    // cookies.txt / bearer / older browser-profile credential for the same site.
    m_byDomain.insert(a.domain, a);
    return AuthResult::success();
}

bool AuthenticationManager::unregister(const QString &domain)
{
    return m_byDomain.remove(domain.toLower()) > 0;
}

AuthResult AuthenticationManager::loadFromJson(const QString &path)
{
    QString file = path;
    if (file.isEmpty()) {
        QString cfg = QStandardPaths::writableLocation(QStandardPaths::ConfigLocation);
        if (cfg.isEmpty())
            cfg = QDir::homePath() + QStringLiteral("/.config");
        file = cfg + QStringLiteral("/nexa/auth.json");
    }

    QFileInfo fi(file);
    if (!fi.exists())                       // config is optional — absence is fine
        return AuthResult::success();

    QFile f(file);
    if (!f.open(QIODevice::ReadOnly))
        return AuthResult::failure(AuthError::FileNotFound, file);
    const QByteArray bytes = f.readAll();
    f.close();

    QJsonParseError perr;
    const QJsonDocument doc = QJsonDocument::fromJson(bytes, &perr);
    if (perr.error != QJsonParseError::NoError || !doc.isObject())
        return AuthResult::failure(AuthError::MalformedFormat,
                                   QStringLiteral("auth.json: %1").arg(perr.errorString()));

    const QJsonObject root = doc.object();
    for (auto it = root.begin(); it != root.end(); ++it) {
        const QString domain = it.key();
        const QJsonObject e = it.value().toObject();
        const QString kind = e.value(QStringLiteral("kind")).toString().toLower();

        AuthResult r;
        if (kind == QStringLiteral("cookies") || kind == QStringLiteral("cookiefile")) {
            r = registerCookieFile(domain, e.value(QStringLiteral("path")).toString());
        } else if (kind == QStringLiteral("bearer") || kind == QStringLiteral("token")) {
            const qint64 exp = qint64(e.value(QStringLiteral("expiresAt")).toDouble(0));
            r = registerBearerToken(domain, e.value(QStringLiteral("token")).toString(), exp);
        } else {
            r = AuthResult::failure(AuthError::MalformedFormat,
                                    QStringLiteral("%1: unknown kind '%2'").arg(domain, kind));
        }
        // Best-effort: keep earlier valid entries, but report the first failure.
        if (!r.ok)
            return r;
    }
    return AuthResult::success();
}

DomainAuth AuthenticationManager::resolve(const QUrl &url) const
{
    const QString host = url.host().toLower();
    if (host.isEmpty() || isExcludedHost(host))
        return DomainAuth{};   // None — preserves the YouTube safeguard

    const qint64 now = nowEpoch();
    DomainAuth best;
    int bestLen = -1;
    for (auto it = m_byDomain.constBegin(); it != m_byDomain.constEnd(); ++it) {
        const DomainAuth &a = it.value();
        if (!hostMatchesDomain(host, a.domain))
            continue;
        if (a.isExpired(now))
            continue;          // drop expired bearer; validateFor surfaces TokenExpired
        if (a.domain.length() > bestLen) {   // most specific (longest) domain wins
            best = a;
            bestLen = a.domain.length();
        }
    }
    return best;
}

bool AuthenticationManager::hasAuthFor(const QUrl &url) const
{
    return resolve(url).kind != DomainAuth::Kind::None;
}

AuthResult AuthenticationManager::validateFor(const QUrl &url) const
{
    const QString host = url.host().toLower();
    if (host.isEmpty() || isExcludedHost(host))
        return AuthResult::success();   // auth not applicable

    // Find the matching registered credential regardless of expiry, so an expired
    // one surfaces the precise reason rather than UnknownDomain.
    const DomainAuth *match = nullptr;
    int bestLen = -1;
    for (auto it = m_byDomain.constBegin(); it != m_byDomain.constEnd(); ++it) {
        const DomainAuth &a = it.value();
        if (hostMatchesDomain(host, a.domain) && a.domain.length() > bestLen) {
            match = &a;
            bestLen = a.domain.length();
        }
    }
    if (!match)
        return AuthResult::success();   // auth is optional — no credential is fine

    if (match->kind == DomainAuth::Kind::BearerToken) {
        if (match->expiresAt > 0 && match->expiresAt <= nowEpoch())
            return AuthResult::failure(AuthError::TokenExpired);
        return AuthResult::success();
    }

    if (match->kind == DomainAuth::Kind::CookieFile) {
        // Re-parse to catch a file that was edited / expired since registration.
        QVector<Cookie> jar;
        const CookieFile::ParseResult pr = CookieFile::parse(match->cookieFilePath, jar);
        switch (pr.status) {
            case CookieFile::ParseStatus::Ok:          return AuthResult::success();
            case CookieFile::ParseStatus::FileNotFound:
                return AuthResult::failure(AuthError::FileNotFound, match->cookieFilePath);
            case CookieFile::ParseStatus::EmptyFile:
                return AuthResult::failure(AuthError::EmptyFile, match->cookieFilePath);
            case CookieFile::ParseStatus::Malformed:
                return AuthResult::failure(AuthError::MalformedFormat, pr.detail);
            case CookieFile::ParseStatus::AllExpired:
                return AuthResult::failure(AuthError::AllExpired, match->cookieFilePath);
        }
    }
    return AuthResult::success();
}

bool AuthenticationManager::applyTo(QNetworkRequest &req, const QUrl &url) const
{
    const DomainAuth a = resolve(url);
    if (a.kind == DomainAuth::Kind::None)
        return false;

    if (a.kind == DomainAuth::Kind::BearerToken) {
        req.setRawHeader(QByteArrayLiteral("Authorization"),
                         QByteArrayLiteral("Bearer ") + a.bearerToken.toUtf8());
        return true;
    }

    if (a.kind == DomainAuth::Kind::CookieFile) {
        QVector<Cookie> jar;
        if (CookieFile::parse(a.cookieFilePath, jar).status != CookieFile::ParseStatus::Ok)
            return false;
        const QByteArray cookieVal = CookieFile::cookieHeaderFor(jar, url, nowEpoch());
        if (cookieVal.isEmpty())
            return false;
        // Append to any browser-captured Cookie header already present.
        QByteArray existing = req.rawHeader(QByteArrayLiteral("Cookie"));
        if (!existing.isEmpty())
            existing += "; ";
        existing += cookieVal;
        req.setRawHeader(QByteArrayLiteral("Cookie"), existing);
        return true;
    }
    return false;
}

HeaderList AuthenticationManager::headerAuthFor(const QUrl &url) const
{
    HeaderList out;
    const DomainAuth a = resolve(url);
    if (a.kind == DomainAuth::Kind::BearerToken) {
        out.append({QByteArrayLiteral("Authorization"),
                    QByteArrayLiteral("Bearer ") + a.bearerToken.toUtf8()});
    } else if (a.kind == DomainAuth::Kind::CookieFile) {
        QVector<Cookie> jar;
        if (CookieFile::parse(a.cookieFilePath, jar).status == CookieFile::ParseStatus::Ok) {
            const QByteArray cookieVal = CookieFile::cookieHeaderFor(jar, url, nowEpoch());
            if (!cookieVal.isEmpty())
                out.append({QByteArrayLiteral("Cookie"), cookieVal});
        }
    }
    return out;
}

// Write a bearer token into a private, owner-only yt-dlp config file and return
// its path. yt-dlp's --config-location reads CLI options from the file, so the
// token reaches yt-dlp WITHOUT ever appearing in the process argument list (where
// `ps` and other users could read it). The token is RFC-6750-charset validated at
// registration, so embedding it in a quoted --add-header line is injection-safe.
QString AuthenticationManager::writeYtDlpAuthConfig(const DomainAuth &a)
{
    const QString dir = authDirPath();
    if (dir.isEmpty())
        return QString();
    QDir().mkpath(dir);
    QFile::setPermissions(dir, QFile::ReadOwner | QFile::WriteOwner | QFile::ExeOwner);

    QString safeDomain = a.domain;
    safeDomain.replace(QRegularExpression(QStringLiteral("[^A-Za-z0-9._-]")), QStringLiteral("_"));
    // Append a short hash of the REAL domain so two distinct domains that sanitize
    // to the same name (e.g. "a:b.com" and "a_b.com") never collide on one file.
    const QString tag = QString::fromLatin1(
        QCryptographicHash::hash(a.domain.toUtf8(), QCryptographicHash::Sha1).toHex().left(8));
    const QString path = dir + QStringLiteral("/ytauth-") + safeDomain
                       + QLatin1Char('-') + tag + QStringLiteral(".conf");

    // The name is predictable; remove any pre-existing file/symlink and create
    // fresh (NewOnly) so a planted symlink can't redirect this bearer-token write
    // onto another file. The 0700 dir already blocks other users.
    QFile::remove(path);
    QFile f(path);
    if (!f.open(QIODevice::WriteOnly | QIODevice::NewOnly))
        return QString();
    // Lock down BEFORE writing the secret so it is never briefly world-readable.
    f.setPermissions(QFile::ReadOwner | QFile::WriteOwner);
    f.write(QStringLiteral("--add-header \"Authorization: Bearer %1\"\n").arg(a.bearerToken).toUtf8());
    f.close();

    if (!m_tempAuthFiles.contains(path))
        m_tempAuthFiles.append(path);
    return path;
}

QStringList AuthenticationManager::ytDlpArgs(const QUrl &url)
{
    const DomainAuth a = resolve(url);
    if (a.kind == DomainAuth::Kind::CookieFile) {
        // A cookie FILE is ideal — only the path crosses the process-arg boundary.
        return {QStringLiteral("--cookies"), a.cookieFilePath};
    }
    if (a.kind == DomainAuth::Kind::BearerToken) {
        // Route the token through a 0600 config file, never the command line.
        const QString cfg = writeYtDlpAuthConfig(a);
        if (!cfg.isEmpty())
            return {QStringLiteral("--config-location"), cfg};
        return {};   // could not write the config — fail closed (no auth) rather than leak
    }
    if (a.kind == DomainAuth::Kind::BrowserCookies) {
        // yt-dlp reads the live cookies straight from the logged-in browser. When a
        // profile is set, target it via the "browser:profile" form (yt-dlp resolves
        // the profile against the browser's user-data dir) so a non-default Chrome
        // profile's session is used instead of the default profile's.
        QString spec = a.browser;
        if (!a.browserProfile.isEmpty())
            spec += QLatin1Char(':') + a.browserProfile;
        return {QStringLiteral("--cookies-from-browser"), spec};
    }
    return {};   // none / excluded host
}

} // namespace nexa
