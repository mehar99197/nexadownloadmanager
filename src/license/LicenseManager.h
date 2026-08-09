#pragma once

#include <QObject>
#include <QString>

class QNetworkAccessManager;
class QNetworkReply;

namespace nexa {

class LicenseManager : public QObject {
    Q_OBJECT
public:
    explicit LicenseManager(QObject *parent = nullptr);

    void start();
    void activate(const QString &licenseKey);
    void deactivate();

    QString plan() const { return m_plan; }
    QString status() const { return m_status; }
    bool isPaid() const { return m_plan == QLatin1String("pro") || m_plan == QLatin1String("team"); }

    static QString deviceFingerprint();

signals:
    void entitlementChanged(const QString &plan);
    void statusChanged(const QString &status);
    void activationFinished(bool valid, const QString &message);

private:
    void validate(const QString &licenseKey, bool userInitiated);
    void setPlan(const QString &plan, const QString &status);
    void clearCache();

    QNetworkAccessManager *m_network = nullptr;
    QNetworkReply *m_reply = nullptr;
    QString m_plan = QStringLiteral("free");
    QString m_status = QStringLiteral("Free plan");
};

} // namespace nexa