#include "core/Categories.h"

#include <QDir>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonValue>

#include <algorithm>

namespace nexa {

QString Category::normalizeExtension(QString ext)
{
    ext = ext.trimmed().toLower();
    while (ext.startsWith(QLatin1Char('.')))
        ext.remove(0, 1);
    // A pasted "*.mp4" is what a Windows user types; take it.
    if (ext.startsWith(QLatin1Char('*')))
        ext.remove(0, 1);
    while (ext.startsWith(QLatin1Char('.')))
        ext.remove(0, 1);
    return ext;
}

QStringList Category::parseList(const QString &json)
{
    QStringList out;
    const QJsonDocument doc = QJsonDocument::fromJson(json.toUtf8());
    if (doc.isArray()) {
        const QJsonArray arr = doc.array();
        for (const QJsonValue &v : arr) {
            const QString s = v.toString().trimmed();
            if (!s.isEmpty())
                out << s;
        }
        return out;
    }
    // Tolerate a hand-edited comma/space list rather than losing the row.
    QString flat = json;
    for (QChar &ch : flat) {
        if (ch == QLatin1Char(',') || ch == QLatin1Char(';') || ch.isSpace())
            ch = QLatin1Char(' ');
    }
    const QStringList parts = flat.split(QLatin1Char(' '), Qt::SkipEmptyParts);
    for (const QString &p : parts) {
        const QString s = p.trimmed();
        if (!s.isEmpty())
            out << s;
    }
    return out;
}

QString Category::serializeExtensions(const QStringList &dotless)
{
    QJsonArray arr;
    for (const QString &e : dotless) {
        const QString norm = normalizeExtension(e);
        if (!norm.isEmpty())
            arr.append(QLatin1Char('.') + norm);   // the shape the schema documents
    }
    return QString::fromUtf8(QJsonDocument(arr).toJson(QJsonDocument::Compact));
}

QString Category::serializeSites(const QStringList &hosts)
{
    QJsonArray arr;
    for (const QString &h : hosts) {
        const QString s = h.trimmed().toLower();
        if (!s.isEmpty())
            arr.append(s);
    }
    return QString::fromUtf8(QJsonDocument(arr).toJson(QJsonDocument::Compact));
}

bool Category::matches(const QString &suffix, const QString &host) const
{
    // A site rule covers its subdomains: "youtube.com" claims www. and m. too,
    // but never "notyoutube.com" — the dot is what makes it a suffix and not a
    // substring.
    if (!host.isEmpty()) {
        for (const QString &site : sites) {
            if (site.isEmpty())
                continue;
            if (host == site || host.endsWith(QLatin1Char('.') + site))
                return true;
        }
    }
    if (!suffix.isEmpty() && extensions.contains(suffix))
        return true;
    return false;
}

QString Category::resolvedFolder(const QString &baseDir) const
{
    const QString rel = folder.trimmed();
    if (rel.isEmpty())
        return QDir(baseDir).filePath(name);
    if (QDir::isAbsolutePath(rel))
        return QDir::cleanPath(rel);
    return QDir::cleanPath(QDir(baseDir).filePath(rel));
}

void CategoryStore::setAll(QVector<Category> cats)
{
    std::stable_sort(cats.begin(), cats.end(), [](const Category &a, const Category &b) {
        if (a.priority != b.priority)
            return a.priority < b.priority;
        return a.id < b.id;
    });
    m_cats = std::move(cats);
}

const Category *CategoryStore::byId(int id) const
{
    for (const Category &c : m_cats)
        if (c.id == id)
            return &c;
    return nullptr;
}

const Category *CategoryStore::byName(const QString &name) const
{
    for (const Category &c : m_cats)
        if (c.name.compare(name, Qt::CaseInsensitive) == 0)
            return &c;
    return nullptr;
}

const Category *CategoryStore::fallback() const
{
    for (const Category &c : m_cats)
        if (c.builtin && !c.hasRules())
            return &c;
    return nullptr;
}

const Category *CategoryStore::match(const QString &fileName, const QUrl &url) const
{
    const QString suffix = QFileInfo(fileName).suffix().toLower();
    const QString host   = url.host().toLower();
    for (const Category &c : m_cats) {
        if (c.hasRules() && c.matches(suffix, host))
            return &c;
    }
    return fallback();
}

int CategoryStore::matchId(const QString &fileName, const QUrl &url) const
{
    const Category *c = match(fileName, url);
    return c ? c->id : 0;
}

QString CategoryStore::folderFor(const QString &baseDir, const QString &fileName,
                                 const QUrl &url) const
{
    const Category *c = match(fileName, url);
    return c ? c->resolvedFolder(baseDir) : baseDir;
}

int CategoryStore::nextPriority() const
{
    int top = -1;
    for (const Category &c : m_cats)
        top = qMax(top, c.priority);
    return top + 1;
}

QVector<Category> CategoryStore::defaults()
{
    struct Seed {
        const char *name;
        const char *icon;
        const char *exts;   // space separated, dotless
    };
    // Order matters: this is the priority order a fresh install gets, and the
    // rule-less catch-all has to come last or it would claim everything.
    static const Seed kSeeds[] = {
        {"Video",      "\xF0\x9F\x8E\xAC", "mp4 mkv avi mov wmv flv webm m4v mpg mpeg ts 3gp"},
        {"Audio",      "\xF0\x9F\x8E\xB5", "mp3 wav flac aac m4a ogg wma opus"},
        {"Documents",  "\xF0\x9F\x93\x84", "pdf doc docx xls xlsx ppt pptx txt epub csv odt"},
        {"Compressed", "\xF0\x9F\x93\xA6", "zip rar 7z tar gz bz2 xz tgz"},
        {"Programs",   "\xF0\x9F\x92\xBF", "exe msi deb rpm dmg pkg apk appimage bin"},
        {"Images",     "\xF0\x9F\x96\xBC", "jpg jpeg png gif bmp svg webp ico tiff"},
        {"Other",      "\xF0\x9F\x93\x81", ""},
    };

    QVector<Category> out;
    int priority = 0;
    for (const Seed &s : kSeeds) {
        Category c;
        c.name     = QString::fromLatin1(s.name);
        c.icon     = QString::fromUtf8(s.icon);
        c.folder.clear();                       // = the category name
        c.priority = priority++;
        c.builtin  = true;
        const QString exts = QString::fromLatin1(s.exts);
        if (!exts.isEmpty())
            c.extensions = exts.split(QLatin1Char(' '), Qt::SkipEmptyParts);
        out.push_back(c);
    }
    return out;
}

} // namespace nexa
