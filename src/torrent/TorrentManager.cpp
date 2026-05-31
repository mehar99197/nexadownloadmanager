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
};

TorrentManager::TorrentManager(QObject *parent)
    : QObject(parent), d(std::make_unique<Impl>())
{
    lt::settings_pack sp;
    sp.set_int(lt::settings_pack::alert_mask,
               lt::alert_category::status | lt::alert_category::error);
    // Reasonable defaults; let libtorrent pick ports + enable DHT/LSD/UPnP.
    sp.set_str(lt::settings_pack::user_agent, "Nexa/0.1 libtorrent");
    sp.set_bool(lt::settings_pack::enable_dht, true);
    d->session = new lt::session(sp);

    auto *timer = new QTimer(this);
    connect(timer, &QTimer::timeout, this, &TorrentManager::poll);
    timer->start(1000);
}

TorrentManager::~TorrentManager()
{
    delete d->session;   // blocks briefly while the session shuts down
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
    if (it != d->handles.end() && it->is_valid())
        it->pause();
}

void TorrentManager::resume(int id)
{
    auto it = d->handles.find(id);
    if (it != d->handles.end() && it->is_valid())
        it->resume();
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
    if (st.flags & lt::torrent_flags::paused)
        return DownloadState::Paused;
    if (st.state == lt::torrent_status::finished ||
        st.state == lt::torrent_status::seeding)
        return DownloadState::Completed;
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

    for (auto it = d->handles.begin(); it != d->handles.end(); ++it) {
        const int id = it.key();
        if (!it->is_valid())
            continue;

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
                d->completed.insert(id);
                it->pause();   // stop seeding — this is a download manager
                emit stateChanged(id, DownloadState::Completed,
                                  QStringLiteral("complete (%1 peers)").arg(st.num_peers));
                emit finished(id);
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
