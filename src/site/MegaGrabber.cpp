#include "site/MegaGrabber.h"
#include "core/ExternalTools.h"

#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonArray>
#include <QJsonObject>
#include <QNetworkRequest>
#include <QStandardPaths>
#include <QTimer>
#include <QDebug>
#include <QUrlQuery>
#include <algorithm>
#include <cmath>

namespace nexa {

static const bool kDebug = qEnvironmentVariableIsSet("NEXA_DEBUG");

// ---- URL parsing ----------------------------------------------------------

// Decode a MEGA base64url string (A-Z a-z 0-9 - _) into raw bytes.
// MEGA uses its own variant where '-' → '+' and '_' → '/', padded with '='.
QByteArray MegaGrabber::base64UrlDecode(const QString &input)
{
    QString s = input;
    s.replace(QLatin1Char('-'), QLatin1Char('+'));
    s.replace(QLatin1Char('_'), QLatin1Char('/'));
    // Restore padding
    const int pad = 4 - (s.size() % 4);
    if (pad < 4)
        s.append(QString(pad, QLatin1Char('=')));
    return QByteArray::fromBase64(s.toLatin1());
}

// Parse various mega.nz URL shapes into file id + raw key bytes.
//
//   Old: https://mega.nz/#!fileid!base64key
//   New: https://mega.nz/file/fileid#base64key
//   Alt: https://mega.co.nz/...
//
// The key in the URL is 44 base64url chars → 32 raw bytes:
//   bytes 0-15 : AES-128 key for file decryption
//   bytes 16-31: CBC-MAC key for integrity verification
MegaGrabber::MegaFileKey MegaGrabber::parseMegaUrl(const QUrl &url)
{
    MegaFileKey result;
    const QString host = url.host().toLower();
    if (host != QStringLiteral("mega.nz") && host != QStringLiteral("mega.co.nz")
        && !host.endsWith(QLatin1String(".mega.nz")))
        return result;

    const QString frag = url.fragment();
    const QString path = url.path();

    // New format: /file/<id>#<key>
    static const QRegularExpression newRe(QStringLiteral("/file/([A-Za-z0-9_-]+)"));
    const auto newM = newRe.match(path);
    if (newM.hasMatch() && !frag.isEmpty()) {
        result.id = newM.captured(1);
        result.key = base64UrlDecode(frag);
        // The key may include a leading '!' separator or just be the raw key
        if (result.key.isEmpty() && frag.contains(QLatin1Char('!'))) {
            const int ex = frag.indexOf(QLatin1Char('!'));
            result.key = base64UrlDecode(frag.mid(ex + 1));
        }
        result.valid = result.key.size() >= 16;
        return result;
    }

    // Old format: /#!<id>!<key>
    if (frag.startsWith(QLatin1Char('!'))) {
        const QStringList parts = frag.mid(1).split(QLatin1Char('!'), Qt::SkipEmptyParts);
        if (parts.size() >= 2) {
            result.id = parts[0];
            result.key = base64UrlDecode(parts[1]);
            result.valid = result.key.size() >= 16;
        }
    }
    return result;
}

bool MegaGrabber::isMegaUrl(const QUrl &url)
{
    return parseMegaUrl(url).valid;
}

// ---- Lifecycle ------------------------------------------------------------

MegaGrabber::MegaGrabber(int id, const QUrl &url, const QString &saveDir,
                         QNetworkAccessManager *nam, QObject *parent)
    : QObject(parent), m_id(id), m_url(url), m_saveDir(saveDir), m_nam(nam)
{
}

MegaGrabber::~MegaGrabber()
{
    cancel();
}

QString MegaGrabber::fileName() const
{
    return QFileInfo(m_savePath).fileName();
}

void MegaGrabber::start()
{
    if (m_state != DownloadState::Queued)
        return;

    m_fileKey = parseMegaUrl(m_url);
    if (!m_fileKey.valid) {
        setState(DownloadState::Error, QStringLiteral("could not parse mega.nz URL"));
        return;
    }

    m_savePath = chooseSavePath();
    setState(DownloadState::Probing, QStringLiteral("resolving MEGA API endpoint"));

    // Step 1: discover the API endpoint by querying the well-known host.
    QNetworkRequest req(QUrl(QStringLiteral("https://eu.api.mega.co.nz/")));
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::NoLessSafeRedirectPolicy);
    req.setRawHeader("User-Agent", "Nexa/0.1");
    m_apiReply = m_nam->get(req);
    connect(m_apiReply, &QNetworkReply::finished, this, &MegaGrabber::onApiResolved);
}

void MegaGrabber::cancel()
{
    if (m_apiReply) {
        m_apiReply->disconnect(this);
        m_apiReply->abort();
        m_apiReply->deleteLater();
        m_apiReply = nullptr;
    }
    if (m_dlReply) {
        m_dlReply->disconnect(this);
        m_dlReply->abort();
        m_dlReply->deleteLater();
        m_dlReply = nullptr;
    }
    if (m_decryptProc) {
        m_decryptProc->disconnect(this);
        m_decryptProc->kill();
        m_decryptProc->deleteLater();
        m_decryptProc = nullptr;
    }
    if (m_encryptedFile.isOpen())
        m_encryptedFile.close();
    m_encryptedFile.remove();
    setState(DownloadState::Paused, QStringLiteral("cancelled"));
}

// ---- MEGA API -------------------------------------------------------------

void MegaGrabber::onApiResolved()
{
    QNetworkReply *r = m_apiReply;
    m_apiReply = nullptr;
    if (!r)
        return;
    r->deleteLater();

    // The response body IS the API host, e.g. "https://g67.api.mega.co.nz:443"
    const QString body = QString::fromUtf8(r->readAll()).trimmed();
    if (body.isEmpty()) {
        // Fallback: use a default API host
        m_apiHost = QStringLiteral("g.api.mega.co.nz:443");
    } else {
        // Strip protocol prefix if present
        m_apiHost = body;
        if (m_apiHost.startsWith(QLatin1String("https://")))
            m_apiHost = m_apiHost.mid(8);
    }
    startDownload();
}

// ---- Download -------------------------------------------------------------

void MegaGrabber::startDownload()
{
    setState(DownloadState::Probing, QStringLiteral("requesting download URL"));

    // MEGA API request: get download URL for the file node.
    // POST /cs with JSON array payload: [{"a":"g","g":1,"p":"<fileId>"}]
    const QString apiUrl = QStringLiteral("https://%1/cs").arg(m_apiHost);
    QUrl apiQUrl(apiUrl);
    QNetworkRequest req{apiQUrl};
    req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    req.setRawHeader("User-Agent", "Nexa/0.1");

    QJsonArray payload;
    QJsonObject cmd;
    cmd[QStringLiteral("a")] = QStringLiteral("g");     // "get download link"
    cmd[QStringLiteral("g")] = 1;                        // request download URL
    cmd[QStringLiteral("p")] = m_fileKey.id;             // public file handle
    payload.append(cmd);

    const QByteArray data = QJsonDocument(payload).toJson(QJsonDocument::Compact);
    m_apiReply = m_nam->post(req, data);
    connect(m_apiReply, &QNetworkReply::finished, this, [this]() {
        QNetworkReply *r = m_apiReply;
        m_apiReply = nullptr;
        if (!r)
            return;
        r->deleteLater();

        if (r->error() != QNetworkReply::NoError) {
            setState(DownloadState::Error,
                     QStringLiteral("MEGA API error: %1").arg(r->errorString()));
            return;
        }

        const QJsonDocument doc = QJsonDocument::fromJson(r->readAll());
        const QJsonArray arr = doc.array();
        if (arr.isEmpty() || !arr[0].isObject()) {
            setState(DownloadState::Error, QStringLiteral("MEGA API returned unexpected response"));
            return;
        }

        const QJsonObject obj = arr[0].toObject();
        const QString dlUrl = obj.value(QStringLiteral("g")).toString();
        const qint64 size = qint64(obj.value(QStringLiteral("s")).toDouble());

        if (dlUrl.isEmpty()) {
            setState(DownloadState::Error, QStringLiteral("MEGA could not provide a download URL"));
            return;
        }

        m_totalBytes = size;

        // Download the encrypted file to a temp location.
        const QString tmpDir = QStandardPaths::writableLocation(QStandardPaths::TempLocation);
        QDir().mkpath(tmpDir);
        const QString tmpPath = QStringLiteral("%1/nexa-mega-%2.enc").arg(tmpDir).arg(m_id);
        m_encryptedFile.setFileName(tmpPath);
        if (!m_encryptedFile.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
            setState(DownloadState::Error, QStringLiteral("cannot create temp file for MEGA download"));
            return;
        }

        setState(DownloadState::Downloading, QStringLiteral("downloading from MEGA CDN"));
        m_clock.start();

        QUrl dlQUrl(dlUrl);
        QNetworkRequest dlReq{dlQUrl};
        dlReq.setRawHeader("User-Agent", "Nexa/0.1");
        m_dlReply = m_nam->get(dlReq);
        connect(m_dlReply, &QNetworkReply::readyRead, this, [this]() {
            if (m_dlReply && m_encryptedFile.isOpen()) {
                const QByteArray chunk = m_dlReply->readAll();
                m_encryptedFile.write(chunk);
                m_doneBytes += chunk.size();
                const double speed = m_clock.elapsed() > 0
                    ? double(m_doneBytes) * 1000.0 / double(m_clock.elapsed()) : 0.0;
                emit progress(m_id, m_doneBytes, m_totalBytes, speed);
            }
        });
        connect(m_dlReply, &QNetworkReply::finished, this, &MegaGrabber::onDownloadFinished);
    });
}

void MegaGrabber::onDownloadFinished()
{
    QNetworkReply *r = m_dlReply;
    m_dlReply = nullptr;
    if (!r)
        return;
    r->deleteLater();

    if (m_encryptedFile.isOpen())
        m_encryptedFile.close();

    if (r->error() != QNetworkReply::NoError && r->error() != QNetworkReply::OperationCanceledError) {
        m_encryptedFile.remove();
        setState(DownloadState::Error,
                 QStringLiteral("MEGA download error: %1").arg(r->errorString()));
        return;
    }

    // If the file is tiny and the URL was wrong (e.g. HTML error page from the CDN),
    // the encrypted file is likely garbage — this catches the common "page not found"
    // redirect case.
    if (m_doneBytes < 16) {
        m_encryptedFile.remove();
        setState(DownloadState::Error, QStringLiteral("MEGA download returned empty response"));
        return;
    }
    if (m_totalBytes > 0 && m_doneBytes < m_totalBytes) {
        if (kDebug)
            qDebug().noquote() << "MEGA" << m_id << "partial download rejected"
                               << m_doneBytes << "/" << m_totalBytes;
        m_encryptedFile.close();
        m_encryptedFile.remove();
        setState(DownloadState::Error,
                 QStringLiteral("incomplete MEGA download; refusing to decrypt corrupted data"));
        return;
    }

    emit progress(m_id, m_doneBytes, m_doneBytes, 0.0);
    decryptFile();
}

// ---- Decryption -----------------------------------------------------------
//
// MEGA encrypts files with AES-128 in CBC mode. Each file is split into chunks
// of progressively larger sizes, and each chunk is encrypted separately with an
// IV derived from the chunk index and the file's CBC-MAC key (bytes 16-31 of
// the file key). The openssl CLI handles the per-chunk CBC decryption.
//
// Chunk boundary table (MEGA specification):
//   Chunks 0-7:    128 KiB (0x20000) each
//   Chunks 8-95:   384 KiB (0x60000) each
//   Chunks 96-127: 896 KiB (0xE0000) each
//   Chunks 128+:   1024 KiB (0x100000) each
//   Last chunk:    remainder

namespace {

struct MegaChunk {
    qint64 start;   // byte offset in the encrypted file
    qint64 size;    // size of this chunk
    int    index;
};

static QVector<MegaChunk> megaChunks(qint64 fileSize)
{
    QVector<MegaChunk> chunks;
    static const struct { int count; qint64 size; } kTiers[] = {
        {8,   0x20000},   // 128 KiB
        {88,  0x60000},   // 384 KiB (indices 8-95 inclusive)
        {32,  0xE0000},   // 896 KiB (indices 96-127 inclusive)
    };
    qint64 offset = 0;
    // In MEGA spec indices are 0-based
    int idx = 0;
    for (const auto &tier : kTiers) {
        for (int i = 0; i < tier.count && offset < fileSize; ++i, ++idx) {
            const qint64 sz = qMin(tier.size, fileSize - offset);
            chunks.append({offset, sz, idx});
            offset += sz;
        }
    }
    // Remaining chunks: 1024 KiB each
    static const qint64 kLarge = 0x100000;
    while (offset < fileSize) {
        const qint64 sz = qMin(kLarge, fileSize - offset);
        chunks.append({offset, sz, idx});
        offset += sz;
        ++idx;
    }
    return chunks;
}

} // namespace

void MegaGrabber::decryptFile()
{
    if (m_fileKey.key.size() < 16) {
        m_encryptedFile.remove();
        setState(DownloadState::Error, QStringLiteral("invalid MEGA decryption key"));
        return;
    }

    const QByteArray aesKey = m_fileKey.key.left(16);   // first 16 bytes = AES-128 key
    const QByteArray metaMac = m_fileKey.key.mid(16);   // bytes 16-31 = CBC-MAC key

    const qint64 fileSize = m_encryptedFile.size();
    const QVector<MegaChunk> chunks = megaChunks(fileSize);

    // Derive the nonce from the MetaMac: first 8 bytes XOR last 8 bytes
    // produces the 8-byte nonce used for IV generation.
    QByteArray nonce(8, '\0');
    if (metaMac.size() >= 16) {
        for (int i = 0; i < 8; ++i)
            nonce[i] = metaMac[i] ^ metaMac[i + 8];
    }

    setState(DownloadState::Probing, QStringLiteral("decrypting"));

    // We decrypt chunk-by-chunk using openssl CLI. For efficiency, chain them
    // through a single openssl process with re-init per chunk.
    // Build output path: replace .enc suffix with the real extension.
    QString outPath = m_savePath;
    {
        // Try to determine file extension from MEGA's API (we'd need the
        // encrypted attributes for the real name — for now, try common types
        // or use a generic .bin).
        QFileInfo fi(m_savePath);
        if (fi.suffix().isEmpty())
            outPath = m_savePath + QStringLiteral(".bin");
    }

    QFile outFile(outPath);
    if (!outFile.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        m_encryptedFile.remove();
        setState(DownloadState::Error, QStringLiteral("cannot create output file for decryption"));
        return;
    }

    if (!m_encryptedFile.open(QIODevice::ReadOnly)) {
        outFile.close();
        outFile.remove();
        m_encryptedFile.remove();
        setState(DownloadState::Error, QStringLiteral("cannot re-read encrypted file"));
        return;
    }

    bool decryptOk = true;
    for (const auto &chunk : chunks) {
        if (m_state == DownloadState::Paused || m_state == DownloadState::Error)
            break;

        m_encryptedFile.seek(chunk.start);
        const QByteArray encData = m_encryptedFile.read(chunk.size);
        if (encData.size() != chunk.size) {
            decryptOk = false;
            break;
        }

        // Build IV for this chunk: nonce XOR chunk_index (little-endian 64-bit)
        QByteArray iv(16, '\0');
        const qint64 idxLE = qint64(chunk.index);
        for (int i = 0; i < 8; ++i) {
            const qint64 shift = qint64(i) * 8;
            const unsigned char byteVal = static_cast<unsigned char>((idxLE >> shift) & 0xff);
            iv[i] = nonce[i] ^ static_cast<char>(byteVal);
        }

        // Spawn openssl to decrypt this chunk
        QProcess proc;
        proc.start(QStringLiteral("openssl"),
                   {QStringLiteral("enc"), QStringLiteral("-d"),
                    QStringLiteral("-aes-128-cbc"),
                    QStringLiteral("-K"), QString::fromLatin1(aesKey.toHex()),
                    QStringLiteral("-iv"), QString::fromLatin1(iv.toHex()),
                    QStringLiteral("-nopad"), QStringLiteral("-nosalt")});

        if (!proc.waitForStarted(5000)) {
            decryptOk = false;
            break;
        }

        proc.write(encData);
        proc.closeWriteChannel();

        if (!proc.waitForFinished(30000)) {
            decryptOk = false;
            proc.kill();
            break;
        }

        const QByteArray decData = proc.readAllStandardOutput();
        if (proc.exitCode() != 0 || decData.isEmpty()) {
            decryptOk = false;
            break;
        }

        outFile.write(decData);
        m_doneBytes += chunk.size;
        const double pct = fileSize > 0 ? double(m_doneBytes) * 100.0 / double(fileSize) : 0.0;
        emit progress(m_id, m_doneBytes, fileSize, 0.0);
    }

    m_encryptedFile.close();
    outFile.close();
    m_encryptedFile.remove();

    if (!decryptOk) {
        outFile.remove();
        setState(DownloadState::Error, QStringLiteral("decryption failed — corrupted download or wrong key"));
        return;
    }

    // Adopt the decrypted output path
    m_savePath = outPath;
    emit progress(m_id, fileSize, fileSize, 0.0);
    setState(DownloadState::Completed, QStringLiteral("done"));
    emit finished(m_id);
}

void MegaGrabber::setState(DownloadState s, const QString &detail)
{
    if (kDebug) {
        if (s == DownloadState::Probing)
            qDebug().noquote() << "MEGA" << m_id << "probing:" << detail;
        else if (s == DownloadState::Downloading)
            qDebug().noquote() << "MEGA" << m_id << "downloading";
        else if (s == DownloadState::Completed)
            qDebug().noquote() << "MEGA" << m_id << "done";
        else if (s == DownloadState::Error)
            qDebug().noquote() << "MEGA" << m_id << "error:" << detail;
    }
    m_state = s;
    emit stateChanged(m_id, s, detail);
}

QString MegaGrabber::chooseSavePath() const
{
    QString baseName = QStringLiteral("mega-download");
    // Try to extract a better name from the URL
    const QString path = m_url.path();
    if (!path.isEmpty()) {
        const QString last = path.section(QLatin1Char('/'), -1);
        if (!last.isEmpty())
            baseName = last;
    }
    QString candidate = QDir(m_saveDir).filePath(baseName);
    // Deduplicate
    if (QFile::exists(candidate)) {
        const QFileInfo fi(candidate);
        const QString base = fi.completeBaseName();
        const QString ext = fi.suffix().isEmpty() ? QString() : QStringLiteral(".") + fi.suffix();
        int n = 1;
        do {
            candidate = QDir(m_saveDir).filePath(QStringLiteral("%1 (%2)%3").arg(base).arg(n).arg(ext));
            ++n;
        } while (QFile::exists(candidate));
    }
    return candidate;
}

} // namespace nexa
