#include <QApplication>
#include <QIcon>
#include "core/DownloadEngine.h"
#include "core/DownloadTask.h"
#include "core/Types.h"
#include "ipc/IpcServer.h"
#include "web/WebServer.h"
#include "ui/MainWindow.h"

#include <QHostInfo>
#include <QNetworkInterface>
#include <QUuid>

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
    QApplication app(argc, argv);
    QApplication::setApplicationName(QStringLiteral("Nexa"));
    QApplication::setOrganizationName(QStringLiteral("Nexa"));
    QApplication::setApplicationVersion(QStringLiteral("0.1.0"));
    QApplication::setWindowIcon(QIcon(QStringLiteral(":/nexa.png")));

    // Modern dark theme — deep navy canvas with a soft glow, accent-tinted
    // controls, and color-coded rows. Mirrors the redesigned mockup.
    app.setStyleSheet(QStringLiteral(R"(
        QWidget { background: #0a0e1a; color: #e6edf3; font-size: 13px; }
        QLabel { background: transparent; }
        #Root { background: qradialgradient(cx:0.5, cy:1.25, radius:1.15,
                    stop:0 #112a2a, stop:0.5 #0a0e1a, stop:1 #0a0e1a); }

        #HeaderBar { background: transparent; }
        #BrandTitle { font-size: 15px; font-weight: 700; color: #f3f6fb; }
        #ActivePill { color: #34d399; border: 1px solid rgba(52,211,153,0.45);
                      background: rgba(52,211,153,0.10); border-radius: 12px;
                      padding: 4px 13px; font-size: 12px; font-weight: 600; }

        #ActionBar { background: transparent; }
        QPushButton { background: #151b2c; color: #cbd5e1; border: 1px solid #232b42;
                      border-radius: 10px; padding: 9px 15px; font-weight: 600; }
        QPushButton:hover { background: #1b2236; border-color: #2d3650; }
        QPushButton:pressed { background: #11162a; }
        QPushButton#Primary { background: rgba(99,102,241,0.16); color: #c7d2fe;
                      border: 1px solid rgba(99,102,241,0.55); }
        QPushButton#Primary:hover { background: rgba(99,102,241,0.26); }
        QPushButton#IconBtn { padding: 9px 12px; font-size: 14px; color: #94a3b8; }

        QLineEdit#Search { background: #0e1424; border: 1px solid #232b42; border-radius: 10px;
                    padding: 8px 13px; color: #e6edf3; selection-background-color: #6366f1; }
        QLineEdit#Search:focus { border-color: #3949ab; }

        QLabel#f_name { color: #e6edf3; font-weight: 600; font-size: 13px; }
        QLabel#f_host { color: #6b7488; font-size: 11px; }
        QLabel#p_pct  { color: #8b94a7; font-size: 11px; }

        QTableWidget { background: transparent; border: 0; outline: 0; }
        QTableWidget::item { border: 0; border-bottom: 1px solid #141b2b; padding: 0; }
        QTableWidget::item:hover { background: rgba(255,255,255,0.02); }
        QTableWidget::item:selected { background: #182040; color: #ffffff; }
        QHeaderView::section { background: transparent; color: #5b6478; padding: 8px 12px;
                       border: 0; border-bottom: 1px solid #1a2233;
                       font-size: 10px; font-weight: 700; }

        QProgressBar { background: #1a2133; border: 0; border-radius: 3px; }
        QProgressBar::chunk { background: #60a5fa; border-radius: 3px; }

        QStatusBar { background: #090c15; border-top: 1px solid #161d2c; }
        QStatusBar::item { border: 0; }

        QScrollBar:vertical { background: transparent; width: 10px; margin: 2px; }
        QScrollBar::handle:vertical { background: #2a3450; border-radius: 5px; min-height: 30px; }
        QScrollBar::handle:vertical:hover { background: #3a466a; }
        QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }

        QMenu { background: #141b2b; color: #e6edf3; border: 1px solid #232b42;
                border-radius: 8px; padding: 6px; }
        QMenu::item { padding: 7px 18px; border-radius: 6px; }
        QMenu::item:selected { background: #1f2740; }
        QToolTip { background: #141b2b; color: #e6edf3; border: 1px solid #232b42; padding: 4px 8px; }

        /* ---- Per-download details plate ---- */
        QDialog { background: #0a0e1a; }
        #Plate { background: #141b2c; border: 1px solid #232b42; border-radius: 14px; }
        #Dd_title { color: #f3f6fb; font-size: 15px; font-weight: 700; }
        #Dd_host  { color: #6b7488; font-size: 11px; }
        #Dd_seclabel { color: #6b7488; font-size: 11px; }
        #Dd_barpct { color: #8b94a7; font-size: 11px; }
        QLabel[ddRole="label"] { color: #8b94a7; font-size: 11px; }
        QLabel[ddRole="value"] { color: #e6edf3; font-size: 13px; }
        #DdCancel { background: rgba(239,68,68,0.14); color: #fda4a4;
                    border: 1px solid rgba(239,68,68,0.50); }
        #DdCancel:hover { background: rgba(239,68,68,0.24); }
    )"));

    qRegisterMetaType<nexa::DownloadState>("nexa::DownloadState");

    nexa::DownloadEngine engine;
    engine.loadPersisted();        // restore unfinished downloads from last run

    // Listen for downloads handed off by the browser extension via nexa-host.
    nexa::IpcServer ipc(&engine);
    ipc.start();

    nexa::MainWindow window(&engine);
    window.show();

    // Command line: nexa [--resume-all] [--batch] <url> [url...]
    //   --batch   quit once every download reaches a terminal state (CLI use)
    const QStringList args = QApplication::arguments();
    const bool batch = args.contains(QStringLiteral("--batch"));

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
            qInfo().noquote() << QStringLiteral("Nexa dashboard: http://%1:%2/?token=%3")
                                     .arg(host).arg(dashboard->port()).arg(dashToken);
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
