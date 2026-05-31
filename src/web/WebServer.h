#pragma once
#include <QObject>
#include <QHash>
#include <QByteArray>
#include <QString>

class QTcpServer;
class QTcpSocket;
class QTimer;

namespace nexa {

class DownloadEngine;

// A tiny, dependency-free HTTP/1.1 server (built on QTcpServer) exposing a REST
// API plus a single-page dashboard so downloads can be monitored and controlled
// from another device on the LAN (e.g. a phone browser).
//
//   GET  /                      -> dashboard HTML
//   GET  /api/downloads         -> JSON array of jobs
//   POST /api/add               -> add a download (body: url=... or {"url":...})
//   POST /api/pause?id=N        -> pause a job
//   POST /api/resume?id=N       -> resume a job
//   POST /api/remove?id=N       -> remove a job (keeps the file)
//
// If a token is configured, every request must carry ?token=... (the dashboard
// page forwards the token it was loaded with). One request per connection
// (Connection: close); requests are size-capped to bound memory use.
class WebServer : public QObject {
    Q_OBJECT
public:
    explicit WebServer(DownloadEngine *engine, QObject *parent = nullptr);

    // Bind to 0.0.0.0 when lanAccessible, else loopback only. Returns false if
    // the port can't be bound.
    bool start(quint16 port, bool lanAccessible, const QString &token = QString());
    quint16 port() const { return m_port; }

private slots:
    void onNewConnection();

private:
    struct Request {
        QString    method;
        QString    path;                         // without query string
        QHash<QString, QString> query;           // decoded query params
        QHash<QString, QString> headers;         // lower-cased keys
        QByteArray body;
    };

    void onReadyRead(QTcpSocket *sock);
    bool tryParse(const QByteArray &buf, Request &req, bool &needMore) const;
    void dispatch(QTcpSocket *sock, const Request &req);
    void sendResponse(QTcpSocket *sock, int code, const QString &contentType,
                      const QByteArray &body) const;
    void sendJson(QTcpSocket *sock, int code, const QByteArray &json) const;
    void closeConnection(QTcpSocket *sock);       // abort + reclaim a connection
    QByteArray downloadsJson() const;

    // Per-connection state: the partial read buffer plus an idle-timeout timer
    // (parented to the socket) that fires if a full request never arrives.
    struct Conn {
        QByteArray buffer;
        QTimer    *timer = nullptr;
    };

    DownloadEngine *m_engine;
    QTcpServer     *m_server = nullptr;
    quint16         m_port = 0;
    QString         m_token;
    QHash<QTcpSocket*, Conn> m_conns;             // live connections

    static constexpr int kMaxRequestBytes = 1 * 1024 * 1024;   // 1 MB per request
    static constexpr int kMaxConnections  = 256;               // bound FDs/memory
    static constexpr int kIdleTimeoutMs   = 8000;              // free slow clients fast
};

} // namespace nexa
