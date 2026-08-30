#include "core/Database.h"
#include "core/DownloadTask.h"

#include <QCoreApplication>
#include <QNetworkAccessManager>
#include <QTemporaryDir>
#include <cstdio>

static int g_failures = 0;

#define CHECK(expr, message) do { \
    if (!(expr)) { \
        std::fprintf(stderr, "FAIL: %s\n", message); \
        ++g_failures; \
    } \
} while (false)

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    QTemporaryDir temp;
    CHECK(temp.isValid(), "temporary directory unavailable");
    if (!temp.isValid())
        return 1;

    nexa::Database db;
    CHECK(db.open(temp.filePath(QStringLiteral("state.db"))), "database did not open");
    if (!db.loadAll().isEmpty())
        CHECK(false, "new database was not empty");

    QNetworkAccessManager nam;
    nexa::DownloadTask task(1, QUrl(QStringLiteral("https://example.com/file")),
                            temp.filePath(QStringLiteral("file.bin")), &nam, &db);

    nexa::SegmentInfo first;
    first.index = 0; first.start = 0; first.end = 4; first.done = 5;
    nexa::SegmentInfo second;
    second.index = 1; second.start = 5; second.end = 9; second.done = 0;
    db.saveTask(task, {first, second});

    nexa::SegmentInfo replacement;
    replacement.index = 0; replacement.start = 0; replacement.end = 2; replacement.done = 1;
    db.saveTask(task, {replacement});

    const auto records = db.loadAll();
    CHECK(records.size() == 1, "task record missing after save");
    if (records.size() == 1) {
        CHECK(records.first().segments.size() == 1,
              "stale segment rows survived a layout replacement");
        if (records.first().segments.size() == 1) {
            const auto &s = records.first().segments.first();
            CHECK(s.index == 0 && s.start == 0 && s.end == 2 && s.done == 1,
                  "replacement segment layout was not restored exactly");
        }
    }
    db.close();
    return g_failures == 0 ? 0 : 1;
}
