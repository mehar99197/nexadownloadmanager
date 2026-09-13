#pragma once
#include <QObject>
#include <QUrl>
#include <QString>
#include <QVector>
#include <QElapsedTimer>
#include "core/Types.h"

class QNetworkAccessManager;
class QNetworkReply;
class QProcess;

namespace nexa {

class CloudProviders;

// Grabs an adaptive video stream and produces a single MP4. start() picks one
// of two strategies, by whether the stream needs a credential:
//
//   * No credential (the common case): the playlist URL goes straight to
//     FFmpeg, which downloads and muxes it. Its HLS client handles AES-128
//     keys, variant selection and redirects more robustly than we can, and
//     `-progress pipe:1` gives us live byte counts to report.
//   * Behind a login: FFmpeg takes headers only on its command line, and argv
//     is readable by other local processes, so a session cookie cannot go
//     there. Instead we parse the master + media playlist ourselves, fetch every
//     segment through Qt (credentials stay in-process) up to setConcurrency()
//     at a time, rewrite a local playlist, and let FFmpeg mux local files only
//     (-c copy, no re-encode). #EXT-X-KEY URIs are absolutised so FFmpeg still
//     fetches and applies the decryption key.
//
// Emits the same signals as DownloadTask so the engine/UI treat it uniformly.
class HlsGrabber : public QObject {
    Q_OBJECT
public:
    HlsGrabber(int id, const QUrl &url, const QString &savePath,
               const HeaderList &headers, QObject *parent = nullptr);
    ~HlsGrabber() override;

    void start();
    void cancel();

    // Parallel segment fetches for the credentialed (per-segment) strategy.
    // Defaults to 16; the engine wires this to the user's Settings value so it
    // can be tuned (or throttled on slow links). Has no effect on the direct
    // FFmpeg path, which manages its own connections.
    void setConcurrency(int n);
    void setCredentialScope(const CloudProviders *providers, const QString &originHost)
    { m_providers = providers; m_credentialHost = originHost.toLower(); }
    void setPublicNetworkOnly(bool on) { m_publicNetworkOnly = on; }

    int           id()        const { return m_id; }
    QUrl          url()       const { return m_url; }
    QString       savePath()  const { return m_savePath; }
    void          setSavePath(const QString &p) { m_savePath = p; }   // before start only
    QString       fileName()  const;
    DownloadState state()     const { return m_state; }

    static bool isStreamUrl(const QUrl &url);   // .m3u8 / .mpd detection

signals:
    void progress(int id, qint64 done, qint64 total, double bytesPerSec);
    void stateChanged(int id, DownloadState state, const QString &detail);
    void finished(int id);

private slots:
    void onPlaylistFetched();
    void onSegmentFinished();
    void onMuxFinished(int exitCode);
    void onFfmpegProgress();       // parse FFmpeg's -progress stream

private:
    void setState(DownloadState s, const QString &detail = QString());
    bool needsCredentialedFetch() const;   // picks the strategy in start()
    void fetchPlaylist(const QUrl &u);
    void handleMaster(const QString &text);
    void handleMedia(const QString &text);
    void pumpDownloads();          // keep up to kConcurrency segment fetches busy
    void startSegmentRequest(int index, int redirects);
    void startMux();
    void muxViaFfmpegDirect();     // DASH / fallback path
    QString tempDir() const;
    void cleanupTemp();
    HeaderList scopedHeaders(const QUrl &target) const;

    struct Segment {
        QUrl    url;
        QString localFile;
        bool    done = false;
    };

    int                    m_id;
    QUrl                   m_url;        // current playlist URL (updated for variants)
    QString                m_savePath;   // final .mp4
    HeaderList             m_headers;
    DownloadState          m_state = DownloadState::Queued;

    QNetworkAccessManager *m_nam = nullptr;
    QNetworkReply         *m_playlistReply = nullptr;
    QProcess              *m_ffmpeg = nullptr;

    QString                m_localPlaylist;   // rewritten index.m3u8 on disk
    QString                m_tempPath;        // private random per-run directory
    QByteArray             m_progressTail;    // partial -progress line from FFmpeg
    QVector<Segment>       m_segments;
    int                    m_nextToFetch = 0;
    int                    m_inFlight = 0;
    int                    m_doneCount = 0;
    int                    m_runGen = 0;        // bumped each (re)start; tags replies
    qint64                 m_bytes = 0;
    bool                   m_resolvedVariant = false;
    bool                   m_cancelled = false;
    QElapsedTimer          m_clock;

    int                    m_concurrency = 16;   // parallel segment fetches (accelerator)
    const CloudProviders  *m_providers = nullptr;
    QString                m_credentialHost;
    bool                   m_publicNetworkOnly = false;
    int                    m_redirects = 0;
};

} // namespace nexa
