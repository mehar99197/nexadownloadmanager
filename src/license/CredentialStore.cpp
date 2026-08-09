#include "license/CredentialStore.h"

#include <QProcess>

#ifdef Q_OS_WIN
#include <windows.h>
#include <wincred.h>
#endif

namespace nexa::credentialstore {

#ifdef Q_OS_WIN

static const wchar_t kCredentialName[] = L"NexaDownloadManager/LicenseKey";

QString readLicenseKey()
{
    PCREDENTIALW credential = nullptr;
    if (!CredReadW(kCredentialName, CRED_TYPE_GENERIC, 0, &credential))
        return QString();
    const QString key = QString::fromUtf16(
        reinterpret_cast<const char16_t *>(credential->CredentialBlob),
        int(credential->CredentialBlobSize / sizeof(char16_t)));
    CredFree(credential);
    return key;
}

bool writeLicenseKey(const QString &key)
{
    CREDENTIALW credential{};
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = const_cast<wchar_t *>(kCredentialName);
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
    credential.UserName = const_cast<wchar_t *>(L"Nexa");
    credential.CredentialBlobSize = DWORD(key.size() * sizeof(char16_t));
    credential.CredentialBlob = reinterpret_cast<LPBYTE>(const_cast<char16_t *>(key.utf16()));
    return CredWriteW(&credential, 0);
}

bool removeLicenseKey()
{
    return CredDeleteW(kCredentialName, CRED_TYPE_GENERIC, 0) || GetLastError() == ERROR_NOT_FOUND;
}

#elif defined(Q_OS_LINUX)

static const char kScript[] = R"PY(
import secretstorage, sys
bus = secretstorage.dbus_init()
collection = secretstorage.get_default_collection(bus)
if collection.is_locked():
    collection.unlock()
attrs = {'application': 'NexaDownloadManager', 'account': 'license'}
op = sys.argv[1]
items = list(collection.search_items(attrs))
if op == 'get':
    if items:
        sys.stdout.buffer.write(items[0].get_secret())
elif op == 'set':
    secret = sys.stdin.buffer.read()
    collection.create_item('Nexa Download Manager license', attrs, secret, replace=True)
elif op == 'delete':
    for item in items:
        item.delete()
)PY";

static bool run(const QString &operation, const QByteArray &input, QByteArray *output)
{
    QProcess process;
    process.start(QStringLiteral("python3"),
                  {QStringLiteral("-c"), QString::fromUtf8(kScript), operation});
    if (!process.waitForStarted(2000))
        return false;
    if (!input.isEmpty())
        process.write(input);
    process.closeWriteChannel();
    if (!process.waitForFinished(5000) || process.exitStatus() != QProcess::NormalExit ||
        process.exitCode() != 0)
        return false;
    if (output)
        *output = process.readAllStandardOutput();
    return true;
}

QString readLicenseKey()
{
    QByteArray output;
    return run(QStringLiteral("get"), {}, &output) ? QString::fromUtf8(output).trimmed()
                                                    : QString();
}

bool writeLicenseKey(const QString &key)
{
    return run(QStringLiteral("set"), key.toUtf8(), nullptr);
}

bool removeLicenseKey()
{
    return run(QStringLiteral("delete"), {}, nullptr);
}

#else

QString readLicenseKey() { return QString(); }
bool writeLicenseKey(const QString &) { return false; }
bool removeLicenseKey() { return true; }

#endif

} // namespace nexa::credentialstore