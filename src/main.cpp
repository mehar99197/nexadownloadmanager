#include <QApplication>
#include <QIcon>
#include "core/DownloadEngine.h"
#include "core/DownloadTask.h"
#include "core/Types.h"
#include "ipc/IpcServer.h"
#include "ipc/NativeHostRegistrar.h"
#include "web/WebServer.h"
#include "ui/MainWindow.h"
#include "ui/SettingsDialog.h"

#include "core/Logging.h"

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
    QString dir = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
    if (dir.isEmpty())
        dir = QStandardPaths::writableLocation(QStandardPaths::TempLocation);
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

    QApplication app(argc, argv);
    QApplication::setApplicationName(QStringLiteral("Nexa"));
    QApplication::setOrganizationName(QStringLiteral("Nexa"));
    QApplication::setApplicationVersion(QStringLiteral("0.1.0"));

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

    // Modern dark theme — deep navy canvas with a soft glow, accent-tinted
    // controls, and color-coded rows. Mirrors the redesigned mockup.
    app.setStyleSheet(QStringLiteral(R"(
        /* ===== NexaDL dark-slate theme (cyan -> purple, matches the logo) ===== */
        QWidget { background: #14161b; color: #cfd6e0; font-size: 13px; }
        QLabel { background: transparent; }
        #Root { background: #14161b; }

        /* ---- Header bar ---- */
        #HeaderBar { background: #0e1014; border-bottom: 1px solid #1f242c; }
        #BrandLogo { background: transparent; }
        #BrandTitle { color: #f0f4f9; font-size: 14px; font-weight: 600; }
        #Breadcrumb { color: #5c6675; font-size: 13px; }
        #IconBtn { background: transparent; color: #8a94a3; border: 1px solid #262b34;
                   border-radius: 8px; padding: 6px 9px; font-size: 14px; min-width: 16px; }
        #IconBtn:hover { background: #1b2029; color: #67e8f9; border-color: #2e3a44; }
        #Primary { background: qlineargradient(x1:0,y1:0,x2:1,y2:0,
                       stop:0 #22d3ee, stop:1 #8b5cf6);
                   color: #08121a; border: 0; border-radius: 8px;
                   padding: 7px 14px; font-size: 12px; font-weight: 700; }
        #Primary:hover { background: qlineargradient(x1:0,y1:0,x2:1,y2:0,
                       stop:0 #4fe0f5, stop:1 #a78bfa); }
        #Primary:pressed { background: qlineargradient(x1:0,y1:0,x2:1,y2:0,
                       stop:0 #15b8d6, stop:1 #7c3aed); }
        /* Header "New Download" — the hero action: cyan->purple gradient. */
        #NewDl { background: qlineargradient(x1:0,y1:0,x2:1,y2:1,
                       stop:0 #22d3ee, stop:1 #8b5cf6);
                 color: #08121a; border: 0; border-radius: 8px;
                 padding: 7px 15px; font-size: 12px; font-weight: 700; }
        #NewDl:hover { background: qlineargradient(x1:0,y1:0,x2:1,y2:1,
                       stop:0 #4fe0f5, stop:1 #a78bfa); }
        #NewDl:pressed { background: qlineargradient(x1:0,y1:0,x2:1,y2:1,
                       stop:0 #15b8d6, stop:1 #7c3aed); }

        /* ---- Metrics bar ---- */
        #MetricsBar { background: #16191f; border-bottom: 1px solid #1f242c; }
        #Metric { background: transparent; border-left: 1px solid #20252e; }
        #MetricFirst { background: transparent; }
        #MetricLabel { color: #5c6675; font-size: 10px; font-weight: 600; }
        #MetricValue { color: #f0f4f9; font-size: 22px; font-weight: 600; }
        #MetricSub { color: #46505e; font-size: 11px; }
        #MetricSub[good="true"] { color: #34d399; }

        /* ---- Toolbar ---- */
        #Toolbar { background: #0e1014; border-bottom: 1px solid #1f242c; }
        #Ghost { background: transparent; color: #8a94a3; border: 1px solid #262b34;
                 border-radius: 8px; padding: 6px 13px; font-size: 12px; font-weight: 500; }
        #Ghost:hover { background: #1b2029; color: #e8edf4; border-color: #2e3a44; }
        #Ghost:disabled { background: transparent; color: #3a4250; border-color: #1a1e25; }
        QLineEdit#Search { background: #1b1f27; border: 1px solid #262b34; border-radius: 8px;
                    padding: 6px 10px 6px 28px; color: #e8edf4;
                    selection-background-color: #22d3ee; selection-color: #08121a; }
        QLineEdit#Search:focus { border-color: #22d3ee; background: #161a21; }

        /* ---- Generic controls (dialogs) ---- */
        QPushButton { background: #1b1f27; color: #cfd6e0; border: 1px solid #262b34;
                      border-radius: 8px; padding: 7px 14px; font-weight: 500; }
        QPushButton:hover { background: #222732; color: #ffffff; border-color: #2e3a44; }
        QPushButton:pressed { background: #161a21; }
        QPushButton#Primary { color: #08121a; border: 0; }
        QLineEdit { background: #161a21; border: 1px solid #262b34; border-radius: 8px;
                    padding: 7px 10px; color: #e8edf4;
                    selection-background-color: #22d3ee; selection-color: #08121a; }
        QLineEdit:focus { border-color: #22d3ee; }

        /* ---- Per-row icon-action buttons ---- */
        QPushButton[ActIcon="true"] { background: transparent; color: #5c6675;
                      border: 1px solid #262b34; border-radius: 6px; padding: 0; font-size: 11px; }
        QPushButton[ActIcon="true"]:hover { background: #1b2029; color: #67e8f9; border-color: #2e3a44; }

        /* ---- Download list ---- */
        QLabel#f_name { color: #f0f4f9; font-weight: 500; font-size: 13px; }
        QLabel#f_host { color: #46505e; font-size: 10px; }
        QLabel#p_pct  { color: #5c6675; font-size: 11px; }

        QTableWidget { background: transparent; border: 0; outline: 0; }
        QTableWidget::item { border: 0; border-bottom: 1px solid #1b1f27; padding: 0; }
        QTableWidget::item:hover { background: #172230; }
        /* Active/selected row: cyan-tinted band with a cyan top+bottom rule. */
        QTableWidget::item:selected { background: #122029; color: #ffffff;
                    border-top: 1px solid #134b5a; border-bottom: 1px solid #134b5a; }
        QHeaderView::section { background: #14161b; color: #46505e; padding: 8px 10px;
                       border: 0; border-bottom: 1px solid #1f242c;
                       font-size: 10px; font-weight: 600; }

        QProgressBar { background: #1b222c; border: 0; border-radius: 3px; }
        QProgressBar::chunk { border-radius: 3px;
                       background: qlineargradient(x1:0,y1:0,x2:1,y2:0,
                       stop:0 #22d3ee, stop:1 #8b5cf6); }

        /* ---- Status badges (colour via the "st" property) ---- */
        QLabel#s_badge { font-size: 10px; font-weight: 700; border-radius: 5px;
                         padding: 3px 8px; }
        QLabel#s_badge[st="active"] { background: #07232b; color: #22d3ee; border: 1px solid #0e4a57; }
        QLabel#s_badge[st="paused"] { background: #221a05; color: #fbbf24; border: 1px solid #3a2c08; }
        QLabel#s_badge[st="done"]   { background: #07241c; color: #34d399; border: 1px solid #0e4536; }
        QLabel#s_badge[st="queued"] { background: #16191f; color: #6b7585; border: 1px solid #262b34; }
        QLabel#s_badge[st="error"]  { background: #2a1116; color: #fb7185; border: 1px solid #4a1f27; }

        /* ---- Empty state ---- */
        #EmptyTitle { color: #cfd6e0; font-size: 16px; font-weight: 600; }
        #EmptyHint  { color: #5c6675; font-size: 12px; }

        /* ---- Footer ---- */
        QStatusBar { background: #0e1014; border-top: 1px solid #1a1e25; }
        QStatusBar::item { border: 0; }
        #FootStat { color: #5c6675; font-size: 11px; }
        #FootVer  { color: #3a4250; font-size: 11px; }

        /* ---- Scrollbars / menus / tooltips ---- */
        QScrollBar:vertical { background: transparent; width: 10px; margin: 2px; }
        QScrollBar::handle:vertical { background: #262b34; border-radius: 5px; min-height: 30px; }
        QScrollBar::handle:vertical:hover { background: #34506b; }
        QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
        QMenu { background: #16191f; color: #cfd6e0; border: 1px solid #262b34;
                border-radius: 8px; padding: 5px; }
        QMenu::item { padding: 6px 16px; border-radius: 6px; }
        QMenu::item:selected { background: #1b2630; color: #67e8f9; }
        QMenu::separator { height: 1px; background: #262b34; margin: 4px 8px; }
        QToolTip { background: #16191f; color: #cfd6e0; border: 1px solid #262b34; padding: 4px 8px; }

        /* ---- Dialogs (details plate / settings) ---- */
        QDialog { background: #161922; }
        #Plate { background: #161922; border: none; border-radius: 10px; }
        #Dd_title { color: #f0f4f9; font-size: 15px; font-weight: 600; }
        #Dd_host  { color: #5c6675; font-size: 11px; }
        #Dd_seclabel { color: #5c6675; font-size: 11px; }
        #Dd_barpct { color: #5c6675; font-size: 11px; }
        QLabel[ddRole="label"] { color: #8a94a3; font-size: 11px; }
        QLabel[ddRole="value"] { color: #e8edf4; font-size: 13px; }
        #DdCancel { background: #2a1116; color: #fb7185; border: 1px solid #4a1f27; }
        #DdCancel:hover { background: #381620; }
    )"));

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
        if (probe.waitForConnected(400)) {
            auto sendFramed = [&probe](const QJsonObject &o) {
                const QByteArray body = QJsonDocument(o).toJson(QJsonDocument::Compact);
                const quint32 len = quint32(body.size());
                QByteArray framed;
                framed.append(char(len & 0xFF));        framed.append(char((len >> 8) & 0xFF));
                framed.append(char((len >> 16) & 0xFF)); framed.append(char((len >> 24) & 0xFF));
                framed.append(body);
                probe.write(framed);
                probe.flush();
                probe.waitForBytesWritten(500);
                probe.waitForReadyRead(2000);   // let the server consume + reply
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

    nexa::MainWindow window(&engine);
    // A peer asking to "show" (second launch / popup) surfaces this window.
    QObject::connect(&ipc, &nexa::IpcServer::showWindowRequested,
                     &window, &nexa::MainWindow::showAndRaise);

    // Background presence: a system tray lets the engine run without a window.
    // When a tray exists, closing the window keeps Nexa running in the tray.
    const bool trayOk = window.setupTray();
    if (trayOk)
        QApplication::setQuitOnLastWindowClosed(false);
    if (!background)
        window.show();                 // normal launch: show the window
    else if (!trayOk)
        window.showMinimized();        // headless but no tray: stay in the taskbar

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

    // Remote dashboard. Bound to loopback by default; --dashboard-lan exposes it
    // on the LAN so a phone can reach it. A high-entropy token gates every call.
    nexa::WebServer *dashboard = nullptr;
    if (wantDashboard) {
        if (dashToken.isEmpty())   // 128-bit token, constant width (no lost zeros)
            dashToken = QUuid::createUuid().toString(QUuid::Id128);
        dashboard = new nexa::WebServer(&engine, &app);
        if (dashboard->start(dashPort, dashLan, dashToken)) {
            const QString host = dashLan ? localIpv4() : QStringLiteral("127.0.0.1");
            const QString scheme = dashboard->isTls() ? QStringLiteral("https")
                                                       : QStringLiteral("http");
            const QString base = QStringLiteral("%1://%2:%3/").arg(scheme, host).arg(dashboard->port());
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
                                     + QStringLiteral("?token=") + dashToken;
            else
                qInfo().noquote() << QStringLiteral("Nexa dashboard: ") + base
                                     + QStringLiteral("  (token hidden in non-interactive output)");
            if (!dashLan)
                qInfo().noquote() << "  (loopback only; pass --dashboard-lan to reach it from other devices)";
        } else {
            qWarning() << "Nexa dashboard could not start on port" << dashPort;
        }
    }

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

    return app.exec();
}
