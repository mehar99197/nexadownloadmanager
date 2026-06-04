#include "auth/CookieFile.h"

#include <QFile>
#include <QFileInfo>
#include <QStringList>
#include <QDateTime>
#include <QHash>
#include <QSet>
#include <QList>
#include <limits>
#include <algorithm>

namespace nexa {

// Two Netscape cookie domains "overlap" when some single host would be sent BOTH
// (so they are true duplicates to collapse). A dot-prefixed domain matches itself
// and all subdomains; a host-only domain matches only that exact host. Disjoint
// siblings (e.g. www.x.com vs api.x.com) do NOT overlap and must both survive.
static bool domainsOverlap(const QString &da, const QString &db)
{
    const bool dotA = da.startsWith(QLatin1Char('.'));
    const bool dotB = db.startsWith(QLatin1Char('.'));
    const QString a = dotA ? da.mid(1) : da;
    const QString b = dotB ? db.mid(1) : db;
    if (a.compare(b, Qt::CaseInsensitive) == 0) return true;
    auto isSub = [](const QString &child, const QString &parent) {
        return child.endsWith(QLatin1Char('.') + parent, Qt::CaseInsensitive);
    };
    if (dotA && isSub(b, a)) return true;   // b is a subdomain covered by dotted a
    if (dotB && isSub(a, b)) return true;   // a is a subdomain covered by dotted b
    return false;
}

QByteArray CookieFile::dedupe(const QByteArray &netscapeText)
{
    const QList<QByteArray> rawLines = netscapeText.split('\n');

    // How "specific" a cookie's domain is for a host. Host-only (no leading dot)
    // beats a dot-prefixed parent domain; a longer domain beats a shorter one.
    auto specificity = [](const QString &domain) -> int {
        QString d = domain;
        const bool hostOnly = !d.startsWith(QLatin1Char('.'));
        if (!hostOnly) d = d.mid(1);
        return d.size() * 2 + (hostOnly ? 1 : 0);
    };

    // Pass 1: collect every cookie line as a record.
    struct Rec { int idx; QString domain; QString path; QString name; int spec; qint64 exp; };
    QVector<Rec> recs;
    for (int i = 0; i < rawLines.size(); ++i) {
        QString line = QString::fromUtf8(rawLines[i]);
        while (line.endsWith(QLatin1Char('\r'))) line.chop(1);
        if (line.trimmed().isEmpty())
            continue;
        QString body = line;
        if (body.startsWith(QLatin1Char('#'))) {
            if (body.startsWith(QStringLiteral("#HttpOnly_")))
                body = body.mid(QStringLiteral("#HttpOnly_").size());
            else
                continue;   // ordinary comment — not a cookie
        }
        const QStringList f = body.split(QLatin1Char('\t'), Qt::KeepEmptyParts);
        if (f.size() != 7)
            continue;       // leave malformed lines for parse() to reject later
        const qint64 exp = f.at(4).toLongLong();
        // expiry 0 == session cookie: treat as the freshest (still-live) value.
        const qint64 expKey = (exp == 0) ? std::numeric_limits<qint64>::max() : exp;
        recs.append({ i, f.at(0), f.at(2), f.at(5), specificity(f.at(0)), expKey });
    }

    // Group TRUE duplicates: same name + path + OVERLAPPING domain. Within each
    // group keep the most-specific, then freshest, line. Disjoint same-name
    // cookies (different non-overlapping subdomains) stay separate so neither is
    // lost — keying on name alone previously deleted the cookie the target host
    // needed (intermittent auth failures + jar corruption).
    const int n = recs.size();
    QVector<int> winnerOf(n, -1);
    QVector<bool> taken(n, false);
    for (int a = 0; a < n; ++a) {
        if (taken[a]) continue;
        QVector<int> members{ a };
        taken[a] = true;
        for (int b = a + 1; b < n; ++b) {
            if (taken[b]) continue;
            if (recs[b].name == recs[a].name && recs[b].path == recs[a].path
                && domainsOverlap(recs[a].domain, recs[b].domain)) {
                members.append(b);
                taken[b] = true;
            }
        }
        int win = members.first();
        for (int m : members)
            if (recs[m].spec > recs[win].spec
                || (recs[m].spec == recs[win].spec && recs[m].exp >= recs[win].exp))
                win = m;
        for (int m : members) winnerOf[m] = win;
    }
    QHash<int,int> winLineForIdx;   // raw-line idx -> winning raw-line idx
    for (int k = 0; k < n; ++k)
        winLineForIdx.insert(recs[k].idx, recs[winnerOf[k]].idx);

    // Pass 2: re-emit. Comments/blanks/malformed pass through; a cookie line is
    // kept only when it is its group's winner.
    QByteArray out;
    for (int i = 0; i < rawLines.size(); ++i) {
        auto passthrough = [&]() {
            out += rawLines[i];
            if (i != rawLines.size() - 1) out += '\n';
        };
        const auto it = winLineForIdx.constFind(i);
        if (it == winLineForIdx.constEnd()) { passthrough(); continue; }  // not a cookie line
        if (it.value() != i) continue;                                    // a duplicate that lost
        passthrough();
    }
    return out;
}

CookieFile::ParseResult CookieFile::parse(const QString &path, QVector<Cookie> &out)
{
    out.clear();
    ParseResult res;

    QFileInfo fi(path);
    if (path.isEmpty() || !fi.exists() || !fi.isFile()) {
        res.status = ParseStatus::FileNotFound;
        res.detail = QStringLiteral("cookie file not found: %1").arg(path);
        return res;
    }

    // Bound the work: a real cookies.txt is kilobyte-scale. A multi-megabyte file
    // is either not a cookie file or hostile; reject it so parsing can never stall
    // the event loop (the parse runs inline in addDownload()).
    if (fi.size() > 5 * 1024 * 1024) {
        res.status = ParseStatus::Malformed;
        res.detail = QStringLiteral("cookie file too large (>5 MB)");
        return res;
    }

    // NOT QIODevice::Text: text mode would silently normalise/strip lone CR bytes,
    // which would let an embedded control char slip past the injection guard below.
    // We strip trailing CR/LF ourselves (so CRLF files still parse), and any
    // remaining control char is then a genuine, rejectable anomaly.
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) {
        res.status = ParseStatus::FileNotFound;
        res.detail = QStringLiteral("cannot open cookie file: %1").arg(f.errorString());
        return res;
    }

    int lineNo = 0;
    while (!f.atEnd()) {
        ++lineNo;
        // Strip only the trailing EOL; never trim interior/leading whitespace,
        // since a cookie value (field 6) may legitimately contain spaces.
        QString line = QString::fromUtf8(f.readLine());
        while (line.endsWith(QLatin1Char('\n')) || line.endsWith(QLatin1Char('\r')))
            line.chop(1);

        // Blank / whitespace-only lines are valid filler — skip them.
        if (line.trimmed().isEmpty())
            continue;

        bool httpOnly = false;
        // Comments start with '#'. The one exception is the "#HttpOnly_" prefix
        // some browsers emit, which marks a REAL cookie: strip it, flag httpOnly,
        // and parse the remainder as a normal 7-field line.
        if (line.startsWith(QLatin1Char('#'))) {
            if (line.startsWith(QStringLiteral("#HttpOnly_"))) {
                httpOnly = true;
                line = line.mid(QStringLiteral("#HttpOnly_").size());
            } else {
                continue;   // ordinary comment
            }
        }

        // Netscape format is strictly TAB-separated with exactly 7 fields. Keep
        // empty parts so a missing field is caught as malformed, not silently merged.
        const QStringList fields = line.split(QLatin1Char('\t'), Qt::KeepEmptyParts);
        if (fields.size() != 7) {
            f.close();
            out.clear();
            res.status = ParseStatus::Malformed;
            res.badLine = lineNo;
            res.detail = QStringLiteral("line %1: expected 7 tab-separated fields, got %2")
                             .arg(lineNo).arg(fields.size());
            return res;
        }

        auto isBool = [](const QString &s) {
            return s.compare(QStringLiteral("TRUE"), Qt::CaseInsensitive) == 0 ||
                   s.compare(QStringLiteral("FALSE"), Qt::CaseInsensitive) == 0;
        };
        auto asBool = [](const QString &s) {
            return s.compare(QStringLiteral("TRUE"), Qt::CaseInsensitive) == 0;
        };

        // Field 1 (Flag/includeSubdomains) and field 3 (Secure) must be TRUE/FALSE.
        if (!isBool(fields.at(1)) || !isBool(fields.at(3))) {
            f.close();
            out.clear();
            res.status = ParseStatus::Malformed;
            res.badLine = lineNo;
            res.detail = QStringLiteral("line %1: flag/secure must be TRUE or FALSE").arg(lineNo);
            return res;
        }

        // Field 4 (expires) must be a valid integer epoch.
        bool okExpiry = false;
        const qint64 expires = fields.at(4).trimmed().toLongLong(&okExpiry);
        if (!okExpiry) {
            f.close();
            out.clear();
            res.status = ParseStatus::Malformed;
            res.badLine = lineNo;
            res.detail = QStringLiteral("line %1: non-numeric expiry '%2'")
                             .arg(lineNo).arg(fields.at(4));
            return res;
        }

        // SECURITY: a cookie name/value with an embedded control char (CR/LF/NUL)
        // would forge extra HTTP headers when joined into the Cookie: header. The
        // tab delimiter was already consumed by split(), so any remaining control
        // char is illegitimate — reject the file as malformed.
        auto hasControlChar = [](const QString &s) {
            for (const QChar ch : s)
                if (ch.unicode() < 0x20 || ch.unicode() == 0x7F)
                    return true;
            return false;
        };
        if (hasControlChar(fields.at(0)) || hasControlChar(fields.at(2)) ||
            hasControlChar(fields.at(5)) || hasControlChar(fields.at(6))) {
            f.close();
            out.clear();
            res.status = ParseStatus::Malformed;
            res.badLine = lineNo;
            res.detail = QStringLiteral("line %1: control character in cookie field").arg(lineNo);
            return res;
        }

        Cookie c;
        c.domain            = fields.at(0).trimmed();
        c.includeSubdomains = asBool(fields.at(1));
        c.path              = fields.at(2).trimmed();
        c.secure            = asBool(fields.at(3));
        c.expires           = expires;
        c.name              = fields.at(5);
        c.value             = fields.at(6);   // verbatim
        c.httpOnly          = httpOnly;
        if (c.path.isEmpty())
            c.path = QStringLiteral("/");
        out.append(c);
    }
    f.close();

    if (out.isEmpty()) {
        res.status = ParseStatus::EmptyFile;
        res.detail = QStringLiteral("cookie file holds no cookies");
        return res;
    }

    // Distinguish "every cookie expired" from "bad format" so the UI can say
    // "re-login" rather than "fix your file".
    const qint64 now = QDateTime::currentSecsSinceEpoch();
    bool anyLive = false;
    for (const Cookie &c : out) {
        if (!c.isExpired(now)) { anyLive = true; break; }
    }
    if (!anyLive) {
        res.status = ParseStatus::AllExpired;
        res.detail = QStringLiteral("all cookies expired");
        return res;
    }

    res.status = ParseStatus::Ok;
    return res;
}

bool CookieFile::domainApplies(const QString &host, const Cookie &c)
{
    QString dom = c.domain.toLower();
    if (dom.startsWith(QLatin1Char('.')))
        dom = dom.mid(1);
    if (dom.isEmpty())
        return false;

    if (host == dom)
        return true;
    // A leading-dot domain or an explicit includeSubdomains flag covers subdomains.
    if (c.includeSubdomains || c.domain.startsWith(QLatin1Char('.')))
        return host.endsWith(QLatin1Char('.') + dom);
    return false;
}

QByteArray CookieFile::cookieHeaderFor(const QVector<Cookie> &jar, const QUrl &url,
                                       qint64 nowEpoch)
{
    const QString host = url.host().toLower();
    QString urlPath = url.path();
    if (urlPath.isEmpty())
        urlPath = QStringLiteral("/");
    const bool isHttps = url.scheme().compare(QStringLiteral("https"), Qt::CaseInsensitive) == 0;

    // RFC 6265 §5.1.4 path-match: equal, or a prefix ending at a "/" boundary —
    // so cookie-path "/foo" matches "/foo" and "/foo/bar" but NOT "/foobar".
    auto pathMatches = [](const QString &reqPath, const QString &cookiePath) {
        if (cookiePath == QStringLiteral("/") || reqPath == cookiePath)
            return true;
        if (!reqPath.startsWith(cookiePath))
            return false;
        return cookiePath.endsWith(QLatin1Char('/')) ||
               reqPath.at(cookiePath.length()) == QLatin1Char('/');
    };

    // Collect matching cookies, de-duplicating by NAME so a jar that was NOT run
    // through dedupe() (e.g. a user-supplied cookies.txt via Site Logins) can't
    // emit two values for the same name (`access_token=STALE; access_token=NEW`),
    // which makes a server honour the stale one and bounce to login. Keep the
    // most-specific match (host-only domain, then longer path).
    struct Pick { QByteArray value; int score; int order; };
    QHash<QString, Pick> best;
    int seen = 0;
    for (const Cookie &c : jar) {
        if (c.isExpired(nowEpoch))      continue;
        if (!domainApplies(host, c))    continue;
        if (!pathMatches(urlPath, c.path)) continue;
        if (c.secure && !isHttps)       continue;   // never leak a Secure cookie over http
        const bool hostOnly = !c.domain.startsWith(QLatin1Char('.'));
        const int score = (hostOnly ? 1'000'000 : 0) + c.domain.size() * 1000 + c.path.size();
        auto it = best.find(c.name);
        if (it == best.end())
            best.insert(c.name, { c.value.toUtf8(), score, seen++ });
        else if (score > it->score)
            *it = { c.value.toUtf8(), score, it->order };
    }
    // Emit in first-seen order for stable output.
    QList<QString> names = best.keys();
    std::sort(names.begin(), names.end(),
              [&](const QString &a, const QString &b) { return best[a].order < best[b].order; });
    QByteArray header;
    for (const QString &n : names) {
        if (!header.isEmpty())
            header += "; ";
        header += n.toUtf8();
        header += '=';
        header += best[n].value;
    }
    return header;
}

} // namespace nexa
