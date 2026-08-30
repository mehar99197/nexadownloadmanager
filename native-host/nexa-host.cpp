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
#include <QElapsedTimer>

#include "ipc/IpcProtocol.h"

#include <cstdio>
#ifndef _WIN32
#include <unistd.h>   // geteuid for the engine-binary ownership check
#endif
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
    if (len == 0 || len > nexa::kMaxIpcFrameBytes)
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

bool socketReadExact(QLocalSocket &socket, QByteArray &out, qsizetype size, int timeoutMs)
{
    QElapsedTimer timer;
    timer.start();
    out.clear();
    out.reserve(size);
    while (out.size() < size) {
        if (socket.bytesAvailable() <= 0) {
            const int remaining = qMax(0, timeoutMs - int(timer.elapsed()));
            if (remaining == 0 || !socket.waitForReadyRead(remaining))
                return false;
        }
        const QByteArray chunk = socket.read(size - out.size());
        if (chunk.isEmpty())
            return false;
        out.append(chunk);
    }
    return true;
}

bool readEngineFrame(QLocalSocket &socket, QByteArray &body, int timeoutMs)
{
    QElapsedTimer timer;
    timer.start();
    QByteArray header;
    if (!socketReadExact(socket, header, 4, timeoutMs))
        return false;
    const auto *bytes = reinterpret_cast<const unsigned char *>(header.constData());
    const quint32 length = quint32(bytes[0]) | (quint32(bytes[1]) << 8) |
                           (quint32(bytes[2]) << 16) | (quint32(bytes[3]) << 24);
    if (length == 0 || length > nexa::kMaxIpcFrameBytes)
        return false;
    const int remaining = qMax(0, timeoutMs - int(timer.elapsed()));
    return remaining > 0 && socketReadExact(socket, body, length, remaining);
}

// Try to send the payload to a running engine and collect one complete frame.
QByteArray relayToEngine(const QByteArray &payload, bool *connected, bool *validReply)
{
    *validReply = false;
    QLocalSocket sock;
    sock.connectToServer(QString::fromLatin1(kIpcName));
    // Tolerate a busy/just-binding engine: the old 300ms budget made the host
    // give up and launch a *second* engine on any momentary delay. 1.5s is still
    // imperceptible in the common (engine-up) case.
    *connected = sock.waitForConnected(1500);
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

    // Most replies are instant, but a "list-formats" request runs yt-dlp -J,
    // which is network-bound and can take several seconds.
    QByteArray body;
    if (!readEngineFrame(sock, body, 25000))
        return {};
    if (!QJsonDocument::fromJson(body).isObject())
        return {};
    *validReply = true;
    return body;
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
    const QFileInfo fi(exe);
    if (!fi.exists())
        return;
#ifndef _WIN32
    // Packaged Linux binaries are normally root-owned, while developer builds
    // are owned by the browser user and may be group-writable due to the
    // workspace umask. Trust only the current user or root. Enforce the
    // non-writable check for root-owned binaries so an untrusted user cannot
    // replace what the host launches; the current user already owns their dev
    // build and is the account that invokes this native host. Symlinks are
    // rejected to avoid a simple link-swap attack.
    if (!fi.isFile() || fi.isSymLink() || !fi.isExecutable())
        return;
    if (fi.ownerId() != ::geteuid() && fi.ownerId() != 0)
        return;
    if (fi.ownerId() == 0 && fi.permissions() & (QFileDevice::WriteGroup | QFileDevice::WriteOther))
        return;
#endif
    if (!QProcess::startDetached(exe, {QStringLiteral("--background")}))
        std::fprintf(stderr, "nexa-host: could not start the Nexa engine\n");
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
    bool validReply = false;
    QByteArray engineReply = relayToEngine(msg, &connected, &validReply);

    if (!connected) {
        launchEngine();
        // Give a cold engine time to start Qt + bind its local server before
        // giving up (~6s). The single-instance guard means a duplicate launch
        // here exits harmlessly, but the longer wait avoids it in the first place.
        for (int i = 0; i < 40 && !connected; ++i) {
            QThread::msleep(150);
            engineReply = relayToEngine(msg, &connected, &validReply);
        }
    }

    if (!connected) {
        reply(false, QStringLiteral("engine unavailable"));
        return 1;
    }

    if (!validReply) {
        reply(false, QStringLiteral("invalid or incomplete engine reply"));
        return 1;
    }
    writeMessage(engineReply);

    return 0;
}
