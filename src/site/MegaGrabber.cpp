#include "site/MegaGrabber.h"

#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonArray>
#include <QJsonObject>
#include <QNetworkRequest>
#include <QRegularExpression>
#include <QDebug>
#include <openssl/evp.h>
#include <cstring>

namespace nexa {

static const bool kDebug = qEnvironmentVariableIsSet("NEXA_DEBUG");

// ---- Crypto primitives (OpenSSL EVP) ----------------------------------------

namespace {

// AES-128-CBC without padding over `len` bytes (a multiple of 16).
bool aesCbcNoPad(bool encrypt, const unsigned char key[16], const unsigned char iv[16],
                 const unsigned char *in, int len, unsigned char *out)
{
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    if (!ctx)
        return false;
    int outl = 0, fin = 0;
    const bool ok =
        EVP_CipherInit_ex(ctx, EVP_aes_128_cbc(), nullptr, key, iv, encrypt ? 1 : 0) == 1
        && EVP_CIPHER_CTX_set_padding(ctx, 0) == 1
        && EVP_CipherUpdate(ctx, out, &outl, in, len) == 1
        && EVP_CipherFinal_ex(ctx, out + outl, &fin) == 1
        && outl + fin == len;
    EVP_CIPHER_CTX_free(ctx);
    return ok;
}

// MEGA chunk boundaries: 128 KiB, 256 KiB, … 1 MiB, then 1 MiB each (last =
// remainder). These only matter for the MAC; CTR decryption is a plain stream.
qint64 nextChunkSize(qint64 current)
{
    return current < 0x100000 ? current + 0x20000 : 0x100000;
}

} // namespace

// Streams ciphertext through AES-128-CTR and, alongside, accumulates MEGA's
// chunked CBC-MAC so the finished file can be verified against the meta-MAC
// carried in the link. Everything is incremental: feed bytes as they arrive.
class MegaCipher {
public:
    MegaCipher(const QByteArray &aesKey, const QByteArray &nonce)
    {
        std::memcpy(m_key, aesKey.constData(), 16);
        std::memcpy(m_nonce, nonce.constData(), 8);
        unsigned char iv[16] = {0};          // counter block = nonce || 0
        std::memcpy(iv, m_nonce, 8);
        m_ctr = EVP_CIPHER_CTX_new();
        m_ok = m_ctr && EVP_DecryptInit_ex(m_ctr, EVP_aes_128_ctr(), nullptr, m_key, iv) == 1;
        std::memset(m_fileMac, 0, sizeof m_fileMac);
        resetChunkMac();
        m_chunkSize = m_chunkRemaining = 0x20000;
    }
    ~MegaCipher() { if (m_ctr) EVP_CIPHER_CTX_free(m_ctr); }
    MegaCipher(const MegaCipher &) = delete;
    MegaCipher &operator=(const MegaCipher &) = delete;

    bool ok() const { return m_ok; }

    // Decrypt `data` in place and feed the plaintext into the MAC.
    bool process(QByteArray &data)
    {
        if (!m_ok || data.isEmpty())
            return m_ok;
        int outl = 0;
        auto *buf = reinterpret_cast<unsigned char *>(data.data());
        if (EVP_DecryptUpdate(m_ctr, buf, &outl, buf, data.size()) != 1 || outl != data.size()) {
            m_ok = false;
            return false;
        }
        feedMac(buf, data.size());
        return m_ok;
    }

    // Close the trailing chunk and return the 8-byte meta-MAC of everything fed.
    QByteArray finish()
    {
        if (m_chunkRemaining != m_chunkSize || !m_pending.isEmpty())
            closeChunk();                     // partial last chunk
        QByteArray meta(8, '\0');
        for (int i = 0; i < 4; ++i) {
            meta[i]     = char(m_fileMac[i]     ^ m_fileMac[i + 4]);
            meta[i + 4] = char(m_fileMac[i + 8] ^ m_fileMac[i + 12]);
        }
        return meta;
    }

private:
    void resetChunkMac()
    {
        std::memcpy(m_chunkMac, m_nonce, 8);      // chunk MAC IV = nonce || nonce
        std::memcpy(m_chunkMac + 8, m_nonce, 8);
    }

    // CBC-MAC step over whole blocks: run CBC with IV = current MAC and keep the
    // last ciphertext block (identical to MAC = AES(MAC XOR block) per block).
    void macBlocks(const unsigned char *in, int len)
    {
        if (len <= 0 || !m_ok)
            return;
        QByteArray out(len, '\0');
        if (!aesCbcNoPad(true, m_key, m_chunkMac, in, len,
                         reinterpret_cast<unsigned char *>(out.data()))) {
            m_ok = false;
            return;
        }
        std::memcpy(m_chunkMac, out.constData() + len - 16, 16);
    }

    void feedMac(const unsigned char *data, qint64 n)
    {
        while (n > 0 && m_ok) {
            const qint64 take = qMin(n, m_chunkRemaining);
            m_pending.append(reinterpret_cast<const char *>(data), int(take));
            data += take;
            n -= take;
            m_chunkRemaining -= take;
            const int full = (m_pending.size() / 16) * 16;
            if (full > 0) {
                macBlocks(reinterpret_cast<const unsigned char *>(m_pending.constData()), full);
                m_pending.remove(0, full);
            }
            if (m_chunkRemaining == 0)
                closeChunk();
        }
    }

    void closeChunk()
    {
        if (!m_pending.isEmpty()) {           // zero-pad the tail block
            m_pending.append(QByteArray(16 - m_pending.size(), '\0'));
            macBlocks(reinterpret_cast<const unsigned char *>(m_pending.constData()), 16);
            m_pending.clear();
        }
        // file_mac = AES(file_mac XOR chunk_mac): CBC-MAC over chunk MACs, zero IV.
        unsigned char zeroIv[16] = {0};
        unsigned char in[16], out[16];
        for (int i = 0; i < 16; ++i)
            in[i] = m_fileMac[i] ^ m_chunkMac[i];
        if (!aesCbcNoPad(true, m_key, zeroIv, in, 16, out)) {
            m_ok = false;
            return;
        }
        std::memcpy(m_fileMac, out, 16);
        resetChunkMac();
        m_chunkSize = nextChunkSize(m_chunkSize);
        m_chunkRemaining = m_chunkSize;
    }

    EVP_CIPHER_CTX *m_ctr = nullptr;
    unsigned char   m_key[16], m_nonce[8], m_chunkMac[16], m_fileMac[16];
    QByteArray      m_pending;                // < 16 bytes awaiting a full block
    qint64          m_chunkSize = 0, m_chunkRemaining = 0;
    bool            m_ok = false;
};

// ---- Key + attribute helpers -----------------------------------------------

bool MegaGrabber::splitFileKey(const QByteArray &nodeKey, QByteArray &aesKey,
                               QByteArray &nonce, QByteArray &metaMac)
{
    if (nodeKey.size() != 32)
        return false;
    aesKey.resize(16);
    for (int i = 0; i < 16; ++i)
        aesKey[i] = char(uchar(nodeKey[i]) ^ uchar(nodeKey[i + 16]));
    nonce   = nodeKey.mid(16, 8);
    metaMac = nodeKey.mid(24, 8);
    return true;
}

QString MegaGrabber::decryptAttributeName(const QByteArray &aesKey, const QByteArray &encryptedAttrs)
{
    if (aesKey.size() != 16 || encryptedAttrs.isEmpty() || encryptedAttrs.size() % 16 != 0)
        return QString();
    QByteArray plain(encryptedAttrs.size(), '\0');
    unsigned char zeroIv[16] = {0};
    if (!aesCbcNoPad(false, reinterpret_cast<const unsigned char *>(aesKey.constData()), zeroIv,
                     reinterpret_cast<const unsigned char *>(encryptedAttrs.constData()),
                     encryptedAttrs.size(), reinterpret_cast<unsigned char *>(plain.data())))
        return QString();
    while (!plain.isEmpty() && plain.endsWith('\0'))
        plain.chop(1);
    if (!plain.startsWith("MEGA{"))
        return QString();
    const QJsonObject attrs = QJsonDocument::fromJson(plain.mid(4)).object();
    QString name = attrs.value(QStringLiteral("n")).toString().trimmed();
    // Never let a remote name escape the download folder.
    name.replace(QLatin1Char('/'), QLatin1Char('_')).replace(QLatin1Char('\\'), QLatin1Char('_'));
    if (name == QLatin1String(".") || name == QLatin1String(".."))
        name.clear();
    return name;
}

QByteArray MegaGrabber::decryptAndMac(const QByteArray &aesKey, const QByteArray &nonce,
                                      QByteArray &ciphertextToPlaintext, int pieceSize)
{
    if (aesKey.size() != 16 || nonce.size() != 8)
        return QByteArray();
    MegaCipher c(aesKey, nonce);
    if (pieceSize <= 0 || pieceSize >= ciphertextToPlaintext.size()) {
        if (!c.process(ciphertextToPlaintext))
            return QByteArray();
        return c.finish();
    }
    QByteArray out;
    out.reserve(ciphertextToPlaintext.size());
    for (int pos = 0; pos < ciphertextToPlaintext.size(); pos += pieceSize) {
        QByteArray piece = ciphertextToPlaintext.mid(pos, pieceSize);
        if (!c.process(piece))
            return QByteArray();
        out.append(piece);
    }
    ciphertextToPlaintext = out;
    return c.finish();
}

// ---- URL parsing ----------------------------------------------------------

// Decode a MEGA base64url string (A-Z a-z 0-9 - _) into raw bytes.
QByteArray MegaGrabber::base64UrlDecode(const QString &input)
{
    QString s = input;
    s.replace(QLatin1Char('-'), QLatin1Char('+'));
    s.replace(QLatin1Char('_'), QLatin1Char('/'));
    const int pad = 4 - (s.size() % 4);
    if (pad < 4)
        s.append(QString(pad, QLatin1Char('=')));
    return QByteArray::fromBase64(s.toLatin1());
}

// Parse the mega.nz URL shapes into file id + raw 32-byte key.
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
        QString keyPart = frag;
        if (keyPart.startsWith(QLatin1Char('!')))
            keyPart = keyPart.mid(1);
        result.key = base64UrlDecode(keyPart);
        result.valid = result.key.size() == 32;
        return result;
    }

    // Old format: /#!<id>!<key>
    if (frag.startsWith(QLatin1Char('!'))) {
        const QStringList parts = frag.mid(1).split(QLatin1Char('!'), Qt::SkipEmptyParts);
        if (parts.size() >= 2) {
            result.id = parts[0];
            result.key = base64UrlDecode(parts[1]);
            result.valid = result.key.size() == 32;
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
    // Detach every connection before cancel(), so the "cancelled" state change
    // can't reach a slot while this object is half-destroyed.
    disconnect();
    cancel();
    delete m_cipher;
    m_cipher = nullptr;
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
    if (!m_fileKey.valid || !splitFileKey(m_fileKey.key, m_aesKey, m_nonce, m_metaMac)) {
        setState(DownloadState::Error, QStringLiteral("could not parse mega.nz URL (missing or malformed key)"));
        return;
    }

    m_savePath = chooseSavePath(QString());   // provisional; replaced once attrs decrypt
    setState(DownloadState::Probing, QStringLiteral("resolving MEGA API endpoint"));

    QNetworkRequest req(QUrl(QStringLiteral("https://eu.api.mega.co.nz/")));
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                     QNetworkRequest::NoLessSafeRedirectPolicy);
    req.setRawHeader("User-Agent", "Nexa/0.1");
    req.setTransferTimeout(20000);
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
    if (m_outFile.isOpen()) {
        m_outFile.close();
        m_outFile.remove();       // a partial CTR stream can't be resumed safely
    }
    delete m_cipher;
    m_cipher = nullptr;
    if (m_state != DownloadState::Completed && m_state != DownloadState::Error)
        setState(DownloadState::Paused, QStringLiteral("cancelled"));
}

void MegaGrabber::failAndCleanup(const QString &why)
{
    if (m_dlReply) {
        m_dlReply->disconnect(this);
        m_dlReply->abort();
        m_dlReply->deleteLater();
        m_dlReply = nullptr;
    }
    if (m_outFile.isOpen())
        m_outFile.close();
    m_outFile.remove();
    delete m_cipher;
    m_cipher = nullptr;
    setState(DownloadState::Error, why);
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
    const QString body = QString::fromUtf8(r->read(512)).trimmed();
    static const QRegularExpression hostRe(QStringLiteral("\\A(?:https://)?([A-Za-z0-9.-]+\\.mega\\.co\\.nz(?::\\d+)?)/?\\z"));
    const auto m = hostRe.match(body);
    m_apiHost = m.hasMatch() ? m.captured(1) : QStringLiteral("g.api.mega.co.nz:443");
    startDownload();
}

void MegaGrabber::startDownload()
{
    setState(DownloadState::Probing, QStringLiteral("requesting download URL"));

    // POST /cs  [{"a":"g","g":1,"p":"<fileId>"}]  → [{"g":url,"s":size,"at":attrs}]
    QNetworkRequest req{QUrl(QStringLiteral("https://%1/cs").arg(m_apiHost))};
    req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    req.setRawHeader("User-Agent", "Nexa/0.1");
    req.setTransferTimeout(20000);

    QJsonObject cmd;
    cmd[QStringLiteral("a")] = QStringLiteral("g");
    cmd[QStringLiteral("g")] = 1;
    cmd[QStringLiteral("p")] = m_fileKey.id;
    const QByteArray data = QJsonDocument(QJsonArray{cmd}).toJson(QJsonDocument::Compact);

    m_apiReply = m_nam->post(req, data);
    connect(m_apiReply, &QNetworkReply::finished, this, [this]() {
        QNetworkReply *r = m_apiReply;
        m_apiReply = nullptr;
        if (!r)
            return;
        r->deleteLater();

        if (r->error() != QNetworkReply::NoError) {
            setState(DownloadState::Error, QStringLiteral("MEGA API error: %1").arg(r->errorString()));
            return;
        }
        const QJsonDocument doc = QJsonDocument::fromJson(r->read(256 * 1024));
        const QJsonArray arr = doc.array();
        if (arr.isEmpty()) {
            setState(DownloadState::Error, QStringLiteral("MEGA API returned an unexpected response"));
            return;
        }
        if (arr[0].isDouble()) {   // MEGA error codes are negative ints (-9 not found, -18 retry…)
            const int code = arr[0].toInt();
            const QString why = code == -9  ? QStringLiteral("file not found or link revoked")
                              : code == -18 ? QStringLiteral("MEGA is temporarily unavailable; try again")
                              : code == -3  ? QStringLiteral("rate limited by MEGA; try again later")
                              : QStringLiteral("MEGA error %1").arg(code);
            setState(DownloadState::Error, why);
            return;
        }
        const QJsonObject obj = arr[0].toObject();
        const QString dlUrl = obj.value(QStringLiteral("g")).toString();
        m_totalBytes = qint64(obj.value(QStringLiteral("s")).toDouble(-1));
        if (dlUrl.isEmpty()) {
            setState(DownloadState::Error, QStringLiteral("MEGA could not provide a download URL"));
            return;
        }

        // Real file name lives in the encrypted attributes.
        const QString name = decryptAttributeName(
            m_aesKey, base64UrlDecode(obj.value(QStringLiteral("at")).toString()));
        m_savePath = chooseSavePath(name);
        beginTransfer(dlUrl);
    });
}

void MegaGrabber::beginTransfer(const QString &downloadUrl)
{
    QDir().mkpath(QFileInfo(m_savePath).absolutePath());
    m_outFile.setFileName(m_savePath);
    if (!m_outFile.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        setState(DownloadState::Error, QStringLiteral("cannot create %1").arg(m_savePath));
        return;
    }
    delete m_cipher;
    m_cipher = new MegaCipher(m_aesKey, m_nonce);
    if (!m_cipher->ok()) {
        failAndCleanup(QStringLiteral("could not initialise AES decryption"));
        return;
    }

    setState(DownloadState::Downloading, QStringLiteral("downloading from MEGA"));
    m_doneBytes = 0;
    m_clock.start();

    QNetworkRequest dlReq{QUrl(downloadUrl)};
    dlReq.setRawHeader("User-Agent", "Nexa/0.1");
    dlReq.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                       QNetworkRequest::NoLessSafeRedirectPolicy);
    m_dlReply = m_nam->get(dlReq);
    connect(m_dlReply, &QNetworkReply::readyRead, this, [this]() {
        if (!m_dlReply || !m_cipher || !m_outFile.isOpen())
            return;
        QByteArray chunk = m_dlReply->readAll();
        if (chunk.isEmpty())
            return;
        if (m_totalBytes >= 0 && m_doneBytes + chunk.size() > m_totalBytes) {
            failAndCleanup(QStringLiteral("MEGA sent more data than the file size"));
            return;
        }
        if (!m_cipher->process(chunk)) {          // decrypts in place + MACs
            failAndCleanup(QStringLiteral("decryption failed"));
            return;
        }
        if (m_outFile.write(chunk) != chunk.size()) {
            failAndCleanup(QStringLiteral("disk write failed: %1").arg(m_outFile.errorString()));
            return;
        }
        m_doneBytes += chunk.size();
        const double speed = m_clock.elapsed() > 0
            ? double(m_doneBytes) * 1000.0 / double(m_clock.elapsed()) : 0.0;
        emit progress(m_id, m_doneBytes, m_totalBytes, speed);
    });
    connect(m_dlReply, &QNetworkReply::finished, this, &MegaGrabber::onDownloadFinished);
}

void MegaGrabber::onDownloadFinished()
{
    QNetworkReply *r = m_dlReply;
    m_dlReply = nullptr;
    if (!r)
        return;
    r->deleteLater();

    if (r->error() != QNetworkReply::NoError) {
        failAndCleanup(QStringLiteral("MEGA download error: %1").arg(r->errorString()));
        return;
    }
    if (m_doneBytes == 0) {
        failAndCleanup(QStringLiteral("MEGA download returned an empty response"));
        return;
    }
    if (m_totalBytes > 0 && m_doneBytes != m_totalBytes) {
        if (kDebug)
            qDebug().noquote() << "MEGA" << m_id << "size mismatch" << m_doneBytes << "/" << m_totalBytes;
        failAndCleanup(QStringLiteral("incomplete MEGA download (%1 of %2 bytes)")
                           .arg(m_doneBytes).arg(m_totalBytes));
        return;
    }

    // Integrity: the chunked CBC-MAC of the plaintext must fold to the link's meta-MAC.
    const QByteArray mac = m_cipher ? m_cipher->finish() : QByteArray();
    delete m_cipher;
    m_cipher = nullptr;
    const bool flushed = m_outFile.flush();
    m_outFile.close();
    if (!flushed) {
        failAndCleanup(QStringLiteral("disk write failed while finishing"));
        return;
    }
    if (mac.size() != 8 || mac != m_metaMac) {
        m_outFile.remove();
        setState(DownloadState::Error,
                 QStringLiteral("integrity check failed — corrupted download or wrong key"));
        return;
    }

    emit progress(m_id, m_doneBytes, m_doneBytes, 0.0);
    setState(DownloadState::Completed, QStringLiteral("done"));
    emit finished(m_id);
}

void MegaGrabber::setState(DownloadState s, const QString &detail)
{
    if (kDebug) {
        if (s == DownloadState::Error)
            qDebug().noquote() << "MEGA" << m_id << "error:" << detail;
        else
            qDebug().noquote() << "MEGA" << m_id << int(s) << detail;
    }
    m_state = s;
    emit stateChanged(m_id, s, detail);
}

QString MegaGrabber::chooseSavePath(const QString &preferredName) const
{
    QString baseName = preferredName;
    if (baseName.isEmpty()) {
        baseName = QStringLiteral("mega-%1.bin").arg(m_fileKey.id.left(8));
    }
    QString candidate = QDir(m_saveDir).filePath(baseName);
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
