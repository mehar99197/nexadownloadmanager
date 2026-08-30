#pragma once
#include <QDialog>
#include <QVector>
#include "core/Types.h"

class QTableWidget;
class QLineEdit;
class QComboBox;
class QLabel;
class QPushButton;

namespace nexa {

class DownloadEngine;

// IDM-style "Download all links" grabber: the extension harvests a page's links
// and the user filters, ticks and downloads the ones they want. Non-modal.
class LinkGrabberDialog : public QDialog {
    Q_OBJECT
public:
    LinkGrabberDialog(DownloadEngine *engine, const QString &pageUrl, const QString &pageTitle,
                      const QVector<LinkItem> &links, const HeaderList &headers,
                      QWidget *parent = nullptr);

    // True when the URL's path ends in an extension people download on purpose
    // (archives, installers, media, documents) — used to pre-tick rows.
    static bool looksLikeFile(const QString &url);
    // A display name for a link: anchor text if useful, else the URL's last segment.
    static QString displayName(const LinkItem &item);

private:
    void applyFilter();
    void setVisibleChecked(bool on);
    void updateSummary();
    void downloadSelected();

    DownloadEngine *m_engine;
    QVector<LinkItem> m_links;
    HeaderList m_headers;
    QTableWidget *m_table = nullptr;
    QLineEdit *m_search = nullptr;
    QComboBox *m_kind = nullptr;
    QLabel *m_summary = nullptr;
    QPushButton *m_download = nullptr;
};

} // namespace nexa
