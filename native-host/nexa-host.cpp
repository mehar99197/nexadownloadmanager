// nexa-host — native messaging bridge between the browser extension and the
// Nexa engine. Reads ONE framed-JSON message from stdin, relays it to the
// running engine over a local socket (launching the engine if needed), then
// writes the engine's reply back to the extension as framed JSON.
//
// Framing (both directions): [4-byte little-endian uint32 length][UTF-8 JSON].

#include <QCoreApplication>
#include <QLocalSocket>
#include <QByteArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProcess>
#include <QThread>
#include <QFileInfo>
#include <QDir>

#include <cstdio>
#include <cstdint>

#ifdef _WIN32
#  include <io.h>
#  include <fcntl.h>
#endif

namespace {

constexpr char kIpcName[] = "nexa-ipc";

// Read exactly n bytes from stdin (blocking). Returns false on EOF/error.
bool readExact(char *buf, size_t n)
{
    size_t got = 0;
    while (got < n) {
        size_t r = std::fread(buf + got, 1, n - got, stdin);
        if (r == 0)
            return false;
        got += r;
    }
    return true;
}

// Read one framed message from the browser.
bool readMessage(QByteArray &out)
{
    unsigned char lenBuf[4];
    if (!readExact(reinterpret_cast<char*>(lenBuf), 4))
        return false;
    const uint32_t len = uint32_t(lenBuf[0]) | (uint32_t(lenBuf[1]) << 8) |
                         (uint32_t(lenBuf[2]) << 16) | (uint32_t(lenBuf[3]) << 24);
    if (len == 0 || len > (64u * 1024u * 1024u))   // sanity cap: 64 MB
        return false;
    out.resize(int(len));
    return readExact(out.data(), len);
}

// Write one framed message back to the browser.
void writeMessage(const QByteArray &json)
{
    const uint32_t len = uint32_t(json.size());
    unsigned char lenBuf[4] = {
        (unsigned char)(len & 0xFF), (unsigned char)((len >> 8) & 0xFF),
        (unsigned char)((len >> 16) & 0xFF), (unsigned char)((len >> 24) & 0xFF)
    };
    std::fwrite(lenBuf, 1, 4, stdout);
    std::fwrite(json.constData(), 1, json.size(), stdout);
    std::fflush(stdout);
}

void reply(bool ok, const QString &message, int id = -1)
{
    QJsonObject o;
    o["ok"] = ok;
    if (id >= 0) o["id"] = id;
    if (!message.isEmpty()) o["message"] = message;
    writeMessage(QJsonDocument(o).toJson(QJsonDocument::Compact));
}

// Try to send the payload to a running engine; returns the reply bytes or empty.
QByteArray relayToEngine(const QByteArray &payload, bool *connected)
{
    QLocalSocket sock;
    sock.connectToServer(QString::fromLatin1(kIpcName));
    *connected = sock.waitForConnected(300);
    if (!*connected)
        return {};

    // Frame to the engine identically (length-prefixed) for symmetry.
    const uint32_t len = uint32_t(payload.size());
    QByteArray framed;
    framed.append(char(len & 0xFF));
    framed.append(char((len >> 8) & 0xFF));
    framed.append(char((len >> 16) & 0xFF));
    framed.append(char((len >> 24) & 0xFF));
    framed.append(payload);
    sock.write(framed);
    sock.flush();
    sock.waitForBytesWritten(500);

    if (!sock.waitForReadyRead(2000))
        return {};
    return sock.readAll();
}

// Best-effort: launch the engine binary (assumed to sit next to this host).
void launchEngine()
{
    const QString dir = QCoreApplication::applicationDirPath();
#ifdef _WIN32
    const QString exe = dir + "/nexa.exe";
#else
    const QString exe = dir + "/nexa";
#endif
    if (QFileInfo::exists(exe))
        QProcess::startDetached(exe, {QStringLiteral("--background")});
}

} // namespace

int main(int argc, char *argv[])
{
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    QCoreApplication app(argc, argv);

    QByteArray msg;
    if (!readMessage(msg)) {
        reply(false, QStringLiteral("no message"));
        return 1;
    }

    const QJsonDocument doc = QJsonDocument::fromJson(msg);
    if (!doc.isObject()) {
        reply(false, QStringLiteral("malformed JSON"));
        return 1;
    }

    bool connected = false;
    QByteArray engineReply = relayToEngine(msg, &connected);

    if (!connected) {
        launchEngine();
        // Give the engine a moment to bind its local server, then retry once.
        for (int i = 0; i < 20 && !connected; ++i) {
            QThread::msleep(150);
            engineReply = relayToEngine(msg, &connected);
        }
    }

    if (!connected) {
        reply(false, QStringLiteral("engine unavailable"));
        return 1;
    }

    // The engine already replies in framed JSON; strip the 4-byte length and
    // forward the JSON body to the browser.
    if (engineReply.size() > 4)
        writeMessage(engineReply.mid(4));
    else
        reply(true, QStringLiteral("queued"));

    return 0;
}
