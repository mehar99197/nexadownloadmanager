#include "site/SpotifyGrabber.h"
#include "core/ExternalTools.h"

#include <QNetworkRequest>
#include <QNetworkReply>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QJsonArray>
#include <QJsonParseError>
#include <QProcess>
#include <QSet>
#include <QFile>
#include <QFileInfo>
#include <QDir>
#include <QRegularExpression>
#include <QStandardPaths>
#include <QDebug>

namespace nexa {

static const bool kDebug = qEnvironmentVariableIsSet("NEXA_DEBUG");

// A stable browser User-Agent: Spotify's edge 403s requests with no/empty UA.
static const QString kUA = QStringLiteral(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36");

namespace {

// Parse open.spotify.com/<type>/<id>, /embed/<type>/<id>, and spotify:<type>:<id>
// into type ("track"/"album"/"playlist") + id.
bool parseSpotifyUrl(const QUrl &url, QString &type, QString &id)
{
    const QString scheme = url.scheme().toLower();
    if (scheme == QLatin1String("spotify")) {
        const QString p = url.toString().mid(QString::fromLatin1("spotify:").length());
        const int colon = p.indexOf(QLatin1Char(':'));
        if (colon <= 0)
            return false;
        type = p.left(colon).toLower();
        id = p.mid(colon + 1);
    } else {
        if (scheme != QLatin1String("http") && scheme != QLatin1String("https"))
            return false;
        const QString host = url.host().toLower();
        if (host != QLatin1String("open.spotify.com")
            && host != QLatin1String("play.spotify.com"))
            return false;
        QStringList parts = url.path().split(QLatin1Char('/'), Qt::SkipEmptyParts);
        if (!parts.isEmpty() && parts.first() == QLatin1String("embed"))
            parts.removeFirst();
        if (parts.size() < 2)
            return false;
        type = parts.at(0).toLower();
        id = parts.at(1);
    }
    return (type == QLatin1String("track") || type == QLatin1String("album")
            || type == QLatin1String("playlist")) && !id.isEmpty();
}

// Extract the JSON blob from <script id="__NEXT_DATA__" ...>...</script>.
QString extractNextData(const QString &html)
{
    static const QRegularExpression re(
        QStringLiteral("<script id=\"__NEXT_DATA__\"[^>]*>(.*?)</script>"),
        QRegularExpression::DotMatchesEverythingOption);
    const auto m = re.match(html);
    return m.hasMatch() ? m.captured(1) : QString();
}

// A raw track node collected from the embed JSON.
struct RawTrack {
    QString uri, name;
    QStringList artists;
    QString previewUrl, artUrl, album, release;
    qint64 durationMs = 0;
};

// Album/playlist embeds keep cover art, album name and release date on the
// container object (the one owning "trackList"); individual track nodes there
// only carry "title"/"subtitle"/"audioPreview"/"duration". Single-track embeds
// carry everything on the track object itself. These defaults are threaded down
// so every track still gets art/album info when its own node lacks it.
struct Inherit {
    QString artUrl, album, release;
    QStringList artists;
};

// Largest cover image from visualIdentity.image[] (or empty if none).
QString bestImage(const QJsonObject &o)
{
    const QJsonValue vi = o.value(QLatin1String("visualIdentity"));
    if (!vi.isObject())
        return QString();
    const QJsonValue img = vi.toObject().value(QLatin1String("image"));
    if (!img.isArray())
        return QString();
    int bestSize = -1;
    QString bestUrl;
    for (const QJsonValue &im : img.toArray()) {
        const QJsonObject io = im.toObject();
        const int sz = io.value(QLatin1String("maxHeight")).toInt(0);
        if (sz > bestSize) {
            bestSize = sz;
            bestUrl = io.value(QLatin1String("url")).toString();
        }
    }
    return bestUrl;
}

// Build inherited defaults from an album/playlist container object.
Inherit inheritFrom(const QJsonObject &o, const Inherit &fallback)
{
    Inherit r = fallback;
    const QString art = bestImage(o);
    if (!art.isEmpty())
        r.artUrl = art;
    const QString nm = o.value(QLatin1String("name")).toString();
    if (!nm.isEmpty())
        r.album = nm;
    const QJsonValue rd = o.value(QLatin1String("releaseDate"));
    if (rd.isObject()) {
        const QString iso = rd.toObject().value(QLatin1String("isoString")).toString();
        if (!iso.isEmpty())
            r.release = iso;
    } else if (rd.isString() && !rd.toString().isEmpty()) {
        r.release = rd.toString();
    }
    const QJsonValue av = o.value(QLatin1String("artists"));
    if (av.isArray()) {
        QStringList names;
        for (const QJsonValue &a : av.toArray()) {
            const QString an = a.toObject().value(QLatin1String("name")).toString();
            if (!an.isEmpty())
                names.append(an);
        }
        if (!names.isEmpty())
            r.artists = names;
    }
    if (r.artists.isEmpty()) {
        const QString sub = o.value(QLatin1String("subtitle")).toString();
        if (!sub.isEmpty()) {
            QStringList names;
            const QStringList parts = sub.split(QStringLiteral(", "), Qt::SkipEmptyParts);
            for (QString p : parts) {
                p = p.trimmed();
                if (!p.isEmpty())
                    names.append(p);
            }
            if (!names.isEmpty())
                r.artists = names;
        }
    }
    return r;
}

// Recursively walk the JSON, collecting every object whose "uri" is a
// spotify:track:... string and that has a non-empty "name"/"title". First-seen
// order wins; duplicates by URI are skipped.
void walkTracks(const QJsonValue &v, const Inherit &inh, QSet<QString> &seen,
                QList<RawTrack> &out)
{
    if (v.isObject()) {
        const QJsonObject o = v.toObject();

        // Album/playlist container: derive inherited defaults for its tracks.
        Inherit next = inh;
        if (o.contains(QLatin1String("trackList")))
            next = inheritFrom(o, inh);

        const QJsonValue uriV = o.value(QLatin1String("uri"));
        if (uriV.isString()) {
            const QString uri = uriV.toString();
            if (uri.startsWith(QLatin1String("spotify:track:"))
                && !seen.contains(uri)) {
                // Track embeds use "name"; album/playlist trackList uses "title".
                QString name = o.value(QLatin1String("name")).toString();
                if (name.isEmpty())
                    name = o.value(QLatin1String("title")).toString();
                if (!name.isEmpty()) {
                    seen.insert(uri);
                    RawTrack rt;
                    rt.uri = uri;
                    rt.name = name;

                    const QJsonValue av = o.value(QLatin1String("artists"));
                    if (av.isArray())
                        for (const QJsonValue &a : av.toArray()) {
                            const QString an = a.toObject().value(QLatin1String("name")).toString();
                            if (!an.isEmpty())
                                rt.artists.append(an);
                        }
                    if (rt.artists.isEmpty()) {
                        const QString sub = o.value(QLatin1String("subtitle")).toString();
                        if (!sub.isEmpty()) {
                            const QStringList parts = sub.split(QStringLiteral(", "), Qt::SkipEmptyParts);
                            for (QString p : parts) {
                                p = p.trimmed();
                                if (!p.isEmpty())
                                    rt.artists.append(p);
                            }
                        }
                    }
                    if (rt.artists.isEmpty())
                        rt.artists = next.artists;

                    const QJsonValue ap = o.value(QLatin1String("audioPreview"));
                    if (ap.isObject())
                        rt.previewUrl = ap.toObject().value(QLatin1String("url")).toString();
                    if (rt.previewUrl.isEmpty())
                        rt.previewUrl = o.value(QLatin1String("preview_url")).toString();

                    const QJsonValue albV = o.value(QLatin1String("album"));
                    if (albV.isObject())
                        rt.album = albV.toObject().value(QLatin1String("name")).toString();
                    if (rt.album.isEmpty())
                        rt.album = next.album;

                    rt.artUrl = bestImage(o);
                    if (rt.artUrl.isEmpty())
                        rt.artUrl = next.artUrl;

                    const QJsonValue dur = o.value(QLatin1String("duration"));
                    if (dur.isObject())
                        rt.durationMs = dur.toObject().value(QLatin1String("totalMilliseconds")).toVariant().toLongLong();
                    else if (dur.isDouble())
                        rt.durationMs = qint64(dur.toDouble());
                    else if (o.value(QLatin1String("duration_ms")).isDouble())
                        rt.durationMs = qint64(o.value(QLatin1String("duration_ms")).toDouble());

                    const QJsonValue rd = o.value(QLatin1String("releaseDate"));
                    if (rd.isObject())
                        rt.release = rd.toObject().value(QLatin1String("isoString")).toString();
                    else if (rd.isString())
                        rt.release = rd.toString();
                    if (rt.release.isEmpty())
                        rt.release = next.release;
                    out.append(rt);
                }
            }
        }
        for (auto it = o.begin(); it != o.end(); ++it)
            walkTracks(it.value(), next, seen, out);
    } else if (v.isArray()) {
        for (const QJsonValue &e : v.toArray())
            walkTracks(e, inh, seen, out);
    }
}

double applyUnit(double v, const QString &unit)
{
    const QChar u = unit.isEmpty() ? QChar() : unit.at(0).toUpper();
    if (u == QLatin1Char('K')) v *= 1024.0;
    else if (u == QLatin1Char('M')) v *= 1024.0 * 1024;
    else if (u == QLatin1Char('G')) v *= 1024.0 * 1024 * 1024;
    else if (u == QLatin1Char('T')) v *= 1024.0 * 1024 * 1024 * 1024;
    return v;
}

// "2.50MiB" -> bytes
qint64 parseSizeToken(const QString &s)
{
    static const QRegularExpression re(QStringLiteral("([\\d.]+)\\s*([KMGT]?)i?B"));
    const auto m = re.match(s);
    return m.hasMatch() ? qint64(applyUnit(m.captured(1).toDouble(), m.captured(2))) : -1;
}

// "1.20MiB/s" -> bytes/second
double parseRateToken(const QString &s)
{
    static const QRegularExpression re(QStringLiteral("([\\d.]+)\\s*([KMGT]?)i?B/s"));
    const auto m = re.match(s);
    return m.hasMatch() ? applyUnit(m.captured(1).toDouble(), m.captured(2)) : 0.0;
}

} // namespace

bool SpotifyGrabber::isSpotifyUrl(const QUrl &url)
{
    QString t, i;
    return parseSpotifyUrl(url, t, i);
}

bool SpotifyGrabber::isSpotifyCdnUrl(const QUrl &url)
{
    const QString host = url.host().toLower();
    return host.endsWith(QLatin1String(".spotifycdn.com"))
        || host == QLatin1String("spotifycdn.com");
}

SpotifyGrabber::SpotifyGrabber(int id, const QUrl &url, const QString &saveDir,
                               QNetworkAccessManager *nam, QObject *parent)
    : QObject(parent), m_id(id), m_url(url), m_saveDir(saveDir), m_nam(nam)
{
    const QByteArray env = qgetenv("NEXA_SPOTIFY_MODE");
    if (!env.isEmpty())
        m_mode = QString::fromLatin1(env).toLower();
    // Provisional save path so the confirm-before-start prompt defaults to the
    // right FOLDER (saveDir) even before metadata resolves the real filename.
    // Without this, savePathOf() is empty while a Spotify grab is held, and the
    // prompt falls back to QDir::homePath(), silently redirecting the download
    // out of the chosen download directory. The real path is set once the embed
    // metadata resolves (onEmbedFetched / startTagging).
    m_savePath = QDir(m_saveDir).filePath(QStringLiteral("spotify-track.mp3"));
}

SpotifyGrabber::~SpotifyGrabber()
{
    cancel();
}

void SpotifyGrabber::setMode(const QString &m)
{
    const QString mm = m.trimmed().toLower();
    if (mm == QLatin1String("full") || mm == QLatin1String("preview") || mm == QLatin1String("auto"))
        m_mode = mm;
}

void SpotifyGrabber::setAudioFormat(const QString &fmt)
{
    const QString f = fmt.trimmed().toLower();
    if (f == QLatin1String("mp3") || f == QLatin1String("m4a")
        || f == QLatin1String("aac") || f == QLatin1String("flac"))
        m_audioFormat = f;
}

QString SpotifyGrabber::sanitizeName(const QString &s)
{
    QString out = s;
    out.replace(QRegularExpression(QStringLiteral("[\\\\/:*?\"<>|]")), QStringLiteral("_"));
    out.replace(QRegularExpression(QStringLiteral("\\s+")), QStringLiteral(" "));
    return out.trimmed();
}

QString SpotifyGrabber::fileName() const
{
    if (!m_savePath.isEmpty() && QFileInfo(m_savePath).isFile())
        return QFileInfo(m_savePath).fileName();
    if (m_tracks.size() == 1) {
        const Track &t = m_tracks.first();
        return QStringLiteral("%1 - %2.%3")
            .arg(sanitizeName(t.artists.join(QStringLiteral(", "))),
                 sanitizeName(t.name), m_audioFormat);
    }
    if (!m_tracks.isEmpty())
        return QStringLiteral("%1 tracks").arg(m_tracks.size());
    return QStringLiteral("spotify download");
}

QString SpotifyGrabber::targetPath(const Track &t) const
{
    const QString base = sanitizeName(
        (t.artists.isEmpty() ? QString() : t.artists.join(QStringLiteral(", ")) + QStringLiteral(" - "))
        + t.name);
    const QString name = base.isEmpty() ? QStringLiteral("spotify-track") : base;
    QString candidate = QDir(m_saveDir).filePath(name + QStringLiteral(".") + m_audioFormat);
    int n = 1;
    while (QFile::exists(candidate)) {
        const QFileInfo fi(candidate);
        candidate = QDir(m_saveDir).filePath(
            QStringLiteral("%1 (%2).%3").arg(fi.completeBaseName()).arg(n).arg(m_audioFormat));
        ++n;
    }
    return candidate;
}

void SpotifyGrabber::setState(DownloadState s, const QString &detail)
{
    if (kDebug)
        qDebug().noquote() << "Spotify" << m_id << "->" << stateToString(s) << detail;
    m_state = s;
    emit stateChanged(m_id, s, detail);
}

void SpotifyGrabber::fail(const QString &reason)
{
    setState(DownloadState::Error, reason);
    emit finished(m_id);
}

void SpotifyGrabber::start()
{
    if (m_cancelled)
        return;
    QString type, id;
    if (!parseSpotifyUrl(m_url, type, id)) {
        fail(QStringLiteral("not a Spotify track/album/playlist URL"));
        return;
    }
    // Resolve effective mode: "auto" -> full if yt-dlp is present, else preview.
    if (m_mode == QLatin1String("auto"))
        m_mode = resolveTool(QStringLiteral("yt-dlp")).isEmpty()
                 ? QStringLiteral("preview") : QStringLiteral("full");

    m_tmpDir = QDir(QStandardPaths::writableLocation(QStandardPaths::TempLocation))
                   .filePath(QStringLiteral("nexa-spotify-%1").arg(m_id));
    QDir().mkpath(m_tmpDir);

    setState(DownloadState::Probing, QStringLiteral("reading Spotify metadata"));
    QNetworkRequest req(QUrl(QStringLiteral("https://open.spotify.com/embed/%1/%2").arg(type, id)));
    req.setHeader(QNetworkRequest::UserAgentHeader, kUA);
    req.setRawHeader("Accept", "text/html,application/xhtml+xml");
    m_embedReply = m_nam->get(req);
    connect(m_embedReply, &QNetworkReply::finished, this, &SpotifyGrabber::onEmbedFetched);
}

void SpotifyGrabber::onEmbedFetched()
{
    if (!m_embedReply)
        return;
    QNetworkReply *r = m_embedReply;
    m_embedReply = nullptr;
    r->deleteLater();
    if (r->error() != QNetworkReply::NoError) {
        fail(QStringLiteral("could not fetch Spotify metadata: ") + r->errorString());
        return;
    }
    const QString html = QString::fromUtf8(r->readAll());
    const QString json = extractNextData(html);
    if (json.isEmpty()) {
        fail(QStringLiteral("Spotify metadata not found (page layout changed?)"));
        return;
    }
    QJsonParseError pe;
    const QJsonDocument doc = QJsonDocument::fromJson(json.toUtf8(), &pe);
    if (pe.error != QJsonParseError::NoError) {
        fail(QStringLiteral("could not parse Spotify metadata: ") + pe.errorString());
        return;
    }
    QList<RawTrack> raws;
    QSet<QString> seen;
    walkTracks(doc.object(), Inherit(), seen, raws);
    for (const RawTrack &rt : raws) {
        Track t;
        t.uri = rt.uri; t.name = rt.name; t.artists = rt.artists;
        t.album = rt.album; t.artUrl = rt.artUrl; t.previewUrl = rt.previewUrl;
        t.durationMs = rt.durationMs; t.releaseDate = rt.release; t.valid = true;
        m_tracks.append(t);
    }
    if (m_tracks.isEmpty()) {
        fail(QStringLiteral("no playable tracks found at this Spotify link"));
        return;
    }
    if (m_tracks.size() == 1)
        m_savePath = targetPath(m_tracks.first());
    else
        m_savePath = m_saveDir;   // a folder; remove() won't delete it (isFile() check)
    processNextTrack();
}

void SpotifyGrabber::processNextTrack()
{
    if (m_cancelled)
        return;
    if (m_trackIndex >= m_tracks.size()) {
        setState(DownloadState::Completed,
                 m_tracks.size() == 1 ? QStringLiteral("done")
                                      : QStringLiteral("%1/%2 tracks").arg(m_tracks.size()).arg(m_tracks.size()));
        emit finished(m_id);
        return;
    }
    const Track &t = m_tracks.at(m_trackIndex);
    m_curDone = 0; m_curTotal = -1; m_lastPct = -1; m_lastError.clear(); m_previewBuffer.clear();
    if (!m_clock.isValid())
        m_clock.start();
    const QString where = (m_mode == QLatin1String("full"))
                          ? QStringLiteral("YouTube match") : QStringLiteral("30s preview");
    setState(DownloadState::Downloading,
             QStringLiteral("%1/%2 · %3 · %4")
                 .arg(m_trackIndex + 1).arg(m_tracks.size())
                 .arg(sanitizeName(t.artists.join(QStringLiteral(", ")) + QStringLiteral(" - ") + t.name),
                      where));
    if (m_mode == QLatin1String("full"))
        startFullDownload(t);
    else
        startPreviewDownload(t);
}

void SpotifyGrabber::startPreviewDownload(const Track &t)
{
    if (t.previewUrl.isEmpty()) {
        // No preview for this track — fall back to a full YouTube match if possible.
        if (!resolveTool(QStringLiteral("yt-dlp")).isEmpty()) {
            m_mode = QStringLiteral("full");
            startFullDownload(t);
        } else {
            fail(QStringLiteral("no preview available and yt-dlp is not installed for a full match"));
        }
        return;
    }
    QNetworkRequest req(QUrl(t.previewUrl));
    req.setHeader(QNetworkRequest::UserAgentHeader, kUA);
    req.setRawHeader("Accept", "audio/*");
    m_previewReply = m_nam->get(req);
    connect(m_previewReply, &QIODevice::readyRead, this, &SpotifyGrabber::onPreviewReadyRead);
    connect(m_previewReply, &QNetworkReply::finished, this, &SpotifyGrabber::onPreviewFinished);
    if (kDebug)
        qDebug().noquote() << "Spotify" << m_id << "preview" << t.previewUrl;
}

void SpotifyGrabber::onPreviewReadyRead()
{
    if (!m_previewReply)
        return;
    m_previewBuffer += m_previewReply->readAll();
    const qint64 total = m_previewReply->header(QNetworkRequest::ContentLengthHeader).toLongLong();
    if (total > 0)
        m_curTotal = total;
    m_curDone = m_previewBuffer.size();
    const double bps = m_curDone / qMax(1.0, m_clock.elapsed() / 1000.0);
    emit progress(m_id, m_doneBytes + m_curDone,
                 m_tracks.size() > 1 ? (m_sumTotal > 0 ? m_sumTotal : -1) : m_curTotal, bps);
}

void SpotifyGrabber::onPreviewFinished()
{
    if (!m_previewReply)
        return;
    QNetworkReply *r = m_previewReply;
    m_previewReply = nullptr;
    r->deleteLater();
    if (r->error() != QNetworkReply::NoError) {
        fail(QStringLiteral("preview download failed: ") + r->errorString());
        return;
    }
    const QString tmpAudio = QDir(m_tmpDir).filePath(QStringLiteral("audio.mp3"));
    QFile f(tmpAudio);
    if (!f.open(QIODevice::WriteOnly) || f.write(m_previewBuffer) != m_previewBuffer.size()) {
        fail(QStringLiteral("could not write preview file"));
        return;
    }
    f.close();
    m_previewBuffer.clear();
    if (m_curTotal <= 0) {
        m_curTotal = QFileInfo(tmpAudio).size();
        m_curDone = m_curTotal;
    }
    m_sumTotal += m_curTotal;
    m_curMediaPath = tmpAudio;
    m_curArtPath.clear();
    const Track &t = m_tracks.at(m_trackIndex);
    if (!t.artUrl.isEmpty()) {
        QNetworkRequest req(QUrl(t.artUrl));
        req.setHeader(QNetworkRequest::UserAgentHeader, kUA);
        m_artReply = m_nam->get(req);
        connect(m_artReply, &QNetworkReply::finished, this, &SpotifyGrabber::onArtFinished);
        return;
    }
    startTagging(tmpAudio, t);
}

void SpotifyGrabber::onArtFinished()
{
    if (!m_artReply)
        return;
    QNetworkReply *r = m_artReply;
    m_artReply = nullptr;
    r->deleteLater();
    if (r->error() == QNetworkReply::NoError) {
        const QByteArray data = r->readAll();
        if (!data.isEmpty()) {
            QString ext = QStringLiteral("jpg");
            const QString ct = r->header(QNetworkRequest::ContentTypeHeader).toString().toLower();
            if (ct.contains(QLatin1String("png"))) ext = QStringLiteral("png");
            else if (ct.contains(QLatin1String("webp"))) ext = QStringLiteral("webp");
            m_curArtPath = QDir(m_tmpDir).filePath(QStringLiteral("cover.") + ext);
            QFile f(m_curArtPath);
            if (f.open(QIODevice::WriteOnly)) { f.write(data); f.close(); }
            else m_curArtPath.clear();
        }
    }
    const Track &t = m_tracks.at(m_trackIndex);
    startTagging(m_curMediaPath, t);
}

void SpotifyGrabber::startFullDownload(const Track &t)
{
    const QString ytdlp = resolveTool(QStringLiteral("yt-dlp"));
    if (ytdlp.isEmpty()) {
        // Fall back to the 30s preview if one exists.
        if (!t.previewUrl.isEmpty()) {
            m_mode = QStringLiteral("preview");
            startPreviewDownload(t);
            return;
        }
        fail(QStringLiteral("yt-dlp is not installed — install yt-dlp or use preview mode"));
        return;
    }
    // Clear any stale audio.* from a previous/aborted track so yt-dlp doesn't
    // treat it as "already downloaded" and skip the real fetch.
    const QDir td(m_tmpDir);
    for (const QString &f : td.entryList({QStringLiteral("audio.*")}))
        QFile::remove(td.filePath(f));

    // yt-dlp (2024+) needs a JavaScript runtime to extract YouTube's player
    // and bypass the signature/ntoken ciphers. It defaults to `deno` ONLY —
    // when deno isn't installed it prints a warning AND the download can fail
    // with HTTP 403 Forbidden (YouTube rejects the un-throttled client). node
    // is the most commonly installed runtime, so detect deno/node/bun/quickjs
    // and pass the first one found via --js-runtimes. If none is present we
    // omit the flag (yt-dlp warns but may still succeed for some videos).
    QStringList jsRuntimes = { QStringLiteral("deno"), QStringLiteral("node"),
                              QStringLiteral("bun"), QStringLiteral("quickjs") };
    QString jsRuntime;
    for (const QString &r : jsRuntimes) {
        if (!resolveTool(r).isEmpty()) { jsRuntime = r; break; }
    }

    // Quote the title for an exact-match search (avoids covers/remixes); the
    // artists go unquoted so "feat." and band names still match.
    const QString query = QStringLiteral("\"%1\" %2")
                              .arg(t.name, t.artists.join(QStringLiteral(" ")));
    m_curMediaPath = QDir(m_tmpDir).filePath(QStringLiteral("audio.") + m_audioFormat);
    QStringList args = {
        QStringLiteral("--no-playlist"),
        QStringLiteral("--extract-audio"),
        QStringLiteral("--audio-format"), m_audioFormat,
        QStringLiteral("--audio-quality"), QStringLiteral("0"),
        QStringLiteral("--newline"),
        QStringLiteral("-o"), QDir(m_tmpDir).filePath(QStringLiteral("audio.%(ext)s")),
    };
    if (!jsRuntime.isEmpty())
        args << QStringLiteral("--js-runtimes") << jsRuntime;
    args << QStringLiteral("ytsearch1:") + query;
    m_ytdlp = new QProcess(this);
    m_ytdlp->setProcessChannelMode(QProcess::MergedChannels);
    connect(m_ytdlp, &QProcess::readyReadStandardOutput, this, &SpotifyGrabber::onYtDlpOutput);
    connect(m_ytdlp, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished),
            this, &SpotifyGrabber::onYtDlpFinished);
    m_ytdlp->start(ytdlp, args);
    if (kDebug)
        qDebug().noquote() << "Spotify" << m_id << "yt-dlp search:" << query
                           << "js-runtime:" << (jsRuntime.isEmpty() ? QStringLiteral("(none)") : jsRuntime);
}

void SpotifyGrabber::onYtDlpOutput()
{
    if (!m_ytdlp)
        return;
    while (m_ytdlp->canReadLine()) {
        const QString line = QString::fromUtf8(m_ytdlp->readLine()).trimmed();
        if (line.isEmpty())
            continue;

        // Phase feedback so the UI isn't silent during yt-dlp's metadata /
        // extraction phases (before the [download] N% lines begin). These are
        // cheap state hints, not progress, but they stop the row looking stuck.
        if (line.contains(QStringLiteral("[youtube:search]"), Qt::CaseInsensitive)
            || line.contains(QStringLiteral("Extracting URL: ytsearch"), Qt::CaseInsensitive)) {
            setState(DownloadState::Downloading, QStringLiteral("searching YouTube"));
            continue;
        }
        if (line.startsWith(QStringLiteral("[download] Destination:"), Qt::CaseInsensitive)) {
            setState(DownloadState::Downloading, QStringLiteral("downloading audio"));
            m_lastPct = -1;   // a new download stream starts — restart the throttle
            continue;
        }
        if (line.startsWith(QStringLiteral("[ExtractAudio]"), Qt::CaseInsensitive)) {
            setState(DownloadState::Downloading, QStringLiteral("extracting audio"));
            continue;
        }

        // Capture yt-dlp ERROR lines so we can surface the real reason and fall
        // back to the 30s preview instead of a generic "could not download".
        if (line.startsWith(QStringLiteral("ERROR"), Qt::CaseInsensitive)) {
            m_lastError = line;
            continue;
        }

        // e.g. "[download]  36.0% of  2.50MiB at  1.20MiB/s ETA 00:01"
        static const QRegularExpression re(
            QStringLiteral("\\[download\\]\\s+([\\d.]+)%(?:\\s+of\\s+~?\\s*([\\d.]+\\s*[KMGT]?i?B))?"
                          "(?:\\s+at\\s+([\\d.]+\\s*[KMGT]?i?B/s))?"));
        const auto m = re.match(line);
        if (m.hasMatch()) {
            const double pct = m.captured(1).toDouble();
            const int p = int(pct + 0.5);
            if (p == m_lastPct)
                continue;
            m_lastPct = p;
            qint64 total = -1;
            if (!m.captured(2).isEmpty())
                total = parseSizeToken(m.captured(2));
            double bps = 0.0;
            if (!m.captured(3).isEmpty())
                bps = parseRateToken(m.captured(3));
            m_curTotal = total;
            if (total > 0)
                m_curDone = qint64(total * pct / 100.0);
            emit progress(m_id, m_doneBytes + (m_curDone > 0 ? m_curDone : 0),
                         m_tracks.size() > 1 ? (m_sumTotal > 0 ? m_sumTotal : -1) : m_curTotal, bps);
        }
    }
}

void SpotifyGrabber::onYtDlpFinished(int exitCode, QProcess::ExitStatus)
{
    if (!m_ytdlp)
        return;
    m_ytdlp->deleteLater();
    m_ytdlp = nullptr;
    const Track &t = m_tracks.at(m_trackIndex);
    if (exitCode != 0 || !QFile::exists(m_curMediaPath)) {
        // Full match failed — fall back to the 30s preview if available, with
        // the real yt-dlp error in the status line so the user knows why.
        const QString why = m_lastError.isEmpty()
            ? QStringLiteral("YouTube match failed")
            : m_lastError;
        if (!t.previewUrl.isEmpty()) {
            setState(DownloadState::Downloading,
                     why + QStringLiteral(" — using 30s preview"));
            m_mode = QStringLiteral("preview");
            startPreviewDownload(t);
        } else {
            fail(why.isEmpty() ? QStringLiteral("yt-dlp could not find/download the track")
                               : why);
        }
        return;
    }
    m_curTotal = QFileInfo(m_curMediaPath).size();
    m_curDone = m_curTotal;
    m_sumTotal += m_curTotal;
    m_curArtPath.clear();
    m_lastError.clear();
    if (!t.artUrl.isEmpty()) {
        QNetworkRequest req(QUrl(t.artUrl));
        req.setHeader(QNetworkRequest::UserAgentHeader, kUA);
        m_artReply = m_nam->get(req);
        connect(m_artReply, &QNetworkReply::finished, this, &SpotifyGrabber::onArtFinished);
        return;
    }
    startTagging(m_curMediaPath, t);
}

void SpotifyGrabber::startTagging(const QString &mediaPath, const Track &t)
{
    m_curMediaPath = mediaPath;
    m_curOutPath = targetPath(t);
    const QString ffmpeg = resolveTool(QStringLiteral("ffmpeg"));
    if (ffmpeg.isEmpty()) {
        // No ffmpeg — just move the raw audio into place (untagged).
        QFile::remove(m_curOutPath);
        if (!QFile::rename(mediaPath, m_curOutPath)) {
            if (QFile::copy(mediaPath, m_curOutPath)) QFile::remove(mediaPath);
            else { fail(QStringLiteral("could not save file")); return; }
        }
        m_savePath = (m_tracks.size() == 1) ? m_curOutPath : m_saveDir;
        finishTrack(m_curOutPath, t);
        return;
    }
    const QString artists = t.artists.join(QStringLiteral(", "));
    // ffmpeg requires ALL inputs (-i) to be declared BEFORE output options
    // (-map/-c/-metadata). Interleaving them makes ffmpeg treat the output
    // options as input options for the next -i and abort with
    // "Error parsing options for input file". So: inputs first, then maps +
    // metadata + codec, then the output file.
    QStringList args = { QStringLiteral("-y"), QStringLiteral("-i"), mediaPath };
    const bool hasArt = !m_curArtPath.isEmpty() && QFile::exists(m_curArtPath);
    if (hasArt)
        args << QStringLiteral("-i") << m_curArtPath;
    args << QStringLiteral("-map") << QStringLiteral("0:a");
    if (hasArt)
        args << QStringLiteral("-map") << QStringLiteral("1:0");
    args << QStringLiteral("-c:a") << QStringLiteral("copy")
         << QStringLiteral("-id3v2_version") << QStringLiteral("3")
         << QStringLiteral("-metadata") << QStringLiteral("title=") + t.name
         << QStringLiteral("-metadata") << QStringLiteral("artist=") + artists
         << QStringLiteral("-metadata") << QStringLiteral("album=") + t.album
         << QStringLiteral("-metadata") << QStringLiteral("date=") + t.releaseDate.left(4);
    if (hasArt)
        args << QStringLiteral("-metadata:s:v") << QStringLiteral("title=Album cover")
             << QStringLiteral("-metadata:s:v") << QStringLiteral("comment=Cover (front)");
    args << m_curOutPath;
    m_ffmpeg = new QProcess(this);
    connect(m_ffmpeg, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished),
            this, &SpotifyGrabber::onFfmpegFinished);
    m_ffmpeg->start(ffmpeg, args);
    if (kDebug)
        qDebug().noquote() << "Spotify" << m_id << "ffmpeg tag ->" << m_curOutPath;
}

void SpotifyGrabber::onFfmpegFinished(int exitCode, QProcess::ExitStatus)
{
    if (!m_ffmpeg)
        return;
    m_ffmpeg->deleteLater();
    m_ffmpeg = nullptr;
    const Track &t = m_tracks.at(m_trackIndex);
    if (exitCode != 0 || !QFile::exists(m_curOutPath)) {
        // Tagging failed — fall back to the raw audio file moved into place.
        QFile::remove(m_curOutPath);
        if (!QFile::copy(m_curMediaPath, m_curOutPath)) {
            fail(QStringLiteral("ffmpeg tagging failed"));
            return;
        }
    }
    QFile::remove(m_curMediaPath);
    m_savePath = (m_tracks.size() == 1) ? m_curOutPath : m_saveDir;
    finishTrack(m_curOutPath, t);
}

void SpotifyGrabber::finishTrack(const QString &outPath, const Track &t)
{
    Q_UNUSED(t)
    const qint64 sz = QFileInfo(outPath).size();
    m_doneBytes += (m_curTotal > 0 ? m_curTotal : sz);
    ++m_trackIndex;
    emit progress(m_id, m_doneBytes, m_sumTotal > 0 ? m_sumTotal : -1, 0.0);
    if (!m_curArtPath.isEmpty()) { QFile::remove(m_curArtPath); m_curArtPath.clear(); }
    processNextTrack();
}

void SpotifyGrabber::cancel()
{
    m_cancelled = true;
    // Detach each reply's handlers before abort(), as MegaGrabber::cancel()
    // does: abort() emits finished() synchronously, and every handler takes
    // its member and nulls it first. Attached, they ran in here — failing the
    // download the user had just paused, or for the cover art, tagging and
    // filing the half-finished track — and deleteLater() then ran on null.
    if (m_embedReply) {
        m_embedReply->disconnect(this);
        m_embedReply->abort();
        m_embedReply->deleteLater();
        m_embedReply = nullptr;
    }
    if (m_previewReply) {
        m_previewReply->disconnect(this);
        m_previewReply->abort();
        m_previewReply->deleteLater();
        m_previewReply = nullptr;
    }
    if (m_artReply) {
        m_artReply->disconnect(this);
        m_artReply->abort();
        m_artReply->deleteLater();
        m_artReply = nullptr;
    }
    // The processes' finished() arrives later, not from kill(), and both
    // handlers return at once on a null member.
    if (m_ytdlp)        { m_ytdlp->kill();         m_ytdlp->deleteLater();        m_ytdlp = nullptr; }
    if (m_ffmpeg)       { m_ffmpeg->kill();        m_ffmpeg->deleteLater();       m_ffmpeg = nullptr; }
    if (!m_tmpDir.isEmpty()) {
        QDir(m_tmpDir).removeRecursively();
        m_tmpDir.clear();
    }
}

} // namespace nexa






