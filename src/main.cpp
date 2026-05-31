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

    // Modern dark theme, shared palette with the web dashboard.
    app.setStyleSheet(QStringLiteral(R"(
        QWidget { background: #0f172a; color: #e2e8f0; font-size: 13px; }
        #HeaderBar { background: #1e293b; border-bottom: 1px solid #334155; }
        #BrandTitle { font-size: 16px; font-weight: 600; color: #f8fafc; }
        #Stats { color: #94a3b8; }
        #ActionBar { background: #0b1220; border-bottom: 1px solid #1e293b; }
        QPushButton { background: #1e293b; color: #e2e8f0; border: 1px solid #334155;
                      border-radius: 8px; padding: 7px 14px; font-weight: 600; }
        QPushButton:hover { background: #334155; }
        QPushButton:pressed { background: #0b1220; }
        QPushButton#Primary { background: #3b82f6; border: 0; color: white; }
        QPushButton#Primary:hover { background: #2563eb; }
        QTableWidget { background: #0f172a; border: 0; outline: 0;
                       alternate-background-color: #131f37;
                       selection-background-color: #1d4ed8; selection-color: white; }
        QTableWidget::item { padding: 4px 10px; border: 0; }
        QHeaderView::section { background: #1e293b; color: #94a3b8; padding: 8px 10px;
                       border: 0; border-bottom: 1px solid #334155; font-weight: 600; }
        QProgressBar { background: #1e293b; border: 0; border-radius: 6px;
                       text-align: center; color: #e2e8f0; }
        QProgressBar::chunk { background: #3b82f6; border-radius: 6px; }
        QStatusBar { background: #1e293b; border-top: 1px solid #334155; }
        QStatusBar QLabel, QStatusBar { color: #94a3b8; }
        QStatusBar::item { border: 0; }
        QScrollBar:vertical { background: #0f172a; width: 11px; margin: 0; }
        QScrollBar::handle:vertical { background: #334155; border-radius: 5px; min-height: 28px; }
        QScrollBar::handle:vertical:hover { background: #475569; }
        QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
        QLineEdit { background: #0b1220; border: 1px solid #334155; border-radius: 6px;
                    padding: 7px; color: #e2e8f0; selection-background-color: #3b82f6; }
        QToolTip { background: #1e293b; color: #e2e8f0; border: 1px solid #334155; }
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
