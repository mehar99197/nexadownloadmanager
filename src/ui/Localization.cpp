#include "ui/Localization.h"

#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QLibraryInfo>
#include <QLocale>
#include <QSettings>
#include <QGuiApplication>
#include <QTranslator>

namespace nexa::i18n {

namespace {
constexpr auto kKey = "ui/language";

// Kept alive for the process; Qt does not take ownership of a translator.
QTranslator *g_appTranslator = nullptr;
QTranslator *g_qtTranslator  = nullptr;
} // namespace

QVector<Language> available()
{
    // Ordered by where Nexa's IDM-alternative audience actually is. "" means
    // "use whatever the desktop is set to".
    return {
        {QString(),                 QStringLiteral("System default"),  QStringLiteral("System default")},
        {QStringLiteral("en"),      QStringLiteral("English"),         QStringLiteral("English")},
        {QStringLiteral("ur"),      QStringLiteral("Urdu"),            QString::fromUtf8("اردو")},
        {QStringLiteral("hi"),      QStringLiteral("Hindi"),           QString::fromUtf8("हिन्दी")},
        {QStringLiteral("ar"),      QStringLiteral("Arabic"),          QString::fromUtf8("العربية")},
        {QStringLiteral("es"),      QStringLiteral("Spanish"),         QString::fromUtf8("Español")},
        {QStringLiteral("pt_BR"),   QStringLiteral("Portuguese (BR)"), QString::fromUtf8("Português (BR)")},
        {QStringLiteral("id"),      QStringLiteral("Indonesian"),      QString::fromUtf8("Bahasa Indonesia")},
        {QStringLiteral("ru"),      QStringLiteral("Russian"),         QString::fromUtf8("Русский")},
        {QStringLiteral("tr"),      QStringLiteral("Turkish"),         QString::fromUtf8("Türkçe")},
        {QStringLiteral("fr"),      QStringLiteral("French"),          QString::fromUtf8("Français")},
        {QStringLiteral("de"),      QStringLiteral("German"),          QString::fromUtf8("Deutsch")},
        {QStringLiteral("zh_CN"),   QStringLiteral("Chinese (Simplified)"), QString::fromUtf8("简体中文")},
    };
}

QString savedLanguage()
{
    return QSettings().value(QLatin1String(kKey)).toString();
}

void setSavedLanguage(const QString &code)
{
    QSettings().setValue(QLatin1String(kKey), code);
}

QStringList searchPaths()
{
    const QString appDir = QCoreApplication::applicationDirPath();
    return {
        appDir + QStringLiteral("/translations"),
        appDir + QStringLiteral("/../share/nexa/translations"),
        QStringLiteral("/usr/share/nexa/translations"),
        QStringLiteral(":/translations"),          // compiled into the binary
    };
}

QString install(QCoreApplication &app)
{
    QString code = savedLanguage();
    if (code.isEmpty())
        code = QLocale::system().name();           // e.g. "ur_PK"

    // Try the full tag first ("pt_BR"), then the bare language ("pt").
    QStringList candidates{code};
    if (const QString base = code.section(QLatin1Char('_'), 0, 0); base != code)
        candidates << base;

    // Qt's own strings (dialog buttons, standard menus) where they are installed.
    if (!g_qtTranslator)
        g_qtTranslator = new QTranslator(&app);
    for (const QString &c : candidates) {
        if (g_qtTranslator->load(QStringLiteral("qtbase_") + c,
                                 QLibraryInfo::path(QLibraryInfo::TranslationsPath))) {
            app.installTranslator(g_qtTranslator);
            break;
        }
    }

    // Urdu, Arabic, Farsi and Hebrew read right-to-left: mirror the layout even
    // when only some strings are translated, so the UI is never half-flipped.
    static const QStringList kRtl{QStringLiteral("ur"), QStringLiteral("ar"),
                                  QStringLiteral("fa"), QStringLiteral("he")};
    if (kRtl.contains(candidates.last()))
        QGuiApplication::setLayoutDirection(Qt::RightToLeft);

    if (!g_appTranslator)
        g_appTranslator = new QTranslator(&app);
    for (const QString &c : candidates) {
        for (const QString &dir : searchPaths()) {
            if (!QFileInfo::exists(dir) && !dir.startsWith(QLatin1Char(':')))
                continue;
            if (g_appTranslator->load(QStringLiteral("nexa_") + c, dir)) {
                app.installTranslator(g_appTranslator);
                return c;
            }
        }
    }
    return QString();   // no translation available: the source English is used
}

} // namespace nexa::i18n
