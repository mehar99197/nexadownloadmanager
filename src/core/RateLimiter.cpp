#include "core/RateLimiter.h"
#include <QTimer>
#include <algorithm>

namespace nexa {

RateLimiter::RateLimiter(QObject *parent)
    : QObject(parent)
{
    m_timer = new QTimer(this);
    m_timer->setInterval(50);   // 20 wakes/sec — smooth pacing without busy-looping
    connect(m_timer, &QTimer::timeout, this, [this]() {
        refill();
        emit replenished();
    });
}

void RateLimiter::setLimit(qint64 bytesPerSec)
{
    const bool wasLimited = isLimited();
    m_limit = qMax<qint64>(0, bytesPerSec);
    if (m_limit > 0) {
        // Restart the budget clock so an old idle period can't release a huge
        // burst the instant a limit is (re)applied.
        m_clock.restart();
        m_lastMs = 0;
        m_tokens = 0.0;
        if (!m_timer->isActive())
            m_timer->start();
    } else {
        m_timer->stop();
    }
    // Tell active readers to (un)bound their socket read buffers so changing the
    // limit mid-download applies/relaxes TCP backpressure on in-flight transfers.
    if (isLimited() != wasLimited)
        emit limitedChanged(isLimited());
}

void RateLimiter::refund(qint64 bytes)
{
    if (m_limit <= 0 || bytes <= 0)
        return;
    m_tokens = std::min(m_tokens + double(bytes), double(m_limit));
}

void RateLimiter::refill()
{
    if (m_limit <= 0)
        return;
    if (!m_clock.isValid())
        m_clock.start();
    const qint64 now = m_clock.elapsed();
    const qint64 dt = now - m_lastMs;
    m_lastMs = now;
    if (dt <= 0)
        return;
    m_tokens += double(m_limit) * double(dt) / 1000.0;
    // Cap the bucket at one second's worth so bursts stay bounded.
    m_tokens = std::min(m_tokens, double(m_limit));
}

qint64 RateLimiter::consume(qint64 want)
{
    if (m_limit <= 0 || want <= 0)
        return want > 0 ? want : 0;
    refill();
    const qint64 granted = qint64(std::min(double(want), m_tokens));
    if (granted > 0)
        m_tokens -= double(granted);
    return granted;
}

} // namespace nexa
