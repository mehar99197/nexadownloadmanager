#include <QApplication>
#include "core/DownloadEngine.h"
#include "core/DownloadTask.h"
#include "core/Types.h"
#include "ipc/IpcServer.h"
#include "ui/MainWindow.h"

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
        // In batch mode, exit as soon as all downloads finish or error out.
        auto checkDone = [&engine]() {
            const auto all = engine.tasks();
            if (all.isEmpty())
                return;
            for (auto *t : all) {
                if (t->state() != nexa::DownloadState::Completed &&
                    t->state() != nexa::DownloadState::Error)
                    return;
            }
            QCoreApplication::quit();
        };
        QObject::connect(&engine, &nexa::DownloadEngine::taskFinished,
                         &app, [checkDone](int) { checkDone(); });
        QObject::connect(&engine, &nexa::DownloadEngine::taskStateChanged,
                         &app, [checkDone](int, nexa::DownloadState, const QString &) { checkDone(); });
    }

    for (int i = 1; i < args.size(); ++i) {
        const QString arg = args.at(i);
        if (arg == QStringLiteral("--resume-all")) {
            engine.resumeUnfinished();   // continue downloads interrupted last run
            continue;
        }
        if (arg == QStringLiteral("--background") || arg == QStringLiteral("--batch"))
            continue;                    // flags, not URLs
        const QUrl u = QUrl::fromUserInput(arg);
        if (u.isValid() && !u.scheme().isEmpty())
            engine.addDownload(u);
    }

    return app.exec();
}
