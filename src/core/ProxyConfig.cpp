#include "core/ProxyConfig.h"

#include <QNetworkProxy>
#include <QSettings>
#include <QUrl>

namespace nexa::proxyconfig {

namespace {
constexpr auto kMode = "proxy/mode";     // none | system | http | socks5
constexpr auto kHost = "proxy/host";
constexpr auto kPort = "proxy/port";
constexpr auto kUser = "proxy/user";
constexpr auto kPass = "proxy/password";

struct Settings {
    QString mode, host, user, password;
    int port = 0;
    bool explicitProxy() const
    { return (mode == QLatin1String("http") || mode == QLatin1String("socks5"))
             && !host.isEmpty() && port > 0; }
};

Settings read()
{
    QSettings s;
    Settings c;
    c.mode = s.value(QLatin1String(kMode), QStringLiteral("none")).toString();
    c.host = s.value(QLatin1String(kHost)).toString().trimmed();
    c.port = s.value(QLatin1String(kPort), 0).toInt();
    c.user = s.value(QLatin1String(kUser)).toString();
    c.password = s.value(QLatin1String(kPass)).toString();
    return c;
}
} // namespace

void applyFromSettings()
{
    const Settings c = read();
    if (c.mode == QLatin1String("system")) {
        QNetworkProxyFactory::setUseSystemConfiguration(true);
        return;
    }
    // Any explicit choice (including "none") must switch the system factory off,
    // or Qt keeps consulting the OS settings and ignores what we set here.
    QNetworkProxyFactory::setUseSystemConfiguration(false);
    if (!c.explicitProxy()) {
        QNetworkProxy::setApplicationProxy(QNetworkProxy(QNetworkProxy::NoProxy));
        return;
    }
    QNetworkProxy proxy(c.mode == QLatin1String("socks5") ? QNetworkProxy::Socks5Proxy
                                                          : QNetworkProxy::HttpProxy,
                        c.host, quint16(c.port));
    if (!c.user.isEmpty()) {
        proxy.setUser(c.user);
        proxy.setPassword(c.password);
    }
    QNetworkProxy::setApplicationProxy(proxy);
}

QString toolProxyUrl()
{
    const Settings c = read();
    if (!c.explicitProxy())
        return QString();          // "none"/"system": let the tool use its own env
    QUrl u;
    u.setScheme(c.mode == QLatin1String("socks5") ? QStringLiteral("socks5")
                                                  : QStringLiteral("http"));
    u.setHost(c.host);
    u.setPort(c.port);
    if (!c.user.isEmpty()) {
        u.setUserName(c.user);
        if (!c.password.isEmpty())
            u.setPassword(c.password);
    }
    return u.toString(QUrl::FullyEncoded);
}

QString describe()
{
    const Settings c = read();
    if (c.mode == QLatin1String("system"))
        return QStringLiteral("Using the system proxy settings");
    if (!c.explicitProxy())
        return QStringLiteral("Direct connection (no proxy)");
    return QStringLiteral("%1 · %2:%3%4")
        .arg(c.mode == QLatin1String("socks5") ? QStringLiteral("SOCKS5") : QStringLiteral("HTTP"),
             c.host)
        .arg(c.port)
        .arg(c.user.isEmpty() ? QString() : QStringLiteral(" (authenticated)"));
}

} // namespace nexa::proxyconfig
