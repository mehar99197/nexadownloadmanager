#include "core/VirusScanner.h"
#include "core/ExternalTools.h"

#include <QFileInfo>
#include <QProcess>
#include <QRegularExpression>
#include <QSettings>
#include <QTimer>

namespace nexa {

namespace {
constexpr auto kEnabled = "security/virusScan";
constexpr auto kCommand = "security/virusScanCommand";
constexpr int  kTimeoutMs = 120000;   // a big archive can take a while
} // namespace

VirusScanner::VirusScanner(QObject *parent) : QObject(parent) {}

QString VirusScanner::defaultCommandTemplate()
{
#if defined(Q_OS_WIN)
    // Defender ships with Windows; -Scan -ScanType 3 scans a single path.
    return QStringLiteral("\"%ProgramFiles%\\Windows Defender\\MpCmdRun.exe\" "
                          "-Scan -ScanType 3 -File %1 -DisableRemediation");
#elif defined(Q_OS_MACOS)
    return QStringLiteral("clamscan --no-summary %1");
#else
    return QStringLiteral("clamscan --no-summary %1");
#endif
}

QString VirusScanner::commandTemplate()
{
    const QString custom = QSettings().value(QLatin1String(kCommand)).toString().trimmed();
    return custom.isEmpty() ? defaultCommandTemplate() : custom;
}

QStringList VirusScanner::splitCommand(const QString &tmpl, const QString &filePath)
{
    // Split on spaces but keep "quoted segments" together, then substitute %1
    // AFTER splitting so a path containing spaces stays a single argument.
    static const QRegularExpression re(QStringLiteral("\"([^\"]*)\"|(\\S+)"));
    QStringList parts;
    auto it = re.globalMatch(tmpl);
    while (it.hasNext()) {
        const auto m = it.next();
        QString token = m.captured(1).isNull() ? m.captured(2) : m.captured(1);
        token.replace(QStringLiteral("%1"), filePath);
        parts << token;
    }
    return parts;
}

bool VirusScanner::scannerAvailable()
{
    const QStringList parts = splitCommand(commandTemplate(), QStringLiteral("x"));
    if (parts.isEmpty())
        return false;
    const QString program = parts.first();
    if (QFileInfo(program).isAbsolute() || program.contains(QLatin1Char('/'))
        || program.contains(QLatin1Char('\\')))
        return QFileInfo::exists(QString(program).replace(QStringLiteral("%ProgramFiles%"),
                                                          qEnvironmentVariable("ProgramFiles")));
    return !resolveTool(program).isEmpty();
}

bool VirusScanner::enabled()
{
    return QSettings().value(QLatin1String(kEnabled), false).toBool();
}

void VirusScanner::scan(int downloadId, const QString &filePath)
{
    if (!QFileInfo::exists(filePath)) {
        emit unavailable(downloadId, filePath, QStringLiteral("the file is gone"));
        return;
    }
    QStringList parts = splitCommand(commandTemplate(), filePath);
    if (parts.isEmpty()) {
        emit unavailable(downloadId, filePath, QStringLiteral("no scan command configured"));
        return;
    }
    QString program = parts.takeFirst();
    program.replace(QStringLiteral("%ProgramFiles%"), qEnvironmentVariable("ProgramFiles"));
    if (!QFileInfo(program).isAbsolute()) {
        const QString resolved = resolveTool(program);
        if (resolved.isEmpty()) {
            emit unavailable(downloadId, filePath,
                             QStringLiteral("%1 is not installed").arg(program));
            return;
        }
        program = resolved;
    }

    auto *proc = new QProcess(this);
    proc->setProcessChannelMode(QProcess::MergedChannels);
    // Everything below is async: a 2 GB archive scan must never block the UI.
    connect(proc, &QProcess::finished, this,
            [this, proc, downloadId, filePath](int code, QProcess::ExitStatus status) {
        const QString output = QString::fromLocal8Bit(proc->readAll()).trimmed();
        proc->deleteLater();
        if (status != QProcess::NormalExit) {
            emit unavailable(downloadId, filePath, QStringLiteral("the scanner stopped unexpectedly"));
            return;
        }
        if (code == 0) {
            emit clean(downloadId, filePath);
            return;
        }
        // clamscan: 1 = found, 2 = error. Defender: non-zero = threat/failure.
        const QString detail = output.isEmpty()
            ? QStringLiteral("the scanner reported a problem (exit code %1)").arg(code)
            : output.left(400);
        if (code == 2)
            emit unavailable(downloadId, filePath, detail);
        else
            emit infected(downloadId, filePath, detail);
    });
    connect(proc, &QProcess::errorOccurred, this,
            [this, proc, downloadId, filePath](QProcess::ProcessError) {
        const QString why = proc->errorString();
        proc->deleteLater();
        emit unavailable(downloadId, filePath, why);
    });
    proc->start(program, parts);
    QTimer::singleShot(kTimeoutMs, proc, [proc]() {
        if (proc->state() != QProcess::NotRunning)
            proc->kill();
    });
}

} // namespace nexa
