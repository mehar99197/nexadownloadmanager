#include <QApplication>
#include <QIcon>
#include "core/DownloadEngine.h"
#include "core/DownloadTask.h"
#include "core/Types.h"
#include "ipc/IpcServer.h"
#include "ipc/NativeHostRegistrar.h"
#include "ipc/ExtensionInstaller.h"
#include "web/WebServer.h"
#include "ui/MainWindow.h"
#include "ui/Theme.h"
#include "ui/Localization.h"
#include "ui/SettingsDialog.h"
#include "ui/FirstRunWizard.h"
#include <QTimer>
#include "license/LicenseManager.h"

#include "core/Logging.h"
#include "core/Portable.h"
#include "core/ProxyConfig.h"

#include <QHostInfo>
#include <QNetworkInterface>
#include <QUuid>
#ifndef _WIN32
#include <unistd.h>   // isatty: hide the dashboard token in non-interactive output
#endif
#include <QLocalSocket>
#include <QJsonDocument>
#include <QJsonObject>
#include <QFile>
#include <QTextStream>
#include <QDateTime>
#include <QStandardPaths>
#include <QDir>
#include <QSettings>
#include <atomic>
#include <algorithm>

// Set by CMake from project(Nexa VERSION …); the fallback keeps a stray build
// (IDE, test target) compiling but is deliberately not a real version.
#ifndef NEXA_VERSION
#define NEXA_VERSION "0.0.0-dev"
#endif

namespace nexa {

// ---- Opt-in troubleshooting log (see core/Logging.h) --------------------
namespace {
std::atomic<bool> g_logEnabled{false};
QtMessageHandler   g_prevHandler = nullptr;

void messageSink(QtMsgType type, const QMessageLogContext &ctx, const QString &msg)
{
    if (g_prevHandler) g_prevHandler(type, ctx, msg);   // keep normal console output
    if (!g_logEnabled.load() || type == QtDebugMsg)
        return;                                          // off, or just debug noise
    QFile f(logFilePath());
    if (f.size() > 1024 * 1024)                          // rotate: cap at ~1 MB
        f.remove();
    if (!f.open(QIODevice::Append | QIODevice::Text))
        return;
    const char *lvl = type == QtWarningMsg ? "WARN"
                    : type == QtCriticalMsg ? "CRIT"
                    : type == QtFatalMsg ? "FATAL" : "INFO";
    QTextStream(&f) << QDateTime::currentDateTime().toString(Qt::ISODate)
                    << " [" << lvl << "] " << msg << '\n';
}
} // namespace

QString logFilePath()
{
    QString dir = portable::appDataDir();
    QDir().mkpath(dir);
    return dir + QStringLiteral("/nexa.log");
}

void setLoggingEnabled(bool on) { g_logEnabled.store(on); }

void installLogging()
{
    g_logEnabled.store(QSettings().value(QStringLiteral("errorLogging"), false).toBool());
    g_prevHandler = qInstallMessageHandler(messageSink);
}

} // namespace nexa

// First non-loopback IPv4 address, so we can print a reachable dashboard URL.
static QString localIpv4()
{
    const auto addrs = QNetworkInterface::allAddresses();
    for (const QHostAddress &a : addrs) {
        if (a.protocol() == QAbstractSocket::IPv4Protocol && !a.isLoopback())
            return a.toString();
    }
    return QStringLiteral("127.0.0.1");
}

int main(int argc, char *argv[])
{
    // Running from an AppImage: put the bundled tools (yt-dlp / ffmpeg / aria2 in
    // the AppDir) first on PATH so every QProcess::start("yt-dlp"/"ffmpeg"/…)
    // finds them. This is what makes the AppImage fully self-contained — it works
    // even on a machine that has none of those installed. (Set before anything
    // launches a child process; child processes inherit this PATH.)
    if (qEnvironmentVariableIsSet("APPDIR")) {
        const QByteArray appdir = qgetenv("APPDIR");
        qputenv("PATH", appdir + "/usr/bin:" + qgetenv("PATH"));
    }

    // `nexa --register-extensions`: write the browser-extension hooks and exit,
    // without a window. On Linux the hooks are system-wide, so this is what the
    // .deb postinst does (via packaging/register-browser-extensions) and what an
    // AppImage or tarball user runs once with sudo. Must be decided before a
    // QApplication exists — under sudo there is usually no display to open.
    for (int i = 1; i < argc; ++i) {
        if (qstrcmp(argv[i], "--register-extensions") != 0) continue;
        QCoreApplication core(argc, argv);
        QCoreApplication::setApplicationName(QStringLiteral("Nexa"));
        QCoreApplication::setOrganizationName(QStringLiteral("Nexa"));
        nexa::portable::initialise();
        const nexa::extinstall::Report report = nexa::extinstall::registerExtensions();
        QTextStream out(stdout);
        if (report.entries.isEmpty())
            out << "No supported browser found on this machine.\n";
        for (const nexa::extinstall::Entry &e : report.entries)
            out << (e.status == nexa::extinstall::Status::Registered ? "  ok   " : "  --   ")
                << e.browser << ": " << e.detail << '\n';
        return report.entries.isEmpty() || report.anyRegistered() ? 0 : 1;
    }

    QApplication app(argc, argv);
    QApplication::setApplicationName(QStringLiteral("Nexa"));
    QApplication::setOrganizationName(QStringLiteral("Nexa"));
    QApplication::setApplicationVersion(QStringLiteral(NEXA_VERSION));   // from CMake project()
    // Portable mode (a `portable.txt` beside the executable) must be resolved
    // BEFORE the first QSettings read, or settings would come from the profile.
    nexa::portable::initialise();

#ifdef Q_OS_WIN
    // Windows: the NSIS installer drops yt-dlp.exe / ffmpeg.exe into the install
    // dir alongside nexa.exe, but that dir is NOT on PATH. Prepend it so bundled
    // tools resolve and the yt-dlp child finds ffmpeg via the inherited PATH.
    // resolveTool() also handles this per-launch; this keeps the whole child-process
    // environment consistent. Set before anything launches a child process (a
    // download starts much later, so doing it after QApplication is fine).
    {
        const QByteArray exeDir = QCoreApplication::applicationDirPath().toLocal8Bit();
        if (!exeDir.isEmpty())
            qputenv("PATH", exeDir + ";" + qgetenv("PATH"));
    }
#endif
    QApplication::setWindowIcon(QIcon(QStringLiteral(":/nexa.png")));

    // Install the opt-in troubleshooting log sink (after org/app name so QSettings
    // resolves correctly). No-op unless the user enabled it in Settings.
    nexa::installLogging();

    // Brand system: violet -> cyan on either a midnight or a paper ground. The
    // whole stylesheet is generated from a named palette (see ui/Theme.h), so the
    // light theme is a real design rather than an inversion.
    // Language before any widget is constructed, so every string is translated
    // on the first paint (Qt only re-translates on demand otherwise).
    nexa::i18n::install(app);
    nexa::theme::apply(app);


    qRegisterMetaType<nexa::DownloadState>("nexa::DownloadState");

    // Command line: nexa [--background] [--resume-all] [--batch] <url> [url...]
    //   --background  run headless (no window) — used by the native host/autostart
    //   --batch       quit once every download reaches a terminal state (CLI use)
    const QStringList args = QApplication::arguments();
    const bool batch = args.contains(QStringLiteral("--batch"));
    const bool background = args.contains(QStringLiteral("--background"));

    // Positional (non-flag) args are URLs/patterns to download. ("--ai <text>"
    // consumes the next token, so skip it.)
    QStringList urlArgs;
    for (int i = 1; i < args.size(); ++i) {
        const QString a = args.at(i);
        if (a == QStringLiteral("--ai")) { ++i; continue; }
        if (!a.startsWith(QStringLiteral("--")))
            urlArgs << a;
    }

    // ---- Single-instance guard -------------------------------------------
    // If an engine is already listening on the IPC socket, forward any URLs to
    // it and (for a plain re-launch) ask it to surface its window, then exit —
    // never open a second window. This is what keeps repeated handoffs/launches
    // from spawning a wall of Nexa windows.
    {
        QLocalSocket probe;
        probe.connectToServer(QStringLiteral("nexa-ipc"));
        // Short waits: when no instance is listening this returns immediately, and
        // when one IS listening we only need long enough to hand off and exit.
        if (probe.waitForConnected(250)) {
            auto sendFramed = [&probe](const QJsonObject &o) {
                const QByteArray body = QJsonDocument(o).toJson(QJsonDocument::Compact);
                const quint32 len = quint32(body.size());
                QByteArray framed;
                framed.append(char(len & 0xFF));        framed.append(char((len >> 8) & 0xFF));
                framed.append(char((len >> 16) & 0xFF)); framed.append(char((len >> 24) & 0xFF));
                framed.append(body);
                probe.write(framed);
                probe.flush();
                probe.waitForBytesWritten(300);
                probe.waitForReadyRead(700);    // let the server consume + reply
                probe.readAll();
            };
            for (const QString &u : urlArgs)
                sendFramed(QJsonObject{{"type", "download"}, {"url", u}});
            if (!background)                    // a plain re-launch wants the window
                sendFramed(QJsonObject{{"type", "show"}});
            probe.disconnectFromServer();
            return 0;
        }
    }

    nexa::DownloadEngine engine;
    // Apply the user's saved preferences (download dir, concurrency, speed caps,
    // subtitles, torrent limits, …) before anything runs. CLI flags below may
    // still override individual values for this session.
    nexa::SettingsDialog::loadInto(&engine);
    nexa::proxyconfig::applyFromSettings();   // before any network activity
    engine.license()->start();
    // Scripted/batch CLI runs can't answer a confirmation prompt — never hold there.
    if (batch)
        engine.setConfirmBeforeStart(false);
    engine.loadPersisted();        // restore unfinished downloads from last run

    // Listen for downloads handed off by the browser extension via nexa-host.
    nexa::IpcServer ipc(&engine);
    if (!ipc.start()) {
        // Another instance grabbed the socket between our probe and now — exit
        // rather than running a windowless, socket-less duplicate.
        return 0;
    }

    // Self-register the native-messaging host with every installed browser so the
    // extension can always reach us — no manual install step, on any machine. The
    // manifest points at OUR nexa-host (resolved from this exe's location) and the
    // extension ids are pinned, so "Specified native messaging host not found"
    // can't recur on a fresh install. Idempotent; cheap (only rewrites on change).
    nexa::registerNativeHost();
    // …and hand every installed browser the extension itself, from its own
    // store, so a fresh install needs no visit to the Web Store. Per-user hooks
    // here; the Linux system-wide ones come from the .deb postinst. The setup
    // guide shows the per-browser result.
    nexa::extinstall::registerExtensions();

    nexa::MainWindow window(&engine);
    // A peer asking to "show" (second launch / popup) surfaces this window.
    QObject::connect(&ipc, &nexa::IpcServer::showWindowRequested,
                     &window, &nexa::MainWindow::showAndRaise);
    // "Download all links" from the extension → link-grabber dialog.
    QObject::connect(&ipc, &nexa::IpcServer::linksReceived,
                     &window, &nexa::MainWindow::showLinkGrabber);

    // Background presence: a system tray lets the engine run without a window.
    // When a tray exists, closing the window keeps Nexa running in the tray.
    const bool trayOk = window.setupTray();
    if (trayOk)
        QApplication::setQuitOnLastWindowClosed(false);
    if (!background)
        window.show();                 // normal launch: show the window
    else if (!trayOk)
        window.showMinimized();        // headless but no tray: stay in the taskbar
    // First launch on this machine: folder → extension → test download.
    if (!background && !batch && urlArgs.isEmpty() && nexa::FirstRunWizard::shouldShow())
        QTimer::singleShot(400, &window, &nexa::MainWindow::showSetupGuide);

    if (batch) {
        // In batch mode, exit as soon as all downloads/streams finish or error.
        auto checkDone = [&engine]() {
            if (engine.allTerminal())
                QCoreApplication::quit();
        };
        QObject::connect(&engine, &nexa::DownloadEngine::taskFinished,
                         &app, [checkDone](int) { checkDone(); });
        QObject::connect(&engine, &nexa::DownloadEngine::taskStateChanged,
                         &app, [checkDone](int, nexa::DownloadState, const QString &) { checkDone(); });
    }

    // First pass: apply settings flags before adding downloads.
    bool wantDashboard = false;
    bool dashLan = false;          // bind 0.0.0.0 only when explicitly opted in
    quint16 dashPort = 8088;
    QString dashToken;
    for (const QString &arg : args) {
        if (arg.startsWith(QStringLiteral("--max="))) {
            engine.setMaxConcurrent(arg.mid(6).toInt());
        } else if (arg == QStringLiteral("--no-categorize")) {
            engine.setAutoCategorize(false);
        } else if (arg == QStringLiteral("--dashboard")) {
            wantDashboard = true;
        } else if (arg.startsWith(QStringLiteral("--dashboard="))) {
            wantDashboard = true;
            dashPort = quint16(arg.mid(12).toUInt());
        } else if (arg == QStringLiteral("--dashboard-lan")) {
            dashLan = true;
        } else if (arg.startsWith(QStringLiteral("--dashboard-token="))) {
            dashToken = arg.mid(18);
            // A short operator-supplied token is brute-forceable on the LAN; refuse
            // it and fall back to a strong random one rather than run weak.
            if (!dashToken.isEmpty() && dashToken.size() < 16) {
                qWarning() << "Nexa: --dashboard-token too short (<16 chars); using a random one";
                dashToken.clear();
            }
        } else if (arg == QStringLiteral("--ai-rename")) {
            engine.setAiRename(true);
        }
    }

    // Remote dashboard. Off unless enabled in Settings or via --dashboard. Bound
    // to loopback by default; LAN exposure (Settings or --dashboard-lan) needs a
    // TLS cert/key. A high-entropy token gates every call; it is generated once
    // per install and persisted so the phone bookmark keeps working. Re-applied
    // live whenever Settings are saved.
    const bool cliPort = std::any_of(args.cbegin(), args.cend(), [](const QString &a) {
        return a.startsWith(QStringLiteral("--dashboard=")); });
    auto *dashboard = new nexa::WebServer(&engine, &app);
    auto applyDashboard = [&, dashboard]() {
        QSettings s;
        if (dashboard->isRunning()) {
            dashboard->stop();
            s.remove(QStringLiteral("dashboard/currentUrl"));
        }
        const bool enabled = wantDashboard || s.value(QStringLiteral("dashboard/enabled"), false).toBool();
        if (!enabled)
            return;
        const quint16 port = cliPort ? dashPort
                                     : quint16(s.value(QStringLiteral("dashboard/port"), 8088).toUInt());
        const bool lan = dashLan || s.value(QStringLiteral("dashboard/lan"), false).toBool();
        QString token = dashToken;
        if (token.isEmpty()) {
            token = s.value(QStringLiteral("dashboard/token")).toString();
            if (token.size() < 16) {   // 128-bit token, constant width (no lost zeros)
                token = QUuid::createUuid().toString(QUuid::Id128);
                s.setValue(QStringLiteral("dashboard/token"), token);
            }
        }
        if (!dashboard->start(port, lan, token)) {
            qWarning() << "Nexa dashboard could not start on port" << port
                       << (lan ? "(LAN mode needs NEXA_TLS_CERT and NEXA_TLS_KEY)" : "");
            return;
        }
        const QString host = lan ? localIpv4() : QStringLiteral("127.0.0.1");
        const QString scheme = dashboard->isTls() ? QStringLiteral("https") : QStringLiteral("http");
        const QString base = QStringLiteral("%1://%2:%3/").arg(scheme, host).arg(dashboard->port());
        s.setValue(QStringLiteral("dashboard/currentUrl"), base + QStringLiteral("?token=") + token);
        
        // SECURITY WARNING: HTTP dashboard on LAN exposes token to network sniffers
        if (lan && !dashboard->isTls()) {
            qWarning() << "⚠️  SECURITY WARNING: Dashboard running on HTTP (LAN mode).";
            qWarning() << "   Your authentication token is transmitted in plaintext!";
            qWarning() << "   Set NEXA_TLS_CERT and NEXA_TLS_KEY environment variables to enable HTTPS.";
        }
        // Only print the secret token when stdout is an interactive terminal —
        // not when redirected to a log file / journald, where anyone who can
        // read the logs would gain full remote control.
#ifdef _WIN32
        const bool interactive = true;
#else
        const bool interactive = ::isatty(STDOUT_FILENO);
#endif
        if (interactive)
            qInfo().noquote() << QStringLiteral("Nexa dashboard: ") + base
                                 + QStringLiteral("?token=") + token;
        else
            qInfo().noquote() << QStringLiteral("Nexa dashboard: ") + base
                                 + QStringLiteral("  (token hidden in non-interactive output)");
        if (!lan)
            qInfo().noquote() << "  (loopback only; enable LAN in Settings or pass --dashboard-lan)";
    };
    applyDashboard();
    QObject::connect(&window, &nexa::MainWindow::dashboardSettingsChanged, &app, applyDashboard);

    for (int i = 1; i < args.size(); ++i) {
        const QString arg = args.at(i);
        if (arg == QStringLiteral("--resume-all")) {
            engine.resumeUnfinished();   // continue downloads interrupted last run
            continue;
        }
        if (arg == QStringLiteral("--ai") && i + 1 < args.size()) {
            engine.runAiCommand(args.at(++i));   // natural-language request
            continue;
        }
        if (arg.startsWith(QStringLiteral("--")))
            continue;                    // flags handled above, not URLs
        // addBatch expands numeric ranges like file[1-20].jpg and queues them.
        engine.addBatch(arg);
    }

    // Seats are concurrent, so hand this machine's back on the way out instead
    // of leaving it held until the lease expires — otherwise quitting on one
    // laptop and opening another looks like the seat limit is broken. Bounded
    // to a few seconds inside releaseSeat(); a crash is covered by the lease.
    const int exitCode = app.exec();
    engine.license()->releaseSeat();
    return exitCode;
}
