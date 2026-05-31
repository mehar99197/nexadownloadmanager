#include <QApplication>
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
        if (arg.startsWith(QStringLiteral("--")))
            continue;                    // flags handled above, not URLs
        // addBatch expands numeric ranges like file[1-20].jpg and queues them.
        engine.addBatch(arg);
    }

    return app.exec();
}
