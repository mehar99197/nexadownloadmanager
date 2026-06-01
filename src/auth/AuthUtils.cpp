#include "auth/AuthUtils.h"

#include <QRegularExpression>

namespace nexa {

QString authErrorDetail(int httpStatus)
{
    return httpStatus == 401 ? QStringLiteral("authentication required (HTTP 401)")
                             : QStringLiteral("access forbidden (HTTP 403)");
}

QString authReasonFromYtDlpLine(const QString &line)
{
    static const QRegularExpression httpRe(QStringLiteral("HTTP Error (401|403)"),
                                           QRegularExpression::CaseInsensitiveOption);
    if (const auto m = httpRe.match(line); m.hasMatch())
        return QStringLiteral("authentication required (HTTP %1)").arg(m.captured(1));

    static const QRegularExpression botRe(QStringLiteral("Sign in to confirm you.*bot"),
                                          QRegularExpression::CaseInsensitiveOption);
    if (botRe.match(line).hasMatch())
        return QStringLiteral("sign-in required — re-export cookies");

    static const QRegularExpression loginRe(
        QStringLiteral("login required|you must be logged in|requires? (a )?(subscription|login|account)|"
                       "this course requires|members[- ]only|private video|account.*(required|cookies)"),
        QRegularExpression::CaseInsensitiveOption);
    if (loginRe.match(line).hasMatch())
        return QStringLiteral("login required — provide cookies or a token");

    return QString();
}

} // namespace nexa
