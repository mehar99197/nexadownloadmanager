// The Windows Explorer hooks, written and taken back again — against a real
// registry, but a throw-away corner of it.
//
// These keys are the one part of Nexa that changes the machine outside its own
// folder, so the properties worth pinning are not "did it write something" but
// the restraints:
//
//   * it never becomes the DEFAULT handler for a file type, only an entry in
//     "Open with";
//   * unregistering removes our value from the shared OpenWithProgids key
//     without taking anybody else's entry with it;
//   * isRegistered() reports false when the stored command points at a
//     DIFFERENT executable, which is what makes the launch-time refresh repair
//     a moved or upgraded install instead of being a permanent no-op.
//
// setClassesRootForTesting redirects everything under a test key, so running
// this never touches the real shell.

#include "shell/ShellIntegration.h"

#include <QCoreApplication>
#include <QDebug>
#include <QDir>
#include <QSettings>
#include <QString>

using namespace nexa;

static int g_failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { qWarning() << "FAIL:" << msg; ++g_failures; } } while (0)

#ifdef Q_OS_WIN

static const QString kTestRoot =
    QStringLiteral("HKEY_CURRENT_USER\\Software\\Nexa\\ShellIntegrationTest\\Classes");

static QString readDefault(const QString &path)
{
    QSettings s(path, QSettings::NativeFormat);
    return s.value(QStringLiteral(".")).toString();
}

static bool keyExists(const QString &path)
{
    QSettings s(path, QSettings::NativeFormat);
    return !s.childKeys().isEmpty() || !s.childGroups().isEmpty();
}

static void wipeTestRoot()
{
    QSettings s(QStringLiteral("HKEY_CURRENT_USER\\Software\\Nexa\\ShellIntegrationTest"),
                QSettings::NativeFormat);
    s.remove(QString());
    s.sync();
}

static void testRegisterWritesWhatExplorerNeeds()
{
    wipeTestRoot();
    shellint::setClassesRootForTesting(kTestRoot);

    const shellint::Report report = shellint::registerShellIntegration();
    CHECK(report.anyRegistered(), "registration reports at least one entry written");

    const QString exe = QDir::toNativeSeparators(QCoreApplication::applicationFilePath());
    const QChar dq(0x22);
    const QString quotedExe = dq + exe + dq;

    // The open verb runs THIS executable, quoted. An unquoted path with a space
    // in it is the classic way a shell verb launches the wrong program.
    const QString openCmd = readDefault(kTestRoot + QStringLiteral("\\Nexa.Download\\shell\\open\\command"));
    CHECK(openCmd.startsWith(quotedExe), "the open command runs this executable, quoted");
    CHECK(openCmd.contains(QStringLiteral("%1")), "the open command is handed the file Explorer passes");

    // The folder verb carries the flag main() parses and the folder Explorer
    // substitutes, both quoted.
    const QString verbCmd = readDefault(
        kTestRoot + QStringLiteral("\\Directory\\Background\\shell\\NexaNewDownload\\command"));
    CHECK(verbCmd.startsWith(quotedExe), "the folder verb runs this executable, quoted");
    CHECK(verbCmd.contains(QStringLiteral("--new-download")), "the folder verb passes --new-download");
    CHECK(verbCmd.contains(dq + QStringLiteral("%V") + dq), "the folder Explorer names is quoted");

    // A label, or the menu entry is blank.
    CHECK(!readDefault(kTestRoot + QStringLiteral("\\Directory\\Background\\shell\\NexaNewDownload")).isEmpty(),
          "the folder-background entry has a label");
    CHECK(!readDefault(kTestRoot + QStringLiteral("\\Directory\\shell\\NexaNewDownload")).isEmpty(),
          "the folder entry has a label");

    shellint::setClassesRootForTesting(QString());
}

static void testNeverStealsAnAssociation()
{
    wipeTestRoot();
    shellint::setClassesRootForTesting(kTestRoot);
    shellint::registerShellIntegration();

    for (const QString &ext : {QStringLiteral(".torrent"), QStringLiteral(".ef2"),
                               QStringLiteral(".crawljob")}) {
        // Listed under "Open with"...
        QSettings owp(kTestRoot + QLatin1Char('\\') + ext + QStringLiteral("\\OpenWithProgids"),
                      QSettings::NativeFormat);
        CHECK(owp.childKeys().contains(QStringLiteral("Nexa.Download")),
              QStringLiteral("%1 lists Nexa under Open with").arg(ext));

        // ...and the type's DEFAULT handler is left exactly as it was. This is
        // the difference between appearing in a menu and hijacking a file type.
        CHECK(readDefault(kTestRoot + QLatin1Char('\\') + ext).isEmpty(),
              QStringLiteral("%1 keeps whatever default handler it had").arg(ext));
    }

    shellint::setClassesRootForTesting(QString());
}

static void testUnregisterLeavesOtherProgramsAlone()
{
    wipeTestRoot();
    shellint::setClassesRootForTesting(kTestRoot);
    shellint::registerShellIntegration();

    // OpenWithProgids is shared with every other program that offers to open
    // the type. Deleting the KEY on uninstall would take their entries with it,
    // so somebody else's value is planted here and must survive.
    const QString owpPath = kTestRoot + QStringLiteral("\\.torrent\\OpenWithProgids");
    {
        QSettings s(owpPath, QSettings::NativeFormat);
        s.setValue(QStringLiteral("SomeOtherClient.Torrent"), QString());
        s.sync();
    }

    CHECK(shellint::unregisterShellIntegration(), "unregister reports success");

    {
        QSettings s(owpPath, QSettings::NativeFormat);
        CHECK(!s.childKeys().contains(QStringLiteral("Nexa.Download")),
              "our own Open-with entry is gone");
        CHECK(s.childKeys().contains(QStringLiteral("SomeOtherClient.Torrent")),
              "another program's Open-with entry survives our uninstall");
    }

    CHECK(!keyExists(kTestRoot + QStringLiteral("\\Nexa.Download")), "the ProgId is gone");
    for (const QString &parent : {QStringLiteral("Directory\\Background"),
                                  QStringLiteral("Directory"),
                                  QStringLiteral("Drive\\Background")}) {
        CHECK(!keyExists(kTestRoot + QLatin1Char('\\') + parent
                             + QStringLiteral("\\shell\\NexaNewDownload")),
              QStringLiteral("the %1 menu entry is gone").arg(parent));
    }

    shellint::setClassesRootForTesting(QString());
}

static void testIsRegisteredTracksThisExecutable()
{
    wipeTestRoot();
    shellint::setClassesRootForTesting(kTestRoot);

    CHECK(!shellint::isRegistered(), "nothing registered yet");
    shellint::registerShellIntegration();
    CHECK(shellint::isRegistered(), "registered, and pointing at this executable");

    // Now pretend Nexa was moved or upgraded: the keys are still there, but they
    // name an executable that is not this one. Answering "registered" here would
    // stop the launch-time refresh from ever repairing it, and the menu entry
    // would keep pointing at a file that is gone.
    {
        const QChar dq(0x22);
        const QString stale = dq + QStringLiteral("C:\\Nowhere\\old-nexa.exe") + dq
                            + QStringLiteral(" ") + dq + QStringLiteral("%1") + dq;
        QSettings s(kTestRoot + QStringLiteral("\\Nexa.Download\\shell\\open\\command"),
                    QSettings::NativeFormat);
        s.setValue(QStringLiteral("."), stale);
        s.sync();
    }
    CHECK(!shellint::isRegistered(), "a stale path does not count as registered");

    // And re-registering repairs it rather than leaving the stale command.
    shellint::registerShellIntegration();
    CHECK(shellint::isRegistered(), "re-registering repairs a moved install");

    shellint::unregisterShellIntegration();
    CHECK(!shellint::isRegistered(), "unregistered");
    shellint::setClassesRootForTesting(QString());
}

static void testUnregisterIsSafeWhenNothingIsThere()
{
    wipeTestRoot();
    shellint::setClassesRootForTesting(kTestRoot);
    // The NSIS uninstaller runs this unconditionally, including on a machine
    // where the app never ran and wrote nothing.
    CHECK(shellint::unregisterShellIntegration(), "removing nothing is not a failure");
    CHECK(!shellint::isRegistered(), "still not registered");
    shellint::setClassesRootForTesting(QString());
}

#endif   // Q_OS_WIN

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    QCoreApplication::setApplicationName(QStringLiteral("NexaShellIntegrationTest"));
    QCoreApplication::setOrganizationName(QStringLiteral("Nexa"));

#ifdef Q_OS_WIN
    testRegisterWritesWhatExplorerNeeds();
    testNeverStealsAnAssociation();
    testUnregisterLeavesOtherProgramsAlone();
    testIsRegisteredTracksThisExecutable();
    testUnregisterIsSafeWhenNothingIsThere();
    wipeTestRoot();   // leave the registry as we found it
#else
    // The module is a no-op off Windows by design, so there is nothing to
    // assert beyond that calling it is harmless.
    CHECK(shellint::registerShellIntegration().entries.isEmpty(),
          "registration is a no-op on this platform");
    CHECK(shellint::unregisterShellIntegration(), "so is removing it");
    CHECK(!shellint::isRegistered(), "and nothing is ever reported as registered");
#endif

    if (g_failures == 0) {
        qInfo() << "Shell integration tests passed";
        return 0;
    }
    qWarning() << g_failures << "failure(s)";
    return 1;
}
