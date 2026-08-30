#pragma once
#include <QObject>
#include <QUrl>
#include <QString>
#include <QStringList>
#include <QList>
#include <QElapsedTimer>
#include <QByteArray>
#include <QProcess>
#include "core/Types.h"

class QNetworkAccessManager;
class QNetworkReply;

namespace nexa {

// Downloads songs from Spotify.
//
// What the DevTools/Playwright network monitoring proved: Spotify's web player
// fetches a Widevine application certificate
// (spclient.wg.spotify.com/widevine-license/v1/application-certificate) and the
// audio bytes on the wire are Widevine-DRM encrypted. So, unlike a plain HLS
// stream, intercepting the currently-playing track's network traffic yields
// encrypted samples that cannot be played back — there is NO usable audio
// stream to capture directly from the web player.
//
// Two strategies that DO produce playable files, both driven here:
//
//   1. "preview" — the public embed endpoint (open.spotify.com/embed/...) exposes
//      an unencrypted 30-second MP3 preview hosted on p.scdn.co. We download it
//      directly and tag it with the track metadata + album art. Always works,
//      no DRM, no dependencies — but it is only a 30-second clip.
//
//   2. "full" (default when yt-dlp is available) — the spotdl strategy: resolve
//      the track's title/artist/album from the same public embed metadata, then
//      drive yt-dlp with a YouTube search ("ytsearch1:<title> <artist>") to fetch
//      the matching full audio, and tag the result with the Spotify metadata +
//      album art via ffmpeg. The audio comes from YouTube (matched to the Spotify
//      track), NOT from Spotify's DRM'd stream — that is the only way to get a
//      full, playable song without breaking Widevine.
//
// Track, album and playlist URLs are supported. Album/playlist embeds list their
// tracks, which are downloaded sequentially with aggregate progress.
//
// Emits the same signals as the other grabbers so the engine/UI treat it
// uniformly. No login is required (the embed metadata is public).
class SpotifyGrabber : public QObject {
    Q_OBJECT
public:
    SpotifyGrabber(int id, const QUrl &url, const QString &saveDir,
                   QNetworkAccessManager *nam, QObject *parent = nullptr);
    ~SpotifyGrabber() override;

    static bool isSpotifyUrl(const QUrl &url);
    // Widevine-encrypted Spotify CDN audio streams (audio-ak.spotifycdn.com/…).
    // These are NOT downloadable/playable — the engine rejects them with a clear
    // DRM error instead of saving an unplayable file.
    static bool isSpotifyCdnUrl(const QUrl &url);

    void start();
    void cancel();

    void setOutputDir(const QString &d) { m_saveDir = d; }   // before start only
    // "full" (yt-dlp + YouTube match) | "preview" (30s DRM-free clip) |
    // "auto" (full if yt-dlp is available, else preview). Default "auto".
    void setMode(const QString &m);
    // Audio container for full mode: "mp3" (default), "m4a", "aac", "flac".
    void setAudioFormat(const QString &fmt);

    int           id()       const { return m_id; }
    QUrl          url()      const { return m_url; }
    QString       savePath() const { return m_savePath; }
    QString       fileName() const;
    DownloadState state()    const { return m_state; }

signals:
    void progress(int id, qint64 done, qint64 total, double bytesPerSec);
    void stateChanged(int id, DownloadState state, const QString &detail);
    void finished(int id);

private slots:
    void onEmbedFetched();
    void onPreviewReadyRead();
    void onPreviewFinished();
    void onArtFinished();
    void onYtDlpOutput();
    void onYtDlpFinished(int exitCode, QProcess::ExitStatus es);
    void onFfmpegFinished(int exitCode, QProcess::ExitStatus es);

private:
    struct Track {
        QString uri;          // spotify:track:...
        QString name;
        QStringList artists;
        QString album;
        QString artUrl;       // largest cover image
        QString previewUrl;  // p.scdn.co mp3 (may be empty)
        qint64  durationMs = 0;
        QString releaseDate;  // ISO string
        bool    valid = false;
    };

    void setState(DownloadState s, const QString &detail = QString());
    void fail(const QString &reason);
    void finishTrack(const QString &outPath, const Track &t);
    void processNextTrack();
    void startPreviewDownload(const Track &t);
    void startFullDownload(const Track &t);
    void startTagging(const QString &mediaPath, const Track &t);
    QString targetPath(const Track &t) const;
    static QString sanitizeName(const QString &s);

    int                    m_id;
    QUrl                   m_url;
    QString                m_saveDir;
    QString                m_savePath;
    QString                m_mode = QStringLiteral("auto");
    QString                m_audioFormat = QStringLiteral("mp3");
    QNetworkAccessManager *m_nam = nullptr;
    DownloadState          m_state = DownloadState::Queued;

    QList<Track>           m_tracks;
    int                    m_trackIndex = 0;
    QString                m_tmpDir;       // per-run temp directory

    QNetworkReply         *m_embedReply = nullptr;
    QNetworkReply         *m_previewReply = nullptr;
    QByteArray             m_previewBuffer;
    QNetworkReply         *m_artReply = nullptr;
    QProcess              *m_ytdlp = nullptr;
    QProcess              *m_ffmpeg = nullptr;

    QString                m_curMediaPath;  // current track's downloaded audio (temp)
    QString                m_curOutPath;     // current track's final tagged output path
    QString                m_curArtPath;     // current track's downloaded cover (temp)

    qint64                 m_curTotal = -1;
    qint64                 m_curDone = 0;
    qint64                 m_doneBytes = 0;  // cumulative bytes across finished tracks
    qint64                 m_sumTotal = 0;   // sum of known sizes (progressive)
    int                    m_lastPct = -1;
    QString                m_lastError;     // last "ERROR:" line from yt-dlp
    QElapsedTimer          m_clock;
    bool                   m_cancelled = false;
};

} // namespace nexa
