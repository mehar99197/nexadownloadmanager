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
class MegaGrabber;
class SpotifyGrabber;
class AiClient;
class Database;
class AuthenticationManager;
class RateLimiter;
class CloudProviders;
class LicenseManager;

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
                     const QString &audioFormat = QString(),  // audio-only sites: m4a/aac/flac/mp3
                     bool publicNetworkOnly = false);       // untrusted browser/dashboard target
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
    QList<int> addRemoteBatch(const QString &text);
    // The single sanitiser every untrusted name goes through before it becomes a
    // path: browser suggestions, Content-Disposition, torrent names. Public and
    // static so the rules can be tested directly.
    static QString sanitizeFileName(const QString &name);

    static QStringList expandPattern(const QString &token);

    // Schedule a download to start at a future time (IDM-style scheduler).
    // Persisted (URL/time/name only — never headers) so it survives a restart;
    // returns the scheduled job id, or -1 for an invalid URL.
    struct ScheduledJob {
        int       id = 0;
        QUrl      url;
        QDateTime when;
        QString   name;
    };
    int scheduleDownload(const QUrl &url, const QDateTime &when,
                         const HeaderList &headers = {}, const QString &name = QString());
    bool cancelScheduled(int id);
    QVector<ScheduledJob> scheduledJobs() const;   // ordered by start time

    void setDownloadDir(const QString &dir) { m_downloadDir = dir; }
    QString downloadDir() const { return m_downloadDir; }

    // Max simultaneously-active file downloads; the rest wait Queued.
    void setMaxConcurrent(int n);
    int  maxConcurrent() const { return m_maxConcurrent; }

    // Global HTTP download speed cap in bytes/sec (0 = unlimited), shared across
    // all active segmented downloads via a token-bucket RateLimiter.
    void   setSpeedLimit(qint64 bytesPerSec);
    qint64 speedLimit() const;

    // Per-download cap in bytes/sec (0 = unlimited), applied on top of the global
    // one. Only meaningful for segmented HTTP downloads; other job types ignore it.
    void   setTaskSpeedLimit(int id, qint64 bytesPerSec);
    qint64 taskSpeedLimit(int id) const;
    bool   supportsSpeedLimit(int id) const { return m_tasks.contains(id); }

    // Sort completed files into per-type subfolders (Video/, Audio/, ...).
    void setAutoCategorize(bool on) { m_autoCategorize = on; }
    bool autoCategorize() const { return m_autoCategorize; }
    static QString categoryFor(const QString &fileName);

    // Parallel segment fetches for HLS stream grabs (applied to new grabbers).
    void setStreamConcurrency(int n) { m_streamConcurrency = qBound(1, n, 64); }
    int  streamConcurrency() const { return m_streamConcurrency; }

    // Network connections actually in flight right now, across every job type.
    // Counted, never inferred from a setting — the UI reports this to the user.
    int  activeConnections() const;

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

    // AI helpers. These run server-side and are entitlement-gated, so
    // aiAvailable() reflects whether this install holds a licence token.
    bool aiAvailable() const;
    void setAiRename(bool on);
    bool aiRename() const { return m_aiRename; }
    void runAiCommand(const QString &naturalLanguage);  // NL -> add/schedule downloads

    DownloadTask *task(int id) const { return m_tasks.value(id, nullptr); }
    QList<DownloadTask*> tasks() const { return m_tasks.values(); }

    // Domain-scoped authentication (cookies.txt / bearer tokens). Lets IpcServer
    // and the UI register credentials; the engine applies them in addDownload().
    AuthenticationManager *auth() const { return m_auth; }
    LicenseManager *license() const { return m_license; }
    QString licensePlan() const { return m_licensePlan; }
    // Why addDownload() would refuse `url` before queuing anything — empty when
    // it would not. The IPC reply carries it so the browser extension shows the
    // same reason the desktop dialog does.
    QString blockReason(const QUrl &url) const;

    // Data-driven cloud provider registry (loaded from JSON at startup).
    CloudProviders *providers() const { return m_providers; }

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
    // A download was queued (not started) solely because the Free plan caps
    // concurrency below what the user asked for — the UI can offer an upgrade.
    void freeLimitReached(int id);
    // A download was refused outright because the plan does not include it
    // (currently: login-gated course sites on Free). Carries a ready-to-show
    // explanation so the UI does not have to reconstruct the reason.
    void downloadBlocked(const QUrl &url, const QString &reason);
    void scheduledAdded(int id);      // a job was scheduled (or restored at startup)
    void scheduledRemoved(int id);    // it fired (became a download) or was cancelled

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
    // Refresh an automatically detected browser session immediately before a
    // site download. Browsers may be opened or switched after Nexa starts.
    void    refreshBrowserLoginFor(const QUrl &url);
    // Fetch a remote .torrent file, then hand the local copy to the libtorrent
    // session (libtorrent can't load an http URL). Redirects are followed
    // MANUALLY and recursively through this same function so the captured
    // credentials can be re-scoped — and dropped — on a cross-host hop;
    // `credHost` carries the origin they belong to across those hops.
    void    fetchTorrentFile(int id, const QUrl &url, const QString &saveDir,
                             const HeaderList &headers,
                             const QString &credHost = QString(), int redirects = 0);
    void    schedule();              // start queued tasks up to m_maxConcurrent
    int     activeCount() const;     // tasks currently Probing/Downloading
    void    ensureTorrents();        // lazily create the libtorrent session
    int     addRemoteDownload(const QUrl &url);
    void    applyLicensePlan(const QString &plan);
    bool    isAuthSiteUrl(const QUrl &url) const;
    void    armScheduled(int id, const QUrl &url, const QDateTime &when,
                         const HeaderList &headers, const QString &name);

    struct ProgressInfo { qint64 done = 0; qint64 total = -1; double speed = 0.0; };

    QNetworkAccessManager *m_nam = nullptr;
    Database              *m_db = nullptr;
    TorrentManager        *m_torrents = nullptr;
    AiClient              *m_ai = nullptr;
    AuthenticationManager *m_auth = nullptr;
    RateLimiter           *m_limiter = nullptr;   // global HTTP speed cap
    CloudProviders        *m_providers = nullptr; // data-driven cloud provider registry
    LicenseManager        *m_license = nullptr;
    QHash<int, DownloadTask*> m_tasks;
    QHash<int, HlsGrabber*>   m_grabbers;
    QHash<int, YtDlpGrabber*> m_siteVideos;
    QHash<int, MegaGrabber*>  m_megaGrabbers;
    QHash<int, SpotifyGrabber*> m_spotifyGrabbers;
    QSet<int>              m_torrentIds;
    QSet<int>              m_playlistIds;   // yt-dlp --yes-playlist jobs (no details plate)
    QSet<int>              m_held;          // created but awaiting the user's confirm prompt
    QHash<int, QTimer*>    m_scheduledTimers;  // cancellable scheduled downloads
    QHash<int, ScheduledJob> m_scheduled;      // what each timer will start
    QHash<int, QString>    m_resolvedNames; // real filename from the pre-prompt probe
    bool                   m_confirmBeforeStart = false;
    QHash<int, ProgressInfo>  m_progress;     // latest done/total/speed per id
    QList<int>             m_pending;        // FIFO of ids waiting for a slot
    QString                m_downloadDir;
    int                    m_maxConcurrent = 3;
    int                    m_requestedMaxConcurrent = 4;
    int                    m_streamConcurrency = 16;   // HLS parallel segment fetches
    bool                   m_embedSubs = false;        // yt-dlp: fetch + embed subtitles
    QString                m_subLangs = QStringLiteral("en");
    int                    m_plConcurrency = 3;        // playlist videos in parallel
    int                    m_torrentDlLimit = 0;       // B/s, 0 = unlimited
    int                    m_torrentUlLimit = 0;
    double                 m_seedRatio = 0.0;          // 0 = don't seed past completion
    bool                   m_autoCategorize = true;
    bool                   m_aiRename = false;
    // Mirrors Entitlements::authSiteDownloads. Free by default so a build that
    // has not yet heard from the licence server gates rather than leaks.
    bool                   m_authSiteDownloads = false;
    bool                   m_aiRenameRequested = false;
    QString                m_licensePlan = QStringLiteral("free");
    bool                   m_inSchedule = false;
};

} // namespace nexa
