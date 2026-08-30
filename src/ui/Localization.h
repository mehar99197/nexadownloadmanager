#pragma once

#include <QString>
#include <QStringList>
#include <QVector>

class QCoreApplication;

namespace nexa::i18n {

// A language Nexa ships (or can ship) a translation for.
struct Language {
    QString code;        // "ur", "pt_BR", … ; empty code == "follow the system"
    QString englishName; // shown in English so it is findable
    QString nativeName;  // shown to speakers of that language
};

// Languages offered in Settings. The first entry is always "System default".
QVector<Language> available();

// Persisted choice (settings key "ui/language"; empty = follow the system).
QString savedLanguage();
void    setSavedLanguage(const QString &code);

// Install the Qt + Nexa translators for the saved (or system) language. Call
// once at startup, after QApplication exists. Returns the language actually
// loaded, or an empty string when running untranslated English.
QString install(QCoreApplication &app);

// Where compiled .qm files are searched, in order (app dir, install prefix,
// Qt resources). Exposed for the "language not installed" message in Settings.
QStringList searchPaths();

} // namespace nexa::i18n
