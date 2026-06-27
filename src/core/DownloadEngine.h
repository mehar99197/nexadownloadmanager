#pragma once
#include <QObject>
#include <QHash>
#include <QList>
#include <QSet>
#include <QVector>
#include <QUrl>
#include <QDateTime>
#include "core/Types.h"

class QNetworkAccessManager;
class QTimer;

namespace nexa {

class DownloadTask;
class HlsGrabber;
class TorrentManager;
class YtDlpGrabber;
class AiClient;
class Database;
class AuthenticationManager;
class RateLimiter;

// Top-level controller: owns the network stack + database and manages the set
// of DownloadTasks. The UI talks only to this class.
class DownloadEngine : public QObject {
    Q_OBJECT
public:
    explicit DownloadEngine(QObject *parent = nullptr);
    ~DownloadEngine() override;

    // Returns the new task id, or -1 on bad input. `headers` carries the
    // browser-captured cookies/UA/referrer to replay on every request.
    // `suggestedName` (e.g. a page title) names stream grabs / unnamed files.
    // `siteFormat` (set for YouTube etc.) picks the yt-dlp quality, e.g. "1080".
    // `playlist` (YouTube etc.): download every video in the playlist via yt-dlp
    // --yes-playlist instead of just the single linked video.
    int  addDownload(const QUrl &url,
                     const QString &savePath = QString(),
                     const HeaderList &headers = {},
                     const QString &suggestedName = QString(),
                     const QString &siteFormat = QString(),
                     bool playlist = false,
                     bool userInitiated = false,    // true = user already confirmed; start now
                     const QString &audioFormat = QString());  // audio-only sites: m4a/aac/flac/mp3
    void pause(int id);
    void resume(int id);
    void remove(int id, bool deleteFile = false);

    // ---- IDM-style "ask before download" confirmation ---------------------
    // When confirmBeforeStart is on, an externally-added download (browser /
    // clipboard) is HELD: the task/grabber is created but not started, and
    // confirmRequested(id) fires so the UI can show a prompt. The UI then calls
    // one of: startHeld (begin), holdLater (keep paused), or cancelHeld (drop).
    void setConfirmBeforeStart(bool on) { m_confirmBeforeStart = on; }
    bool confirmBeforeStart() const     { return m_confirmBeforeStart; }
    bool isHeld(int id) const           { return m_held.contains(id); }
    void startHeld(int id);
    void holdLater(int id);
    void cancelHeld(int id);
    // Override where a (held, not-yet-started) download will be saved.
    void setSaveLocation(int id, const QString &folder, const QString &fileName);
    // Probe the URL for the real filename (Content-Disposition); emits nameResolved.
    void resolveName(int id);
    QString resolvedNameOf(int id) const { return m_resolvedNames.value(id); }

    // Remove every completed job from the list and scrub completed history from
    // the database. Returns how many were cleared. Surfaced via Settings.
    int  clearCompleted();

    // Batch add: accepts whitespace/newline-separated URLs and expands numeric
    // ranges like "http://x/file[1-20].jpg" into individual downloads.
    QList<int> addBatch(const QString &text, const HeaderList &headers = {});
    static QStringList expandPattern(const QString &token);

    // Schedule a download to start at a future time (IDM-style scheduler).
    int scheduleDownload(const QUrl &url, const QDateTime &when,
                         const HeaderList &headers = {});

    void setDownloadDir(const QString &dir) { m_downloadDir = dir; }
    QString downloadDir() const { return m_downloadDir; }

    // Max simultaneously-active file downloads; the rest wait Queued.
    void setMaxConcurrent(int n) { m_maxConcurrent = qMax(1, n); schedule(); }
    int  maxConcurrent() const { return m_maxConcurrent; }

    // Global HTTP download speed cap in bytes/sec (0 = unlimited), shared across
    // all active segmented downloads via a token-bucket RateLimiter.
    void   setSpeedLimit(qint64 bytesPerSec);
    qint64 speedLimit() const;

    // Sort completed files into per-type subfolders (Video/, Audio/, ...).
    void setAutoCategorize(bool on) { m_autoCategorize = on; }
    bool autoCategorize() const { return m_autoCategorize; }
    static QString categoryFor(const QString &fileName);

    // Parallel segment fetches for HLS stream grabs (applied to new grabbers).
    void setStreamConcurrency(int n) { m_streamConcurrency = qBound(1, n, 64); }
    int  streamConcurrency() const { return m_streamConcurrency; }

    // Subtitle embedding for yt-dlp video grabs (applied to new grabbers).
    void setSubtitles(bool embed, const QString &langs = QStringLiteral("en"))
    { m_embedSubs = embed; if (!langs.trimmed().isEmpty()) m_subLangs = langs.trimmed(); }
    bool    subtitlesEnabled() const { return m_embedSubs; }
    QString subtitleLangs() const { return m_subLangs; }

    // How many playlist videos to download in parallel (applied to new playlist
    // grabs). Higher uses more of the bandwidth that one-at-a-time leaves idle.
    void setPlaylistConcurrency(int n) { m_plConcurrency = qBound(1, n, 8); }
    int  playlistConcurrency() const { return m_plConcurrency; }

    // BitTorrent session caps (bytes/sec, 0 = unlimited) and seed-to-ratio.
    // Remembered and (re)applied whenever the torrent session is created.
    void   setTorrentSpeedLimits(int downloadBytesPerSec, int uploadBytesPerSec);
    void   setSeedRatio(double ratio);
    double seedRatio() const { return m_seedRatio; }
    int    torrentDownloadLimit() const { return m_torrentDlLimit; }
    int    torrentUploadLimit() const { return m_torrentUlLimit; }

    // AI helpers (require $ANTHROPIC_API_KEY). aiAvailable() reflects key presence.
    bool aiAvailable() const;
    void setAiRename(bool on) { m_aiRename = on; }   // AI-rename files on completion
    bool aiRename() const { return m_aiRename; }
    void runAiCommand(const QString &naturalLanguage);  // NL -> add/schedule downloads

    DownloadTask *task(int id) const { return m_tasks.value(id, nullptr); }
    QList<DownloadTask*> tasks() const { return m_tasks.values(); }

    // Domain-scoped authentication (cookies.txt / bearer tokens). Lets IpcServer
    // and the UI register credentials; the engine applies them in addDownload().
    AuthenticationManager *auth() const { return m_auth; }

    // Unified accessors that work for both file downloads and stream grabs.
    QString       nameOf(int id) const;
    DownloadState stateOf(int id) const;
    QString       savePathOf(int id) const;   // resolved destination path
    QString       hostOf(int id) const;   // source host, for the UI row subtitle
    QString       urlOf(int id) const;    // full source URL (empty for torrents)

    // Resume capability for ANY job type — a definitive Yes/No, never "unknown".
    // HTTP downloads depend on the server honouring Range; torrents and yt-dlp/
    // HLS grabs always resume in Nexa.
    bool          isResumable(int id) const;

    // Reorder the waiting queue to match the given display order: any ids in
    // `idsInDisplayOrder` that are still queued are moved to that relative order
    // (others are left untouched), then the scheduler re-evaluates. Lets the UI
    // drag/reorder which queued download starts next.
    void reorderQueue(const QList<int> &idsInDisplayOrder);

    // True only for yt-dlp --yes-playlist jobs (many videos in one job). The UI
    // uses this to suppress the single-file "details" plate for playlists.
    bool          isPlaylist(int id) const { return m_playlistIds.contains(id); }

    // True when at least one job exists and all (downloads + grabs) are done
    // or errored — used by --batch mode to know when to exit.
    bool allTerminal() const;

    // A point-in-time view of one job, for the remote dashboard / API.
    struct TaskSnapshot {
        int           id = 0;
        QString       name;
        DownloadState state = DownloadState::Queued;
        qint64        done = 0;
        qint64        total = -1;     // -1 = unknown
        double        speed = 0.0;    // bytes/sec
    };
    // All jobs (downloads, stream grabs, torrents) ordered by id.
    QVector<TaskSnapshot> snapshot() const;

    // Rebuild unfinished tasks from the database (call once at startup).
    void loadPersisted();

    // Resume every restored task that isn't finished yet (IDM-style).
    void resumeUnfinished();

signals:
    void taskAdded(int id);
    void confirmRequested(int id);   // a held download awaits the user's confirm prompt
    void nameResolved(int id, const QString &name);   // real filename from a pre-download probe
    void taskProgress(int id, qint64 done, qint64 total, double bytesPerSec);
    void taskStateChanged(int id, nexa::DownloadState state, const QString &detail);
    void taskFinished(int id);
    void taskRemoved(int id);
    void taskRenamed(int id, const QString &newName);   // AI rename applied

private slots:
    void cacheProgress(int id, qint64 done, qint64 total, double bytesPerSec);
    void dropProgress(int id);

private:
    QString resolveSavePath(const QUrl &url, const QString &savePath) const;
    QString pathForName(const QString &fileName) const;  // categorise + de-dup
    void    wireTask(DownloadTask *t);
    // Default the known auth sites to "use my logged-in browser" at startup, so
    // yt-dlp reads live cookies and the user never needs to open Site Logins.
    void    autoEnableBrowserLogins();
    // Fetch a remote .torrent file (async, following redirects), then hand the
    // local copy to the libtorrent session. libtorrent can't load an http URL.
    void    fetchTorrentFile(int id, const QUrl &url, const QString &saveDir,
                             const HeaderList &headers);
    void    schedule();              // start queued tasks up to m_maxConcurrent
    int     activeCount() const;     // tasks currently Probing/Downloading
    void    ensureTorrents();        // lazily create the libtorrent session

    struct ProgressInfo { qint64 done = 0; qint64 total = -1; double speed = 0.0; };

    QNetworkAccessManager *m_nam = nullptr;
    Database              *m_db = nullptr;
    TorrentManager        *m_torrents = nullptr;
    AiClient              *m_ai = nullptr;
    AuthenticationManager *m_auth = nullptr;
    RateLimiter           *m_limiter = nullptr;   // global HTTP speed cap
    QHash<int, DownloadTask*> m_tasks;
    QHash<int, HlsGrabber*>   m_grabbers;
    QHash<int, YtDlpGrabber*> m_siteVideos;
    QSet<int>              m_torrentIds;
    QSet<int>              m_playlistIds;   // yt-dlp --yes-playlist jobs (no details plate)
    QSet<int>              m_held;          // created but awaiting the user's confirm prompt
    QHash<int, QTimer*>    m_scheduledTimers;  // cancellable scheduled downloads
    QHash<int, QString>    m_resolvedNames; // real filename from the pre-prompt probe
    bool                   m_confirmBeforeStart = false;
    QHash<int, ProgressInfo>  m_progress;     // latest done/total/speed per id
    QList<int>             m_pending;        // FIFO of ids waiting for a slot
    QString                m_downloadDir;
    int                    m_maxConcurrent = 4;
    int                    m_streamConcurrency = 16;   // HLS parallel segment fetches
    bool                   m_embedSubs = false;        // yt-dlp: fetch + embed subtitles
    QString                m_subLangs = QStringLiteral("en");
    int                    m_plConcurrency = 3;        // playlist videos in parallel
    int                    m_torrentDlLimit = 0;       // B/s, 0 = unlimited
    int                    m_torrentUlLimit = 0;
    double                 m_seedRatio = 0.0;          // 0 = don't seed past completion
    bool                   m_autoCategorize = true;
    bool                   m_aiRename = false;
    bool                   m_inSchedule = false;
};

} // namespace nexa
