#include <QApplication>
#include <QIcon>
#include "core/DownloadEngine.h"
#include "core/DownloadTask.h"
#include "core/Types.h"
#include "ipc/IpcServer.h"
#include "web/WebServer.h"
#include "ui/MainWindow.h"
#include "ui/SettingsDialog.h"

#include "core/Logging.h"

#include <QHostInfo>
#include <QNetworkInterface>
#include <QUuid>
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
    QApplication::setWindowIcon(QIcon(QStringLiteral(":/nexa.png")));

    // Install the opt-in troubleshooting log sink (after org/app name so QSettings
    // resolves correctly). No-op unless the user enabled it in Settings.
    nexa::installLogging();

    // Modern dark theme — deep navy canvas with a soft glow, accent-tinted
    // controls, and color-coded rows. Mirrors the redesigned mockup.
    app.setStyleSheet(QStringLiteral(R"(
        /* ===== Flat dark dashboard ===== */
        QWidget { background: #1a1a1a; color: #cccccc; font-size: 13px; }
        QLabel { background: transparent; }
        #Root { background: #1a1a1a; }

        /* ---- Header bar ---- */
        #HeaderBar { background: #111111; border-bottom: 1px solid #2a2a2a; }
        #BrandLogo { background: #ffffff; color: #000000; border-radius: 6px;
                     font-size: 16px; font-weight: 700; }
        #BrandTitle { color: #ffffff; font-size: 14px; font-weight: 500; }
        #Breadcrumb { color: #666666; font-size: 13px; }
        #IconBtn { background: transparent; color: #888888; border: 1px solid #2a2a2a;
                   border-radius: 6px; padding: 6px 9px; font-size: 14px; min-width: 16px; }
        #IconBtn:hover { background: #222222; color: #ffffff; border-color: #3a3a3a; }
        #Primary { background: #0d6efd; color: #ffffff; border: 0; border-radius: 6px;
                   padding: 7px 14px; font-size: 12px; font-weight: 500; }
        #Primary:hover { background: #2b7dfd; }
        #Primary:pressed { background: #0b5ed7; }
        /* Header "New Download" — dark, outlined (matches the mock). */
        #NewDl { background: #1f1f1f; color: #ffffff; border: 1px solid #333333;
                 border-radius: 6px; padding: 7px 14px; font-size: 12px; font-weight: 500; }
        #NewDl:hover { background: #2a2a2a; border-color: #3a3a3a; }
        #NewDl:pressed { background: #161616; }

        /* ---- Metrics bar ---- */
        #MetricsBar { background: #161616; border-bottom: 1px solid #2a2a2a; }
        #Metric { background: transparent; border-left: 1px solid #222222; }
        #MetricFirst { background: transparent; }
        #MetricLabel { color: #555555; font-size: 10px; font-weight: 500; }
        #MetricValue { color: #ffffff; font-size: 22px; font-weight: 600; }
        #MetricSub { color: #444444; font-size: 11px; }
        #MetricSub[good="true"] { color: #22c55e; }

        /* ---- Toolbar ---- */
        #Toolbar { background: #111111; border-bottom: 1px solid #2a2a2a; }
        #Ghost { background: transparent; color: #666666; border: 1px solid #2a2a2a;
                 border-radius: 6px; padding: 6px 13px; font-size: 12px; font-weight: 500; }
        #Ghost:hover { background: #222222; color: #ffffff; }
        QLineEdit#Search { background: #262626; border: 1px solid #2f2f2f; border-radius: 6px;
                    padding: 6px 10px 6px 28px; color: #ffffff;
                    selection-background-color: #0d6efd; }
        QLineEdit#Search:focus { border-color: #0d6efd; background: #1f1f1f; }

        /* ---- Generic controls (dialogs) ---- */
        QPushButton { background: #1f1f1f; color: #cccccc; border: 1px solid #2a2a2a;
                      border-radius: 6px; padding: 7px 14px; font-weight: 500; }
        QPushButton:hover { background: #2a2a2a; color: #ffffff; }
        QPushButton:pressed { background: #161616; }
        QPushButton#Primary { background: #0d6efd; color: #ffffff; border: 0; }
        QPushButton#Primary:hover { background: #2b7dfd; }
        QLineEdit { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 6px;
                    padding: 7px 10px; color: #ffffff; selection-background-color: #0d6efd; }
        QLineEdit:focus { border-color: #0d6efd; }

        /* ---- Per-row icon-action buttons ---- */
        QPushButton[ActIcon="true"] { background: transparent; color: #555555;
                      border: 1px solid #2a2a2a; border-radius: 4px; padding: 0; font-size: 11px; }
        QPushButton[ActIcon="true"]:hover { background: #222222; color: #ffffff; border-color: #3a3a3a; }

        /* ---- Download list ---- */
        QLabel#f_name { color: #ffffff; font-weight: 500; font-size: 13px; }
        QLabel#f_host { color: #444444; font-size: 10px; }
        QLabel#p_pct  { color: #555555; font-size: 11px; }

        QTableWidget { background: transparent; border: 0; outline: 0; }
        QTableWidget::item { border: 0; border-bottom: 1px solid #1f1f1f; padding: 0; }
        QTableWidget::item:hover { background: #1e1e1e; }
        /* Active/selected row: blue-tinted band with a blue top+bottom rule. */
        QTableWidget::item:selected { background: #141420; color: #ffffff;
                    border-top: 1px solid #1e3a5f; border-bottom: 1px solid #1e3a5f; }
        QHeaderView::section { background: #1a1a1a; color: #444444; padding: 8px 10px;
                       border: 0; border-bottom: 1px solid #222222;
                       font-size: 10px; font-weight: 600; }

        QProgressBar { background: #222222; border: 0; border-radius: 2px; }
        QProgressBar::chunk { background: #0d6efd; border-radius: 2px; }

        /* ---- Status badges (colour via the "st" property) ---- */
        QLabel#s_badge { font-size: 10px; font-weight: 700; border-radius: 4px;
                         padding: 3px 8px; }
        QLabel#s_badge[st="active"] { background: #0d1a2e; color: #60a5fa; border: 1px solid #1e3a5f; }
        QLabel#s_badge[st="paused"] { background: #1a1200; color: #fbbf24; border: 1px solid #3a2800; }
        QLabel#s_badge[st="done"]   { background: #0a1a0a; color: #4ade80; border: 1px solid #1a3a1a; }
        QLabel#s_badge[st="queued"] { background: #1a1a1a; color: #666666; border: 1px solid #2a2a2a; }
        QLabel#s_badge[st="error"]  { background: #1a0a0a; color: #f87171; border: 1px solid #3a1a1a; }

        /* ---- Empty state ---- */
        #EmptyTitle { color: #cccccc; font-size: 16px; font-weight: 600; }
        #EmptyHint  { color: #555555; font-size: 12px; }

        /* ---- Footer ---- */
        QStatusBar { background: #111111; border-top: 1px solid #1a1a1a; }
        QStatusBar::item { border: 0; }
        #FootStat { color: #555555; font-size: 11px; }
        #FootVer  { color: #333333; font-size: 11px; }

        /* ---- Scrollbars / menus / tooltips ---- */
        QScrollBar:vertical { background: transparent; width: 10px; margin: 2px; }
        QScrollBar::handle:vertical { background: #2a2a2a; border-radius: 5px; min-height: 30px; }
        QScrollBar::handle:vertical:hover { background: #3a3a3a; }
        QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
        QMenu { background: #161616; color: #cccccc; border: 1px solid #2a2a2a;
                border-radius: 6px; padding: 5px; }
        QMenu::item { padding: 6px 16px; border-radius: 4px; }
        QMenu::item:selected { background: #222222; color: #ffffff; }
        QMenu::separator { height: 1px; background: #2a2a2a; margin: 4px 8px; }
        QToolTip { background: #161616; color: #cccccc; border: 1px solid #2a2a2a; padding: 4px 8px; }

        /* ---- Dialogs (details plate / settings) ---- */
        QDialog { background: #1a1a1a; }
        #Plate { background: #161616; border: 1px solid #2a2a2a; border-radius: 6px; }
        #Dd_title { color: #ffffff; font-size: 15px; font-weight: 600; }
        #Dd_host  { color: #666666; font-size: 11px; }
        #Dd_seclabel { color: #666666; font-size: 11px; }
        #Dd_barpct { color: #555555; font-size: 11px; }
        QLabel[ddRole="label"] { color: #888888; font-size: 11px; }
        QLabel[ddRole="value"] { color: #ffffff; font-size: 13px; }
        #DdCancel { background: #1a0a0a; color: #f87171; border: 1px solid #3a1a1a; }
        #DdCancel:hover { background: #2a1010; }
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
    engine.loadPersisted();        // restore unfinished downloads from last run

    // Listen for downloads handed off by the browser extension via nexa-host.
    nexa::IpcServer ipc(&engine);
    if (!ipc.start()) {
        // Another instance grabbed the socket between our probe and now — exit
        // rather than running a windowless, socket-less duplicate.
        return 0;
    }

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
            qInfo().noquote() << QStringLiteral("Nexa dashboard: %1://%2:%3/?token=%4")
                                     .arg(scheme, host).arg(dashboard->port()).arg(dashToken);
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
