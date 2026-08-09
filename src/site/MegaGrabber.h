#pragma once
#include <QObject>
#include <QUrl>
#include <QString>
#include <QProcess>
#include <QElapsedTimer>
#include <QFile>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include "core/Types.h"

namespace nexa {

// Downloads files from mega.nz by implementing the MEGA API protocol.
// MEGA encrypts files with AES-128-CBC (key derived from the URL fragment),
// so this grabber handles both the API negotiation and the decryption pass.
//
// URL shapes handled:
//   https://mega.nz/#!fileid!key                    (old format)
//   https://mega.nz/file/fileid#key                 (new format)
//   https://mega.co.nz/...
//
// Decryption is delegated to the `openssl` CLI tool (AES-128-CBC) rather than
// bundling a crypto library — openssl is widely available and avoids the need
// for yet another dependency.
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
    void decryptFile();
    QString chooseSavePath() const;

    // Parse the mega.nz URL to extract file id and key (base64url-encoded).
    struct MegaFileKey {
        QString id;    // file/node id
        QByteArray key; // raw 32-byte key (first 16 = AES key, second 16 = CBC-MAC key)
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

    // API step
    QString            m_apiHost;      // e.g. "g.api.mega.co.nz:443"
    QNetworkReply     *m_apiReply = nullptr;

    // Download step
    QFile              m_encryptedFile;
    QNetworkReply     *m_dlReply = nullptr;
    qint64             m_totalBytes = -1;
    qint64             m_doneBytes = 0;

    // Decrypt step
    QProcess          *m_decryptProc = nullptr;

    // Speed tracking
    QElapsedTimer      m_clock;
};

} // namespace nexa
