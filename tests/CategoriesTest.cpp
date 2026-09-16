// Download categories: the rules that decide which folder a download lands in,
// and the SQLite rows behind them.
//
// Two things here are worth pinning down independently of the UI. First, the
// matching order: it is one pass from the top, and a user who drags a row
// upwards has to be able to predict the result. Second, deleting a category
// must not leave a dangling id on downloads — SQLite does not enforce the
// foreign key, so the cleanup is ours to get right and ours to prove.
#include "core/Categories.h"
#include "core/Database.h"

#include <QCoreApplication>
#include <QDebug>
#include <QDir>
#include <QSqlDatabase>
#include <QSqlError>
#include <QSqlQuery>
#include <QTemporaryDir>
#include <QUrl>

using namespace nexa;

static int g_failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { qWarning() << "FAIL:" << msg; ++g_failures; } } while (0)

static Category makeCategory(const QString &name, const QStringList &exts,
                             const QStringList &sites, int priority)
{
    Category c;
    c.name       = name;
    c.extensions = exts;
    c.sites      = sites;
    c.priority   = priority;
    return c;
}

static void testDefaults()
{
    const QVector<Category> defs = CategoryStore::defaults();
    CHECK(defs.size() == 7, QStringLiteral("seven built-ins, got %1").arg(defs.size()));

    // The names are the folders already sitting in every existing user's
    // download directory. Renaming one orphans the files inside it.
    QStringList names;
    for (const Category &c : defs)
        names << c.name;
    CHECK(names == QStringList({"Video", "Audio", "Documents", "Compressed",
                                "Programs", "Images", "Other"}),
          QStringLiteral("built-in names unchanged, got %1").arg(names.join(QLatin1Char(','))));

    for (const Category &c : defs)
        CHECK(c.builtin, QStringLiteral("%1 is marked built-in").arg(c.name));

    // The catch-all has to be last, or it would claim everything above it.
    CHECK(defs.last().name == QLatin1String("Other"), "the rule-less category sorts last");
    CHECK(!defs.last().hasRules(), "Other carries no rules");
    for (int i = 0; i < defs.size() - 1; ++i)
        CHECK(defs[i].hasRules(), QStringLiteral("%1 carries rules").arg(defs[i].name));
}

static void testExtensionMatching()
{
    CategoryStore store;
    store.setAll(CategoryStore::defaults());

    struct Case { const char *file; const char *want; };
    static const Case kCases[] = {
        {"movie.mp4",       "Video"},
        {"song.MP3",        "Audio"},        // case folded
        {"report.pdf",      "Documents"},
        {"archive.tar.gz",  "Compressed"},   // the LAST suffix is the type
        {"setup.exe",       "Programs"},
        {"photo.jpeg",      "Images"},
        {"mystery.qqq",     "Other"},        // unknown falls through
        {"noextension",     "Other"},
    };
    for (const Case &c : kCases) {
        const Category *got = store.match(QString::fromLatin1(c.file), QUrl());
        CHECK(got && got->name == QLatin1String(c.want),
              QStringLiteral("%1 -> %2, got %3")
                  .arg(QLatin1String(c.file), QLatin1String(c.want),
                       got ? got->name : QStringLiteral("(none)")));
    }
}

static void testSiteMatching()
{
    CategoryStore store;
    QVector<Category> cats = CategoryStore::defaults();
    // Dragged above Video: a course MP4 is a course, not a film.
    cats.push_back(makeCategory(QStringLiteral("Courses"), {}, {QStringLiteral("udemy.com")}, -1));
    store.setAll(cats);

    const Category *courses = store.match(QStringLiteral("lecture.mp4"),
                                          QUrl(QStringLiteral("https://www.udemy.com/x/l.mp4")));
    CHECK(courses && courses->name == QLatin1String("Courses"),
          "a site rule above Video wins for an .mp4");

    // Subdomains are covered; a lookalike host is not.
    const Category *sub = store.match(QStringLiteral("lecture.mp4"),
                                      QUrl(QStringLiteral("https://m.udemy.com/l.mp4")));
    CHECK(sub && sub->name == QLatin1String("Courses"), "m.udemy.com is udemy.com");
    const Category *lookalike = store.match(QStringLiteral("lecture.mp4"),
                                            QUrl(QStringLiteral("https://notudemy.com/l.mp4")));
    CHECK(lookalike && lookalike->name == QLatin1String("Video"),
          "notudemy.com is NOT udemy.com");

    // The same category below Video loses: order is the whole rule.
    QVector<Category> lowered = CategoryStore::defaults();
    lowered.push_back(makeCategory(QStringLiteral("Courses"), {},
                                   {QStringLiteral("udemy.com")}, 99));
    CategoryStore below;
    below.setAll(lowered);
    const Category *loser = below.match(QStringLiteral("lecture.mp4"),
                                        QUrl(QStringLiteral("https://udemy.com/l.mp4")));
    CHECK(loser && loser->name == QLatin1String("Video"),
          "dragged below Video, the site rule loses — priority is honest");
}

static void testRulelessCustomNeverSwallows()
{
    // A half-filled custom category (no extensions, no sites) dragged to the top
    // must not claim every download. Only the built-in catch-all does that, and
    // only after everything else has passed.
    CategoryStore store;
    QVector<Category> cats = CategoryStore::defaults();
    Category empty = makeCategory(QStringLiteral("Unfinished"), {}, {}, -5);
    empty.builtin = false;
    cats.push_back(empty);
    store.setAll(cats);

    const Category *got = store.match(QStringLiteral("movie.mp4"), QUrl());
    CHECK(got && got->name == QLatin1String("Video"), "a rule-less custom row claims nothing");
    const Category *fell = store.match(QStringLiteral("mystery.qqq"), QUrl());
    CHECK(fell && fell->name == QLatin1String("Other"), "unmatched still reaches Other");
}

static void testFolderResolution()
{
    const QString base = QDir::toNativeSeparators(QStringLiteral("/tmp/dl"));
    Category c = makeCategory(QStringLiteral("Video"), {QStringLiteral("mp4")}, {}, 0);

    // Blank folder = a subfolder named after the category.
    CHECK(QDir(c.resolvedFolder(QStringLiteral("/tmp/dl"))).absolutePath()
              == QDir(QStringLiteral("/tmp/dl/Video")).absolutePath(),
          "blank folder falls back to the category name");

    // Relative stays under the base, so moving Downloads moves everything.
    c.folder = QStringLiteral("Media/Films");
    CHECK(QDir(c.resolvedFolder(QStringLiteral("/tmp/dl"))).absolutePath()
              == QDir(QStringLiteral("/tmp/dl/Media/Films")).absolutePath(),
          "a relative folder hangs off the download dir");

    // Absolute escapes it entirely — a second disk, say.
    c.folder = QDir::toNativeSeparators(QStringLiteral("/mnt/media"));
    CHECK(QDir(c.resolvedFolder(QStringLiteral("/tmp/dl"))).absolutePath()
              == QDir(QStringLiteral("/mnt/media")).absolutePath(),
          "an absolute folder is used as-is");
    Q_UNUSED(base);
}

static void testFolderForIsWhatTheEngineCalls()
{
    // DownloadEngine::pathForName() delegates straight to this, so it is the
    // function that actually decides where a file lands.
    CategoryStore store;
    store.setAll(CategoryStore::defaults());
    const QString base = QStringLiteral("/tmp/dl");

    CHECK(QDir(store.folderFor(base, QStringLiteral("clip.mp4"), QUrl())).absolutePath()
              == QDir(QStringLiteral("/tmp/dl/Video")).absolutePath(),
          "an .mp4 resolves to the Video folder");
    CHECK(QDir(store.folderFor(base, QStringLiteral("odd.qqq"), QUrl())).absolutePath()
              == QDir(QStringLiteral("/tmp/dl/Other")).absolutePath(),
          "an unknown type resolves to Other");

    // No list loaded at all (a database that failed to open) must not invent a
    // folder — the download belongs in the plain download directory.
    CategoryStore none;
    CHECK(QDir(none.folderFor(base, QStringLiteral("clip.mp4"), QUrl())).absolutePath()
              == QDir(base).absolutePath(),
          "an empty store files into the download dir itself");
    CHECK(none.matchId(QStringLiteral("clip.mp4"), QUrl()) == 0, "and claims no category id");
}

static void testSerialisationRoundTrip()
{
    // Extensions are written with a dot (the shape the schema documents) and
    // read back without one. Both spellings parse, because a hand-edited row
    // should not lose its rules.
    const QString json = Category::serializeExtensions({QStringLiteral("mp4"),
                                                        QStringLiteral(".MKV"),
                                                        QStringLiteral("*.avi")});
    CHECK(json.contains(QStringLiteral(".mp4")) && json.contains(QStringLiteral(".mkv"))
              && json.contains(QStringLiteral(".avi")),
          QStringLiteral("extensions serialise dotted and folded: %1").arg(json));

    QStringList back;
    for (const QString &raw : Category::parseList(json))
        back << Category::normalizeExtension(raw);
    CHECK(back == QStringList({"mp4", "mkv", "avi"}),
          QStringLiteral("round trip, got %1").arg(back.join(QLatin1Char(','))));

    // A hand-typed list instead of JSON still loads rather than vanishing.
    const QStringList loose = Category::parseList(QStringLiteral(".mp4, .mkv;.avi"));
    CHECK(loose.size() == 3, QStringLiteral("loose list parses, got %1").arg(loose.size()));

    CHECK(Category::parseList(QString()).isEmpty(), "empty input is safe");
    CHECK(Category::normalizeExtension(QStringLiteral("  .TS  ")) == QLatin1String("ts"),
          "extensions are trimmed, folded and de-dotted");
}

static void testPersistence()
{
    QTemporaryDir tmp;
    if (!tmp.isValid()) {
        qWarning() << "FAIL: could not create a temporary directory";
        ++g_failures;
        return;
    }
    const QString dbPath = tmp.filePath(QStringLiteral("nexa.db"));

    int customId = 0;
    {
        Database db;
        CHECK(db.open(dbPath), "database opens");

        // A fresh database seeds itself, so an install with no categories still
        // sorts files exactly as it did before the feature existed.
        QVector<Category> seeded = db.loadCategories();
        CHECK(seeded.size() == 7, QStringLiteral("seeded on first open, got %1").arg(seeded.size()));
        CHECK(seeded.first().name == QLatin1String("Video"), "seeded in priority order");
        for (const Category &c : seeded)
            CHECK(c.id > 0, QStringLiteral("%1 got a row id").arg(c.name));

        Category custom = makeCategory(QStringLiteral("Courses"), {QStringLiteral("mp4")},
                                       {QStringLiteral("udemy.com")}, 99);
        custom.icon = QStringLiteral("C");
        CHECK(db.saveCategory(custom), "a custom category saves");
        CHECK(custom.id > 0, "the insert wrote its id back");
        customId = custom.id;

        db.close();
    }
    {
        // Everything survives the restart, rules included.
        Database db;
        CHECK(db.open(dbPath), "database reopens");
        const QVector<Category> all = db.loadCategories();
        CHECK(all.size() == 8, QStringLiteral("nothing re-seeded on reopen, got %1").arg(all.size()));

        CategoryStore store;
        store.setAll(all);
        const Category *courses = store.byId(customId);
        CHECK(courses != nullptr, "the custom category came back");
        if (courses) {
            CHECK(courses->extensions == QStringList({"mp4"}), "extensions survive the round trip");
            CHECK(courses->sites == QStringList({"udemy.com"}), "sites survive the round trip");
            CHECK(!courses->builtin, "a custom category is not built-in");
        }

        // Reordering writes the visible order back as priorities.
        QVector<Category> reordered = all;
        std::rotate(reordered.begin(), reordered.end() - 1, reordered.end());
        CHECK(db.saveCategoryOrder(reordered), "the new order saves");
        const QVector<Category> after = db.loadCategories();
        CHECK(!after.isEmpty() && after.first().id == customId,
              "the dragged row now sorts first");

        db.close();
    }
    {
        // Deleting a category must clear it off the downloads that referenced
        // it. Without that the row keeps a dangling id, because SQLite does not
        // enforce the foreign key unless it is asked to.
        Database db;
        CHECK(db.open(dbPath), "database reopens for the delete case");
        QSqlDatabase probe = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"),
                                                       QStringLiteral("cat-probe"));
        probe.setDatabaseName(dbPath);
        CHECK(probe.open(), "the probe connection opens");
        QSqlQuery q(probe);
        q.prepare(QStringLiteral(
            "INSERT INTO downloads (id, url, save_path, total, state, category_id) "
            "VALUES (901, 'https://e.com/a.mp4', '/tmp/a.mp4', 10, 4, :cat)"));
        q.bindValue(QStringLiteral(":cat"), customId);
        CHECK(q.exec(), QStringLiteral("seed a download row: %1").arg(q.lastError().text()));

        CHECK(db.removeCategory(customId), "the custom category deletes");

        QSqlQuery check(probe);
        check.exec(QStringLiteral("SELECT category_id FROM downloads WHERE id = 901"));
        CHECK(check.next(), "the download row is still there");
        CHECK(check.value(0).isNull(),
              "its category id was cleared, not left dangling");

        const QVector<Category> left = db.loadCategories();
        CategoryStore store;
        store.setAll(left);
        CHECK(store.byId(customId) == nullptr, "and the category itself is gone");
        // The seeded set is untouched: deleting a custom row is not a reset.
        CHECK(left.size() == 7, QStringLiteral("built-ins remain, got %1").arg(left.size()));
        probe.close();
        db.close();
    }
}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);

    testDefaults();
    testExtensionMatching();
    testSiteMatching();
    testRulelessCustomNeverSwallows();
    testFolderResolution();
    testFolderForIsWhatTheEngineCalls();
    testSerialisationRoundTrip();
    testPersistence();

    if (g_failures == 0)
        qInfo() << "CategoriesTest: all checks passed";
    else
        qWarning() << "CategoriesTest:" << g_failures << "check(s) failed";
    return g_failures == 0 ? 0 : 1;
}
