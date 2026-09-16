#pragma once
#include <QString>
#include <QStringList>
#include <QVector>
#include <QUrl>

namespace nexa {

// One download category: a rule set plus the folder the files it claims land in.
//
// Rules are matched against two things a download always has — the file name's
// extension and the host it came from. A site rule is what makes "everything
// from youtube.com goes to Courses/" possible without touching the extension
// lists, which is the case the old hard-coded categoriser could not express.
struct Category {
    int         id = 0;
    QString     name;                 // "Video", "Courses", …
    QString     icon;                 // emoji, shown in the table and the dialog
    QString     folder;               // empty = use `name`; relative = under the
                                      // download dir; absolute = used as-is
    QStringList extensions;           // lowercase, WITHOUT the dot ("mp4")
    QStringList sites;                // lowercase hosts ("youtube.com")
    int         priority = 0;         // lower is checked first
    bool        builtin  = false;     // seeded default: editable, not deletable

    // A category with no rules at all claims nothing by matching — it can only
    // be reached as the catch-all (see CategoryStore::fallback). That keeps a
    // half-filled custom category from quietly swallowing every download.
    bool hasRules() const { return !extensions.isEmpty() || !sites.isEmpty(); }

    // `suffix` is lowercase and dotless; `host` is a lowercase hostname.
    bool matches(const QString &suffix, const QString &host) const;

    // Absolute directory for this category. `baseDir` is the download folder.
    QString resolvedFolder(const QString &baseDir) const;

    // Extensions are stored in the database with a leading dot (".mp4"), the
    // shape the schema documents, and normalised away on the way in. Both
    // spellings are accepted when parsing so a hand-edited row still loads.
    static QString normalizeExtension(QString ext);
    static QStringList parseList(const QString &json);
    static QString serializeExtensions(const QStringList &dotless);
    static QString serializeSites(const QStringList &hosts);
};

// The ordered category list plus the matching rule, kept in memory so the
// engine can resolve a save path without touching SQLite on every download.
//
// Matching is deliberately one pass, top to bottom: the first category whose
// site OR extension rule fits wins. One visible order, one rule — which is
// what makes the drag-to-reorder control in the dialog mean something.
class CategoryStore {
public:
    // Replaces the list and re-sorts it by priority (then id, so the order is
    // stable across restarts when two rows share a priority).
    void setAll(QVector<Category> cats);
    const QVector<Category> &all() const { return m_cats; }
    bool isEmpty() const { return m_cats.isEmpty(); }

    const Category *byId(int id) const;
    const Category *byName(const QString &name) const;

    // The category that claims this download, or the catch-all, or nullptr when
    // even that is gone.
    const Category *match(const QString &fileName, const QUrl &url) const;
    int matchId(const QString &fileName, const QUrl &url) const;

    // Absolute folder for a download. Falls back to `baseDir` itself when no
    // category applies, which is exactly what "categorising off" looks like.
    QString folderFor(const QString &baseDir, const QString &fileName, const QUrl &url) const;

    // The rule-less built-in every unmatched download lands in ("Other").
    const Category *fallback() const;

    // One past the last priority — where a newly added category goes.
    int nextPriority() const;

    // The seven categories a fresh install starts with. These mirror the
    // folders the hard-coded categoriser used to create, names included:
    // renaming them would orphan the Video/ and Audio/ folders already sitting
    // in every existing user's download directory.
    static QVector<Category> defaults();

private:
    QVector<Category> m_cats;   // sorted by (priority, id)
};

} // namespace nexa
