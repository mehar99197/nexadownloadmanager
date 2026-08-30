#include "core/DownloadImport.h"

#include <QFileInfo>
#include <QRegularExpression>
#include <QSet>
#include <QStringList>
#include <QUrl>

namespace nexa::downloadimport {

namespace {

bool isSupportedUrl(const QString &candidate)
{
    const QString text = candidate.trimmed();
    if (text.isEmpty())
        return false;
    // The scheme must be written out. QUrl::fromUserInput() helpfully turns bare
    // words into "http://<word>", which would import every stray line of an
    // export file (a comment, a package name) as a download.
    static const QRegularExpression schemeRe(
        QStringLiteral("\\A(?:https?|ftp)://|\\Amagnet:\\?"), QRegularExpression::CaseInsensitiveOption);
    if (!schemeRe.match(text).hasMatch())
        return false;
    const QUrl u = QUrl::fromUserInput(text);
    if (!u.isValid())
        return false;
    const QString s = u.scheme().toLower();
    if (s == QLatin1String("magnet"))
        return true;
    return (s == QLatin1String("http") || s == QLatin1String("https")
            || s == QLatin1String("ftp")) && !u.host().isEmpty();
}

// Only the request context another manager might have saved; anything else
// (Host, Content-Length, …) is deliberately dropped.
void addHeaderIfUseful(HeaderList &headers, const QString &rawName, const QString &value)
{
    const QString name = rawName.trimmed().toLower();
    const QString v = value.trimmed();
    if (v.isEmpty())
        return;
    // Reject control characters outright: these files come from elsewhere.
    for (const QChar c : v)
        if (c < QChar(0x20) || c == QChar(0x7f))
            return;
    if (name == QLatin1String("referer") || name == QLatin1String("referrer"))
        headers.append({QByteArrayLiteral("Referer"), v.toUtf8()});
    else if (name == QLatin1String("user-agent") || name == QLatin1String("agent"))
        headers.append({QByteArrayLiteral("User-Agent"), v.toUtf8()});
    else if (name == QLatin1String("cookie") || name == QLatin1String("cookies"))
        headers.append({QByteArrayLiteral("Cookie"), v.toUtf8()});
}

QVector<ImportedDownload> dedupe(const QVector<ImportedDownload> &in)
{
    QVector<ImportedDownload> out;
    QSet<QString> seen;
    for (const ImportedDownload &d : in) {
        if (seen.contains(d.url))
            continue;
        seen.insert(d.url);
        out.append(d);
    }
    return out;
}

QStringList splitLines(const QString &text)
{
    return text.split(QRegularExpression(QStringLiteral("\r\n|\r|\n")));
}

} // namespace

// IDM's export: blocks bounded by a lone "<" and ">", the first non-empty line
// being the URL and the rest "Name: value" headers.
QVector<ImportedDownload> parseIdmEf2(const QString &text)
{
    QVector<ImportedDownload> out;
    ImportedDownload current;
    bool inBlock = false;
    for (const QString &raw : splitLines(text)) {
        const QString line = raw.trimmed();
        if (line == QLatin1String("<")) {
            inBlock = true;
            current = ImportedDownload();
            continue;
        }
        if (line == QLatin1String(">")) {
            if (inBlock && !current.url.isEmpty())
                out.append(current);
            inBlock = false;
            continue;
        }
        if (!inBlock || line.isEmpty())
            continue;
        if (current.url.isEmpty() && isSupportedUrl(line)) {
            current.url = line;
            continue;
        }
        const int colon = line.indexOf(QLatin1Char(':'));
        if (colon > 0)
            addHeaderIfUseful(current.headers, line.left(colon), line.mid(colon + 1));
    }
    // A file that never closed its last block still holds a usable download.
    if (inBlock && !current.url.isEmpty())
        out.append(current);
    return dedupe(out);
}

// JDownloader's .crawljob: "key=value" lines, blank line between entries.
QVector<ImportedDownload> parseCrawljob(const QString &text)
{
    QVector<ImportedDownload> out;
    ImportedDownload current;
    auto flush = [&]() {
        if (!current.url.isEmpty())
            out.append(current);
        current = ImportedDownload();
    };
    for (const QString &raw : splitLines(text)) {
        const QString line = raw.trimmed();
        if (line.isEmpty()) {
            flush();
            continue;
        }
        const int eq = line.indexOf(QLatin1Char('='));
        if (eq <= 0)
            continue;
        const QString key = line.left(eq).trimmed().toLower();
        const QString value = line.mid(eq + 1).trimmed();
        if ((key == QLatin1String("text") || key == QLatin1String("downloadlinks")
             || key == QLatin1String("url")) && isSupportedUrl(value))
            current.url = value;
        else if (key == QLatin1String("filename") || key == QLatin1String("downloadname"))
            current.fileName = value;
        else if (key == QLatin1String("referrer") || key == QLatin1String("referer"))
            addHeaderIfUseful(current.headers, QStringLiteral("referer"), value);
        else if (key == QLatin1String("useragent"))
            addHeaderIfUseful(current.headers, QStringLiteral("user-agent"), value);
        else if (key == QLatin1String("cookies"))
            addHeaderIfUseful(current.headers, QStringLiteral("cookie"), value);
    }
    flush();
    return dedupe(out);
}

// A plain list: one URL per line. "#" and ";" start a comment; a CSV's first
// field is used so an exported spreadsheet works too.
QVector<ImportedDownload> parsePlainList(const QString &text)
{
    QVector<ImportedDownload> out;
    for (const QString &raw : splitLines(text)) {
        QString line = raw.trimmed();
        if (line.isEmpty() || line.startsWith(QLatin1Char('#')) || line.startsWith(QLatin1Char(';')))
            continue;
        // A spreadsheet export puts the URL in the first column; prefer that over
        // the whole line, which would otherwise carry the remaining columns along.
        if (line.contains(QLatin1Char(','))) {
            const QString first = line.section(QLatin1Char(','), 0, 0).trimmed();
            if (isSupportedUrl(first))
                line = first;
        }
        if (isSupportedUrl(line))
            out.append(ImportedDownload{line, QString(), {}});
    }
    return dedupe(out);
}

QVector<ImportedDownload> parseAny(const QString &fileName, const QString &text)
{
    const QString ext = QFileInfo(fileName).suffix().toLower();
    if (ext == QLatin1String("ef2"))
        return parseIdmEf2(text);
    if (ext == QLatin1String("crawljob"))
        return parseCrawljob(text);
    // Unknown extension: sniff, because people rename these files freely.
    if (text.contains(QRegularExpression(QStringLiteral("(?m)^\\s*<\\s*$"))))
        return parseIdmEf2(text);
    if (text.contains(QRegularExpression(QStringLiteral("(?mi)^(text|downloadlinks)="))))
        return parseCrawljob(text);
    return parsePlainList(text);
}

QString fileDialogFilter()
{
    return QStringLiteral("All supported exports (*.ef2 *.crawljob *.txt *.csv *.lst);;"
                          "IDM export (*.ef2);;JDownloader (*.crawljob);;"
                          "Link list (*.txt *.csv *.lst);;All files (*)");
}

} // namespace nexa::downloadimport
