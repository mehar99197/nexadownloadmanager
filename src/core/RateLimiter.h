#pragma once
#include <QObject>
#include <QElapsedTimer>

class QTimer;

namespace nexa {

// A shared global token-bucket rate limiter for HTTP segment downloads. One
// instance is owned by the engine and consulted by every SegmentDownloader, so
// the cap is applied across ALL active downloads combined (an IDM-style global
// speed limit). Single-threaded: everything runs on the GUI event loop, so no
// locking is needed.
//
// Usage from a reader: ask consume(want) for how many bytes you may read right
// now (0..want); read exactly that many and leave the rest buffered. When you
// get 0, wait for replenished() (emitted ~20×/s while limited) and try again.
class RateLimiter : public QObject {
    Q_OBJECT
public:
    explicit RateLimiter(QObject *parent = nullptr);

    void   setLimit(qint64 bytesPerSec);    // 0 = unlimited
    qint64 limit() const { return m_limit; }
    bool   isLimited() const { return m_limit > 0; }

    // Grant up to `want` bytes against the current budget. Returns the number
    // granted (0..want); unlimited always returns `want`.
    qint64 consume(qint64 want);

    // Return budget reserved by consume() but not actually used (a short read),
    // so the granted rate stays accurate.
    void   refund(qint64 bytes);

signals:
    void replenished();          // periodic wake so token-starved readers can drain
    void limitedChanged(bool limited);   // limited<->unlimited transition

private:
    void refill();        // add tokens accrued since the last call

    qint64        m_limit = 0;     // bytes/sec (0 = unlimited)
    double        m_tokens = 0.0;  // available byte budget
    QElapsedTimer m_clock;
    qint64        m_lastMs = 0;
    QTimer       *m_timer = nullptr;   // runs only while limited
};

} // namespace nexa
