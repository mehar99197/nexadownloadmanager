#pragma once
#include <QDialog>
#include <QStringList>

class QPlainTextEdit;
class QLabel;
class QListWidget;
class QDialogButtonBox;

namespace nexa {

class DownloadEngine;

// IDM-style batch download: paste a list of addresses, or one address carrying a
// numeric range like https://site.com/scan[001-240].jpg, and queue the lot.
//
// The expansion itself is DownloadEngine::expandPattern -- the same code the
// command line and the remote dashboard already use, so the dialog cannot
// disagree with them about what a pattern means. What the dialog adds is the
// part that was missing: showing the person what their pattern actually expands
// to BEFORE two hundred downloads appear in the list. A range is easy to get
// wrong by an order of magnitude, and a queue is a slow place to find that out.
class BatchDownloadDialog : public QDialog {
    Q_OBJECT
public:
    explicit BatchDownloadDialog(DownloadEngine *engine, QWidget *parent = nullptr);

    // Addresses queued when the dialog was accepted (empty otherwise).
    QStringList queued() const { return m_queued; }

private slots:
    void refreshPreview();
    void queueThem();

private:
    // Expand the text area into the addresses that would be queued, capped at
    // kPreviewCeiling so a fat-fingered [1-999999] cannot build a huge list just
    // to render a preview of its first twelve entries.
    QStringList expandInput(bool *truncated) const;

    static constexpr int kPreviewRows     = 12;
    static constexpr int kPreviewCeiling  = 10000;

    DownloadEngine   *m_engine;
    QPlainTextEdit   *m_input = nullptr;
    QLabel           *m_count = nullptr;
    QListWidget      *m_preview = nullptr;
    QDialogButtonBox *m_buttons = nullptr;
    QStringList       m_queued;
};

} // namespace nexa
