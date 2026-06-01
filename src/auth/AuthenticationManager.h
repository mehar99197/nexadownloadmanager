#pragma once
#include <QObject>
#include <QString>
#include <QHash>
#include <QUrl>
#include <QStringList>
#include "core/Types.h"
#include "auth/CookieFile.h"

class QNetworkRequest;

namespace nexa {

// Why a separate class: authentication is a cross-cutting concern that must be
// applied to BOTH the native QNetworkRequest path (DownloadTask/SegmentDownloader)
// and the yt-dlp QProcess path (YtDlpGrabber), DOMAIN-SCOPED (e.g. udemy.com needs
// cookies/bearer; youtube.com must NOT, or its extractor breaks). Keeping it here,
// depending only on Qt Core/Network + QUrl, lets DownloadEngine own ONE instance,
// resolve auth for a URL, and hand the APPLIED result to the download classes —
// which never depend on this manager's internals (one-way dependency, no cycle).

// Categorised, exception-free error codes. Returned (never thrown) so nothing
// crosses the Qt signal boundary as a C++ exception.
enum class AuthError {
    None,
    FileNotFound,      // cookies.txt path does not exist / not readable
    EmptyFile,         // file opened but holds no cookie lines
    MalformedFormat,   // a non-comment line is not exactly 7 tab fields / bad types
    AllExpired,        // parsed fine, but every cookie's expiry is in the past
    TokenExpired,      // bearer token's optional expiry epoch is in the past
    UnknownDomain      // no credential registered for the requested domain
};

inline QString authErrorToString(AuthError e) {
    switch (e) {
        case AuthError::None:            return QStringLiteral("ok");
        case AuthError::FileNotFound:    return QStringLiteral("cookie file not found");
        case AuthError::EmptyFile:       return QStringLiteral("cookie file is empty");
        case AuthError::MalformedFormat: return QStringLiteral("malformed cookies.txt (expected 7 tab-separated fields)");
        case AuthError::AllExpired:      return QStringLiteral("all cookies expired — re-login in the browser");
        case AuthError::TokenExpired:    return QStringLiteral("bearer token expired");
        case AuthError::UnknownDomain:   return QStringLiteral("no credentials registered for this domain");
    }
    return QStringLiteral("unknown auth error");
}

// Result of a load/validate call: a bool with a human-readable reason, plus the
// machine code so callers (IPC, UI) can branch (e.g. AllExpired -> "re-login").
struct AuthResult {
    bool      ok = false;
    AuthError code = AuthError::None;
    QString   detail;                 // ready to surface to the UI
    explicit operator bool() const { return ok; }
    static AuthResult success() { return {true, AuthError::None, QString()}; }
    static AuthResult failure(AuthError c, const QString &extra = QString()) {
        QString d = authErrorToString(c);
        if (!extra.isEmpty()) d += QStringLiteral(": ") + extra;
        return {false, c, d};
    }
};

// One domain's credential. A value type (copyable, no QObject) so it can live in
// a QHash and be passed around freely.
struct DomainAuth {
    enum class Kind { None, CookieFile, BearerToken };
    Kind    kind = Kind::None;
    QString domain;            // registration key, e.g. "udemy.com" (host-suffix matched)
    QString cookieFilePath;    // absolute path to a Netscape cookies.txt (Kind::CookieFile)
    QString bearerToken;       // raw token value, no "Bearer " prefix (Kind::BearerToken)
    qint64  expiresAt = 0;     // bearer expiry, unix epoch seconds; 0 = never expires
    bool    isExpired(qint64 nowEpoch) const {
        return kind == Kind::BearerToken && expiresAt > 0 && expiresAt <= nowEpoch;
    }
};

class AuthenticationManager : public QObject {
    Q_OBJECT
public:
    explicit AuthenticationManager(QObject *parent = nullptr);
    ~AuthenticationManager() override;   // cleans up any temp yt-dlp auth configs

    // ---- Registration (programmatic) ------------------------------------
    // Register a Netscape cookies.txt for a domain. Parses + validates eagerly so
    // a bad file is rejected up front (malformed / all-expired / missing). On
    // success the path is stored and replayed later. Fast local IO; non-blocking.
    AuthResult registerCookieFile(const QString &domain, const QString &cookieFilePath);

    // Register a raw Authorization: Bearer token for a domain. `expiresAt` is an
    // optional unix-epoch-seconds expiry (0 = no expiry); validated against now.
    AuthResult registerBearerToken(const QString &domain, const QString &token,
                                   qint64 expiresAt = 0);

    // Remove any credential for a domain. Returns true if one was present.
    bool unregister(const QString &domain);

    // Load a config file (default ~/.config/nexa/auth.json). Schema:
    //   { "udemy.com": { "kind": "cookies", "path": "/abs/cookies.txt" },
    //     "example.com": { "kind": "bearer", "token": "X", "expiresAt": 1735689600 } }
    // Returns ok=false with the first offending domain's error; valid entries that
    // precede the failure are still registered (best-effort), like browser imports.
    AuthResult loadFromJson(const QString &path = QString());

    // ---- Resolution -----------------------------------------------------
    // The credential that applies to `url`, or kind==None if none matches (or the
    // host is a YouTube host, which is always excluded). Host-suffix matched; the
    // most specific (longest) registered domain wins.
    DomainAuth resolve(const QUrl &url) const;

    // True if we hold a usable (non-expired) credential for this URL's host.
    bool hasAuthFor(const QUrl &url) const;

    // Re-validate the credential for `url` right before use (re-checks bearer
    // expiry and, for cookie files, that the file still parses and isn't all
    // expired). Returns success() when no credential applies (auth is optional).
    AuthResult validateFor(const QUrl &url) const;

    // ---- Application: NATIVE Qt path ------------------------------------
    // Sets Cookie and/or Authorization on `req` if a credential matches `url`.
    // No-op (and harmless) when none applies — so DownloadTask/SegmentDownloader
    // need no auth-specific branching. Returns true if anything was applied.
    bool applyTo(QNetworkRequest &req, const QUrl &url) const;

    // The same auth, expressed as HeaderList entries to merge into the existing
    // browser-captured HeaderList before it is handed to DownloadTask. Lets the
    // engine inject auth without DownloadTask knowing this manager exists.
    HeaderList headerAuthFor(const QUrl &url) const;

    // ---- Application: yt-dlp path ---------------------------------------
    // CLI flags to splice into YtDlpGrabber's arg list for `url`:
    //   cookie file -> {"--cookies", "/abs/cookies.txt"}  (path only; no secret)
    //   bearer only -> {"--config-location", "/run/.../auth.conf"} — the token is
    //                  written into a 0600 temp config file rather than passed on
    //                  the command line, so it never appears in `ps` output.
    //   none / YouTube host -> {} (empty: preserves the no-forward safeguard)
    // Non-const: a bearer credential lazily materialises a temp config file whose
    // path is tracked and removed in the destructor.
    QStringList ytDlpArgs(const QUrl &url);

    // (HTTP 401/403 classification lives in auth/AuthUtils.h as free functions, so
    // the download classes can depend on it WITHOUT depending on this manager.)

private:
    // Host-suffix match honouring an exact host or a dot-boundary subdomain.
    static bool hostMatchesDomain(const QString &host, const QString &domain);
    // Hosts yt-dlp must own exclusively — never inject auth for these.
    static bool isExcludedHost(const QString &host);
    static qint64 nowEpoch();
    // Write a bearer token into a private 0600 yt-dlp config file; returns its path
    // (empty on failure). Keeps the secret off the process-argument boundary.
    QString writeYtDlpAuthConfig(const DomainAuth &a);

    QHash<QString, DomainAuth> m_byDomain;   // key = normalised domain (lower-case)
    QStringList m_tempAuthFiles;             // temp yt-dlp config files to clean up
};

} // namespace nexa
