#include "torrent/TorrentManager.h"

#include <QTimer>
#include <QHash>
#include <QSet>
#include <QFileInfo>
#include <QDir>
#include <QUrl>
#include <QDebug>

#include <libtorrent/session.hpp>
#include <libtorrent/session_params.hpp>
#include <libtorrent/settings_pack.hpp>
#include <libtorrent/add_torrent_params.hpp>
#include <libtorrent/torrent_handle.hpp>
#include <libtorrent/torrent_status.hpp>
#include <libtorrent/torrent_flags.hpp>
#include <libtorrent/magnet_uri.hpp>
#include <libtorrent/torrent_info.hpp>
#include <libtorrent/alert_types.hpp>

namespace lt = libtorrent;

namespace nexa {

static const bool kDebug = qEnvironmentVariableIsSet("NEXA_DEBUG");

struct TorrentManager::Impl {
    lt::session                    *session = nullptr;
    QHash<int, lt::torrent_handle>  handles;
    QHash<int, QString>             names;
    QSet<int>                       completed;   // ids we've already signalled done
    QSet<int>                       errored;     // ids already reported as failed
    int                             dlLimit = 0; // session download cap, B/s (0=∞)
    int                             ulLimit = 0; // session upload cap, B/s (0=∞)
    double                          seedRatio = 0.0;  // 0 = don't seed past completion
};

TorrentManager::TorrentManager(QObject *parent)
    : QObject(parent), d(std::make_unique<Impl>())
{
    lt::settings_pack sp;
    sp.set_int(lt::settings_pack::alert_mask,
               lt::alert_category::status | lt::alert_category::error);
    sp.set_str(lt::settings_pack::user_agent, "Nexa/0.1 libtorrent");

    // ---- Aggressive throughput tuning -----------------------------------
    // Saturate the swarm: connect to many more peers, ramp them up fast, and
    // never throttle. libtorrent's defaults (200 conns, slow connect rate) leave
    // a lot of bandwidth unused on a well-seeded torrent.
    sp.set_int(lt::settings_pack::connections_limit,   1200);   // global peer cap (def 200)
    sp.set_int(lt::settings_pack::connection_speed,     500);   // new conns/sec (def ~30)
    sp.set_int(lt::settings_pack::active_downloads,      16);   // def 3
    sp.set_int(lt::settings_pack::active_seeds,           8);
    sp.set_int(lt::settings_pack::active_limit,          64);   // def 15
    sp.set_int(lt::settings_pack::unchoke_slots_limit,   64);   // def 8
    sp.set_int(lt::settings_pack::download_rate_limit,    0);   // 0 = unlimited
    sp.set_int(lt::settings_pack::upload_rate_limit,      0);
    // Bigger socket buffers + auto-tuned send/recv so a fat pipe isn't starved.
    sp.set_int(lt::settings_pack::send_buffer_watermark, 3 * 1024 * 1024);
    sp.set_bool(lt::settings_pack::enable_outgoing_utp,  true);
    sp.set_bool(lt::settings_pack::enable_incoming_utp,  true);

    // Maximise peer discovery: DHT + local discovery + port mapping.
    sp.set_bool(lt::settings_pack::enable_dht,    true);
    sp.set_bool(lt::settings_pack::enable_lsd,    true);
    sp.set_bool(lt::settings_pack::enable_upnp,   true);
    sp.set_bool(lt::settings_pack::enable_natpmp, true);

    d->session = new lt::session(sp);

    auto *timer = new QTimer(this);
    connect(timer, &QTimer::timeout, this, &TorrentManager::poll);
    timer->start(1000);
}

TorrentManager::~TorrentManager()
{
    delete d->session;   // blocks briefly while the session shuts down
}

void TorrentManager::setSpeedLimits(int downloadBytesPerSec, int uploadBytesPerSec)
{
    d->dlLimit = qMax(0, downloadBytesPerSec);
    d->ulLimit = qMax(0, uploadBytesPerSec);
    if (!d->session)
        return;
    lt::settings_pack sp;
    sp.set_int(lt::settings_pack::download_rate_limit, d->dlLimit);
    sp.set_int(lt::settings_pack::upload_rate_limit,   d->ulLimit);
    d->session->apply_settings(sp);   // live; affects all current + future torrents
}

void TorrentManager::setSeedRatio(double ratio)
{
    d->seedRatio = qMax(0.0, ratio);
}

bool TorrentManager::isTorrentUrl(const QString &s)
{
    const QString t = s.trimmed();
    return t.startsWith(QStringLiteral("magnet:"), Qt::CaseInsensitive) ||
           t.endsWith(QStringLiteral(".torrent"), Qt::CaseInsensitive);
}

bool TorrentManager::add(int id, const QString &magnetOrPath, const QString &saveDir)
{
    QDir().mkpath(saveDir);
    lt::add_torrent_params atp;
    try {
        if (magnetOrPath.startsWith(QStringLiteral("magnet:"), Qt::CaseInsensitive)) {
            atp = lt::parse_magnet_uri(magnetOrPath.toStdString());
        } else {
            // Local .torrent file (strip a file:// scheme if present).
            QString path = magnetOrPath;
            if (path.startsWith(QStringLiteral("file://")))
                path = QUrl(path).toLocalFile();
            atp.ti = std::make_shared<lt::torrent_info>(path.toStdString());
        }
    } catch (const std::exception &e) {
        emit stateChanged(id, DownloadState::Error,
                          QStringLiteral("invalid torrent: %1").arg(e.what()));
        return false;
    }

    atp.save_path = saveDir.toStdString();
    atp.max_connections = 500;   // per-torrent peer cap (this is a single big download)
    atp.max_uploads     = 16;
    try {
        lt::torrent_handle h = d->session->add_torrent(std::move(atp));
        d->handles.insert(id, h);
        const QString nm = QString::fromStdString(h.status().name);
        d->names.insert(id, nm.isEmpty() ? QStringLiteral("torrent") : nm);
        emit stateChanged(id, DownloadState::Probing,
                          QStringLiteral("connecting / fetching metadata"));
    } catch (const std::exception &e) {
        emit stateChanged(id, DownloadState::Error,
                          QStringLiteral("add failed: %1").arg(e.what()));
        return false;
    }
    return true;
}

void TorrentManager::pause(int id)
{
    auto it = d->handles.find(id);
    if (it != d->handles.end() && it->is_valid()) {
        // add_torrent_params defaults to torrent_flags::default_flags, which
        // INCLUDES auto_managed. An auto-managed torrent is owned by libtorrent's
        // queue manager, which re-starts it within a second or so — making a bare
        // pause() a silent no-op. Drop out of auto-management first so the pause
        // actually sticks; resume() puts it back.
        it->unset_flags(lt::torrent_flags::auto_managed);
        it->pause();
    }
}

void TorrentManager::resume(int id)
{
    auto it = d->handles.find(id);
    if (it != d->handles.end() && it->is_valid()) {
        it->resume();
        // Hand the torrent back to the queue manager so session-wide limits
        // (active_downloads/active_seeds) keep applying.
        it->set_flags(lt::torrent_flags::auto_managed);
    }
}

void TorrentManager::remove(int id, bool deleteFiles)
{
    auto it = d->handles.find(id);
    if (it != d->handles.end() && it->is_valid()) {
        d->session->remove_torrent(*it,
            deleteFiles ? lt::session::delete_files : lt::remove_flags_t{});
    }
    d->handles.remove(id);
    d->names.remove(id);
    d->completed.remove(id);
}

bool TorrentManager::has(int id) const
{
    return d->handles.contains(id);
}

QString TorrentManager::nameOf(int id) const
{
    return d->names.value(id, QStringLiteral("torrent"));
}

DownloadState TorrentManager::stateOf(int id) const
{
    auto it = d->handles.constFind(id);
    if (it == d->handles.constEnd() || !it->is_valid())
        return DownloadState::Queued;

    const lt::torrent_status st = it->status();
    // Finished/seeding wins over the paused flag: a completed download that we
    // auto-paused (seed ratio reached, or "don't seed") is still Completed, not
    // Paused. Only an unfinished, paused torrent reports Paused.
    if (st.state == lt::torrent_status::finished ||
        st.state == lt::torrent_status::seeding)
        return DownloadState::Completed;
    if (st.flags & lt::torrent_flags::paused)
        return DownloadState::Paused;
    if (st.state == lt::torrent_status::downloading_metadata ||
        st.state == lt::torrent_status::checking_files ||
        st.state == lt::torrent_status::checking_resume_data)
        return DownloadState::Probing;
    return DownloadState::Downloading;
}

void TorrentManager::poll()
{
    // Drain alerts so the queue doesn't grow unbounded (status read directly).
    std::vector<lt::alert*> alerts;
    d->session->pop_alerts(&alerts);

    // Inspect them before dropping them. These are the ONLY channel through which
    // libtorrent reports a fatal problem — a corrupt/unreadable .torrent, a disk
    // write failure, or a magnet whose metadata never resolved. Discarding the
    // whole queue meant such a torrent simply sat at 0% forever with no error
    // ever reaching the user.
    const auto idForHandle = [this](const lt::torrent_handle &h) -> int {
        for (auto it = d->handles.cbegin(); it != d->handles.cend(); ++it) {
            if (it.value() == h)
                return it.key();
        }
        return -1;
    };
    const auto reportFailure = [this](int id, const QString &why) {
        if (id < 0 || d->errored.contains(id))
            return;                       // unknown handle, or already reported
        d->errored.insert(id);
        emit stateChanged(id, DownloadState::Error, why);
    };
    for (lt::alert *a : alerts) {
        if (const auto *e = lt::alert_cast<lt::torrent_error_alert>(a)) {
            reportFailure(idForHandle(e->handle),
                          QStringLiteral("torrent error: %1")
                              .arg(QString::fromStdString(e->error.message())));
        } else if (const auto *e = lt::alert_cast<lt::file_error_alert>(a)) {
            reportFailure(idForHandle(e->handle),
                          QStringLiteral("disk error: %1")
                              .arg(QString::fromStdString(e->error.message())));
        } else if (const auto *e = lt::alert_cast<lt::metadata_failed_alert>(a)) {
            reportFailure(idForHandle(e->handle),
                          QStringLiteral("could not fetch torrent metadata: %1")
                              .arg(QString::fromStdString(e->error.message())));
        }
        // Tracker/peer errors are routine (many trackers are dead) and must NOT
        // fail the torrent — DHT/PEX can still find peers.
    }

    for (auto it = d->handles.begin(); it != d->handles.end(); ++it) {
        const int id = it.key();
        if (!it->is_valid())
            continue;
        if (d->errored.contains(id))
            continue;   // already failed above; don't overwrite Error with a status

        const lt::torrent_status st = it->status();

        // Cache the name once metadata arrives.
        const QString nm = QString::fromStdString(st.name);
        if (!nm.isEmpty() && d->names.value(id) != nm)
            d->names[id] = nm;

        const qint64 done   = static_cast<qint64>(st.total_done);
        const qint64 wanted = static_cast<qint64>(st.total_wanted);
        const double rate    = static_cast<double>(st.download_rate);
        emit progress(id, done, wanted > 0 ? wanted : -1, rate);

        if (kDebug) {
            qDebug().noquote()
                << "NEXA TORRENT" << id
                << "state=" << int(st.state)
                << "peers=" << st.num_peers
                << "seeds=" << st.num_seeds
                << "done=" << done << "/" << wanted
                << "rate=" << int(rate / 1024) << "KB/s"
                << "name=" << QString::fromStdString(st.name);
        }

        const bool paused     = bool(st.flags & lt::torrent_flags::paused);
        const bool isFinished = (st.state == lt::torrent_status::finished ||
                                 st.state == lt::torrent_status::seeding);

        if (isFinished) {
            if (!d->completed.contains(id)) {
                // First time we see it done: the file is usable now, so signal
                // Completed. Stop immediately unless the user opted to seed to a
                // ratio, in which case we keep seeding in the background.
                d->completed.insert(id);
                if (d->seedRatio <= 0.0)
                    it->pause();
                emit stateChanged(id, DownloadState::Completed,
                                  QStringLiteral("complete (%1 peers)").arg(st.num_peers));
                emit finished(id);
            } else if (d->seedRatio > 0.0 && !paused) {
                // Already completed and seeding: stop once the target share ratio
                // (uploaded / downloaded) is reached, so we don't seed forever.
                const qint64 down = qMax<qint64>(1, qint64(st.all_time_download));
                const double ratio = double(st.all_time_upload) / double(down);
                if (ratio >= d->seedRatio)
                    it->pause();
            }
            continue;
        }

        QString detail;
        DownloadState state;
        switch (st.state) {
            case lt::torrent_status::downloading_metadata:
                state = DownloadState::Probing;
                detail = QStringLiteral("fetching metadata (%1 peers)").arg(st.num_peers);
                break;
            case lt::torrent_status::checking_files:
            case lt::torrent_status::checking_resume_data:
                state = DownloadState::Probing;
                detail = QStringLiteral("checking");
                break;
            default:
                state = paused ? DownloadState::Paused : DownloadState::Downloading;
                detail = QStringLiteral("%1% · %2 peers · %3 KB/s")
                             .arg(int(st.progress * 100))
                             .arg(st.num_peers)
                             .arg(int(rate / 1024));
                break;
        }
        emit stateChanged(id, state, detail);
    }
}

} // namespace nexa
