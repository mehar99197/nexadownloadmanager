#pragma once
#include <QString>
#include <QByteArray>
#include <QVector>
#include <QUrl>

namespace nexa {

// One cookie parsed from a Netscape cookies.txt line. A plain value type (no
// QObject) so a jar is just a QVector<Cookie>. Epochs are qint64 to avoid the
// year-2038 32-bit overflow.
struct Cookie {
    QString domain;                 // field 0, e.g. ".udemy.com" or "www.udemy.com"
    bool    includeSubdomains = false;  // field 1 (Flag): TRUE => host-suffix match
    QString path;                   // field 2, e.g. "/"
    bool    secure = false;         // field 3 (Secure): TRUE => https-only
    qint64  expires = 0;            // field 4: unix epoch seconds; 0 = session cookie
    QString name;                   // field 5
    QString value;                  // field 6 (verbatim; may contain spaces)
    bool    httpOnly = false;       // derived from the "#HttpOnly_" line prefix

    // Session cookies (expires==0) never expire offline; otherwise compare epochs.
    bool isExpired(qint64 nowEpoch) const { return expires > 0 && expires <= nowEpoch; }
};

// A standalone Netscape cookies.txt parser/validator. No QObject, no network —
// pure local file IO + offline arithmetic, so it is safe to call inline on the
// event-loop thread. Reports problems through its own small ParseResult value
// (deliberately NOT AuthResult, so this file has zero dependency on the manager,
// avoiding an include cycle).
class CookieFile {
public:
    enum class ParseStatus {
        Ok,            // at least one non-expired cookie parsed
        FileNotFound,  // path missing / not readable
        EmptyFile,     // opened, but no cookie lines
        Malformed,     // a data line is not exactly 7 tab fields / bad field type
        AllExpired     // parsed fine, but every cookie's expiry is in the past
    };

    struct ParseResult {
        ParseStatus status = ParseStatus::Ok;
        QString     detail;       // human-readable reason (for the UI)
        int         badLine = -1; // 1-based offending line on Malformed, else -1
    };

    // Parse `path` into `out` (cleared first). Returns the categorised status.
    static ParseResult parse(const QString &path, QVector<Cookie> &out);

    // Build a "Cookie: a=b; c=d" header VALUE from the cookies in `jar` that
    // apply to `url`: domain match (host-suffix when includeSubdomains, else
    // exact host), path-prefix, secure-vs-scheme, and not expired at `nowEpoch`.
    // Returns an empty array when nothing applies.
    static QByteArray cookieHeaderFor(const QVector<Cookie> &jar, const QUrl &url,
                                      qint64 nowEpoch);

    // Collapse duplicate cookies (same NAME) that pile up in a raw browser export
    // when a site has been logged into more than once — e.g. an `access_token` at
    // BOTH ".udemy.com" and "www.udemy.com" with different values. A browser sends
    // one effective value per name to a host, but a dumped jar carries them all;
    // yt-dlp forwards every one and the server may honour the STALE token and bounce
    // the request to a login page. For each name we keep a single cookie — the most
    // host-specific domain, breaking ties by latest expiry — and drop the rest.
    // Input and output are Netscape cookies.txt TEXT; the "#HttpOnly_" prefix and a
    // leading comment header are preserved. Non-cookie/comment lines pass through.
    static QByteArray dedupe(const QByteArray &netscapeText);

private:
    // Whether `host` is covered by a cookie's domain, honouring includeSubdomains.
    static bool domainApplies(const QString &host, const Cookie &c);
};

} // namespace nexa
