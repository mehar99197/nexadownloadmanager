#pragma once
#include <QObject>
#include <QUrl>
#include <QString>
#include <QByteArray>
#include <QElapsedTimer>
#include <QFile>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include "core/Types.h"

namespace nexa {

class MegaCipher;   // AES-128-CTR stream decrypt + MEGA chunked CBC-MAC (OpenSSL EVP)

// Downloads files from mega.nz by speaking the MEGA API protocol.
//
// MEGA public links carry a 32-byte node key in the URL fragment. Folding it
// (first 16 bytes XOR last 16) gives the AES-128 key; bytes 16-23 are the CTR
// nonce and bytes 24-31 the "meta-MAC" the file must verify against. File data
// is AES-128-CTR, so it is decrypted IN-PLACE AS IT STREAMS IN — no temp file,
// no second pass, and the GUI thread never blocks (the old openssl-CLI design
// spawned a synchronous process per chunk and froze the app on large files).
// The per-chunk CBC-MAC is accumulated alongside and checked at the end, so a
// corrupted or wrong-key download is rejected instead of saved.
//
// URL shapes handled:
//   https://mega.nz/#!fileid!key                    (old format)
//   https://mega.nz/file/fileid#key                 (new format)
//   https://mega.co.nz/...
class MegaGrabber : public QObject {
    Q_OBJECT
public:
    MegaGrabber(int id, const QUrl &url, const QString &saveDir,
                QNetworkAccessManager *nam, QObject *parent = nullptr);
    ~MegaGrabber() override;

    static bool isMegaUrl(const QUrl &url);

    void start();
    void cancel();

    int     id()       const { return m_id; }
    QUrl    url()      const { return m_url; }
    QString savePath() const { return m_savePath; }
    QString fileName() const;
    DownloadState state() const { return m_state; }

    // Protocol helpers (exposed for unit tests).
    // Split a 32-byte node key into the folded AES key, 8-byte nonce, 8-byte meta-MAC.
    static bool splitFileKey(const QByteArray &nodeKey, QByteArray &aesKey,
                             QByteArray &nonce, QByteArray &metaMac);
    // Decrypt the node's "at" attribute blob (AES-128-CBC, zero IV) and return
    // its "n" (file name), or an empty string when it doesn't parse.
    static QString decryptAttributeName(const QByteArray &aesKey, const QByteArray &encryptedAttrs);
    // Decrypt `ciphertext` (AES-128-CTR from offset 0) and return the 8-byte
    // meta-MAC MEGA expects for that plaintext — used by tests to round-trip.
    // `pieceSize` > 0 feeds the stream in pieces of that size (exercises the
    // incremental chunk/MAC bookkeeping the way readyRead does).
    static QByteArray decryptAndMac(const QByteArray &aesKey, const QByteArray &nonce,
                                    QByteArray &ciphertextToPlaintext, int pieceSize = 0);

signals:
    void progress(int id, qint64 done, qint64 total, double bytesPerSec);
    void stateChanged(int id, DownloadState state, const QString &detail);
    void finished(int id);

private slots:
    void onApiResolved();
    void onDownloadFinished();

private:
    void setState(DownloadState s, const QString &detail = QString());
    void startDownload();
    void beginTransfer(const QString &downloadUrl);
    void failAndCleanup(const QString &why);
    QString chooseSavePath(const QString &preferredName) const;

    // Parse the mega.nz URL to extract file id and key (base64url-encoded).
    struct MegaFileKey {
        QString id;      // file/node id
        QByteArray key;  // raw 32-byte node key from the URL
        bool valid = false;
    };
    static MegaFileKey parseMegaUrl(const QUrl &url);
    static QByteArray base64UrlDecode(const QString &input);

    int                m_id;
    QUrl               m_url;
    QString            m_saveDir;
    QString            m_savePath;
    QNetworkAccessManager *m_nam = nullptr;
    DownloadState      m_state = DownloadState::Queued;
    MegaFileKey        m_fileKey;
    QByteArray         m_aesKey, m_nonce, m_metaMac;

    // API step
    QString            m_apiHost;      // e.g. "g.api.mega.co.nz:443"
    QNetworkReply     *m_apiReply = nullptr;

    // Transfer step (decrypt-as-you-go)
    QFile              m_outFile;
    MegaCipher        *m_cipher = nullptr;
    QNetworkReply     *m_dlReply = nullptr;
    qint64             m_totalBytes = -1;
    qint64             m_doneBytes = 0;

    QElapsedTimer      m_clock;
};

} // namespace nexa
