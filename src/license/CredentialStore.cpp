#include "license/CredentialStore.h"

#include <QProcess>

#ifdef NEXA_TEST_CREDENTIAL_STORE
#include <QHash>
#elif defined(Q_OS_WIN)
#include <string>
#include <windows.h>
#include <wincred.h>
#endif

namespace nexa::credentialstore {

// Two secrets, one store. They are kept apart deliberately: signing in does not
// invent a licence key, and removing a key does not sign the machine out.
namespace {
constexpr auto kLicenseSlot = "license";
constexpr auto kAccountSlot = "account-token";
}

#ifdef NEXA_TEST_CREDENTIAL_STORE

// Test builds get an in-memory store.
//
// The licence tests drive the real LicenseManager, which stores whatever the
// fake server hands it — so with the platform store compiled in, running the
// suite wrote "NDM-AAAA-BBBB-CCCC" into the developer's actual Windows
// Credential Manager, where the installed copy of Nexa would read it on its
// next launch. A test must not reach outside its own process.
static QHash<QString, QString> &memoryStore()
{
    static QHash<QString, QString> store;
    return store;
}

static QString readSecret(const char *slot) { return memoryStore().value(QString::fromLatin1(slot)); }
static bool writeSecret(const char *slot, const QString &value)
{
    memoryStore().insert(QString::fromLatin1(slot), value);
    return true;
}
static bool removeSecret(const char *slot)
{
    memoryStore().remove(QString::fromLatin1(slot));
    return true;
}

#elif defined(Q_OS_WIN)

static std::wstring credentialName(const char *slot)
{
    const QString name = QStringLiteral("NexaDownloadManager/")
        + (QLatin1String(slot) == QLatin1String(kAccountSlot) ? QStringLiteral("AccountToken")
                                                              : QStringLiteral("LicenseKey"));
    return name.toStdWString();
}

static QString readSecret(const char *slot)
{
    const std::wstring name = credentialName(slot);
    PCREDENTIALW credential = nullptr;
    if (!CredReadW(name.c_str(), CRED_TYPE_GENERIC, 0, &credential))
        return QString();
    const QString value = QString::fromUtf16(
        reinterpret_cast<const char16_t *>(credential->CredentialBlob),
        int(credential->CredentialBlobSize / sizeof(char16_t)));
    CredFree(credential);
    return value;
}

static bool writeSecret(const char *slot, const QString &value)
{
    std::wstring name = credentialName(slot);
    CREDENTIALW credential{};
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = name.data();
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
    credential.UserName = const_cast<wchar_t *>(L"Nexa");
    credential.CredentialBlobSize = DWORD(value.size() * sizeof(char16_t));
    credential.CredentialBlob = reinterpret_cast<LPBYTE>(const_cast<ushort *>(value.utf16()));
    return CredWriteW(&credential, 0);
}

static bool removeSecret(const char *slot)
{
    const std::wstring name = credentialName(slot);
    return CredDeleteW(name.c_str(), CRED_TYPE_GENERIC, 0) || GetLastError() == ERROR_NOT_FOUND;
}

#elif defined(Q_OS_LINUX)

// `account` is the attribute the two secrets differ by, so they are separate
// items in the same collection rather than one overwriting the other.
static const char kScript[] = R"PY(
import secretstorage, sys
bus = secretstorage.dbus_init()
collection = secretstorage.get_default_collection(bus)
if collection.is_locked():
    collection.unlock()
op, slot = sys.argv[1], sys.argv[2]
attrs = {'application': 'NexaDownloadManager', 'account': slot}
label = 'Nexa Download Manager ' + ('account token' if slot == 'account-token' else 'license')
items = list(collection.search_items(attrs))
if op == 'get':
    if items:
        sys.stdout.buffer.write(items[0].get_secret())
elif op == 'set':
    secret = sys.stdin.buffer.read()
    collection.create_item(label, attrs, secret, replace=True)
elif op == 'delete':
    for item in items:
        item.delete()
)PY";

static bool run(const QString &operation, const char *slot, const QByteArray &input,
                QByteArray *output)
{
    QProcess process;
    process.start(QStringLiteral("python3"),
                  {QStringLiteral("-c"), QString::fromUtf8(kScript), operation,
                   QString::fromLatin1(slot)});
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

static QString readSecret(const char *slot)
{
    QByteArray output;
    return run(QStringLiteral("get"), slot, {}, &output) ? QString::fromUtf8(output).trimmed()
                                                         : QString();
}

static bool writeSecret(const char *slot, const QString &value)
{
    return run(QStringLiteral("set"), slot, value.toUtf8(), nullptr);
}

static bool removeSecret(const char *slot)
{
    return run(QStringLiteral("delete"), slot, {}, nullptr);
}

#else

static QString readSecret(const char *) { return QString(); }
static bool writeSecret(const char *, const QString &) { return false; }
static bool removeSecret(const char *) { return true; }

#endif

QString readLicenseKey() { return readSecret(kLicenseSlot); }
bool writeLicenseKey(const QString &key) { return writeSecret(kLicenseSlot, key); }
bool removeLicenseKey() { return removeSecret(kLicenseSlot); }

QString readAccountToken() { return readSecret(kAccountSlot); }
bool writeAccountToken(const QString &token) { return writeSecret(kAccountSlot, token); }
bool removeAccountToken() { return removeSecret(kAccountSlot); }

} // namespace nexa::credentialstore
