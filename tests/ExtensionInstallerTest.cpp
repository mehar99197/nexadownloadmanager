// The auto-install planner must (a) write exactly the hooks each browser reads,
// (b) never touch a browser whose store listing does not exist yet, (c) leave
// other people's Firefox policies alone, and (d) be safe to run on every launch.
#include "ipc/ExtensionInstaller.h"

#include <QCoreApplication>
#include <QDebug>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTemporaryDir>

using namespace nexa::extinstall;

namespace {
int failures = 0;
#define CHECK(expr) do { if (!(expr)) { qCritical() << "FAIL" << __LINE__ << #expr; ++failures; } } while (false)

QByteArray slurp(const QString &p) { QFile f(p); return f.open(QIODevice::ReadOnly) ? f.readAll() : QByteArray(); }
Browser b(const char *key, const char *name, Family fam, bool sandboxed = false)
{ return Browser{QString::fromLatin1(key), QString::fromLatin1(name), fam, sandboxed}; }
} // namespace

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);

    // ---- env file parsing: quotes, comments, case
    {
        const Ids ids = parseIdsEnv(QByteArrayLiteral(
            "# comment\nNEXA_CHROME_STORE_ID=\"ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP\"\n"
            "NEXA_EDGE_STORE_ID=\nNEXA_FIREFOX_XPI_URL='https://x.test/nexa.xpi'\nNEXA_FIREFOX_EXT_ID=nexa@nexa.local\n"));
        CHECK(ids.chromeStoreId == QStringLiteral("abcdefghijklmnopabcdefghijklmnop"));
        CHECK(ids.edgeStoreId.isEmpty());
        CHECK(ids.firefoxXpiUrl == QStringLiteral("https://x.test/nexa.xpi"));
        CHECK(ids.firefoxExtId == QStringLiteral("nexa@nexa.local"));
    }

#if defined(Q_OS_LINUX)
    QTemporaryDir root;
    CHECK(root.isValid());
    const QString R = root.path();
    const QVector<Browser> browsers = {
        b("chrome",   "Google Chrome", Family::Chromium),
        b("chromium", "Chromium",      Family::Chromium),
        b("brave",    "Brave",         Family::Chromium),
        b("edge",     "Microsoft Edge",Family::Chromium),
        b("firefox",  "Firefox",       Family::Firefox),
        b("chromium", "Chromium (snap)", Family::Chromium, /*sandboxed=*/true),
    };

    // ---- nothing published: nothing written, everybody "waiting"
    {
        Ids none; none.firefoxExtId = QStringLiteral("nexa@nexa.local");
        CHECK(plan(browsers, none, R).isEmpty());
        const Report rep = apply(browsers, none, R);
        CHECK(rep.entries.size() == browsers.size());
        CHECK(!rep.anyRegistered());
        int waiting = 0, manual = 0;
        for (const Entry &e : rep.entries) { if (e.status == Status::WaitingForStore) ++waiting; if (e.status == Status::Manual) ++manual; }
        CHECK(waiting == 5);
        CHECK(manual == 1);   // the snap
        CHECK(!QDir(R + QStringLiteral("/etc")).exists());
    }

    Ids ids;
    ids.chromeStoreId = QStringLiteral("abcdefghijklmnopabcdefghijklmnop");
    ids.firefoxXpiUrl = QStringLiteral("https://nexadownloadmanager.com/dl/nexa.xpi");
    ids.firefoxExtId  = QStringLiteral("nexa@nexa.local");

    // ---- someone else's Firefox policy must survive our merge
    {
        QDir().mkpath(R + QStringLiteral("/etc/firefox/policies"));
        QFile f(R + QStringLiteral("/etc/firefox/policies/policies.json"));
        CHECK(f.open(QIODevice::WriteOnly));
        f.write("{\"policies\":{\"DisableTelemetry\":true,\"ExtensionSettings\":{\"other@x\":{\"installation_mode\":\"blocked\"}}}}");
        f.close();
    }

    const QVector<Target> targets = plan(browsers, ids, R);
    // chrome ×2 dirs, chromium ×2 dirs, brave policy, edge policy (chrome id fallback), firefox merge
    CHECK(targets.size() == 7);
    for (const Target &t : targets) CHECK(t.path.startsWith(R));

    const Report first = apply(browsers, ids, R);
    CHECK(first.anyRegistered());
    for (const Entry &e : first.entries) {
        if (e.browser == QStringLiteral("Chromium (snap)")) CHECK(e.status == Status::Manual);
        else CHECK(e.status == Status::Registered);
    }

    // Chrome: external-extension JSON in both documented directories
    const QByteArray chromeJson = slurp(R + QStringLiteral("/opt/google/chrome/extensions/") + ids.chromeStoreId + QStringLiteral(".json"));
    CHECK(QJsonDocument::fromJson(chromeJson).object().value(QStringLiteral("external_update_url")).toString()
          == QStringLiteral("https://clients2.google.com/service/update2/crx"));
    CHECK(slurp(R + QStringLiteral("/usr/share/google-chrome/extensions/") + ids.chromeStoreId + QStringLiteral(".json")) == chromeJson);
    CHECK(slurp(R + QStringLiteral("/usr/share/chromium/extensions/") + ids.chromeStoreId + QStringLiteral(".json")) == chromeJson);

    // Brave / Edge: managed policy, normal_installed (user can still remove it)
    {
        const QJsonObject brave = QJsonDocument::fromJson(slurp(R + QStringLiteral("/etc/brave/policies/managed/nexa-extension.json"))).object();
        const QJsonObject entry = brave.value(QStringLiteral("ExtensionSettings")).toObject().value(ids.chromeStoreId).toObject();
        CHECK(entry.value(QStringLiteral("installation_mode")).toString() == QStringLiteral("normal_installed"));
        CHECK(entry.value(QStringLiteral("update_url")).toString().startsWith(QStringLiteral("https://clients2.google.com")));
        const QJsonObject edge = QJsonDocument::fromJson(slurp(R + QStringLiteral("/etc/opt/edge/policies/managed/nexa-extension.json"))).object();
        CHECK(edge.value(QStringLiteral("ExtensionSettings")).toObject().contains(ids.chromeStoreId));   // no Edge id → Chrome store copy
    }

    // Firefox: merged, theirs intact
    {
        const QJsonObject pol = QJsonDocument::fromJson(slurp(R + QStringLiteral("/etc/firefox/policies/policies.json"))).object()
                                    .value(QStringLiteral("policies")).toObject();
        CHECK(pol.value(QStringLiteral("DisableTelemetry")).toBool() == true);
        const QJsonObject es = pol.value(QStringLiteral("ExtensionSettings")).toObject();
        CHECK(es.value(QStringLiteral("other@x")).toObject().value(QStringLiteral("installation_mode")).toString() == QStringLiteral("blocked"));
        const QJsonObject mine = es.value(QStringLiteral("nexa@nexa.local")).toObject();
        CHECK(mine.value(QStringLiteral("installation_mode")).toString() == QStringLiteral("normal_installed"));
        CHECK(mine.value(QStringLiteral("install_url")).toString() == ids.firefoxXpiUrl);
    }

    // ---- idempotent: everything already in place, second pass writes nothing
    for (const Target &t : targets) CHECK(targetInPlace(t));
    {
        const QString probe = R + QStringLiteral("/usr/share/chromium/extensions/") + ids.chromeStoreId + QStringLiteral(".json");
        const QDateTime before = QFileInfo(probe).lastModified();
        const Report second = apply(browsers, ids, R);
        CHECK(second.anyRegistered());
        CHECK(QFileInfo(probe).lastModified() == before);
        bool installerNote = false;
        for (const Entry &e : second.entries)
            if (e.browser == QStringLiteral("Chromium")) installerNote = e.detail.contains(QStringLiteral("installer"));
        CHECK(!installerNote);   // the note is only for the real system root
    }

    // ---- Edge with its own store id goes to the Edge store
    {
        Ids withEdge = ids;
        withEdge.edgeStoreId = QStringLiteral("ppppppppppppppppppppppppppppppp" "p");
        const QVector<Target> t2 = plan({b("edge", "Microsoft Edge", Family::Chromium)}, withEdge, R);
        CHECK(t2.size() == 1);
        CHECK(t2.first().payload.contains("edge.microsoft.com"));
        CHECK(t2.first().payload.contains(withEdge.edgeStoreId.toUtf8()));
    }

    // ---- remove: our files gone, their Firefox policy still there
    for (const Target &t : targets) CHECK(removeTarget(t));
    CHECK(!QFileInfo::exists(R + QStringLiteral("/etc/brave/policies/managed/nexa-extension.json")));
    CHECK(!QFileInfo::exists(R + QStringLiteral("/usr/share/chromium/extensions/") + ids.chromeStoreId + QStringLiteral(".json")));
    {
        const QJsonObject pol = QJsonDocument::fromJson(slurp(R + QStringLiteral("/etc/firefox/policies/policies.json"))).object()
                                    .value(QStringLiteral("policies")).toObject();
        CHECK(pol.value(QStringLiteral("DisableTelemetry")).toBool() == true);
        CHECK(pol.value(QStringLiteral("ExtensionSettings")).toObject().contains(QStringLiteral("other@x")));
        CHECK(!pol.value(QStringLiteral("ExtensionSettings")).toObject().contains(QStringLiteral("nexa@nexa.local")));
    }
#endif

    if (failures) qCritical() << failures << "check(s) failed";
    else qInfo() << "extension installer: all checks passed";
    return failures ? 1 : 0;
}
