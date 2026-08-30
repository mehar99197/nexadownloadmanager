#pragma once

#include <QDialog>
#include <QList>
#include <QString>

class QGridLayout;
class QLabel;
class QLineEdit;
class QPushButton;

namespace nexa {

class ThemeCard;

// The "Themes" gallery: every built-in look as a live miniature of the app.
// Clicking a card applies it to the running application immediately so the
// user judges the real thing; Cancel puts the previous one back.
class ThemeGalleryDialog : public QDialog {
    Q_OBJECT
public:
    explicit ThemeGalleryDialog(QWidget *parent = nullptr);

    // The id in force when the dialog closes.
    QString selectedId() const { return m_selected; }

    /**
     * Restrict which themes may be applied.
     *
     * Locked themes are still shown, with their real preview and a PRO badge —
     * the gallery is the best advert the upgrade has. Defaults to unrestricted
     * so tests and any other caller are unaffected until this is called.
     */
    void setThemeEntitlement(bool allThemesAllowed, const QStringList &allowedIds);

signals:
    // The application stylesheet just changed under the caller's feet.
    void themeApplied(const QString &id);
    // A locked theme was clicked. The caller owns the upgrade messaging so this
    // dialog stays free of any licensing dependency.
    void lockedThemeChosen(const QString &id, const QString &name);

private:
    enum Filter { All, DarkOnly, LightOnly };

    void buildGrid();
    void setFilter(Filter f);
    void choose(const QString &id);
    void applyLive(const QString &id);
    void updateFooter();

    bool    allowsTheme(const QString &id) const;

    QString m_originalId;
    QString m_selected;
    Filter  m_filter = All;
    bool        m_allThemesAllowed = true;
    QStringList m_allowedThemeIds;

    QWidget      *m_gridHost = nullptr;
    QGridLayout  *m_grid = nullptr;
    QList<ThemeCard *> m_cards;
    QPushButton  *m_fAll = nullptr, *m_fDark = nullptr, *m_fLight = nullptr;
    QLineEdit    *m_search = nullptr;
    QString       m_query;
    int           m_columns = 3;
    QLabel       *m_footNote = nullptr;
};

} // namespace nexa
