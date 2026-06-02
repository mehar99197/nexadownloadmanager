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

// Grabs an adaptive video stream and produces a single MP4.
//   * HLS (.m3u8): parses the master + media playlist ourselves, downloads all
//     segments in parallel, rewrites a local playlist, then muxes with FFmpeg
//     (-c copy, no re-encode). Encryption (#EXT-X-KEY) is passed through to
//     FFmpeg, which fetches the key and decrypts.
//   * DASH (.mpd) or anything else: handed straight to FFmpeg, which downloads
//     and muxes it.
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

    // Parallel segment fetches. Defaults to 16; the engine wires this to the
    // user's Settings value so it can be tuned (or throttled on slow links).
    void setConcurrency(int n);

    int           id()        const { return m_id; }
    QUrl          url()       const { return m_url; }
    QString       savePath()  const { return m_savePath; }
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

private:
    void setState(DownloadState s, const QString &detail = QString());
    void fetchPlaylist(const QUrl &u);
    void handleMaster(const QString &text);
    void handleMedia(const QString &text);
    void pumpDownloads();          // keep up to kConcurrency segment fetches busy
    void startMux();
    void muxViaFfmpegDirect();     // DASH / fallback path
    QString tempDir() const;
    void cleanupTemp();

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
};

} // namespace nexa
